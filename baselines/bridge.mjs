// Official controllers keep their control flow; all model calls use published Ditto.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDitto, createInferWorker, createHttpProvider, createInteractionWorker, createWebSearchTool, graph, Sandbox, runReactFlow } from '@codesoul-co/ditto';
import { openAutomation, checkAutomation } from '../dist/src/benchmark-environment.js';
import { benchmarkPath } from '../dist/src/benchmark-hub.js';
import { readTasks } from '../dist/src/data.js';
import { automationInstruction } from '../dist/src/aflow-seed.js';
import { modelFetch, observableProvider } from '../dist/src/provider-progress.js';
import { createPythonTool, pythonImage, pythonExecutor } from '../dist/src/python-tool.js';
const root=resolve(import.meta.dirname,'..');
process.loadEnvFile(resolve(root,'.env'));
const config=JSON.parse(readFileSync(resolve(root,process.env.MFLOW_BASELINE_PROTOCOL??'baselines/protocol.json'),'utf8'));
const out=resolve(root,config.runDirectory);mkdirSync(out,{recursive:true});
const allowed=new Set(['AFlow','DyLAN','AutoAgents','EvoAgent']);
const append=(file,row)=>appendFileSync(resolve(out,file),JSON.stringify(row)+'\n');
const readRows=file=>existsSync(file)?readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
let spent=readRows(resolve(out,'usage.jsonl')).reduce((n,r)=>n+r.charged,0),active=0;
const optimizerFailures=new Map();
const upstream=observableProvider(createHttpProvider({kind:'openai-compatible',baseUrl:process.env.MFLOW_BASE_URL,apiKey:process.env.MFLOW_API_KEY,timeoutMs:config.providerTimeoutMs,fetch:modelFetch,maxTokensField:'max_tokens',providerOptions:config.providerOptions??{thinking:{type:'disabled'}},sandbox:new Sandbox(root,{network:[new URL(process.env.MFLOW_BASE_URL).origin]})}),{stream:true,onProgress:p=>{mkdirSync(resolve(out,'requests'),{recursive:true});writeFileSync(resolve(out,'requests',p.id+'.json'),JSON.stringify(p));}});
const automation=config.benchmark==='automationbench',sessions=new Map(),lookup=new Map();
const image=automation?undefined:await pythonImage(config.aflowPythonImage);
if(automation){await checkAutomation();for(const split of ['search','test'])for(const t of await readTasks(await benchmarkPath('automationbench',split)))lookup.set(t.id,t);}
const port=Number(process.env.MFLOW_BASELINE_PORT??8197);
const scopeKey=b=>JSON.stringify([b.method,b.phase,b.taskId]);
const statePath=b=>resolve(out,b.method,b.phase,'executions',createHash('sha256').update(scopeKey(b)).digest('hex')+'.json');
const staticClass=`class Workflow:
    def __init__(self,name,llm_config,dataset):
        self.llm=create_llm_instance(llm_config)
        self.custom=operator.Custom(self.llm)
        self.sc_ensemble=operator.ScEnsemble(self.llm)
    async def __call__(self,problem):
`;
const staticSeeds=[
  {name:'single',composition:staticClass+`        answer=await self.custom(input=problem,instruction=prompt_custom.EXECUTE)
        return answer['response'],0\n`},
  {name:'plan-execute',composition:staticClass+`        plan=await self.custom(input=problem,instruction=prompt_custom.PLAN)
        answer=await self.custom(input=problem+'\\nDependency plan:\\n'+plan['response'],instruction=prompt_custom.EXECUTE)
        return answer['response'],0\n`},
  {name:'review',composition:staticClass+`        answer=await self.custom(input=problem,instruction=prompt_custom.EXECUTE)
        review=await self.custom(input=problem+'\\nPrevious execution:\\n'+answer['response'],instruction=prompt_custom.REVIEW)
        return review['response'],0\n`},
].map(s=>({...s,organization:{},prompts:'EXECUTE = '+JSON.stringify(automationInstruction)+'\nPLAN = '+JSON.stringify('Plan entity lookups, API dependencies and exact postconditions. Inspect if useful; do not make writes. Return a concise actionable plan.')+'\nREVIEW = '+JSON.stringify('Inspect actual current state against the original task. Repair missing or incorrect effects. Preserve successful writes and never duplicate records or sends.')+'\n'}));
const provider={async invoke(input,options){
  const {method,phase,taskId}=input.metadata,id=randomUUID();
  const estimate=Buffer.byteLength(JSON.stringify(input),'utf8')+input.generation.maxTokens+1024;
  append('requests.jsonl',{id,method,phase,taskId,estimate,at:new Date().toISOString()});
  let response;active++;
  try{return response=await upstream.invoke(input,options);}
  catch(error){if(input.metadata.optimizerCallId)optimizerFailures.set(input.metadata.optimizerCallId,error);throw error;}
  finally{
    active--;
    const u=response?.usage,known=u?.totalTokens??(u?.inputTokens!==undefined&&u?.outputTokens!==undefined?u.inputTokens+u.outputTokens:undefined);
    const charged=known??estimate;spent+=charged;
    append('usage.jsonl',{id,method,phase:`${method}:${phase}`,taskId,charged,usage:u??null,unknownUsage:known===undefined,finishReason:response?.finishReason??'unknown',at:new Date().toISOString()});
    append('responses.jsonl',{id,method,phase,taskId,message:response?.message??null,inputHash:createHash('sha256').update(JSON.stringify(input.messages)).digest('hex')});
  }
}};
const runFile=promisify(execFile);
const searchProvider={origin:'https://duckduckgo.com',async search({query,limit},options){
  const {stdout}=await runFile(resolve(root,'../MFlow-baselines/.venv-legacy/bin/python'),[resolve(root,'baselines/search_provider.py'),query,String(limit)],{signal:options?.signal,maxBuffer:8*1024*1024});
  return JSON.parse(stdout);
}};
const tools=[createWebSearchTool({provider:searchProvider}),...(image?[createPythonTool(image)]:[])];
const runtime=createDitto({...(image?{sandboxExecutor:pythonExecutor()}:{}),sandbox:{execute:!!image,tools:tools.map(t=>t.name),network:[searchProvider.origin]},workers:[createInferWorker({providers:{baseline:provider},timeoutMs:config.providerTimeoutMs}),createInteractionWorker({tools})]});
const plan=graph('baseline-original-prompt').node('sample','INFER.REASONING.SAMPLE',[],x=>x);
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  try{
    if(req.url==='/status'){res.end(JSON.stringify({spent,active,pythonImage:image,overallTokenCeiling:null,episodeTokenLimit:null,maxOutputTokens:config.maxOutputTokens,runDirectory:config.runDirectory}));return;}
    if(req.method!=='POST'||!['/sample','/search','/python','/start','/finish','/bootstrap','/propose','/freeze'].includes(req.url))throw new Error('Unknown endpoint');
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    if(['/bootstrap','/propose','/freeze'].includes(req.url)){
      if(!automation)throw new Error('Static AutomationBench controller only');
      if(req.url==='/bootstrap'){
        res.end(JSON.stringify({mode:'aflow-static',dataset:'AutomationBench',questionType:'API workflow automation',config:{seed:config.seed,maxRounds:null,validationRounds:config.aflow.validationRounds,concurrency:config.concurrency},...staticSeeds[0],seeds:staticSeeds,
          interface:automationInstruction+'\nOptimize a static Python AFlow Workflow using original operator.Custom(self.llm) and operator.ScEnsemble(self.llm). Custom calls have native Ditto API tools. No Programmer, imports, filesystem, eval, subprocess, SDK or network calls in generated code. Plan/rank stages must not write; execution/review stages may use tools. Every workflow shares one fresh task world. Return the Python Workflow class and prompt constants without Markdown. Preserve native single-modification, parent-feedback and experience optimization. No test data is available. Workflow __call__ returns (answer_string,0); actual cost is measured by Ditto.'}));return;
      }
      if(!Number.isSafeInteger(body.round)||body.round<1)throw new Error('Invalid round');
      if(req.url==='/freeze'){
        const files=Object.fromEntries(['graph.py','prompt.py'].map(name=>[name,createHash('sha256').update(readFileSync(resolve(out,'AFlow/workspace/AutomationBench/workflows/round_'+body.round,name))).digest('hex')]));
        writeFileSync(resolve(out,'AFlow/frozen.json'),JSON.stringify({round:body.round,validationScore:body.score,stopReason:body.stopReason,strategy:body.strategy,files,frozenBeforeTest:true},null,2));res.end(JSON.stringify({frozen:true}));return;
      }
      const optimizerCallId=randomUUID();
      const input={model:{provider:'baseline',model:config.model,providerOptions:{response_format:{type:'json_object'}}},messages:[{role:'system',content:'Return JSON with exactly three nonempty string fields: modification, graph, prompt. graph is the complete Python Workflow class; prompt defines Python constants. No Markdown fences.'},{role:'user',content:body.prompt}],generation:{temperature:config.temperature,maxTokens:config.maxOutputTokens},metadata:{method:'AFlow',phase:'search',taskId:'optimizer-round-'+body.round,optimizerCallId}};
      try{
        const result=await runtime.run(plan,input);if(result.sample.status!=='success')throw new Error(result.sample.error?.message??'Optimizer failed');
        const proposal=JSON.parse(result.sample.output.message.content);for(const key of ['modification','graph','prompt'])if(typeof proposal[key]!=='string'||!proposal[key])throw new Error('Invalid static proposal');
        res.end(JSON.stringify(proposal));return;
      }catch(error){const unavailable=optimizerFailures.has(optimizerCallId);res.statusCode=502;res.end(JSON.stringify({error:String(error),fatal:unavailable,unavailable}));return;}
      finally{optimizerFailures.delete(optimizerCallId);}
    }
    if(!allowed.has(body.method)||!['pilot','search','test'].includes(body.phase)||typeof body.taskId!=='string')throw new Error('Invalid scope');
    if(req.url==='/python'){
      if(!image||body.method!=='AFlow')throw new Error('Isolated Python requires the MATH AFlow image');
      const result=await runtime.invoke('INTERACTION.ACT.TOOL',{call:{id:randomUUID(),name:'python',arguments:{code:body.code}}});
      append('tools.jsonl',{method:body.method,phase:body.phase,taskId:body.taskId,code:body.code,result,pythonImage:image,at:new Date().toISOString()});
      res.end(JSON.stringify(result));return;
    }
    if(req.url==='/start'){
      if(!automation)throw new Error('Task worlds require AutomationBench');
      const task=lookup.get(body.benchmarkTaskId),split=body.phase==='test'?'test':'search';
      if(!task||task.dataset.split!==split)throw new Error('Task split mismatch');
      const key=scopeKey(body);if(sessions.has(key))throw new Error('Task already running');
      if(existsSync(statePath(body))){res.end(JSON.stringify({checkpoint:true}));return;}
      const env=await openAutomation(task),local=createDitto({sandbox:{tools:env.tools.map(t=>t.name)},workers:[createInferWorker({providers:{baseline:provider},timeoutMs:config.providerTimeoutMs}),createInteractionWorker({tools:env.tools})]});
      sessions.set(key,{env,runtime:local,tools:env.tools,observations:[]});res.end(JSON.stringify({checkpoint:false}));return;
    }
    if(req.url==='/finish'){
      const path=statePath(body),session=sessions.get(scopeKey(body));
      let checkpoint;
      if(existsSync(path))checkpoint=JSON.parse(readFileSync(path,'utf8'));
      else{if(!session)throw new Error('Missing task world');checkpoint={taskId:body.benchmarkTaskId,...await session.env.request({op:'snapshot'})};mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(checkpoint));const {renameSync}=await import('node:fs');renameSync(path+'.tmp',path);}
      const task=lookup.get(body.benchmarkTaskId);if(!task||checkpoint.taskId!==task.id)throw new Error('Checkpoint task mismatch');
      const env=session?.env??await openAutomation(task);
      try{res.end(JSON.stringify(await env.request({op:'grade',...checkpoint})));}finally{env.close();await session?.runtime.close();sessions.delete(scopeKey(body));}
      return;
    }
    if(req.url==='/search'){
      const session=sessions.get(scopeKey(body));
      const result=automation?await session.runtime.invoke('INTERACTION.ACT.TOOL',{call:{id:randomUUID(),name:'api_search',arguments:{query:body.query,top_k:8}}}):await runtime.invoke('INTERACTION.ACT.TOOL',{call:{id:randomUUID(),name:'web_search',arguments:{query:body.query,limit:8}}});
      append('search.jsonl',{method:body.method,phase:body.phase,taskId:body.taskId,query:body.query,result,at:new Date().toISOString()});
      if(result.status!=='success')throw new Error(result.error?.message??'Web search failed');
      res.end(JSON.stringify(automation?{results:result.content}:result.structuredContent));return;
    }
    const input={model:{provider:'baseline',model:config.model},messages:body.messages,generation:{temperature:config.temperature,maxTokens:config.maxOutputTokens},metadata:{method:body.method,phase:body.phase,taskId:body.taskId}};
    const session=sessions.get(scopeKey(body));
    if(automation&&body.tools!==false&&!session)throw new Error('Start the task before execution');
    if(session&&body.tools!==false){
      input.messages=[{role:'system',content:automationInstruction+'\nRespect the current framework stage: planning, ranking, role design and retention checks should produce their required format without writes. Execution/refinement stages may execute and repair. Shared preceding API observations:\n'+JSON.stringify(session.observations)},...input.messages];
      input.actions=session.tools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema,target:{kind:'tool',toolName:t.name}}));
      input.constraints={maxSteps:Number.MAX_SAFE_INTEGER,maxActionCalls:Number.MAX_SAFE_INTEGER,maxTotalTokens:Number.MAX_SAFE_INTEGER,timeoutMs:config.providerTimeoutMs};
      const result=await runReactFlow(session.runtime,input,{timeoutMs:config.providerTimeoutMs});
      session.observations.push(...result.observations);
      if(result.status!=='completed')throw new Error('Incomplete Ditto tool loop: '+JSON.stringify({stopReason:result.stopReason,error:result.error}));
      res.end(JSON.stringify({message:result.result,finishReason:'stop'}));return;
    }
    const result=await runtime.run(plan,input);
    if(result.sample.status!=='success')throw new Error(result.sample.error?.message??'Ditto sample failed');
    res.end(JSON.stringify(result.sample.output));
  }catch(error){res.statusCode=502;res.end(JSON.stringify({error:String(error)}));}
});
server.requestTimeout=0;server.timeout=0;
server.listen(port,'127.0.0.1',()=>{
  writeFileSync(resolve(out,'bridge.json'),JSON.stringify({pid:process.pid,port,ditto:'0.1.1',pythonImage:image,...config},null,2));
  console.log(`Baseline bridge listening on 127.0.0.1:${port}`);
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
