// Official controllers keep their control flow; all model calls use published Ditto.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createDitto, createInferWorker, createHttpProvider, createInteractionWorker, graph, Sandbox, runReactFlow } from '@codesoul-co/ditto';
import { openAutomation, checkAutomation } from '../dist/src/benchmark-environment.js';
import { benchmarkPath } from '../dist/src/benchmark-hub.js';
import { readTasks, actorInput, withTaskImages } from '../dist/src/data.js';
import { automationInstruction, hleInstruction } from '../dist/src/aflow-seed.js';
import { modelFetch, observableProvider, ProviderFailure } from '../dist/src/provider-progress.js';
import { createPythonTool, pythonImage, pythonExecutor, createBenchmarkWebTool } from '../dist/src/python-tool.js';
import { DittoAgents, MeteredProvider, arithmeticTool } from '../dist/src/ditto.js';
import { gradeHLE } from '../dist/src/hle-grading.js';
const root=resolve(import.meta.dirname,'..');
process.loadEnvFile(resolve(root,'.env'));
const config=JSON.parse(readFileSync(resolve(root,process.env.MFLOW_BASELINE_PROTOCOL??'baselines/protocol.json'),'utf8'));
const out=resolve(root,config.runDirectory);mkdirSync(out,{recursive:true});
const allowed=new Set(['AFlow','DyLAN','AutoAgents','EvoAgent']);
const append=(file,row)=>appendFileSync(resolve(out,file),JSON.stringify(row)+'\n');
const readRows=file=>existsSync(file)?readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
let spent=readRows(resolve(out,'usage.jsonl')).reduce((n,r)=>n+r.charged,0),active=0;
const optimizerFailures=new Map();
const upstream=observableProvider(createHttpProvider({kind:'openai-compatible',baseUrl:process.env.MFLOW_BASE_URL,apiKey:process.env.MFLOW_API_KEY,timeoutMs:config.providerTimeoutMs,idleTimeoutMs:process.env.MFLOW_PROVIDER_IDLE_TIMEOUT_MS?Number(process.env.MFLOW_PROVIDER_IDLE_TIMEOUT_MS):undefined,fetch:modelFetch,maxTokensField:'max_tokens',providerOptions:config.providerOptions??{thinking:{type:'disabled'}},sandbox:new Sandbox(root,{network:[new URL(process.env.MFLOW_BASE_URL).origin]})}),{stream:true,onProgress:p=>{const path=resolve(out,'requests',p.id+'.json');if(p.state==='completed'){rmSync(path,{force:true});return;}mkdirSync(resolve(out,'requests'),{recursive:true});writeFileSync(path,JSON.stringify(p));}});
const automation=config.benchmark==='automationbench',hle=config.benchmark==='hle',dataset=hle?'HLE':'AutomationBench',instruction=hle?hleInstruction:automationInstruction,sessions=new Map(),lookup=new Map();
const image=automation?undefined:await pythonImage(config.aflowPythonImage);
if(hle)process.env.MFLOW_HLE_PROTOCOL=config.datasetProtocol;
if(automation)await checkAutomation();
if(automation||hle)for(const split of ['search','test'])for(const t of await readTasks(await benchmarkPath(config.benchmark,split)))lookup.set(t.id,t);
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
].map(s=>({...s,organization:{},prompts:'EXECUTE = '+JSON.stringify(instruction)+'\nPLAN = '+JSON.stringify(hle?'[PLAN ONLY] Select subject-specific methods, exact assumptions and decisive checks for the academic question. Do not guess its answer.':'[PLAN ONLY] Plan entity lookups, API dependencies and exact postconditions. Inspect if useful; do not make writes. Return a concise actionable plan.')+'\nREVIEW = '+JSON.stringify(hle?'Check the candidate against the original question and image. Diagnose the decisive error or uncertainty; use a complementary method or external evidence if useful. Return Explanation, Answer and calibrated Confidence.':'Inspect actual current state against the original task. Repair missing or incorrect effects. Preserve successful writes and never duplicate records or sends.')+'\n'}));
const ledgerProvider={async invoke(input,options){
  const {method,phase,taskId,kind}=input.metadata,id=randomUUID();
  const estimate=Buffer.byteLength(JSON.stringify(input),'utf8')+input.generation.maxTokens+1024;
  append('requests.jsonl',{id,method,phase,taskId,estimate,at:new Date().toISOString()});
  let response;active++;
  try{return response=await upstream.invoke(input,options);}
  catch(error){if(input.metadata.optimizerCallId)optimizerFailures.set(input.metadata.optimizerCallId,error);throw error;}
  finally{
    active--;
    const u=response?.usage,known=u?.totalTokens??(u?.inputTokens!==undefined&&u?.outputTokens!==undefined?u.inputTokens+u.outputTokens:undefined);
    const charged=known??estimate;spent+=charged;
    append('usage.jsonl',{id,method,kind,phase:`${method}:${phase}`,taskId,charged,usage:u??null,unknownUsage:known===undefined,finishReason:response?.finishReason??'unknown',at:new Date().toISOString()});
    append('responses.jsonl',{id,method,phase,taskId,outputHash:createHash('sha256').update(JSON.stringify(response?.message??null)).digest('hex'),inputHash:createHash('sha256').update(JSON.stringify(input.messages)).digest('hex')});
  }
}};
// Reuse MFlow's transient retry policy; each attempt still settles in the ledger.
const provider={async invoke(input,options){
  const result=await new MeteredProvider(ledgerProvider).invoke(input,options);
  if(input.metadata.optimizerCallId)optimizerFailures.delete(input.metadata.optimizerCallId);
  return result;
}};
const tools=[createBenchmarkWebTool(),...(image?[arithmeticTool,createPythonTool(image)]:[])];
const runtime=createDitto({...(image?{sandboxExecutor:pythonExecutor()}:{}),sandbox:{execute:!!image,tools:tools.map(t=>t.name),network:['https://www.bing.com']},workers:[createInferWorker({providers:{baseline:provider},timeoutMs:config.providerTimeoutMs}),createInteractionWorker({tools})]});
const plan=graph('baseline-original-prompt').node('sample','INFER.REASONING.SAMPLE',[],x=>x);
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  try{
    if(req.url==='/status'){res.end(JSON.stringify({spent,active,pythonImage:image,overallTokenCeiling:null,episodeTokenLimit:null,maxOutputTokens:config.maxOutputTokens,runDirectory:config.runDirectory}));return;}
    if(req.method!=='POST'||!['/sample','/search','/python','/start','/finish','/bootstrap','/propose','/freeze','/checkpoint-round','/reset-method'].includes(req.url))throw new Error('Unknown endpoint');
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    if(req.url==='/reset-method'){
      if(!allowed.has(body.method))throw new Error('Invalid method');
      let released=0;
      for(const [key,session] of sessions)if(JSON.parse(key)[0]===body.method &&
          (body.phase===undefined||JSON.parse(key)[1]===body.phase) &&
          (body.taskPrefix===undefined||JSON.parse(key)[2].startsWith(body.taskPrefix))){
        await session.runtime.close();session.env?.close();sessions.delete(key);released++;
      }
      res.end(JSON.stringify({released}));return;
    }
    if(['/bootstrap','/propose','/freeze','/checkpoint-round'].includes(req.url)){
      if(!automation&&!hle)throw new Error('Static benchmark controller unavailable');
      if(req.url==='/bootstrap'){
        res.end(JSON.stringify({mode:'aflow-static',dataset,questionType:hle?'expert academic reasoning with question images':'API workflow automation',config:{seed:config.seed,maxRounds:null,validationRounds:config.aflow.validationRounds,concurrency:config.concurrency},...staticSeeds[0],seeds:staticSeeds,
          interface:instruction+'\nOptimize a static Python AFlow Workflow using original operator.Custom(self.llm) and operator.ScEnsemble(self.llm). Custom calls have the same native Ditto tools as every compared actor. Programmer may be used only for HLE; its code runs through public Ditto isolated Python. No imports, filesystem, eval, subprocess, SDK or network calls in generated Workflow code. ScEnsemble ranks without tools. Prefix Custom planning-only instructions with [PLAN ONLY] to disable tools in that call; solution/review stages may use tools. Question images are supplied automatically to actor calls. Return the Python Workflow class and prompt constants without Markdown. Preserve native single-modification, parent-feedback and experience optimization. No test data is available. Operator interfaces: await Custom(input, instruction) returns {response:string}; await ScEnsemble(solutions:list[str], problem:str) returns {response:string}; HLE-only await Programmer(problem, analysis) returns {code:string,output:string}. Workflow __call__ returns (answer_string,0); actual cost is measured by Ditto.'}));return;
      }
      if(!Number.isSafeInteger(body.round)||body.round<1)throw new Error('Invalid round');
      if(req.url==='/freeze'||req.url==='/checkpoint-round'){
        const files=Object.fromEntries(['graph.py','prompt.py'].map(name=>[name,createHash('sha256').update(readFileSync(resolve(out,'AFlow/workspace/'+dataset+'/workflows/round_'+body.round,name))).digest('hex')]));
        const path=resolve(out,'AFlow',req.url==='/freeze'?'frozen.json':`round-candidates/round-${body.round}.json`);
        mkdirSync(resolve(path,'..'),{recursive:true});
        writeFileSync(path+'.tmp',JSON.stringify({round:body.round,validationScore:body.score,stopReason:body.stopReason,strategy:body.strategy,files,frozenBeforeTest:true},null,2));
        const {renameSync}=await import('node:fs');renameSync(path+'.tmp',path);
        res.end(JSON.stringify({frozen:true}));return;
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
      if(!image||body.method!=='AFlow')throw new Error('Isolated Python requires a pinned AFlow image');
      const result=await runtime.invoke('INTERACTION.ACT.TOOL',{call:{id:randomUUID(),name:'python',arguments:{code:body.code}}});
      append('tools.jsonl',{method:body.method,phase:body.phase,taskId:body.taskId,code:body.code,result,pythonImage:image,at:new Date().toISOString()});
      res.end(JSON.stringify(result));return;
    }
    if(req.url==='/start'){
      if(!automation&&!hle)throw new Error('Benchmark task sessions unavailable');
      const task=lookup.get(body.benchmarkTaskId),split=body.phase==='test'?'test':'search';
      if(!task||task.dataset.split!==split)throw new Error('Task split mismatch');
      const key=scopeKey(body);
      if(existsSync(statePath(body))){const checkpoint=JSON.parse(readFileSync(statePath(body),'utf8'));if(checkpoint.taskId!==task.id)throw new Error('Checkpoint task mismatch');res.end(JSON.stringify({checkpoint:true,answer:checkpoint.answer??''}));return;}
      if(sessions.has(key))throw new Error('Task already running');
      if(hle){const input=await actorInput(task),scopedTools=tools.map(t=>t.name==='web_search'?createBenchmarkWebTool(input):t),local=createDitto({sandboxExecutor:pythonExecutor(),sandbox:{execute:true,tools:scopedTools.map(t=>t.name),network:['https://www.bing.com']},workers:[createInferWorker({providers:{baseline:provider},timeoutMs:config.providerTimeoutMs}),createInteractionWorker({tools:scopedTools})]});sessions.set(key,{task,input,runtime:local,tools:scopedTools,observations:[]});res.end(JSON.stringify({checkpoint:false}));return;}
      const env=await openAutomation(task),local=createDitto({sandbox:{tools:env.tools.map(t=>t.name)},workers:[createInferWorker({providers:{baseline:provider},timeoutMs:config.providerTimeoutMs}),createInteractionWorker({tools:env.tools})]});
      sessions.set(key,{env,runtime:local,tools:env.tools,observations:[]});res.end(JSON.stringify({checkpoint:false}));return;
    }
    if(req.url==='/finish'){
      const path=statePath(body),session=sessions.get(scopeKey(body));
      let checkpoint;
      if(existsSync(path))checkpoint=JSON.parse(readFileSync(path,'utf8'));
      else{if(!session)throw new Error('Missing task session');if(hle&&typeof body.answer!=='string')throw new Error('HLE needs the completed actor answer');checkpoint={taskId:body.benchmarkTaskId,...(hle?{answer:body.answer}:await session.env.request({op:'snapshot'}))};mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(checkpoint));const {renameSync}=await import('node:fs');renameSync(path+'.tmp',path);}
      const task=lookup.get(body.benchmarkTaskId);if(!task||checkpoint.taskId!==task.id)throw new Error('Checkpoint task mismatch');
      if(hle){
        if(!checkpoint.grade){
          const scoped={invoke(input,options){return ledgerProvider.invoke({...input,metadata:{...input.metadata,method:body.method,phase:body.phase,taskId:body.taskId}},options);}};
          const agents=new DittoAgents(new MeteredProvider(scoped),{model:config.model,baseUrl:process.env.MFLOW_BASE_URL,temperature:config.temperature,seed:config.seed},[]);
          const graded=await gradeHLE(task,checkpoint.answer,agents);checkpoint.grade={...graded,partialCredit:graded.score};
          writeFileSync(path+'.tmp',JSON.stringify(checkpoint));const {renameSync}=await import('node:fs');renameSync(path+'.tmp',path);
        }
        await session?.runtime.close();sessions.delete(scopeKey(body));res.end(JSON.stringify(checkpoint.grade));return;
      }
      const env=session?.env??await openAutomation(task);
      try{res.end(JSON.stringify(await env.request({op:'grade',...checkpoint})));}finally{env.close();await session?.runtime.close();sessions.delete(scopeKey(body));}
      return;
    }
    if(req.url==='/search'){
      const session=sessions.get(scopeKey(body));
      const result=automation?await session.runtime.invoke('INTERACTION.ACT.TOOL',{call:{id:randomUUID(),name:'api_search',arguments:{query:body.query,top_k:8}}}):await (hle?session.runtime:runtime).invoke('INTERACTION.ACT.TOOL',{call:{id:randomUUID(),name:'web_search',arguments:{query:body.query,limit:8}}});
      append('search.jsonl',{method:body.method,phase:body.phase,taskId:body.taskId,query:body.query,result,at:new Date().toISOString()});
      if(result.status!=='success')throw new ProviderFailure('MODEL_TOOL_ERROR',result.error?.message??'Web search failed');
      res.end(JSON.stringify(automation?{results:result.content}:result.structuredContent));return;
    }
    const input={model:{provider:'baseline',model:config.model},messages:body.messages,generation:{temperature:config.temperature,maxTokens:config.maxOutputTokens},metadata:{method:body.method,phase:body.phase,taskId:body.taskId}};
    const session=sessions.get(scopeKey(body));
    if(hle)input.messages=withTaskImages(input.messages,session?.input);
    if(session&&body.tools===false)input.messages=[{role:'system',content:instruction+'\nThis is a control/design stage. Do not execute actions or claim new effects. Preserve the requested control schema instead of the final-answer format. Design complementary task-specific roles using the capabilities listed above.'},...input.messages];
    if((automation||hle)&&body.tools!==false&&!session)throw new Error('Start the task before execution');
    if(session&&body.tools!==false){
      input.messages=[{role:'system',content:instruction+'\nRespect the current framework stage: planning, ranking, role design and retention checks should produce their required format without writes. Execution/refinement stages may execute and repair. Shared preceding tool observations:\n'+JSON.stringify(session.observations)},...input.messages];
      input.actions=session.tools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema,target:{kind:'tool',toolName:t.name}}));
      input.constraints={maxSteps:Number.MAX_SAFE_INTEGER,maxActionCalls:Number.MAX_SAFE_INTEGER,maxTotalTokens:Number.MAX_SAFE_INTEGER,timeoutMs:config.providerTimeoutMs};
      const result=await runReactFlow(session.runtime,input,{timeoutMs:config.providerTimeoutMs});
      session.observations.push(...result.observations);
      if(result.status!=='completed')throw new ProviderFailure(result.stopReason==='max_tokens'?'INCOMPLETE_MODEL_OUTPUT':(result.error?.code??'MODEL_TOOL_ERROR'),'Incomplete Ditto tool loop: '+JSON.stringify({stopReason:result.stopReason,error:result.error}));
      res.end(JSON.stringify({message:result.result,finishReason:'stop'}));return;
    }
    const result=await runtime.run(plan,input);
    if(result.sample.status!=='success')throw new ProviderFailure(result.sample.error?.code??'INVALID_MODEL_OUTPUT',result.sample.error?.message??'Ditto sample failed');
    res.end(JSON.stringify(result.sample.output));
  }catch(error){res.statusCode=502;res.end(JSON.stringify({error:String(error)}));}
});
server.requestTimeout=0;server.timeout=0;
server.listen(port,'127.0.0.1',()=>{
  writeFileSync(resolve(out,'bridge.json'),JSON.stringify({pid:process.pid,port:server.address().port,ditto:'0.1.2',pythonImage:image,...config},null,2));
  console.log(`Baseline bridge listening on 127.0.0.1:${port}`);
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
