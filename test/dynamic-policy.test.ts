import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkSeeds } from '../src/aflow-seed.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { initialStrategy, limitsSchema } from '../src/types.js';
import { organizationEvidence, summarizeOrganizations } from '../src/organization.js';
import { validateComposition } from '../src/composition.js';

const model={model:'fixture',baseUrl:'https://invalid.example',temperature:0,seed:42};
const response=(content:string)=>({message:{role:'assistant' as const,content},finishReason:'stop' as const,usage:{totalTokens:1}});
const twice={name:'generated_twice',description:'Double a number',parameters:[{name:'x',description:'Input',type:'number',required:true}],implementation:{kind:'sequence',steps:[{tool:'arithmetic',arguments:{values:[{$input:'/x'},{$input:'/x'}]}}]}};
const first=`return loop({id:'first',plan:function*(ctx){
  const id=ctx.self+'/solve'; const out=yield* graphStep(graph('solve').node(id,'INFER.REASONING.SAMPLE',[],()=>ctx.request(ctx.self,ctx.textMessages(ctx.self),false,'text')),null);
  return ctx.publishText(ctx.self,ctx.unwrap(out[id]).message.content,'raw');
}});`;
const second=`return loop({id:'cross-agent',plan:function*(ctx){
  const id=ctx.self+'/check';const out=yield* graphStep(graph('joint')
    .node('root/evidence','CONTEXT.LOAD',[],()=>({sources:[{role:'user',content:'Observed first-stage evidence'}]}))
    .node(ctx.self+'/create','INTERACTION.ACT.TOOL',['root/evidence'],()=>({call:{id:'create',name:'create_tool',arguments:{definition:${JSON.stringify(twice)}}}}))
    .node('root/use','INTERACTION.ACT.TOOL',[ctx.self+'/create'],()=>({call:{id:'use',name:'generated_twice',arguments:{x:3}}}))
    .node(ctx.self+'/observe','INTERACTION.OBSERVE',['root/use'],(_,out)=>({result:out['root/use']}))
    .node(id,'INFER.REASONING.SAMPLE',['root/evidence',ctx.self+'/observe'],(_,out)=>ctx.request(ctx.self,[{role:'user',content:JSON.stringify({evidence:out['root/evidence'],observation:out[ctx.self+'/observe']})}],false,'text')),null);
  return ctx.publishText(ctx.self,ctx.unwrap(out[id]).message.content,'raw');
}});`;

test('synchronous ctx delegation fails before evaluation; embedded source and legitimate generators remain valid',()=>{
  for (const call of ["ctx.spawnTemplate('solver','child')", "ctx['spawnTemplate']('solver','child')", "ctx.publishText('root','done')"])
    assert.throws(()=>validateComposition(`return loop({id:'invalid',plan:function*(ctx){yield* ${call};}});`),/is synchronous/);
  validateComposition(`return loop({id:'valid',plan:function*(ctx){
    const example="yield* ctx.spawnTemplate('solver','child')";
    // yield* ctx.spawnTemplate is an invalid example, not executed code.
    ctx.spawnTemplate('solver','child');return yield* ctx.runAgent('child');
  }});`);
});

test('recursive agent programs unwind before repeating effects, then permit recovery and sequential reuse',async()=>{
  const seed=benchmarkSeeds([{benchmark:'math',metric:'math'}],['dynamic-policy'])[0];
  for(const p of [...seed.organization.initialAgents,...seed.organization.agentTemplates!.map(t=>t.profile)])p.tools=['write_fixture'];
  const recursive=`return loop({id:'recursive',plan:function*(ctx){
    yield* graphStep(graph('effect').node('root/write','INTERACTION.ACT.TOOL',[],()=>({call:{id:'w',name:'write_fixture',arguments:{}}})),null);
    return yield* ctx.runAgent('child');
  }});`;
  const child=`return loop({id:'child',plan:function*(ctx){return yield* ctx.runAgent('root');}});`;
  const composition=`return loop({id:'outer',plan:function*(ctx){
    const template=ctx.agents.find(a=>a.profile.id==='root').templateId;
    ctx.bindProgram('root',${JSON.stringify(recursive)});
    ctx.spawn({...ctx.profile('root'),id:'child'},'root',${JSON.stringify(child)});
    try{yield* ctx.runAgent('root');throw new Error('Expected recursion guard');}
    catch(error){if(!String(error).includes('Recursive runAgent'))throw error;ctx.recordDecision({error:String(error)});}
    ctx.bindTemplate('root',template);
    yield* ctx.runAgent('root');
    return (yield* ctx.runAgent('root')).candidate_answer;
  }});`;
  let writes=0,calls=0;
  const meter=new MeteredProvider({async invoke(){calls++;return response('Recovered. \\boxed{7}');}});
  const runner=new OrganizationRuntime(new DittoAgents(meter,model,[{name:'write_fixture',description:'Fixture effect',inputSchema:{type:'object'},validate(){},async execute(){writes++;return {status:'success',content:'effect-already-applied'};}}]),limitsSchema.parse({maxSteps:30,maxTokens:200000}));
  const result=await runner.run({...initialStrategy,...seed,composition},{id:'recursive-program',prompt:'Synthetic recovery'});
  assert.equal(result.answer,'\\boxed{7}');assert.equal(writes,1);assert.equal(calls,2);
  assert.match(JSON.stringify(result.orchestration!.decisions),/Recursive runAgent/);
});

test('frozen dynamic policy changes internal graph and cross-agent routing only when new evidence requires it',async()=>{
  const seed=benchmarkSeeds([{benchmark:'automationbench',metric:'automationbench'}],['dynamic-policy'])[0];
  for(const p of [...seed.organization.initialAgents,...seed.organization.agentTemplates!.map(t=>t.profile)])p.tools=['arithmetic'];
  const candidate={...initialStrategy,...seed},frozen=JSON.parse(JSON.stringify(candidate));
  for(const task of ['simple','complex','complex']){
    const meter=new MeteredProvider({async invoke(input){
      if(input.metadata?.nodeId==='root/policy'){
        const data=JSON.parse(String(input.messages[1].content)),stage=data.evidence.stage;
        assert.ok(input.messages[0].content.toString().includes('DITTO DESIGN GUIDE'));
        if(stage===0){assert.deepEqual(data.members.map((a:any)=>a.profile.id),['root']);return response(JSON.stringify({stop:false,reason:'Need evidence',gap:'Initial execution',answer:'',composition:`return loop({id:'spawn-stage',plan:function*(ctx){ctx.spawn({...ctx.profile('root'),id:'specialist',nodes:['INFER.REASONING.SAMPLE'],tools:['arithmetic']},'root',${JSON.stringify(first)});return yield* ctx.runAgent('specialist');}});`}));}
        assert.ok(data.evidence.outputs.some((o:any)=>o.agentId==='specialist'));
        if(task==='complex'&&stage===1)return response(JSON.stringify({stop:false,reason:'Observed unresolved gap',gap:'Cross-check',answer:'',composition:`return loop({id:'revise-stage',plan:function*(ctx){ctx.reconfigure('specialist',{...ctx.profile('specialist'),capability:'Independent evidence cross-check'});ctx.bindProgram('specialist',${JSON.stringify(second)});return yield* ctx.runAgent('specialist');}});`}));
        return response(JSON.stringify({stop:true,reason:'Evidence complete',gap:'',composition:'',answer:'done'}));
      }
      if(input.metadata?.nodeId==='specialist/check')assert.ok(JSON.stringify(input.messages).includes('6'));
      return response(task==='complex'&&input.metadata?.nodeId==='specialist/solve'?'Unresolved gap':'Observed evidence');
    }});
    const execution=await new OrganizationRuntime(new DittoAgents(meter,model,[{name:'arithmetic',description:'Fixture addition',inputSchema:{type:'object'},validate(){},async execute(args){return {status:'success',content:{sum:(args.values as number[]).reduce((a,b)=>a+b,0)}}}}]),limitsSchema.parse({maxSteps:40,maxTokens:100000})).run(frozen,{id:task,prompt:task});
    assert.equal(execution.answer,'done');
    assert.equal(execution.orchestration!.decisions!.length,task==='simple'?2:3);
    const crossed=execution.orchestration!.graphs.some(g=>g.nodes.some(n=>n.id==='specialist/check'&&n.dependencies.includes('root/evidence')));
    const lastPolicy=execution.orchestration!.graphs.filter(g=>g.nodes.some(n=>n.id==='root/policy')).at(-1)!;
    assert.equal(crossed,task==='complex',JSON.stringify(JSON.parse((lastPolicy.inputs as any)['root/policy'].messages[1].content).evidence.last));
    assert.equal(execution.agents.filter(a=>a.id==='specialist').length,1);
    assert.notDeepEqual(execution.agents[0].nodes,execution.agents[1].nodes);
    assert.equal(execution.orchestration!.tools!.length,task==='simple'?0:1);
    if(task==='complex')assert.ok(execution.orchestration!.toolCalls!.some(c=>c.agentId==='root'&&c.name==='generated_twice'&&c.status==='success'));
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

test('broken generated stages recover in the same world, preserve tool effects and stop accumulating stale source',async()=>{
  const seed=benchmarkSeeds([{benchmark:'math',metric:'math'}],['dynamic-policy'])[0];
  for(const p of [...seed.organization.initialAgents,...seed.organization.agentTemplates!.map(t=>t.profile)])p.tools=['write_fixture'];
  let decisions=0,writes=0;
  const faulty=[
    `return loop({id:'missing-binding',plan:function*(ctx){
      yield* graphStep(graph('effect').node('root/write','INTERACTION.ACT.TOOL',[],()=>({call:{id:'w',name:'write_fixture',arguments:{}}}))
        .node('root/observe','INTERACTION.OBSERVE',['root/write'],(_,out)=>({result:out['root/write']})),null);
      ctx.spawn({...ctx.profile('root'),id:'child'});
      return yield* ctx.runAgent('child');
    }});`,
    `return loop({id:'wrong-source-type',plan:function*(ctx){ctx.bindProgram('child',function*(){return 'invalid';});return yield* ctx.runAgent('child');}});`,
    `return loop({id:'wrong-property-access',plan:function*(ctx){ctx.agents();return yield* ctx.runAgent('child');}});`,
  ];
  const meter=new MeteredProvider({async invoke(input){
    if(input.metadata?.nodeId==='root/policy'){
      const state=JSON.parse(String(input.messages[1].content)).evidence;
      assert.ok(state.structure.programs.length<=1,'Only current root source belongs in the next design context');
      if(decisions===1)assert.match(state.last.error,/no bound program/);
      if(decisions===2)assert.match(state.last.error,/source STRING/);
      assert.ok(decisions<3,'Must not repeat failed code indefinitely');
      return response(JSON.stringify({stop:false,reason:'Repair fixture',gap:'Fixture binding',composition:faulty[decisions++],answer:''}));
    }
    assert.ok(JSON.stringify(input.messages).includes('effect-already-applied'));
    return response('Recovered existing effect. \\boxed{7}');
  }});
  const runner=new OrganizationRuntime(new DittoAgents(meter,model,[{name:'write_fixture',description:'Fixture effect',inputSchema:{type:'object'},validate(){},async execute(){writes++;return {status:'success',content:'effect-already-applied'};}}]),limitsSchema.parse({maxSteps:40,maxTokens:200000}));
  const result=await runner.run({...initialStrategy,...seed},{id:'broken-program',prompt:'Synthetic recovery check'});
  assert.equal(result.answer,'\\boxed{7}');assert.equal(decisions,3);assert.equal(writes,1);
  assert.equal(result.orchestration!.programs!.length,3,'Full audit source remains available to search');
  assert.ok(result.orchestration!.lifecycle.some(e=>e.action==='RUN_TEMPLATE'&&e.agentId==='root'));
  assert.ok(result.orchestration!.decisions!.some(d=>(d.decision as any).reason==='Execution repair exhausted'));
});

test('native Context failure reaches stage recovery without replaying successful writes',async()=>{
  const seed=benchmarkSeeds([{benchmark:'math',metric:'math'}],['dynamic-policy'])[0];
  for(const p of [...seed.organization.initialAgents,...seed.organization.agentTemplates!.map(t=>t.profile)])p.tools=['write_fixture'];
  const bad=`return loop({id:'oversized-context',plan:function*(ctx){
    yield* graphStep(graph('write').node('root/write','INTERACTION.ACT.TOOL',[],()=>({call:{id:'w',name:'write_fixture',arguments:{}}})),null);
    yield* graphStep(graph('context').node('root/load','CONTEXT.LOAD',[],()=>({sources:[{role:'user',content:'x'.repeat(1000001)}]})),null);
    throw new Error('Published Context limit should reject the oversized item');
  }});`;
  let writes=0,decisions=0;
  const meter=new MeteredProvider({async invoke(input){
    if(input.metadata?.nodeId==='root/policy'){
      const state=JSON.parse(String(input.messages[1].content)).evidence;
      if(decisions++===0)return response(JSON.stringify({stop:false,reason:'Execute fixture',gap:'Initial',answer:'',composition:bad}));
      if(decisions===2){
        assert.match(state.last.error,/inline byte limit/);
        return response(JSON.stringify({stop:false,reason:'Recover in same world',gap:'Read existing effect',answer:'',composition:first}));
      }
      assert.equal(decisions,3);return response(JSON.stringify({stop:true,reason:'Observed completion',gap:'',composition:'',answer:'done'}));
    }
    assert.equal(writes,1);return response('Observed existing effect');
  }});
  const runner=new OrganizationRuntime(new DittoAgents(meter,model,[{name:'write_fixture',description:'Fixture effect',inputSchema:{type:'object'},validate(){},async execute(){writes++;return {status:'success',content:'applied'};}}]),limitsSchema.parse({maxSteps:30,maxTokens:200000}));
  const result=await runner.run({...initialStrategy,...seed},{id:'context-recovery',prompt:'Synthetic context failure'});
  assert.equal(writes,1);assert.equal(result.answer,'done');assert.equal(result.executionError,undefined);
  assert.ok(result.orchestration!.decisions!.some(d=>(d.decision as any).recovery==='stage-feedback'));
});
