import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { initialComposition, validateComposition } from '../src/composition.js';
import { organizationEvidence, summarizeOrganizations } from '../src/organization.js';
import { initialStrategy, limitsSchema, rootProfile, type AgentProfile, type Strategy } from '../src/types.js';
import { programPrompts, initialOrganization } from '../src/aflow-search.js';
import { ScriptedProvider, output } from './fixtures.js';
import type { ModelProvider } from '@codesoul-co/ditto/worker/infer';

const model = { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 };
const profile: AgentProfile = { ...rootProfile, tools: ['arithmetic'], nodes: ['CONTEXT.LOAD', 'INFER.REASONING.SAMPLE', 'INTERACTION.ACT.TOOL', 'INTERACTION.OBSERVE'] };
const strategy = (composition = initialComposition, profiles = [profile]): Strategy => ({ ...initialStrategy,
  composition, organization: { initialAgents: profiles }, prompts: programPrompts });
const fixtureLibrary = () => {
  const organization = structuredClone(initialOrganization);
  for (const p of [...organization.initialAgents, ...organization.agentTemplates!.map(t => t.profile)])
    p.tools = p.tools.filter(t => t !== 'python');
  return organization;
};
const run = (provider: ModelProvider, candidate = strategy(), prompt = 'Synthetic fixture') =>
  new OrganizationRuntime(new DittoAgents(new MeteredProvider(provider), model), limitsSchema.parse({maxSteps: 20, maxTokens: 100000}))
    .run(candidate, { id: 'fixture', prompt });

test('native seed executes declared context, inference and interaction nodes through Ditto', async () => {
  let calls = 0;
  const provider: ModelProvider = { async invoke(input) {
    if (++calls === 1) return { message: { role: 'assistant', content: '' }, finishReason: 'action_request',
      actionRequests: [{ id: 'sum', name: 'arithmetic', arguments: {operation: 'add', values: [2, 3]} }], usage: {totalTokens: 20} };
    assert.ok(JSON.stringify(input.messages).includes('5'));
    assert.equal(input.messages.at(-1)?.metadata?.actionRequestId, 'sum');
    return {message:{role:'assistant',content:JSON.stringify(output('5'))},finishReason:'stop',usage:{totalTokens:20}};
  } };
  const result = await run(provider);
  assert.equal(result.answer, '5'); assert.equal(calls, 2);
  assert.equal(result.orchestration?.graphs.length, 3);
  assert.equal(result.toolEvents.length, 1);
  assert.equal(organizationEvidence(result).nodeCalls?.['INTERACTION.ACT.TOOL'], 1);
});

const heterogeneous = `return loop({id:'heterogeneous', plan:function*(ctx) {
  const derived = ctx.spawn({...ctx.profile('root'), id:'checker', tools:[], nodes:['INFER.REASONING.REFLECT'], capability:'Verification only'});
  const plan = graph('woven')
    .node('root/solve','INFER.REASONING.SAMPLE',[],()=>ctx.request('root',ctx.messages('root')))
    .node('checker/verify','INFER.REASONING.REFLECT',['root/solve'],(_,out)=>({
      model:{model:'fixture'},mode:'verify',target:{result:ctx.unwrap(out['root/solve']).message}}));
  const result = yield* graphStep(plan,null);
  const initial = ctx.decode(ctx.unwrap(result['root/solve']).message.content);
  ctx.publish('root',initial);
  ctx.dormant('checker');
  if (!ctx.unwrap(result['checker/verify']).assessment.passed) {
    const revise = graph('revise').node('root/revise','INFER.REASONING.SAMPLE',[],
      ()=>ctx.request('root',ctx.messages('root',ctx.unwrap(result['checker/verify']),'integrate')));
    const revised = yield* graphStep(revise,null);
    return ctx.publish('root',ctx.decode(ctx.unwrap(revised['root/revise']).message.content)).candidate_answer;
  }
  return initial.candidate_answer;
}});`;

test('different agent node capabilities weave into one graph, then dynamically route critique back', async () => {
  let samples=0;
  const fake = new ScriptedProvider(input => {
    if (input.messages[0].content.toString().includes('Assess the supplied target'))
      return {assessment:{passed:false,summary:'WRONG-RECOMPUTE'},issues:[{severity:'error',description:'Synthetic discrepancy'}]};
    if (++samples===1) return output('wrong');
    assert.ok(JSON.stringify(input.messages).includes('WRONG-RECOMPUTE'));
    return output('fixed');
  });
  const result = await run(fake,strategy(heterogeneous));
  assert.equal(result.answer,'fixed'); assert.equal(fake.inputs.length,3);
  const evidence = organizationEvidence(result);
  assert.deepEqual(evidence.executedAgents,['root','checker']);
  assert.equal(evidence.nodeCalls?.['INFER.REASONING.REFLECT'],1);
  assert.deepEqual(evidence.graphs?.[0].nodes[1].dependencies,['root/solve']);
  assert.equal(evidence.actions.SPAWN,1); assert.equal(evidence.actions.DORMANT,1);
  assert.deepEqual(result.agents[1].nodes,['INFER.REASONING.REFLECT']);
  assert.equal(summarizeOrganizations([{taskId:'fixture',score:1,organization:evidence}]).spawnedTasks,1);
  // Persisted code + profiles can be reloaded for frozen inference; no prior task state.
  const second = await run(new ScriptedProvider(i => i.messages[0].content.toString().includes('Assess the supplied target')
    ? {assessment:{passed:true,summary:'pass'},issues:[]} : output('fresh')), JSON.parse(JSON.stringify(strategy(heterogeneous))));
  assert.equal(second.answer,'fresh'); assert.equal(second.agents.length,2);
});

test('nested agent generators interleave graph steps with independent loop state', async () => {
  const code = `function* agent(ctx,id) {
    let last;
    for(let i=0;i<2;i++) {
      const g=graph(id+'/turn').node(id+'/sample','INFER.REASONING.SAMPLE',[],()=>ctx.request(id,ctx.messages(id,{iteration:i})));
      const result=yield* graphStep(g,null);
      last=ctx.publish(id,ctx.decode(ctx.unwrap(result[id+'/sample']).message.content));
    }
    return last;
  }
  return loop({id:'interleaved',plan:function*(ctx){
    ctx.spawn({...ctx.profile('root'),id:'child'});
    const a=agent(ctx,'root'),b=agent(ctx,'child');
    let na=a.next(),nb=b.next();
    while(!na.done || !nb.done) {
      if(!na.done) na=a.next(yield na.value);
      if(!nb.done) nb=b.next(yield nb.value);
    }
    return na.value.candidate_answer;
  }});`;
  const result=await run(new ScriptedProvider(()=>output('ok')),strategy(code));
  assert.deepEqual(result.orchestration?.graphs.map(g=>g.id),['root/turn','child/turn','root/turn','child/turn']);
  assert.equal(result.answer,'ok');
});

test('native composition rejects unauthorized nodes/tools and invalid loops before model work',async()=>{
  const fake=new ScriptedProvider(()=>output('x'));
  const bad=`return loop({id:'bad',plan:function*(ctx){
    const g=graph('bad').node('root/review','INFER.REASONING.REFLECT',[],()=>({}));
    yield* graphStep(g,null);return 'bad';}});`;
  await assert.rejects(run(fake,strategy(bad)),/cannot execute node/); assert.equal(fake.inputs.length,0);
  const tool=`return loop({id:'bad',plan:function*(){
    yield* graphStep(graph('bad').node('root/tool','INTERACTION.ACT.TOOL',[],()=>({call:{id:'x',name:'python',arguments:{}}})),null);return 'bad';}});`;
  await assert.rejects(run(fake,strategy(tool)),/cannot use tool/);
  assert.throws(()=>validateComposition('return process.env'),/process is not defined/);
  await assert.rejects(run(fake,strategy("return loop({id:'bad',plan:function*(){while(true){} return 'bad';}});")),/timed out/);
});

test('final task labels cannot enter native composition', async()=>{
  const fake=new ScriptedProvider(i=>{assert.ok(!JSON.stringify(i).includes('SECRET-LABEL'));return output('ok');});
  const runtime=new OrganizationRuntime(new DittoAgents(new MeteredProvider(fake),model),limitsSchema.parse({}));
  await runtime.run(strategy(),{id:'fixture',prompt:'fixture',answer:'SECRET-LABEL'} as any);
});

test('Ditto schedules independent heterogeneous nodes concurrently and records bindings', async()=>{
  let active=0,peak=0;
  const provider:ModelProvider={async invoke(){
    peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,15));active--;
    return {message:{role:'assistant',content:JSON.stringify(output('ok'))},finishReason:'stop',usage:{totalTokens:20}};
  }};
  const code=`return loop({id:'parallel',plan:function*(ctx){
    ctx.spawn({...ctx.profile('root'),id:'other',nodes:['INFER.REASONING.TRAJECTORY'],tools:[],reasoning:'cot'});
    const g=graph('parallel')
      .node('root/sample','INFER.REASONING.SAMPLE',[],()=>ctx.request('root',ctx.messages('root')))
      .node('other/trajectory','INFER.REASONING.TRAJECTORY',[],()=>({messages:ctx.messages('other'),model:{model:'fixture'},strategy:{name:'cot',options:{rounds:1}}}));
    const out=yield* graphStep(g,null,{concurrency:2});
    ctx.publish('other',ctx.decode(ctx.unwrap(out['other/trajectory']).result.content));
    return ctx.publish('root',ctx.decode(ctx.unwrap(out['root/sample']).message.content)).candidate_answer;
  }});`;
  const result=await run(provider,strategy(code));
  assert.equal(peak,2);assert.equal(result.calls,2);assert.equal(result.tokens,40);
  assert.equal(result.orchestration?.graphs[0].inputs['other/trajectory'] !== undefined,true);
  assert.equal(result.outputs.length,2);
});

test('optimizer context preserves full parent feedback above Ditto default 64 KiB', async()=>{
  const instruction='parent-graph-and-execution-evidence\n'.repeat(3000);
  const fake=new ScriptedProvider(input=>{
    assert.ok(input.messages[0].content.toString().startsWith(instruction));
    assert.ok(Buffer.byteLength(input.messages[0].content.toString())>65536);
    return output('ok');
  });
  const {agentOutputSchema}=await import('../src/types.js');
  const agents=new DittoAgents(new MeteredProvider(fake),model);
  const result=await agents.structured('aflow-optimizer',instruction,{},agentOutputSchema,
    limitsSchema.parse({maxTokens:1000000}));
  assert.equal(result.value.candidate_answer,'ok');assert.equal(fake.inputs.length,1);
});

test('agent Context uses published maximums instead of default storage cutoffs',async()=>{
  const {graph}=await import('@codesoul-co/ditto');
  const runtime=new DittoAgents(new MeteredProvider(new ScriptedProvider()),model).runtime([],1000);
  const text='long-evidence-'.repeat(6000);
  const sources=Array.from({length:300},(_,i)=>({role:'user' as const,content:i===0?text:`evidence-${i}`}));
  try{
    const result=await runtime.run(graph<typeof sources>('context-capacity').node('load','CONTEXT.LOAD',[],input=>({sources:input})),sources);
    assert.equal(result.load.items.length,300);assert.equal(result.load.items[0].content,text);
  }finally{await runtime.close();}
});

test('searched library freezes heterogeneous internal graphs together with dynamic MAS routing', async () => {
  const { initialLibraryComposition } = await import('../src/composition.js');
  const candidate: Strategy = { ...strategy(), composition: initialLibraryComposition,
    organization: fixtureLibrary() };
  // Optimize one subagent's internal graph without replacing the outer MAS policy.
  candidate.organization!.agentTemplates![1].composition = candidate.organization!.agentTemplates![1].composition.replace("mode: 'verify'", "mode: 'critique'");
  const frozen = JSON.stringify(candidate);
  let roots = 0;
  const fake = new ScriptedProvider(input => {
    const text = JSON.stringify(input.messages);
    assert.ok(!text.includes('SECRET-LABEL'));
    // REFLECT supplies its own system prompt before the task messages.
    if (input.messages[0].content.toString().includes('Assess the supplied target'))
      return { assessment: { passed: false, summary: 'CHECK-OMITTED-CASE' }, issues: [] };
    if (++roots === 1) return output('tentative', [{ id: 'gap', text: 'Check omitted boundary case' }]);
    assert.ok(text.includes('CHECK-OMITTED-CASE'));
    return output('correct');
  });
  const runtime = new OrganizationRuntime(new DittoAgents(new MeteredProvider(fake), model), limitsSchema.parse({ maxTokens: 100000 }));
  const result = await runtime.run(JSON.parse(frozen), { id: 'heldout', prompt: 'Synthetic problem', answer: 'SECRET-LABEL' } as any);
  assert.equal(result.answer, 'correct');
  const org = organizationEvidence(result);
  assert.equal(org.actions.SPAWN, 1);
  assert.equal(org.actions.RUN_TEMPLATE, 3);
  assert.deepEqual(result.agents[1].nodes, ['INFER.REASONING.REFLECT']);
  assert.equal((result.orchestration!.graphs[1].inputs['verifier-0/verify'] as any).mode, 'critique');
  assert.deepEqual(summarizeOrganizations([{ taskId: 'heldout', score: 1, organization: org }]).templateUsage,
    { solver: { runs: 2, tasks: 1, correctTasks: 1 }, verifier: { runs: 1, tasks: 1, correctTasks: 1 } });
  // Same frozen artifact, fresh task: routing can skip derivation entirely.
  const second = await run(new ScriptedProvider(() => output('fresh')), JSON.parse(frozen));
  assert.equal(second.answer, 'fresh'); assert.equal(second.agents.length, 1);
  assert.equal(organizationEvidence(second).actions.SPAWN, undefined);
  assert.equal(JSON.stringify(candidate), frozen);
});

test('template instances retain independent loop state while MAS interleaves their graph steps', async () => {
  const candidate: Strategy = { ...strategy(), organization: fixtureLibrary(), composition: `
  return loop({id:'woven-library',plan:function*(ctx){
    ctx.spawnTemplate('solver','child','root');
    ctx.bindTemplate('child','solver');
    const a=ctx.runAgent('root',{route:'root'}), b=ctx.runAgent('child',{route:'child'});
    let x=a.next(), y=b.next();
    while(!x.done || !y.done){
      if(!x.done) x=a.next(yield x.value);
      if(!y.done) y=b.next(yield y.value);
    }
    return x.value.candidate_answer+'+'+y.value.candidate_answer;
  }});` };
  candidate.organization!.agentTemplates![0].composition = `return loop({id:'twice',plan:function*(ctx){
    let output;
    for(let i=0;i<2;i++){
      const n=ctx.self+'/sample';
      const g=graph(ctx.self+'/'+i).node(n,'INFER.REASONING.SAMPLE',[],()=>ctx.request(ctx.self,ctx.messages(ctx.self,{round:i,evidence:ctx.evidence})));
      const result=yield* graphStep(g,null);
      output=ctx.publish(ctx.self,ctx.decode(ctx.unwrap(result[n]).message.content));
    }
    return output;
  }});`;
  const fake = new ScriptedProvider(input => {
    const payload = JSON.parse(String(input.messages[1].content)).payload;
    assert.equal(payload.profile.id, payload.evidence.evidence.route);
    return output(payload.profile.id);
  });
  const result = await run(fake, JSON.parse(JSON.stringify(candidate)));
  assert.equal(result.answer, 'root+child');
  assert.deepEqual(result.orchestration!.graphs.map(g => g.id), ['root/0','child/0','root/1','child/1']);
  assert.equal(result.orchestration!.lifecycle.find(e => e.action === 'SPAWN')?.templateId, 'solver');
});

test('library contracts reject missing templates, capability mismatches and infinite nested loops', async () => {
  const { organizationSchema } = await import('../src/types.js');
  assert.throws(() => organizationSchema.parse({ ...initialOrganization, initialBindings: { root: 'missing' } }), /Invalid initial template/);
  assert.throws(() => organizationSchema.parse({ ...initialOrganization, agentTemplates: [initialOrganization.agentTemplates![0], initialOrganization.agentTemplates![0]] }), /unique/);
  const candidate: Strategy = { ...strategy(), organization: fixtureLibrary(),
    composition: `return loop({id:'main',plan:function*(ctx){return (yield* ctx.runAgent('root')).candidate_answer;}});` };
  candidate.organization!.agentTemplates![0].composition = `return loop({id:'bad',plan:function*(){while(true){} }});`;
  const fake = new ScriptedProvider(() => output('unused'));
  await assert.rejects(run(fake, candidate), /timed out/);
  candidate.organization!.agentTemplates![0].composition = `return loop({id:'bad',plan:function*(ctx){
    yield* graphStep(graph('bad').node('root/check','INFER.REASONING.REFLECT',[],()=>({})),null);}});`;
  await assert.rejects(run(fake, candidate), /cannot execute node/);
  assert.equal(fake.inputs.length, 0);
});
