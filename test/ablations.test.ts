import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProvider, SampleInput } from '@codesoul-co/ditto/worker/infer';
import { ablationStrategy } from '../src/ablations.js';
import { textOrganization, textPrompts, textSolver, textReviewer } from '../src/aflow-seed.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { initialStrategy, limitsSchema, type Strategy } from '../src/types.js';

const source = (): Strategy => {
  const organization = structuredClone(textOrganization);
  for (const template of organization.agentTemplates!) template.profile.tools = ['arithmetic'].filter(t => template.profile.tools.includes(t));
  const independent = organization.agentTemplates!.find(t => t.id === 'independent')!;
  organization.agentTemplates!.push({ ...structuredClone(independent), id: 'checker', composition: textSolver,
    profile: { ...independent.profile, objective: 'Check problem constraints.', capability: 'Constraint checking' } });
  return { ...initialStrategy, id: 's2', organization, prompts: textPrompts };
};
const run = (candidate: Strategy, provider: ModelProvider) => new OrganizationRuntime(
  new DittoAgents(new MeteredProvider(provider), { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 }),
  limitsSchema.parse({ maxSteps: 40, maxTokens: 100000 })).run(candidate,
  { id: 'synthetic', prompt: 'Compute 2 + 3.', answer: 'HIDDEN-REFERENCE' } as any);

for (const variant of ['fixed-drop-heterogeneous','fixed-drop-homogeneous'] as const) {
  test(`${variant} preserves the complete frozen library and routes all roles before normalization`,async()=>{
    const original=source(),solver=original.organization!.agentTemplates!.find(t=>t.id==='solver')!;
    original.organization!.agentTemplates=['solver','independent','calculator','span_extractor','normalizer'].map(id=>({
      ...structuredClone(solver),id,profile:{...structuredClone(solver.profile),objective:id,private_context:`Role ${id}`,tools:[]},
      composition:id==='normalizer'?"return loop({id:'normalize',plan:function*(ctx){return ctx.publishText(ctx.self,String(ctx.evidence).trim(),'raw');}});":id==='independent'?textReviewer:solver.composition,
    }));
    const before=JSON.stringify(original),candidate=ablationStrategy(original,variant),calls:SampleInput[]=[];
    const result=await run(candidate,{async invoke(input){
      const id=String(input.metadata?.agentId);calls.push(input);
      const messages=JSON.stringify(input.messages);
      if(['independent','calculator','span_extractor'].includes(id))assert.ok(!messages.includes('ANSWER-root'));
      if(id==='root'&&calls.length>1)for(const role of ['root','independent','calculator','span_extractor'])assert.ok(messages.includes('ANSWER-'+role));
      if(id==='normalizer')assert.ok(messages.includes('FINAL'));
      const content=id==='normalizer'||(id==='root'&&calls.length>1)?'FINAL':'ANSWER-'+id;
      return {message:{role:'assistant',content},finishReason:'stop',usage:{totalTokens:20}};
    }});
    assert.equal(result.answer,'FINAL');
    assert.deepEqual(result.orchestration!.lifecycle.filter(e=>e.action==='RUN_TEMPLATE').map(e=>e.agentId),
      ['root','independent','calculator','span_extractor','root','normalizer']);
    assert.equal(result.agents.length,5);
    assert.equal(calls.length,variant==='fixed-drop-homogeneous'?6:5);
    assert.equal(result.actualTokens,calls.length*20);
    assert.ok(!JSON.stringify(calls).includes('HIDDEN-REFERENCE'));
    assert.equal(JSON.stringify(original),before);assert.deepEqual(candidate.prompts,original.prompts);
    if(variant==='fixed-drop-heterogeneous')assert.deepEqual(candidate.organization,original.organization);
    else for(const template of candidate.organization!.agentTemplates!) {
      assert.equal(template.composition,solver.composition);
      assert.deepEqual(template.profile.nodes,solver.profile.nodes);
      assert.equal(template.profile.private_context,'Role '+template.id);
    }
    assert.throws(()=>ablationStrategy(source(),variant),/requested templates/);
  });
}

test('DROP frozen trajectory templates publish Message.content instead of an object string',async()=>{
  const original=source(),solver=original.organization!.agentTemplates!.find(t=>t.id==='solver')!;
  original.organization!.agentTemplates=['solver','independent','calculator','span_extractor','normalizer'].map(id=>({
    ...structuredClone(solver),id,profile:{...structuredClone(solver.profile),nodes:['CONTEXT.LOAD','INFER.REASONING.SAMPLE','INFER.REASONING.TRAJECTORY'],tools:[]},
    composition:['independent','span_extractor'].includes(id)?`return loop({id:'trajectory',plan:function*(ctx){
      const name=ctx.self+'/reason';
      const out=yield* graphStep(graph('reason').node(name,'INFER.REASONING.TRAJECTORY',[],()=>({messages:ctx.textMessages(ctx.self),strategy:{name:'cot',options:{rounds:2}},model:'default'})),null);
      const r=ctx.unwrap(out[name]);return ctx.publishText(ctx.self,String(r.result).trim(),'raw');
    }});`:solver.composition,
  }));
  const before=JSON.stringify(original);
  const result=await run(ablationStrategy(original,'fixed-drop-heterogeneous'),{async invoke(){
    return {message:{role:'assistant',content:'5'},finishReason:'stop',usage:{totalTokens:1}};
  }});
  for(const id of ['independent','span_extractor'])assert.equal(result.outputs.find(o=>o.agentId===id)!.output.candidate_answer,'5');
  assert.equal(JSON.stringify(original),before);
});

for (const variant of ['single', 'fixed-full', 'fixed-uniform'] as const) {
  test(`${variant} preserves capabilities and executes its frozen path even when answers agree`, async () => {
    const original = source(), candidate = ablationStrategy(original, variant), calls: SampleInput[] = [];
    if (variant === 'fixed-uniform') {
      const shared = original.organization!.agentTemplates!.find(t => t.id === 'independent')!;
      for (const template of candidate.organization!.agentTemplates!) {
        assert.equal(template.composition, shared.composition);
        assert.deepEqual(template.profile.tools, shared.profile.tools);
        assert.deepEqual(template.profile.nodes, shared.profile.nodes);
        assert.equal(template.profile.objective, original.organization!.agentTemplates!.find(t => t.id === template.id)!.profile.objective);
      }
      assert.deepEqual(candidate.organization!.initialAgents[0].tools, shared.profile.tools);
    } else assert.deepEqual(candidate.organization, original.organization);
    assert.deepEqual(candidate.prompts, original.prompts);
    const result = await run(candidate, { async invoke(input) {
      calls.push(input);
      if (variant === 'fixed-uniform') assert.ok(input.actions?.some(action => action.name === 'arithmetic'));
      if (input.metadata?.agentId === 'independent') assert.ok(!JSON.stringify(input.messages).includes('PROOF-EVIDENCE'));
      if (calls.length === 5) assert.ok(JSON.stringify(input.messages).includes('PROOF-EVIDENCE'));
      return { message: { role: 'assistant', content: 'PROOF-EVIDENCE: 2 + 3 = 5. \\boxed{5}' }, finishReason: 'stop', usage: { totalTokens: 20 } };
    } });
    assert.deepEqual(calls.map(c => c.metadata?.agentId), variant === 'single' ? ['root'] : ['root', 'reviewer', 'independent', 'checker', 'root']);
    assert.equal(result.answer, String.raw`\boxed{5}`);
    assert.ok(!JSON.stringify(calls).includes('HIDDEN-REFERENCE'));
    assert.equal(result.agents.length, variant === 'single' ? 1 : 4);
  });
}

for (const variant of ['fixed-heterogeneous', 'fixed-homogeneous'] as const) {
  test(`${variant} keeps roles and shares evidence through the same fixed two-agent route`, async () => {
    const original = source();
    const solver = original.organization!.agentTemplates!.find(t => t.id === 'solver')!;
    const verifier = structuredClone(original.organization!.agentTemplates!.find(t => t.id === 'independent')!);
    verifier.id = 'verifier';
    verifier.profile.objective = 'Independently verify without writing.';
    verifier.profile.private_context = 'Read-only verifier instructions.';
    verifier.profile.tools = [];
    original.organization!.agentTemplates = [solver, verifier];
    const candidate = ablationStrategy(original, variant), calls: SampleInput[] = [];
    assert.deepEqual(candidate.prompts, original.prompts);
    if (variant === 'fixed-heterogeneous') assert.deepEqual(candidate.organization, original.organization);
    else for (const template of candidate.organization!.agentTemplates!) {
      assert.equal(template.composition, solver.composition);
      assert.deepEqual(template.profile.tools, solver.profile.tools);
      assert.deepEqual(template.profile.nodes, solver.profile.nodes);
      assert.equal(template.profile.reasoning, solver.profile.reasoning);
      const inherited: typeof solver = original.organization!.agentTemplates!.find(t => t.id === template.id)!;
      assert.equal(template.profile.objective, inherited.profile.objective);
      assert.equal(template.profile.private_context, inherited.profile.private_context);
    }
    const result = await run(candidate, { async invoke(input) {
      calls.push(input);
      if (calls.length > 1) assert.ok(JSON.stringify(input.messages).includes('OBSERVED-RECORD-123'));
      return { message: { role: 'assistant', content: 'OBSERVED-RECORD-123: complete. \\boxed{5}' }, finishReason: 'stop', usage: { totalTokens: 20 } };
    } });
    assert.deepEqual(calls.map(c => c.metadata?.agentId), ['root', 'verifier', 'root']);
    assert.equal(result.agents.length, 2);
    assert.equal(result.answer, String.raw`\boxed{5}`);
    assert.ok(!JSON.stringify(calls).includes('HIDDEN-REFERENCE'));
    assert.equal(original.organization!.agentTemplates[1].profile.tools.length, 0);
  });
}
