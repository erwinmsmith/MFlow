// Original baseline controllers use this local transport; inference and budgets are Ditto public APIs.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDitto, createInferWorker, createHttpProvider, graph, Sandbox, TokenBudget } from '@codesoul-co/ditto';
const root=resolve(import.meta.dirname,'..');
process.loadEnvFile(resolve(root,'.env'));
const out=resolve(root,'runs/baselines-math'); mkdirSync(out,{recursive:true});
const log=resolve(out,'usage.jsonl'), mf=resolve(root,'runs/math-search-v2-20260927-02/test');
const prior=3543561, budget=new TokenBudget(30000000-prior), episodes=new Map(), phases=new Map();
const allowed=new Set(['AFlow','DyLAN','AutoAgents','EvoAgent']);
// Optimizer prompts are search-level work, not one benchmark episode.
const episodeLimit=(method,phase,taskId)=>method==='AFlow'&&phase==='search'&&taskId.startsWith('optimizer-round-')?2280742:24000;
function append(file, value) { appendFileSync(resolve(out,file),JSON.stringify(value)+'\n'); }
function scopeBudget(map,key,limit) { if(!map.has(key)) map.set(key,new TokenBudget(limit)); return map.get(key); }
const previous=existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
for(const r of previous) {
  for(const b of [budget,scopeBudget(episodes,r.episode,episodeLimit(r.method,r.phase.split(':')[1],r.taskId)),scopeBudget(phases,r.phase, r.phase==='AFlow:search'?2280742:30000000)]) {
    b.reserve(r.charged,{runId:r.episode})({totalTokens:r.charged});
  }
}
function mflowReserve() {
  if(existsSync(resolve(mf,'summary.json')))return JSON.parse(readFileSync(resolve(mf,'summary.json'),'utf8')).actualTokens;
  const rows=readFileSync(resolve(mf,'test.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return rows.reduce((n,r)=>n+r.execution.actualTokens,0)+(486-rows.length)*24000;
}
const upstream=createHttpProvider({kind:'openai-compatible',baseUrl:process.env.MFLOW_BASE_URL,apiKey:process.env.MFLOW_API_KEY,maxTokensField:'max_tokens',providerOptions:{thinking:{type:'disabled'}},sandbox:new Sandbox(root,{network:[new URL(process.env.MFLOW_BASE_URL).origin]})});
const provider={async invoke(input,options) {
  const {method,phase,taskId}=input.metadata;
  const key=`${method}:${phase}:${taskId}`, phaseKey=`${method}:${phase}`;
  const estimate=Buffer.byteLength(JSON.stringify(input),'utf8')+input.generation.maxTokens+1024;
  const episode=scopeBudget(episodes,key,episodeLimit(method,phase,taskId)),phaseBudget=scopeBudget(phases,phaseKey,phaseKey==='AFlow:search'?2280742:30000000);
  if(estimate>budget.remaining-mflowReserve())throw new Error('GLOBAL_BUDGET');
  if(estimate>phaseBudget.remaining)throw new Error('SEARCH_BUDGET');
  if(estimate>episode.remaining)throw new Error('EPISODE_BUDGET');
  const scope={runId:key,label:'baseline-inference'}, settlements=[budget,phaseBudget,episode].map(b=>b.reserve(estimate,scope));
  const before=episode.spent;let response;
  try {response=await upstream.invoke(input,options);}
  finally {
    let failure;
    for(const settle of settlements)try{settle(response?.usage);}catch(e){failure=e;}
    const charged=episode.spent-before;
    // Requests within one episode are serial; concurrent methods use independent episode scopes.
    append('usage.jsonl',{method,phase:phaseKey,episode:key,taskId,charged,usage:response?.usage??null,finishReason:response?.finishReason??'unknown',at:new Date().toISOString()});
    append('responses.jsonl',{method,phase,taskId,message:response?.message??null,inputHash:createHash('sha256').update(JSON.stringify(input.messages)).digest('hex')});
    if(failure)throw failure;
  }
  if(!response?.usage)throw new Error('Missing provider usage');
  return response;
}};
const runtime=createDitto({workers:[createInferWorker({providers:{baseline:provider}})]});
const plan=graph('baseline-original-prompt').node('sample','INFER.REASONING.SAMPLE',[],x=>x);
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  try {
    if(req.url==='/status') {res.end(JSON.stringify({spent:budget.spent,mflowReserved:mflowReserve(),remaining:budget.remaining-mflowReserve()}));return;}
    if(req.method!=='POST'||req.url!=='/sample')throw new Error('Unknown endpoint');
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2000000)throw new Error('Input too large');}
    const body=JSON.parse(raw);
    if(!allowed.has(body.method)||!['pilot','search','test'].includes(body.phase)||typeof body.taskId!=='string')throw new Error('Invalid scope');
    const input={model:{provider:'baseline',model:'deepseek-flash'},messages:body.messages,generation:{temperature:0,maxTokens:4096},metadata:{method:body.method,phase:body.phase,taskId:body.taskId}};
    const result=await runtime.run(plan,input,{signal:AbortSignal.timeout(90000)});
    if(result.sample.status!=='success')throw new Error(result.sample.error?.message??'Ditto sample failed');
    res.end(JSON.stringify(result.sample.output));
  }catch(error){res.statusCode=429;res.end(JSON.stringify({error:String(error)}));}
});
server.listen(8197,'127.0.0.1',()=>{writeFileSync(resolve(out,'bridge.json'),JSON.stringify({pid:process.pid,port:8197,ditto:'0.1.1',model:'deepseek-flash',overallTokenCeiling:30000000,priorTokens:prior},null,2));console.log('Baseline Ditto bridge listening on 127.0.0.1:8197');});
