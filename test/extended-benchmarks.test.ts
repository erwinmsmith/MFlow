import test from 'node:test';
import assert from 'node:assert/strict';
import { readTasks, assertDisjoint, assertDatasetRole } from '../src/data.js';
import { taskSchema, initialStrategy, limitsSchema } from '../src/types.js';
import { benchmarkSeed, benchmarkSeeds } from '../src/aflow-seed.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { executeBenchmark, openAutomation, automationTools } from '../src/benchmark-environment.js';
import { grade } from '../src/grading.js';
import { benchmarkPath } from '../src/benchmark-hub.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { validateComposition } from '../src/composition.js';

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
  const agents = new DittoAgents(provider, model);
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
