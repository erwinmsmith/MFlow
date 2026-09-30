import test from 'node:test';
import { stat, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readTasks, assertDisjoint, assertDatasetRole, actorInput } from '../src/data.js';
import { taskSchema, initialStrategy, limitsSchema } from '../src/types.js';
import { benchmarkSeed, benchmarkSeeds } from '../src/aflow-seed.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { executeBenchmark, openAutomation, automationTools } from '../src/benchmark-environment.js';
import { grade } from '../src/grading.js';
import { pythonImage } from '../src/python-tool.js';
import { benchmarkPath, benchmarkHome, sharedPath } from '../src/benchmark-hub.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { validateComposition } from '../src/composition.js';

const hleTools=['arithmetic','python','web_search'].map(name=>({name,description:'Offline fixture',inputSchema:{type:'object',properties:{}},effects:['read'] as ['read'],validate:()=>{},execute:async()=>{throw new Error('No tool request expected in fixture');}}));
const model = { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 };

test('multiple MAS roots preserve distinct graphs; a factory creates an executable agent outside the library', async () => {
  const seeds = benchmarkSeeds([{benchmark:'automationbench',metric:'automationbench'}]);
  assert.deepEqual(seeds.map(s=>s.name),['single','review','plan-execute','parallel-plan','adaptive']);
  for(const seed of seeds)validateComposition(seed.composition);
  assert.equal(seeds[2].organization.initialAgents.length,2);
  const seed=seeds[4],template=seed.organization.agentTemplates![0];
  const profile={id:'new-api-specialist',...template.profile,private_context:'NEW-CAPABILITY-MARKER'};
  const program=template.composition.replace("id+'/sample'", "id+'/new-specialist-node'");
  let n=0;
  const agents=new DittoAgents(new MeteredProvider({async invoke(input){
    n++;const factory=input.metadata?.nodeId==='root/factory';
    if(!factory)assert.ok(JSON.stringify(input.messages).includes('NEW-CAPABILITY-MARKER'));
    return {message:{role:'assistant',content:factory?JSON.stringify({profile,composition:program}):'Task completed by new program'},finishReason:'stop',usage:{totalTokens:10}};
  }}),model,automationTools.map(name=>({name,description:'Offline fixture',inputSchema:{type:'object',properties:{}},effects:['read'] as ['read'],validate:()=>{},execute:async()=>({status:'success' as const,content:''})})));
  const before=JSON.stringify(seed.organization);
  const runtime=new OrganizationRuntime(agents,limitsSchema.parse({maxTokens:100000}));
  const result=await runtime.run({...initialStrategy,...seed},{id:'isolated-task',prompt:'A public workflow request'});
  assert.equal(result.answer,'Task completed by new program');assert.equal(n,2);
  assert.ok(result.orchestration!.lifecycle.some(e=>e.action==='RUN_PROGRAM'&&e.agentId===profile.id));
  assert.ok(result.orchestration!.graphs.some(g=>g.nodes.some(node=>node.id===profile.id+'/new-specialist-node')));
  assert.equal(result.orchestration!.programs![0].composition,program);
  assert.equal(JSON.stringify(seed.organization),before);
  await assert.rejects(runtime.run({...initialStrategy,...seed,composition:`return loop({id:'unsafe',plan:function*(ctx){ctx.spawn(${JSON.stringify(profile)},'root','return process.env;');return '';}});`},{id:'invalid',prompt:'Public request'}),/process is not defined/);
});

test('HLE remains test-only and grading references enter only the Ditto judge', async () => {
  const task = taskSchema.parse({ id: 'hle:fixture', prompt: 'An academic question', answer: 'GRADER_ONLY_REFERENCE',
    metric: 'hle', benchmark: 'hle', dataset: { protocol: 'hle-text-test-v1', split: 'test' } });
  assert.throws(() => assertDatasetRole([task], 'search'));
  assert.throws(() => assertDatasetRole([task], 'prepare'));
  assert.throws(() => taskSchema.parse({ ...task, dataset: { ...task.dataset, split: 'search' } }));
  const seed = benchmarkSeed([task]), calls: string[] = [];
  const provider = new MeteredProvider({ async invoke(input) {
    const text = JSON.stringify(input); calls.push(text);
    const judging = input.metadata?.kind === 'hle-judge';
    return { message: { role: 'assistant', content: judging ? JSON.stringify({
      extracted_final_answer: 'candidate', reasoning: 'Fixture judgement', correct: 'no', confidence: 60, strict: true,
    }) : 'Explanation: fixture\nAnswer: candidate\nConfidence: 60%' }, finishReason: 'stop', usage: {totalTokens: 10} };
  } });
  const agents = new DittoAgents(provider, model, hleTools);
  const execution = await executeBenchmark(task, agents, { ...initialStrategy, ...seed }, limitsSchema.parse({maxTokens: 100000}));
  assert.ok(calls.every(c => !c.includes(task.answer)));
  const previous = process.env.MFLOW_HLE_JUDGE_MODEL;
  process.env.MFLOW_HLE_JUDGE_MODEL = 'fixture-judge';
  try {
    const result = await grade(task, execution.answer, execution, agents);
    assert.equal(result.score, 0); assert.equal(result.confidence, 60);
    assert.ok(calls.at(-1)!.includes(task.answer)); assert.ok(calls.at(-1)!.includes('fixture-judge'));
    assert.equal(provider.tokens, 30);
  } finally { if (previous === undefined) delete process.env.MFLOW_HLE_JUDGE_MODEL; else process.env.MFLOW_HLE_JUDGE_MODEL = previous; }
});

test('official shared views are locked, disjoint, and HLE has no search view', async t => {
  let search, heldout, hle;
  try { search = await readTasks('benchmark:automationbench/search'); heldout = await readTasks('benchmark:automationbench/test'); hle = await readTasks('benchmark:hle/test'); }
  catch (e) { t.skip(`Local assets unavailable: ${String(e)}`); return; }
  assert.equal(search.length, 200); assert.equal(heldout.length, 600); assert.equal(hle.length, 2158);
  assertDisjoint(search, heldout);
  await assert.rejects(benchmarkPath('hle', 'search'), /no search split/);
});

test('Ditto registered API tools mutate one official world, whose saved checkpoint can be regraded', async t => {
  let tasks;
  try { tasks = await readTasks('benchmark:automationbench/search'); }
  catch (e) { t.skip(`Local official assets unavailable: ${String(e)}`); return; }
  const task = tasks.find(t => t.reference?.automationTaskId === 'simple.email_sf_contact_phone_update')!;
  const seed = benchmarkSeed([task]); let n = 0;
  const calls: string[] = [];
  const provider = new MeteredProvider({ async invoke(input) {
    calls.push(JSON.stringify(input)); n++;
    const action = n === 1 ? { id: 'discover', name: 'api_search', arguments: {query: 'salesforce contacts update', top_k: 1} }
      : n === 2 ? { id: 'update', name: 'api_fetch', arguments: {method: 'PATCH',
        url: 'https://yourinstance.salesforce.com/services/data/v61.0/sobjects/Contact/003001', params: null,
        body: JSON.stringify({Phone: '+1-555-0101'})} } : undefined;
    return { message: {role: 'assistant', content: action ? '' : 'Updated the contact.'}, finishReason: action ? 'action_request' : 'stop',
      ...(action ? {actionRequests: [action]} : {}), usage: {totalTokens: 10} };
  } });
  const execution = await executeBenchmark(task, new DittoAgents(provider, model), { ...initialStrategy, ...seed }, limitsSchema.parse({maxTokens: 100000, maxToolCalls: 10}));
  assert.ok(execution.toolEvents.length >= 2);
  assert.ok(calls.every(c => !c.includes('initial_state') && !c.includes('assertions')));
  const restored = JSON.parse(JSON.stringify(execution));
  const result = await grade(task, execution.answer, restored);
  assert.equal(result.score, 1); assert.equal(result.partialCredit, 1);
  await assert.rejects(grade(task, 'I completed it'), /saved world checkpoint/);
  const fresh = await openAutomation(task);
  try {
    const snapshot = await fresh.request<{contract: string; world: unknown}>({op: 'snapshot'});
    const untouched = await fresh.request<{score: number}>({op: 'grade', ...snapshot});
    assert.equal(untouched.score, 0);
  } finally { fresh.close(); }
  const [one,two]=await Promise.all([openAutomation(task),openAutomation(task)]);
  try {
    await one.tools.find(t=>t.name==='api_fetch')!.execute({method:'PATCH',url:'https://yourinstance.salesforce.com/services/data/v61.0/sobjects/Contact/003001',params:null,body:JSON.stringify({Phone:'+1-555-0101'})},{} as never);
    const [a,b]=await Promise.all([one.request<{contract:string;world:unknown}>({op:'snapshot'}),two.request<{contract:string;world:unknown}>({op:'snapshot'})]);
    assert.equal((await one.request<{score:number}>({op:'grade',...a})).score,1);
    assert.equal((await two.request<{score:number}>({op:'grade',...b})).score,0);
  } finally {one.close();two.close();}
});

test('full HLE holdout is disjoint; question images reach newly derived native agents without labels or bloated logs', async t => {
  const previous=process.env.MFLOW_HLE_PROTOCOL;process.env.MFLOW_HLE_PROTOCOL='hle-full-holdout-v1';
  try {
    let search,heldout;
    try {search=await readTasks('benchmark:hle/search');heldout=await readTasks('benchmark:hle/test');}
    catch(error){t.skip(`Local HLE assets unavailable: ${String(error)}`);return;}
    assert.equal(search.length,200);assert.equal(heldout.length,2300);assertDisjoint(search,heldout);
    assert.equal(search.filter(t=>t.images?.length).length,28);
    assert.equal(heldout.filter(t=>t.images?.length).length,314);
    assertDatasetRole(search,'search');assert.throws(()=>assertDatasetRole(heldout,'search'));
    const images=await Promise.all(search.filter(t=>t.images?.length).map(async task=>({task,size:(await stat(sharedPath(benchmarkHome(),task.images![0].path))).size})));
    const task={...images.sort((a,b)=>b.size-a.size)[0].task,answer:'GRADER_ONLY_IMAGE_REFERENCE'};
    const input=await actorInput(task);assert.deepEqual(Object.keys(input).sort(),['id','imageParts','images','prompt']);
    const seeds=benchmarkSeeds([task]);assert.equal(seeds.length,5);for(const seed of seeds)validateComposition(seed.composition);
    const seed=seeds[4],template=seed.organization.agentTemplates![0];
    const profile={id:'subject-specialist',...template.profile};let calls=0;
    const agents=new DittoAgents(new MeteredProvider({async invoke(request){
      calls++;const parts=request.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]);
      assert.deepEqual(parts.filter(p=>typeof p==='object'&&p!==null&&'type' in p&&p.type==='image_url'),input.imageParts);
      assert.ok(!JSON.stringify(request.messages).includes(task.answer));
      const factory=request.metadata?.nodeId==='root/factory';
      return {message:{role:'assistant',content:factory?JSON.stringify({profile,composition:template.composition}):'Explanation: fixture only\nAnswer: candidate\nConfidence: 20%'},finishReason:'stop',usage:{totalTokens:10}};
    }}),model,hleTools);
    const execution=await new OrganizationRuntime(agents,limitsSchema.parse({maxTokens:Number.MAX_SAFE_INTEGER})).run({...initialStrategy,...seed},input);
    assert.equal(calls,2);assert.ok(execution.agents.some(a=>a.id===profile.id));
    const log=JSON.stringify(execution);assert.ok(log.includes('benchmark-asset:'));assert.ok(!log.includes(input.imageParts![0].image_url.url));
    const altered={...task,images:task.images!.map(i=>({...i,sha256:'0'.repeat(64)}))};
    await assert.rejects(actorInput(altered),/checksum mismatch/);
    assert.throws(()=>taskSchema.parse({...task,dataset:{protocol:'hle-full-test-v1',split:'search'}}));
  } finally {if(previous===undefined)delete process.env.MFLOW_HLE_PROTOCOL;else process.env.MFLOW_HLE_PROTOCOL=previous;}
});

test('HLE baseline public bridge carries images and checkpoints actor/judge results without repeated calls', async t => {
  const previous=process.env.MFLOW_HLE_PROTOCOL;process.env.MFLOW_HLE_PROTOCOL='hle-full-holdout-v1';
  let tasks;
  try {tasks=await readTasks('benchmark:hle/search');}
  catch(error){t.skip(`Local HLE assets unavailable: ${String(error)}`);return;}
  finally {if(previous===undefined)delete process.env.MFLOW_HLE_PROTOCOL;else process.env.MFLOW_HLE_PROTOCOL=previous;}
  try {await pythonImage();}catch(error){t.skip(`Local Docker image unavailable: ${String(error)}`);return;}
  const task=tasks.find(t=>t.images?.length)!,calls:Record<string,any>[]=[];
  const mock=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls.push(body);
    const content=body.model==='fixture-judge'?JSON.stringify({extracted_final_answer:'candidate',reasoning:'Offline fixture',correct:'no',confidence:20,strict:true}):'Explanation: fixture\nAnswer: candidate\nConfidence: 20%';
    res.setHeader('Content-Type','text/event-stream');
    res.end('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(r=>mock.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'mflow-hle-bridge-')),out=join(dir,'out');
  const config=JSON.parse(await readFile('configs/hle-baselines.json','utf8'));
  await writeFile(join(dir,'protocol.json'),JSON.stringify({...config,runDirectory:out,model:'fixture-actor'}));
  const child=spawn(process.execPath,['baselines/bridge.mjs'],{cwd:resolve('.'),env:{...process.env,
    MFLOW_BASELINE_PROTOCOL:join(dir,'protocol.json'),MFLOW_BASELINE_PORT:'0',MFLOW_BASE_URL:`http://127.0.0.1:${(mock.address() as {port:number}).port}`,
    MFLOW_API_KEY:'fixture',MFLOW_HLE_JUDGE_MODEL:'fixture-judge',BENCHMARK_HOME:benchmarkHome()}});
  let errors='';child.stderr.on('data',c=>errors+=c);child.stdout.resume();
  try {
    let address='';
    for(let i=0;i<100;i++){
      try {const state=JSON.parse(await readFile(join(out,'bridge.json'),'utf8'));address=`http://127.0.0.1:${state.port}`;break;}
      catch {if(child.exitCode!==null)throw new Error(errors);await new Promise(r=>setTimeout(r,50));}
    }
    assert.ok(address,'Bridge did not become ready');
    const scope={method:'DyLAN',phase:'search',taskId:'fixture-image',benchmarkTaskId:task.id};
    const rpc=async(route:string,extra:Record<string,unknown>={})=>{
      const response=await fetch(address+'/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,...extra})});
      const result=await response.json() as Record<string,any>;assert.equal(response.status,200,JSON.stringify(result));return result;
    };
    assert.equal((await rpc('start')).checkpoint,false);
    const answer=(await rpc('sample',{messages:[{role:'user',content:task.prompt}]})).message.content;
    assert.equal((await rpc('finish',{answer})).score,0);
    assert.equal(calls.length,2);
    assert.ok(calls[0].messages.some((m:any)=>Array.isArray(m.content)&&m.content.some((p:any)=>p.type==='image_url')));
    assert.ok(calls[1].messages.every((m:any)=>typeof m.content==='string'));
    assert.equal((await rpc('start')).answer,answer);
    await rpc('finish',{answer});assert.equal(calls.length,2);
    const ledger=(await readFile(join(out,'usage.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(ledger.filter(r=>r.kind==='hle-judge').length,1);assert.ok(ledger.every(r=>!r.unknownUsage));
  } finally {child.kill();await new Promise<void>(r=>child.exitCode!==null?r():child.once('exit',()=>r()));await new Promise<void>(r=>mock.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
