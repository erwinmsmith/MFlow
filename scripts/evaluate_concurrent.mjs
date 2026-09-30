// Schedule frozen standard test episodes; execution stays in the selected runtime.
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, readdir, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateConcurrent, checkpointExecution } from '../dist/src/evaluation.js';

const { values } = parseArgs({ options: {
  bundle: { type: 'string' }, test: { type: 'string' }, out: { type: 'string' },
  runtime: { type: 'string' }, concurrency: { type: 'string', default: '50' }, resume: { type: 'boolean' },
} });
const required = name => { if (!values[name]) throw new Error(`--${name} is required`); return values[name]; };
const out = resolve(required('out')), runtime = resolve(required('runtime'));
const load = name => import(pathToFileURL(join(runtime, `${name}.js`)).href);
const [{ readTasks, assertTestDisjoint }, { digest, save, mean },
  { DittoAgents, MeteredProvider, httpProvider, executionVersion, arithmeticTool },
  { OrganizationRuntime }, { createPythonTool }, { grade, checkScoring, gradingIdentity },
  { strategySchema, searchConfigSchema, profileSchema }] = await Promise.all(
    ['data', 'util', 'ditto', 'runtime', 'python-tool', 'grading', 'types'].map(load));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const bundle = await json(required('bundle'));
if (bundle.version !== 3 || bundle.executionVersion !== executionVersion || bundle.dittoVersion !== '0.1.1'
    || bundle.experimentalScope !== 'standard-isolated-state-v2') throw new Error('Incompatible frozen bundle');
strategySchema.parse(bundle.strategy); searchConfigSchema.parse(bundle.config); profileSchema.array().min(1).parse(bundle.pool);
const tasks = await readTasks(required('test'));
const knownSourceOverlaps = assertTestDisjoint(tasks, bundle);
await checkScoring(tasks);
if (!process.env.MFLOW_API_KEY) throw new Error('MFLOW_API_KEY is required');
const concurrency = Number(values.concurrency);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
const python = process.env.MFLOW_BENCH_PYTHON ?? 'python3';
const manifest = { bundleHash: digest(bundle), testDataHash: digest(tasks), protocol: 'standard',
  ...(gradingIdentity ? await gradingIdentity(tasks) : {}),
  gradingCode: digest(await readFile(join(runtime, 'grading.js'), 'utf8')),
  mathGrader: digest(await readFile('scripts/grade_math.py', 'utf8')),
  dependencies: digest(await readFile('package-lock.json', 'utf8')), benchmarkPython: python,
  pythonEnvironment: (await promisify(execFile)(python, ['-c',
    "import sys,json,importlib.metadata as m; print(json.dumps([sys.version, sorted((p.metadata['Name'],p.version) for p in m.distributions())]))"])).stdout.trim() };
if (values.resume) {
  if (digest(await json(join(out, 'manifest.json'))) !== digest(manifest)) throw new Error('Evaluation resume manifest mismatch');
} else {
  await mkdir(out, { recursive: false });
  await save(join(out, 'manifest.json'), manifest);
}
const lockPath = join(out, 'concurrent.lock');
try {
  const old = await json(lockPath);
  let alive = true;
  try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  if (alive) throw new Error(`Concurrent evaluator already running: ${old.pid}`);
  await unlink(lockPath);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const lock = await open(lockPath, 'wx');
await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
try {
  const usageDir = join(out, 'task-usage');
  await mkdir(usageDir, { recursive: true });
  const legacyPath = join(out, 'serial-usage.json');
  const legacyUsage = await json(legacyPath).catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    const records = await json(join(out, 'usage.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    await save(legacyPath, records); return records;
  });
  const runtimeHashes = Object.fromEntries(await Promise.all((await readdir(runtime)).filter(n => n.endsWith('.js'))
    .map(async name => [name, digest(await readFile(join(runtime, name), 'utf8'))])));
  const scheduleIdentity = { runtimeHashes, episodeIsolation: 'one-provider-per-task', bundleHash: digest(bundle) };
  const previous = await json(join(out, 'concurrent-manifest.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (previous && digest(previous) !== digest(scheduleIdentity)) throw new Error('Frozen execution code changed');
  await save(join(out, 'concurrent-manifest.json'), scheduleIdentity);
  const result = await evaluateConcurrent({ out, tasks, concurrency, evaluate: async task => {
    const usagePath = join(usageDir, `${digest(task.id)}.json`);
    const earlier = await json(usagePath).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    let writes = Promise.resolve();
    const provider = new MeteredProvider(httpProvider(bundle.model, process.env.MFLOW_API_KEY, {
      onProgress: progress => save(join(out, 'requests', `${progress.id}.json`), { taskId: task.id, ...progress }),
    }), undefined, records => {
      const snapshot = [...earlier, ...records];
      writes = writes.then(() => save(usagePath, snapshot)); return writes;
    });
    const agents = new DittoAgents(provider, bundle.model,
      bundle.pythonImage ? [arithmeticTool, createPythonTool(bundle.pythonImage)] : undefined);
    const execution = await checkpointExecution(join(out, 'executions', `${digest(task.id)}.json`), task.id,
      () => new OrganizationRuntime(agents, bundle.config.episode, bundle.pool).run(bundle.strategy, { id: task.id, prompt: task.prompt }));
    return { taskId: task.id, ...await grade(task, execution.answer), execution };
  } });
  const records = [...legacyUsage];
  for (const name of await readdir(usageDir)) if (name.endsWith('.json')) records.push(...await json(join(usageDir, name)));
  await save(join(out, 'usage.json'), records);
  const interruption = await json(join(out, 'serial-interruption.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const unknownCalls = records.filter(r => r.status !== 'known').length;
  const knownTokens = records.filter(r => r.status === 'known').reduce((n,r) => n + r.charged, 0);
  const accounting = { knownTokens, recordedUnknownCalls: unknownCalls, recordedChargedTokens: records.reduce((n,r) => n+r.charged,0),
    unobservedInterruptedAttempts: interruption?.unobservedInterruptedAttempts ?? 0 };
  const summary = { strategy: bundle.strategy.id, count: result.rows.length, planned: tasks.length,
    correct: result.rows.reduce((n,r) => n+r.score,0), accuracy: mean(result.rows.map(r=>r.score)), complete: result.rows.length === tasks.length,
    meanTokens: mean(result.rows.map(r=>r.execution.tokens)), concurrency, testDataHash: digest(tasks), knownSourceOverlaps,
    protocol: 'standard', actualTokens: unknownCalls || accounting.unobservedInterruptedAttempts ? null : knownTokens, accounting,
    errors: result.errors };
  await save(join(out, summary.complete ? 'summary.json' : 'partial-summary.json'), summary);
  console.log(JSON.stringify(summary));
  if (!summary.complete) process.exitCode = 1;
} finally { await unlink(lockPath); }
