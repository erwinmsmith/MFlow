// BFCL's official multi-turn controller calls published Ditto for every sample/action.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDitto, createInferWorker, createInteractionWorker, createHttpProvider, Sandbox } from '@codesoul-co/ditto';
import { modelFetch, observableProvider } from '../dist/src/provider-progress.js';

export const categories = ['multi_turn_base', 'multi_turn_miss_param', 'multi_turn_miss_func', 'multi_turn_long_context'];
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const filesBelow = path => readdirSync(path,{withFileTypes:true}).flatMap(d=>d.isDirectory()?filesBelow(resolve(path,d.name)):[resolve(path,d.name)]);
const hashFiles = paths => {const digest=createHash('sha256');for(const p of paths.sort())digest.update(p.split('bfcl_eval/').at(-1)).update(readFileSync(p));return digest.digest('hex');};
const readRows = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const append = (path, row) => appendFileSync(path, JSON.stringify(row) + '\n');
const atomic = (path, row) => { writeFileSync(path + '.tmp', JSON.stringify(row, null, 2)); renameSync(path + '.tmp', path); };

export function dittoMessages(messages) {
  return messages.map(m => ({role: m.role, content: m.content ?? '',
    ...(m.tool_calls ? {metadata: {actionRequests: m.tool_calls.map(t => ({id: t.id, name: t.function.name, arguments: JSON.parse(t.function.arguments)}))}} : {}),
    ...(m.tool_call_id ? {metadata: {actionRequestId: m.tool_call_id}} : {})}));
}

export function bfclResponse(output) {
  const calls = output.actionRequests ?? output.message.metadata?.actionRequests ?? [];
  const message = {role: 'assistant', content: output.message.content ?? ''};
  if (calls.length) message.tool_calls = calls.map(c => ({id: c.id, type: 'function', function: {name: c.name, arguments: JSON.stringify(c.arguments)}}));
  return {model_responses: calls.length ? calls.map(c => ({[c.name]: JSON.stringify(c.arguments)})) : message.content,
    model_responses_message_for_chat_history: message, tool_call_ids: calls.map(c => c.id),
    input_token: output.usage?.inputTokens ?? 0, output_token: output.usage?.outputTokens ?? 0};
}

export function summarize(run, ids) {
  const rows = readdirSync(resolve(run, 'results')).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(resolve(run, 'results', f), 'utf8')));
  const usage = readRows(resolve(run, 'usage.jsonl'));
  const known = usage.filter(r => Number.isFinite(r.tokens));
  const byCategory = Object.fromEntries(categories.map(c => { const subset = rows.filter(r => r.category === c); return [c, {completed: subset.length, planned: ids.filter(id => id.startsWith(c + '_')).length, correct: subset.reduce((n, r) => n + r.score, 0)}]; }));
  return {planned: ids.length, completed: rows.length, correct: rows.reduce((n, r) => n + r.score, 0),
    accuracy: rows.length ? rows.reduce((n, r) => n + r.score, 0) / rows.length : null,
    byCategory, cost: {calls: usage.length, knownTokens: known.reduce((n,r) => n+r.tokens, 0),
      inputTokens: usage.reduce((n,r) => n+(r.usage?.inputTokens ?? 0),0), outputTokens: usage.reduce((n,r) => n+(r.usage?.outputTokens ?? 0),0),
      cachedInputTokens: usage.reduce((n,r) => n+(r.usage?.cachedInputTokens ?? 0),0), unknownCalls: usage.length-known.length}, updatedAt: new Date().toISOString()};
}

export async function runTask({official, python, run, taskId, provider, config}) {
  const child = spawn(python, ['benchmark-hub/bfcl_bridge.py', '--official', official, '--project', resolve(run, 'official-work'), '--task', taskId], {stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = '', transportError;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const failure = new Promise((_, reject) => { child.once('error', reject); child.stdin.once('error', reject); });
  failure.catch(() => {});
  const lines = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  const next = async () => { const line = await Promise.race([lines.next(), failure]); if (line.done) throw new Error(`BFCL exited: ${stderr}`); return JSON.parse(line.value); };
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const cachePath = resolve(run, 'checkpoints', taskId + '.jsonl');
  const saved = readRows(cachePath);
  let sampleIndex = 0, runtime, activeCalls = [];
  const pending = new Map();
  const usageProvider = {async invoke(input, options) {
    let output;
    const startedAt = new Date().toISOString();
    try { output = await provider.invoke(input, options); return output; }
    catch (error) { transportError = error; throw error; }
    finally { const usage = output?.usage;
      append(resolve(run, 'usage.jsonl'), {taskId, startedAt, at: new Date().toISOString(), usage,
        tokens: usage?.totalTokens ?? (Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens) ? usage.inputTokens+usage.outputTokens : null),
        error: transportError ? String(transportError) : undefined}); }
  }};
  try {
    while (true) {
      const request = await next();
      if (request.op === 'sample') {
        await runtime?.close();
        activeCalls = request.tools.map(t => t.function);
        const tools = activeCalls.map(t => ({name: t.name, description: t.description, inputSchema: t.parameters, effects: ['read','write'],
          validate(args) { if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('BFCL arguments must be an object'); },
          async execute(args) {
            const source = pending.get(t.name + ':' + JSON.stringify(args));
            if (!source) throw new Error('Tool call does not match the official controller request');
            send({op: 'execute-native', source});
            // Execution timeout protects the local simulator; LLM requests use their own deadline.
            let timer;
            try {
              const result = await Promise.race([next(), new Promise((_,reject) => {timer=setTimeout(() => {child.kill();reject(new Error('BFCL environment timeout'));},60000);})]);
              if (result.op !== 'native-result' || result.error) throw new Error(result.error ?? 'Unexpected BFCL native result');
              return {status: 'success', content: result.result};
            } finally {clearTimeout(timer);}
          }}));
        runtime = createDitto({sandbox: {tools: tools.map(t => t.name)}, workers: [createInferWorker({providers: {bfcl: usageProvider}, timeoutMs: config.timeoutMs}), createInteractionWorker({tools})]});
        const signature = hash(request), cached = saved[sampleIndex];
        let response;
        if (cached) {
          if (cached.signature !== signature) throw new Error('BFCL resume request mismatch; refusing to mix protocols');
          response = cached.response;
        } else {
          const input = {model: {provider: 'bfcl', model: config.model}, messages: dittoMessages(request.messages),
            actions: tools.map(t => ({name:t.name,description:t.description,inputSchema:t.inputSchema,target:{kind:'tool',toolName:t.name}})),
            generation: {temperature: config.temperature, maxTokens: config.maxOutputTokens},
            metadata: {method:'SingleLLM',phase:'test',taskId,nodeId:'single/sample'}};
          const result = await runtime.invoke('INFER.REASONING.SAMPLE', input);
          if (result.status !== 'success') throw transportError ?? new Error(result.error?.message ?? 'Ditto inference failed');
          // A cut-off response is not a completed model turn and is resumable as an infrastructure failure.
          if (result.output.finishReason === 'length') throw new Error('Incomplete model output: length');
          if (['error','cancelled'].includes(result.output.finishReason)) throw transportError ?? new Error('Ditto inference did not complete');
          response = bfclResponse(result.output);
          append(cachePath, {signature, response});
        }
        sampleIndex++;
        send({result: response});
      } else if (request.op === 'tools') {
        const results = [];
        for (const call of request.calls) {
          // An unavailable function is a model error, never permission to expose held-out tools.
          if (!activeCalls.some(t => t.name === call.name)) { results.push(`Error during execution: function ${call.name} is not currently available.`); continue; }
          pending.set(call.name + ':' + JSON.stringify(call.arguments), call.source);
          const result = await runtime.invoke('INTERACTION.ACT.TOOL', {call:{id:randomUUID(),name:call.name,arguments:call.arguments}});
          pending.clear();
          if (result.status !== 'success') throw new Error(result.error?.message ?? 'Ditto tool execution failed');
          results.push(result.content);
        }
        send({result: results});
      } else if (request.op === 'checkpoint') {
        atomic(resolve(run, 'responses', taskId + '.json'), {id: taskId, result: request.result, officialStepLimit: request.officialStepLimit});
        send({result: true});
      } else if (request.op === 'done') {
        atomic(resolve(run, 'results', taskId + '.json'), {...request.result, completedAt:new Date().toISOString()});
        rmSync(cachePath, {force:true});
        return request.result;
      } else { throw new Error(request.error ?? 'Unexpected BFCL protocol operation'); }
    }
  } finally { await runtime?.close(); child.stdin.end(); child.kill(); }
}

async function main() {
  const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);
  if (existsSync('.env')) process.loadEnvFile('.env');
  const home = resolve(process.env.BENCHMARK_HOME ?? '../Benchmarks');
  const official = resolve(option('--official', resolve(home, 'collections/official-20260930/BFCL/official/berkeley-function-call-leaderboard')));
  const python = process.env.MFLOW_BFCL_PYTHON ?? resolve(home, 'environments/bfcl/bin/python');
  const run = resolve(option('--run', 'runs/bfcl-single'));
  for (const dir of ['results','responses','checkpoints','requests']) mkdirSync(resolve(run,dir),{recursive:true});
  // Interleave categories to make early progress informative; each category still uses every official task.
  const lists = categories.map(c => readRows(resolve(official,`bfcl_eval/data/BFCL_v4_${c}.json`)).map(r => r.id));
  const ids = Array.from({length:Math.max(...lists.map(x=>x.length))},(_,i)=>lists.map(list=>list[i]).filter(Boolean)).flat();
  if (args.includes('--status')) {console.log(JSON.stringify({...summarize(run,ids),process:existsSync(resolve(run,'status.json'))?JSON.parse(readFileSync(resolve(run,'status.json'),'utf8')):null},null,2));return;}
  const config = {model:process.env.MFLOW_MODEL ?? 'deepseek-flash',temperature:0,maxOutputTokens:393216,timeoutMs:2147483647,seed:42,seedSent:false,providerOptions:{thinking:{type:'disabled'}}};
  const baseUrl = process.env.MFLOW_BASE_URL;
  if (!baseUrl || !process.env.MFLOW_API_KEY) throw new Error('MFLOW_BASE_URL and MFLOW_API_KEY are required');
  const concurrency = Number(option('--concurrency','8'));
  if (!Number.isSafeInteger(concurrency)||concurrency<1) throw new Error('Invalid concurrency');
  const manifest = {protocol:'bfcl-v4-official-multiturn-fc-single-v1',config,baseUrl,ids,
    officialRevision:execFileSync('git',['-C',official,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    officialRuntimeHash:hashFiles(filesBelow(resolve(official,'bfcl_eval')).filter(p=>p.endsWith('.py')||(p.includes('/multi_turn_func_doc/')&&p.endsWith('.json')))),
    adapterHash:hash(['scripts/bfcl_single.mjs','benchmark-hub/bfcl_bridge.py','dist/src/provider-progress.js','dist/src/generation-guidance.js','package-lock.json'].map(p=>readFileSync(p,'utf8'))),
    dataHash:hash(categories.flatMap(c=>[resolve(official,`bfcl_eval/data/BFCL_v4_${c}.json`),resolve(official,`bfcl_eval/data/possible_answer/BFCL_v4_${c}.json`)]).map(p=>readFileSync(p,'utf8')))};
  const manifestPath=resolve(run,'manifest.json');
  if(existsSync(manifestPath)&&JSON.stringify(JSON.parse(readFileSync(manifestPath,'utf8')))!==JSON.stringify(manifest))throw new Error('Frozen BFCL manifest mismatch');
  atomic(manifestPath,manifest);
  const lock=resolve(run,'actor.pid');
  if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));try{process.kill(pid,0);throw new Error(`BFCL already running: ${pid}`);}catch(e){if(e.code!=='ESRCH')throw e;}}
  writeFileSync(lock,String(process.pid));
  let halted=false, completedThisRun=0;
  const limit=Number(option('--pilot-count','0'));
  const todo=ids.filter(id=>!existsSync(resolve(run,'results',id+'.json'))).slice(0,limit||undefined);
  const provider=observableProvider(createHttpProvider({kind:'openai-compatible',baseUrl,apiKey:process.env.MFLOW_API_KEY,
    timeoutMs:config.timeoutMs,fetch:modelFetch,maxTokensField:'max_tokens',providerOptions:config.providerOptions,
    sandbox:new Sandbox(root,{network:[new URL(baseUrl).origin]})}),{stream:true,onProgress:async p=>{
      const path=resolve(run,'requests',p.id+'.json');
      if(['completed','failed'].includes(p.state))rmSync(path,{force:true});else atomic(path,p);
    }});
  const status=(state,extra={})=>atomic(resolve(run,'status.json'),{state,pid:process.pid,concurrency,completedThisRun,...extra,updatedAt:new Date().toISOString()});
  status('running');
  const signals=()=>{halted=true;status('draining');};process.on('SIGTERM',signals);process.on('SIGINT',signals);
  let cursor=0;
  try{
    await Promise.all(Array.from({length:concurrency},async()=>{while(!halted&&cursor<todo.length){const taskId=todo[cursor++];
      try{const row=await runTask({official,python,run,taskId,provider,config});completedThisRun++;console.log(JSON.stringify({id:taskId,score:row.score,at:row.completedAt}));}
      catch(e){halted=true;append(resolve(run,'errors.jsonl'),{taskId,error:String(e),at:new Date().toISOString()});console.error(taskId,String(e));}
      atomic(resolve(run,'summary.json'),summarize(run,ids));status(halted?'draining':'running');
    }}));
    const summary=summarize(run,ids);atomic(resolve(run,'summary.json'),summary);status(halted?'interrupted':summary.completed===ids.length?'completed':'pilot-completed');
    if(halted)process.exitCode=1;
  }finally{rmSync(lock,{force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(String(e));process.exitCode=1;});
