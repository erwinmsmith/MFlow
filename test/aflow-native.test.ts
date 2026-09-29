import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { programDecision, validateProgram, normalizeProgram, PolicyContractError } from '../src/strategy-program.js';
import { runAFlowSearch, initialOrganization, programPrompts, parallelMap, unrestrictedConfig, aflowConfigSchema } from '../src/aflow-search.js';
import { initialLibraryComposition } from '../src/composition.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { initialStrategy, limitsSchema, rootProfile } from '../src/types.js';
import { ScriptedProvider, output, request } from './fixtures.js';
import { createPythonTool, pythonImage } from '../src/python-tool.js';
import type { ModelProvider, SampleInput, SampleOutput } from '@codesoul-co/ditto/worker/infer';

test('policy programs route dynamic assignments and editable prompts through published Ditto', async () => {
  const fake = new ScriptedProvider((input) => {
    const { kind, payload } = request(input);
    if (kind === 'factory') return { ...rootProfile, id: payload.id };
    if (payload.profile.id !== 'root') return { ...output('56'), artifacts: [{ id: 'e', type: 'number', content: '56', deficit_refs: [payload.assigned.id] }] };
    if (payload.incoming.length) return output('56', [], payload.owned_deficits.map((d: {id: string}) => d.id));
    return output('0');
  });
  const meter = new MeteredProvider(fake);
  const runtime = new OrganizationRuntime(new DittoAgents(meter, { model: 'fixture', baseUrl: 'https://invalid.example', seed: 42, temperature: 0 }), limitsSchema.parse({ maxSteps: 8 }));
  const strategy = { ...initialStrategy, prompts: { ...programPrompts, agent: 'AGENT-MARKER', factory: 'FACTORY-MARKER', integrate: 'INTEGRATE-MARKER' }, program: `
if (state.step === 0) return { action: 'DERIVE', agentId: 'root', request: 'Independently calculate 7 times 8' };
const d = state.deficits[0];
if (d.status === 'ACTIVE') return { action: 'CONNECT', deficitId: d.id };
if (d.status === 'DELIVERED') return { action: 'CONTINUE', agentId: 'root' };
return { action: 'STOP' };` };
  const result = await runtime.run(strategy, { id: 'fixture', prompt: 'Calculate 7 times 8' });
  assert.equal(result.answer, '56');
  assert.deepEqual(result.trace.map((t) => t.decision.action), ['DERIVE', 'CONNECT', 'CONTINUE', 'STOP']);
  for (const marker of ['AGENT-MARKER', 'FACTORY-MARKER', 'INTEGRATE-MARKER'])
    assert.ok(fake.inputs.some((i) => JSON.stringify(i.messages).includes(marker)));
  assert.equal(result.reusedPrefixSteps, 0);
  assert.ok(fake.inputs.every((i) => !('answer' in (request(i).payload.task ?? {}))));
});

test('program faults cannot fabricate a valid action or access host globals', () => {
  const state = { deficits: [], agents: [{ id: 'root', status: 'ACTIVE' as const, depth: 0, turns: 1, stalled: false }], maxDepth: 3 };
  assert.throws(() => programDecision('while(true) {}', state), /timed out/);
  assert.throws(() => programDecision('return process.env;', state), /process is not defined/);
  assert.throws(() => programDecision('return {action:"STOP",agentId:"unknown"}', state), /unknown agent/);
});

test('complete functions normalize without changing decisions; invalid contracts fail before benchmark calls', () => {
  const state = { deficits: [], agents: [{ id: 'root', status: 'ACTIVE' as const, depth: 0, turns: 1, stalled: false }], maxDepth: 3 };
  for (const code of ['state => ({action:"STOP"})', '(state) => { return {action:"STOP"}; }', 'function policy(state) { return {action:"STOP"}; }']) {
    validateProgram(code);
    assert.equal(programDecision(normalizeProgram(code), state).action, 'STOP');
  }
  assert.throws(() => validateProgram('const answer = 1;'), PolicyContractError);
  const helperBody = 'function stop() { return {action:"STOP"}; } return stop();';
  assert.equal(normalizeProgram(helperBody), helperBody);
  validateProgram(helperBody);
  assert.throws(() => validateProgram('(state) => { return {action:"CONTINUE", request:"format answer"}; }'), /request requires DERIVE/);
  assert.throws(() => validateProgram('return {action:"FAKE"};'), PolicyContractError);
});

test('validation drains in-flight work and stops scheduling after a technical failure', async () => {
  let calls = 0, active = 0;
  await assert.rejects(parallelMap([0, 1, 2, 3, 4], 2, async (i) => {
    calls++; active++;
    if (i === 0) { active--; throw new PolicyContractError('bad policy'); }
    await new Promise((r) => setTimeout(r, 10)); active--; return i;
  }), PolicyContractError);
  assert.equal(calls, 2); assert.equal(active, 0);
});

test('published Ditto executes isolated Python and returns its observation to the agent', async (t) => {
  let image: string;
  try { image = await pythonImage(); } catch { t.skip('Docker Python image unavailable'); return; }
  let calls = 0;
  const provider: ModelProvider = { async invoke(input: SampleInput): Promise<SampleOutput> {
    if (++calls === 1) return { message: { role: 'assistant', content: '' }, finishReason: 'action_request',
      actionRequests: [{ id: 'py', name: 'python', arguments: { code: 'from fractions import Fraction\nprint(Fraction(1, 3) + Fraction(1, 6))' } }], usage: { totalTokens: 10 } };
    assert.ok(JSON.stringify(input.messages).includes('1/2'));
    return { message: { role: 'assistant', content: JSON.stringify(output('1/2')) }, finishReason: 'stop', usage: { totalTokens: 10 } };
  } };
  const agents = new DittoAgents(new MeteredProvider(provider), { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 }, [createPythonTool(image)]);
  const runtime = new OrganizationRuntime(agents, limitsSchema.parse({}), [{ ...rootProfile, tools: ['python'], reasoning: 'react' }]);
  const result = await runtime.run({ ...initialStrategy, program: 'return {action:"STOP"};', prompts: programPrompts }, { id: 'python-fixture', prompt: 'Add one third and one sixth.' });
  assert.equal(result.answer, '1/2'); assert.ok(result.toolEvents.length); assert.equal(calls, 2);
});

test('parallel validation preserves task order and executes every task despite early poor scores', async () => {
  let active = 0, peak = 0, calls = 0;
  const results = await parallelMap(Array.from({ length: 17 }, (_, i) => i), 3, async (i) => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 1)); active--;
    return i;
  });
  assert.deepEqual(results, Array.from({ length: 17 }, (_, i) => i));
  assert.equal(calls, 17); assert.equal(peak, 3);
  assert.equal(unrestrictedConfig(393216).episode.maxTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(aflowConfigSchema.parse({}).maxRounds, null);
});

test('official AFlow controller fully repeats candidates, freezes selection, and resumes without new calls', async (t) => {
  const python = resolve('../MFlow-baselines/.venv-aflow/bin/python');
  const source = resolve('../MFlow-baselines/sources/AFlow');
  try { await access(python); await access(source); }
  catch { t.skip('Official AFlow checkout and Python environment are required'); return; }
  try { await pythonImage(); } catch { t.skip('Docker Python image unavailable'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'mflow-native-test-'));
  const oldKey = process.env.MFLOW_API_KEY;
  process.env.MFLOW_API_KEY = 'offline-fixture';
  let agents = 0, proposals = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const payload = JSON.parse(input.messages[1].content);
    let value;
    if (payload.kind === 'aflow-optimizer') {
      proposals++;
      assert.ok(input.messages[0].content.includes('parent_execution'));
      assert.ok(input.messages[0].content.includes('initialAgents'));
      assert.ok(input.messages[0].content.includes('nodeCalls'));
      assert.ok(input.messages[0].content.includes('composition'));
      assert.ok(input.messages[0].content.includes('agentTemplates'));
      assert.ok(input.messages[0].content.includes('RUN_TEMPLATE'));
      value = { organization: initialOrganization, modification: `Change the agent instructions (${proposals}).`, composition: initialLibraryComposition, prompts: { ...programPrompts, agent: 'NATIVE-CANDIDATE-MARKER' } };
    } else {
      agents++;
      const candidate = input.messages[0].content.includes('NATIVE-CANDIDATE-MARKER');
      // Candidate is deliberately worse: it must still execute every task/repetition.
      value = output(candidate ? 'wrong' : '42');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const search = join(dir, 'tasks.jsonl');
    await writeFile(search, [0, 1, 2, 3].map((i) => JSON.stringify({ id: `train-${i}`, prompt: `fixture ${i}`, answer: '42', metric: 'exact' })).join('\n') + '\n');
    const options = { out: join(dir, 'search'), search, source, python,
      config: { maxRounds: 1, validationRounds: 2, concurrency: 2 },
      model: { model: 'fixture', baseUrl: `http://127.0.0.1:${address.port}`, temperature: 0, seed: 42 } };
    await runAFlowSearch(options);
    assert.equal(agents, 16); assert.equal(proposals, 1);
    const records = JSON.parse(await readFile(join(options.out, 'MATH/workflows/results.json'), 'utf8'));
    assert.deepEqual(records.map((r: {score: number}) => r.score), [1, 1, 0, 0]);
    const bundle = JSON.parse(await readFile(join(options.out, 'best.json'), 'utf8'));
    assert.equal(bundle.strategy.id, 's1');
    assert.deepEqual(bundle.pool, initialOrganization.initialAgents);
    assert.deepEqual(bundle.strategy.organization, initialOrganization);
    const library = JSON.parse(await readFile(join(options.out, 'agent-library.json'), 'utf8'));
    assert.deepEqual(library.templates, bundle.strategy.organization.agentTemplates);
    assert.equal(library.selectedRound, 1);
    const child = JSON.parse(await readFile(join(options.out, 'MATH/workflows/round_2/strategy.json'), 'utf8'));
    assert.deepEqual(child.organization, initialOrganization);
    assert.equal(child.composition, initialLibraryComposition);
    const parentContext = JSON.parse(await readFile(join(options.out, 'MATH/workflows/round_2/parent_context.json'), 'utf8'));
    assert.deepEqual(parentContext.strategy.organization, initialOrganization);
    assert.equal(parentContext.strategy.composition, initialLibraryComposition);
    assert.equal(parentContext.execution.length, 2);
    assert.equal(parentContext.execution[0].evaluated, 4);
    assert.equal(bundle.config.prefixCache, false);
    await runAFlowSearch({ ...options, resume: true });
    assert.equal(agents, 16); assert.equal(proposals, 1);
    // Reconstruct a crash after usage settlement but before the last task row commit.
    const checkpointPath = join(options.out, 'controller.json');
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    checkpoint.phase = 'evaluating'; checkpoint.round = 1;
    checkpoint.experience = JSON.parse(await readFile(join(options.out, 'MATH/workflows/round_2/experience.json'), 'utf8'));
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    await rm(join(options.out, 'round-2/pass-1/0.json'));
    await runAFlowSearch({ ...options, resume: true });
    assert.equal(agents, 17); assert.equal(proposals, 1);
    assert.equal(JSON.parse(await readFile(join(options.out, 'round-2/pass-1/0.json'), 'utf8')).tokens, 40);
    await assert.rejects(runAFlowSearch({ ...options, resume: true, config: { ...options.config, validationRounds: 3 } }), /manifest mismatch/);
    const unbounded = { ...options, out: join(dir, 'convergence'), config: { ...options.config, maxRounds: null, validationRounds: 1 } };
    await runAFlowSearch(unbounded);
    const stopped = JSON.parse(await readFile(join(unbounded.out, 'controller.json'), 'utf8'));
    assert.equal(stopped.stopReason, 'converged');
    // [1,0,0,0,0,0,0,0]: top-three mean stabilizes after the third node,
    // then requires five more native convergence comparisons.
    assert.equal(stopped.round, 8);
    assert.equal(proposals, 8);
    assert.equal(agents, 49);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.MFLOW_API_KEY; else process.env.MFLOW_API_KEY = oldKey;
  }
});

test('provider unavailability aborts native search without writing zero scores', async (t) => {
  const python=resolve('../MFlow-baselines/.venv-aflow/bin/python'), source=resolve('../MFlow-baselines/sources/AFlow');
  try { await access(python); await access(source); await pythonImage(); }
  catch { t.skip('Native controller and Docker required'); return; }
  const dir=await mkdtemp(join(tmpdir(),'mflow-outage-'));
  const oldKey=process.env.MFLOW_API_KEY; process.env.MFLOW_API_KEY='fixture';
  let calls=0;
  const server=createServer((_req,res)=>{calls++;res.writeHead(402,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture unavailable'}}));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  try {
    const search=join(dir,'tasks.jsonl');await writeFile(search,JSON.stringify({id:'fixture',prompt:'fixture',answer:'42',metric:'exact'})+'\n');
    await assert.rejects(runAFlowSearch({out:join(dir,'search'),search,source,python,config:{maxRounds:1,validationRounds:1,concurrency:1},model:{model:'fixture',baseUrl:`http://127.0.0.1:${addr.port}`,temperature:0,seed:42}}),/controller exited/);
    assert.equal(calls,1);
    await assert.rejects(access(join(dir,'search/round-1/pass-0/0.json')));
    await assert.rejects(access(join(dir,'search/best.json')));
  } finally {
    server.close();await rm(dir,{recursive:true,force:true});
    if(oldKey===undefined)delete process.env.MFLOW_API_KEY;else process.env.MFLOW_API_KEY=oldKey;
  }
});

test('optimizer infrastructure/format failure stops without creating phantom rounds',async(t)=>{
  const python=resolve('../MFlow-baselines/.venv-aflow/bin/python'),source=resolve('../MFlow-baselines/sources/AFlow');
  try{await access(python);await access(source);await pythonImage();}
  catch{t.skip('Native controller and Docker required');return;}
  const dir=await mkdtemp(join(tmpdir(),'mflow-optimizer-fault-'));
  const oldKey=process.env.MFLOW_API_KEY;process.env.MFLOW_API_KEY='fixture';let calls=0;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);const payload=JSON.parse(input.messages[1].content);calls++;
    const content=payload.kind==='agent'?JSON.stringify(output('42')):'invalid JSON';
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');
  try{
    const search=join(dir,'tasks.jsonl');await writeFile(search,JSON.stringify({id:'fixture',prompt:'fixture',answer:'42',metric:'exact'})+'\n');
    const out=join(dir,'search');
    await assert.rejects(runAFlowSearch({out,search,source,python,config:{maxRounds:1,validationRounds:1,concurrency:1},model:{model:'fixture',baseUrl:`http://127.0.0.1:${address.port}`,temperature:0,seed:42}}),/controller exited/);
    const checkpoint=JSON.parse(await readFile(join(out,'controller.json'),'utf8'));
    assert.equal(checkpoint.round,1);assert.equal(checkpoint.phase,'generating');
    assert.equal(calls,3); // Initial execution, optimizer, one syntax-only repair.
    await assert.rejects(access(join(out,'MATH/workflows/round_2/strategy.json')));
  }finally{server.close();await rm(dir,{recursive:true,force:true});if(oldKey===undefined)delete process.env.MFLOW_API_KEY;else process.env.MFLOW_API_KEY=oldKey;}
});
