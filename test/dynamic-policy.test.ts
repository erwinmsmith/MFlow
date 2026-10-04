import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkSeeds } from '../src/aflow-seed.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { initialStrategy, limitsSchema } from '../src/types.js';
import { organizationEvidence, summarizeOrganizations } from '../src/organization.js';

const model={model:'fixture',baseUrl:'https://invalid.example',temperature:0,seed:42};
const response=(content:string)=>({message:{role:'assistant' as const,content},finishReason:'stop' as const,usage:{totalTokens:1}});
const first=`return loop({id:'first',plan:function*(ctx){
  const id=ctx.self+'/solve'; const out=yield* graphStep(graph('solve').node(id,'INFER.REASONING.SAMPLE',[],()=>ctx.request(ctx.self,ctx.textMessages(ctx.self),false,'text')),null);
  return ctx.publishText(ctx.self,ctx.unwrap(out[id]).message.content,'raw');
}});`;
const second=`return loop({id:'cross-agent',plan:function*(ctx){
  const id=ctx.self+'/check';const out=yield* graphStep(graph('joint')
    .node('root/evidence','CONTEXT.LOAD',[],()=>({sources:[{role:'user',content:'Observed first-stage evidence'}]}))
    .node(id,'INFER.REASONING.SAMPLE',['root/evidence'],(_,out)=>ctx.request(ctx.self,[{role:'user',content:out['root/evidence'].items[0].content}],false,'text')),null);
  return ctx.publishText(ctx.self,ctx.unwrap(out[id]).message.content,'raw');
}});`;

test('frozen dynamic policy changes internal graph and cross-agent routing only when new evidence requires it',async()=>{
  const seed=benchmarkSeeds([{benchmark:'automationbench',metric:'automationbench'}],['dynamic-policy'])[0];
  for(const p of [...seed.organization.initialAgents,...seed.organization.agentTemplates!.map(t=>t.profile)])p.tools=[];
  const candidate={...initialStrategy,...seed},frozen=JSON.parse(JSON.stringify(candidate));
  for(const task of ['simple','complex','complex']){
    const meter=new MeteredProvider({async invoke(input){
      if(input.metadata?.nodeId==='root/policy'){
        const data=JSON.parse(String(input.messages[1].content)),stage=data.evidence.stage;
        assert.ok(input.messages[0].content.toString().includes('DITTO DESIGN GUIDE'));
        if(stage===0)return response(JSON.stringify({stop:false,reason:'Need evidence',gap:'Initial execution',answer:'',composition:`return loop({id:'spawn-stage',plan:function*(ctx){ctx.spawn({...ctx.profile('root'),id:'specialist',tools:[]},'root',${JSON.stringify(first)});return yield* ctx.runAgent('specialist');}});`}));
        assert.ok(data.evidence.outputs.some((o:any)=>o.agentId==='specialist'));
        if(task==='complex'&&stage===1)return response(JSON.stringify({stop:false,reason:'Observed unresolved gap',gap:'Cross-check',answer:'',composition:`return loop({id:'revise-stage',plan:function*(ctx){ctx.reconfigure('specialist',{...ctx.profile('specialist'),capability:'Independent evidence cross-check'});ctx.bindProgram('specialist',${JSON.stringify(second)});return yield* ctx.runAgent('specialist');}});`}));
        return response(JSON.stringify({stop:true,reason:'Evidence complete',gap:'',composition:'',answer:'done'}));
      }
      return response(task==='complex'&&input.metadata?.nodeId==='specialist/solve'?'Unresolved gap':'Observed evidence');
    }});
    const execution=await new OrganizationRuntime(new DittoAgents(meter,model,[]),limitsSchema.parse({maxSteps:40,maxTokens:100000})).run(frozen,{id:task,prompt:task});
    assert.equal(execution.answer,'done');
    assert.equal(execution.orchestration!.decisions!.length,task==='simple'?2:3);
    const crossed=execution.orchestration!.graphs.some(g=>g.nodes.some(n=>n.id==='specialist/check'&&n.dependencies.includes('root/evidence')));
    assert.equal(crossed,task==='complex');
    assert.equal(execution.agents.filter(a=>a.id==='specialist').length,1);
    const feedback=summarizeOrganizations([{taskId:task,score:1,organization:organizationEvidence(execution)}]);
    assert.ok(feedback.reusableCandidates.programs.length>0);
    assert.deepEqual(frozen,candidate);
  }
});

test('native verifier input errors are observable and a generated stage can repair without discarding the episode',async()=>{
  const seed=benchmarkSeeds([{benchmark:'math',metric:'math'}],['single'])[0];
  for(const p of [...seed.organization.initialAgents,...seed.organization.agentTemplates!.map(t=>t.profile)])p.tools=[];
  seed.organization.initialAgents[0].nodes!.push('INFER.REASONING.REFLECT');
  const bad=`return loop({id:'bad',plan:function*(ctx){const out=yield* graphStep(graph('bad').node('root/check','INFER.REASONING.REFLECT',[],()=>({criteria:'wrong'})),null);if(out['root/check'].status==='success')throw new Error('Must reject bad contract');return ctx.publishText('root',out['root/check'].error.code,'raw');}});`;
  const candidate={...initialStrategy,...seed,composition:`return loop({id:'main',plan:function*(ctx){ctx.bindProgram('root',${JSON.stringify(bad)});return (yield* ctx.runAgent('root')).candidate_answer;}});`};
  const meter=new MeteredProvider({async invoke(){throw new Error('Invalid node input must not call model');}});
  const execution=await new OrganizationRuntime(new DittoAgents(meter,model,[]),limitsSchema.parse({maxSteps:10})).run(candidate,{id:'invalid',prompt:'Fixture'});
  assert.equal(execution.answer,'INVALID_INPUT');
});

test('late successful tools and programs remain visible after many ordinary feedback examples',()=>{
  const rows=Array.from({length:30},(_,i)=>({taskId:String(i),score:1,organization:{agents:[],actions:{},noops:{},edges:[],transitions:[],deficits:[],peakActive:1,depth:0,toolCalls:0,stopReason:'strategy' as const,stopDetail:undefined}}));
  const tool={creatorId:'root',definition:{name:'generated_identity',description:'identity',parameters:[],implementation:{kind:'python' as const,source:'def run(args): return args'}},hash:'tool',origin:'generated' as const};
  const late={...rows[0],taskId:'late',organization:{...rows[0].organization,tools:[tool],toolUsage:[{agentId:'child',name:'generated_identity',status:'success'}]}};
  const summary=summarizeOrganizations([...rows,late]);
  assert.ok(summary.examples.some(r=>r.taskId==='late'));
  assert.equal(summary.reusableCandidates.tools.length,1);
});
