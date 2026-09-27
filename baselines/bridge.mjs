// Official controllers keep their control flow; all model calls use published Ditto.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDitto, createInferWorker, createHttpProvider, createInteractionWorker, createWebSearchTool, graph, Sandbox } from '@codesoul-co/ditto';
const root=resolve(import.meta.dirname,'..');
process.loadEnvFile(resolve(root,'.env'));
const config=JSON.parse(readFileSync(resolve(root,'baselines/protocol.json'),'utf8'));
const out=resolve(root,config.runDirectory);mkdirSync(out,{recursive:true});
const allowed=new Set(['AFlow','DyLAN','AutoAgents','EvoAgent']);
const append=(file,row)=>appendFileSync(resolve(out,file),JSON.stringify(row)+'\n');
const readRows=file=>existsSync(file)?readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
let spent=readRows(resolve(out,'usage.jsonl')).reduce((n,r)=>n+r.charged,0),active=0;
const upstream=createHttpProvider({kind:'openai-compatible',baseUrl:process.env.MFLOW_BASE_URL,apiKey:process.env.MFLOW_API_KEY,timeoutMs:config.providerTimeoutMs,maxTokensField:'max_tokens',providerOptions:{thinking:{type:'disabled'}},sandbox:new Sandbox(root,{network:[new URL(process.env.MFLOW_BASE_URL).origin]})});
const provider={async invoke(input,options){
  const {method,phase,taskId}=input.metadata,id=randomUUID();
  const estimate=Buffer.byteLength(JSON.stringify(input),'utf8')+input.generation.maxTokens+1024;
  append('requests.jsonl',{id,method,phase,taskId,estimate,at:new Date().toISOString()});
  let response;active++;
  try{return response=await upstream.invoke(input,options);}
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
const runtime=createDitto({sandbox:{tools:['web_search'],network:[searchProvider.origin]},workers:[createInferWorker({providers:{baseline:provider},timeoutMs:config.providerTimeoutMs}),createInteractionWorker({tools:[createWebSearchTool({provider:searchProvider})]})]});
const plan=graph('baseline-original-prompt').node('sample','INFER.REASONING.SAMPLE',[],x=>x);
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  try{
    if(req.url==='/status'){res.end(JSON.stringify({spent,active,overallTokenCeiling:null,episodeTokenLimit:null,maxOutputTokens:config.maxOutputTokens,runDirectory:config.runDirectory}));return;}
    if(req.method!=='POST'||!['/sample','/search'].includes(req.url))throw new Error('Unknown endpoint');
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    if(!allowed.has(body.method)||!['pilot','search','test'].includes(body.phase)||typeof body.taskId!=='string')throw new Error('Invalid scope');
    if(req.url==='/search'){
      const result=await runtime.invoke('INTERACTION.ACT.TOOL',{call:{id:randomUUID(),name:'web_search',arguments:{query:body.query,limit:8}}});
      append('search.jsonl',{method:body.method,phase:body.phase,taskId:body.taskId,query:body.query,result,at:new Date().toISOString()});
      if(result.status!=='success')throw new Error(result.error?.message??'Web search failed');
      res.end(JSON.stringify(result.structuredContent));return;
    }
    const input={model:{provider:'baseline',model:config.model},messages:body.messages,generation:{temperature:config.temperature,maxTokens:config.maxOutputTokens},metadata:{method:body.method,phase:body.phase,taskId:body.taskId}};
    const result=await runtime.run(plan,input);
    if(result.sample.status!=='success')throw new Error(result.sample.error?.message??'Ditto sample failed');
    res.end(JSON.stringify(result.sample.output));
  }catch(error){res.statusCode=502;res.end(JSON.stringify({error:String(error)}));}
});
server.requestTimeout=0;server.timeout=0;
server.listen(8197,'127.0.0.1',()=>{
  writeFileSync(resolve(out,'bridge.json'),JSON.stringify({pid:process.pid,port:8197,ditto:'0.1.1',...config},null,2));
  console.log('Unrestricted baseline bridge listening on 127.0.0.1:8197');
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
