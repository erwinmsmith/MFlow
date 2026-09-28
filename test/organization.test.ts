import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrganizationRuntime } from '../src/runtime.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { rootProfile, initialStrategy, limitsSchema, strategySchema } from '../src/types.js';
import { ScriptedProvider, output, request } from './fixtures.js';
import { organizationEvidence } from '../src/organization.js';
import { programPrompts } from '../src/aflow-search.js';
import { validateProgram, programDecision } from '../src/strategy-program.js';

const model = { model: 'fixture', baseUrl: 'https://invalid.example', seed: 42, temperature: 0 };
const specialist = { ...rootProfile, id: 'specialist', capability: 'Exact enumeration', objective: 'Return independently computed evidence', tools: ['arithmetic'], reasoning: 'react' as const };
const { id: _, ...capability } = specialist;

test('one exported heterogeneous population grows different graphs, reconfigures and reuses without leaking episodes', async () => {
  const fake = new ScriptedProvider(input => {
    const {kind, payload} = request(input);
    if (kind === 'retrieve') return {agent_id: 'specialist'};
    assert.notEqual(kind, 'factory'); // Explicit searched capability does not get overwritten by another factory call.
    if (payload.profile.id !== 'root') return { ...output('56'), artifacts: [{id:'e', type:'exact', content:'56', deficit_refs:[payload.assigned.id]}] };
    if (payload.incoming.length) return output('56', [], payload.owned_deficits.map((d:{id:string})=>d.id));
    return output('0', [{id:'d',text:'Compute the product'}]);
  });
  const strategy = strategySchema.parse({ ...initialStrategy, prompts: programPrompts,
    organization: { initialAgents: [rootProfile, specialist] }, program: `
const d = state.deficits.find(d => d.owner === 'root');
if (state.step === 0) return state.task.prompt === 'reuse'
  ? {action:'RECONFIGURE', agentId:'specialist', profile:${JSON.stringify({...capability,capability:'Independent exact multiplication'})}}
  : {action:'DERIVE', deficitId:d.id, profile:${JSON.stringify({...capability,capability:'Alternative arithmetic derivation'})}};
if (state.task.prompt === 'reuse' && state.step === 1) return {action:'REACTIVATE', deficitId:d.id, agentId:'specialist'};
if (d.status === 'ACTIVE') return {action:'CONNECT', deficitId:d.id};
if (d.status === 'DELIVERED') return {action:'CONTINUE'};
if (state.agents.find(a => a.id === d.source).status === 'ACTIVE') return {action:'DORMANT', agentId:d.source};
return {action:'STOP'};` });
  const frozen = JSON.parse(JSON.stringify(strategy));
  const runtime = new OrganizationRuntime(new DittoAgents(new MeteredProvider(fake), model), limitsSchema.parse({maxSteps:12}));
  const reused = await runtime.run(frozen, {id:'one',prompt:'reuse'});
  const spawned = await runtime.run(frozen, {id:'two',prompt:'spawn'});
  assert.equal(reused.answer,'56'); assert.equal(spawned.answer,'56');
  assert.equal(reused.agents.length,2); assert.equal(spawned.agents.length,3);
  assert.equal(reused.agents[1].capability,'Independent exact multiplication');
  assert.equal(spawned.agents[1].capability,'Exact enumeration'); // Fresh profiles for next task.
  assert.equal(spawned.agents[2].capability,'Alternative arithmetic derivation');
  assert.equal(reused.edges[0].source,'specialist'); assert.equal(reused.edges[0].target,'root');
  assert.notEqual(spawned.edges[0].source,'specialist');
  assert.equal(reused.trace.at(-1)!.state.agents.find(a=>a.id==='specialist')!.status,'DORMANT');
  const evidence=organizationEvidence(reused);
  assert.equal(evidence.actions.RECONFIGURE,1); assert.equal(evidence.actions.CONNECT,1);
  assert.equal(evidence.deficits[0].status,'RESOLVED');
  assert.ok(fake.inputs.some(i => JSON.stringify(i).includes('Independent exact multiplication')));
  assert.deepEqual(strategy,frozen);
});

test('saved capability policies allow recursive derivation and route evidence through owners', async () => {
  const fake = new ScriptedProvider(input => {
    const {payload} = request(input);
    if (payload.profile.id === 'root') return payload.incoming.length ? output('56',[],payload.owned_deficits.map((d:{id:string})=>d.id)) : output('0');
    return { ...output('56', payload.profile.id==='agent-1' && !payload.incoming.length ? [{id:'check',text:'Check child calculation'}] : [], payload.incoming.length ? payload.owned_deficits.map((d:{id:string})=>d.id):[]),
      artifacts:[{id:'e',type:'exact',content:'56',deficit_refs:[payload.assigned.id]}] };
  });
  const strategy = {...initialStrategy,program:`
if (state.step===0) return {action:'DERIVE',request:'Independent solution',profile:${JSON.stringify(capability)}};
if (state.step===1) return {action:'DERIVE',deficitId:'agent-1:check',profile:${JSON.stringify({...capability,capability:'Constraint audit'})}};
if (state.step===2) return {action:'CONNECT',deficitId:'agent-1:check'};
if (state.step===3) return {action:'CONTINUE',agentId:'agent-1'};
const d=state.deficits.find(d=>d.owner==='root');
if (state.step===4) return {action:'CONNECT',deficitId:d.id};
if (state.step===5) return {action:'CONTINUE'};
return {action:'STOP'};`};
  const r=await new OrganizationRuntime(new DittoAgents(new MeteredProvider(fake),model),limitsSchema.parse({maxSteps:8})).run(strategy,{id:'nested',prompt:'Multiply'});
  assert.equal(r.answer,'56');assert.equal(r.depth,2);
  assert.deepEqual(r.edges.map(e=>[e.source,e.target]),[['agent-2','agent-1'],['agent-1','root']]);
});

test('contract checks reject unknown tools and incomplete reconfiguration', () => {
  assert.throws(()=>validateProgram('return {action:"RECONFIGURE"};'),/requires a complete profile/);
  assert.throws(()=>validateProgram(`return {action:"DERIVE",request:"check",profile:${JSON.stringify({...capability,tools:['unavailable']})}};`),/unavailable tool/);
  assert.equal(programDecision('return {action:"CONTINUE"};',{agents:[{id:'root',status:'ACTIVE',depth:0,turns:1,stalled:false}],deficits:[],maxDepth:10}).agentId,'root');
});
