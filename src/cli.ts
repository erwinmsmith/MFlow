import { parseArgs } from "node:util";
import { z } from "zod";
import { readFile, mkdir, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createDitto,
  createContextWorker,
  graph,
  checkpointState,
  restoreState,
  BranchStore,
  TokenBudget,
  stateDigest,
  type StoreSnapshot,
} from "@codesoul-co/ditto";
import { DittoAgents, MeteredProvider, httpProvider, executionVersion, arithmeticTool } from "./ditto.js";
import { createPythonTool, createBenchmarkWebTool } from './python-tool.js';
import { prepare, readTasks, assertTestDisjoint } from "./data.js";
import { grade, checkScoring, gradingIdentity } from "./grading.js";
import { benchmarkHome, benchmarkPath, benchmarkName } from './benchmark-hub.js';
import { executeBenchmark } from './benchmark-environment.js';
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  searchConfigSchema,
  strategySchema,
  profileSchema,
  rootProfile,
  initialStrategy,
  type SearchConfig,
} from "./types.js";
import { OrganizationRuntime } from "./runtime.js";
import { CanonicalPool } from "./canonical.js";
import { Search, type Bundle } from "./search.js";
import { evaluateFrozen, evaluateConcurrent, checkpointExecution } from "./evaluation.js";
import { save, append, digest, mean } from "./util.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: "string" },
    out: { type: "string" },
    config: { type: "string" },
    search: { type: "string" },
    confirmation: { type: "string" },
    test: { type: "string" },
    bundle: { type: "string" },
    question: { type: "string" },
    pool: { type: "string" },
    seed: { type: "string" },
    protocol: { type: "string" },
    state: { type: "string" },
    "state-out": { type: "string" },
    name: { type: "string" },
    benchmark: { type: 'string' },
    split: { type: 'string' },
    verify: { type: "boolean" },
    resume: { type: "boolean" },
    source: { type: "string" },
    python: { type: "string" },
    concurrency: { type: 'string' },
    initialization: { type: 'string' },
  },
});
const required = (key: keyof typeof values) => {
  const value = values[key];
  if (typeof value !== "string" || !value) throw new Error(`--${key} is required`);
  return value;
};
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
function model(seed: number) {
  const name = process.env.MFLOW_MODEL ?? "deepseek-flash";
  return {
    model: name,
    baseUrl: process.env.MFLOW_BASE_URL ?? "https://api.deepseek.com",
    temperature: 0,
    seed,
    ...(process.env.MFLOW_PROVIDER_OPTIONS ? { providerOptions:
      z.record(z.string(), z.unknown()).parse(JSON.parse(process.env.MFLOW_PROVIDER_OPTIONS)) } : {}),
  };
}
async function outputDirectory(path: string) {
  await mkdir(path, { recursive: false });
}
async function run() {
  const command = positionals[0];
  const datasetPath = async (role: 'search' | 'test') => {
    if (values[role]) return values[role]!;
    if (values.benchmark) return benchmarkPath(values.benchmark, role);
    return required(role);
  };
  if (values.resume && ((command !== "evaluate" && command !== "search") || (values.protocol && values.protocol !== "standard")))
    throw new Error("--resume supports frozen standard evaluation only");
  if (command === "benchmarks") {
    const exec = promisify(execFile);
    if (values.seed) throw new Error("AFlow benchmark splits are fixed; --seed cannot resplit them");
    const action = positionals[1] ?? (values.verify ? 'verify' : 'list');
    const args = values.out ? ["scripts/benchmarks.py", "--name", values.name ?? "all",
      "--out", values.out, ...(values.verify ? ["--verify"] : [])] :
      ['benchmark-hub/bench.py', '--root', benchmarkHome(), action,
        ...(action === 'verify' ? ['--name', values.name ?? 'all'] : []),
        ...(action === 'path' ? [required('name'), ...(values.split ? ['--split', values.split] : [])] : [])];
    const { stdout } = await exec(process.env.MFLOW_BENCH_PYTHON ?? "python3", args, { maxBuffer: 2_000_000 });
    process.stdout.write(stdout);
    return;
  }
  if (command === "prepare") {
    await prepare(
      required("input"),
      required("out"),
      Number(values.seed ?? 42),
    );
    console.log("Prepared disjoint search, confirmation and test splits.");
    return;
  }
  if (command === 'seed') {
    const name = benchmarkName(required('benchmark'));
    if (name !== 'hle' && name !== 'automationbench') throw new Error('seed supports hle and automationbench');
    const { benchmarkSeed, benchmarkSeeds } = await import('./aflow-seed.js');
    const { unrestrictedConfig, aflowConfigSchema } = await import('./aflow-search.js');
    const input: Parameters<typeof benchmarkSeed>[0] = [{ benchmark: name, metric: name }];
    const seed = values.initialization ? benchmarkSeeds(input, [values.initialization])[0] : benchmarkSeed(input);
    const config = unrestrictedConfig(aflowConfigSchema.parse({}).maxOutputTokens);
    const bundle: Bundle = { version: 3, executionVersion, dittoVersion: '0.1.2',
      model: model(42), config, strategy: { ...initialStrategy, id: `${name}-unsearched-seed`,
        composition: seed.composition, organization: seed.organization, prompts: seed.prompts },
      pool: seed.organization.initialAgents, experimentalScope: 'standard-isolated-state-v2', searchDataHash: digest([]),
      selectionTaskIds: [], selectionPromptHashes: [], selectionGroups: [] };
    await access(required('out')).then(() => { throw new Error('Seed output already exists'); }, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await save(required('out'), bundle);
    console.log('Saved an unsearched seed bundle; no dataset or model was accessed.');
    return;
  }
  if (command === "doctor") {
    const runtime = createDitto({ workers: [createContextWorker()] });
    try {
      const result = await runtime.run(
        graph<string>("package-check").node(
          "context",
          "CONTEXT.LOAD",
          [],
          (text) => ({ sources: [{ role: "user", content: text }] }),
        ),
        "published-package-probe",
      );
      if (result.context.items[0]?.content !== "published-package-probe")
        throw new Error("Ditto context contract failed");
      const checkpoint = checkpointState("doctor", "1", { step: 1 });
      if (restoreState(checkpoint, "doctor", "1").step !== 1)
        throw new Error("Checkpoint probe failed");
      const store = new BranchStore("doctor"),
        a = store.fork(),
        b = store.fork();
      a.set("memory", 1);
      a.discard();
      if (b.get("memory") !== undefined)
        throw new Error("Fork isolation probe failed");
      b.set("memory", 2);
      b.commit();
      const budget = new TokenBudget(10);
      budget.reserve(10, { runId: "doctor" })({ totalTokens: 4 });
      if (budget.remaining !== 6) throw new Error("Budget probe failed");
      console.log(
        JSON.stringify(
          {
            node: process.version,
            ditto: "0.1.2",
            contextGraph: "passed",
            prefixCheckpoint: "explicit-state roundtrip passed",
            resourceFork:
              "explicit-state isolation passed; external resources unsupported",
            tokenReservation:
              "passed; physical bound depends on provider estimator",
            protocols: ["standard", "continual"],
          },
          null,
          2,
        ),
      );
    } finally {
      await runtime.close();
    }
    return;
  }
  if (command === "search") {
    if (values.confirmation || values.pool || values.state || values['state-out'] || (values.protocol && values.protocol !== 'standard'))
      throw new Error('Official AFlow search uses the full validation split and fresh standard episodes');
    const { runAFlowSearch, aflowConfigSchema } = await import('./aflow-search.js');
    const config = aflowConfigSchema.parse(values.config ? await json(values.config) : {});
    await runAFlowSearch({ out: required('out'), search: await datasetPath('search'), config,
      model: model(config.seed), resume: !!values.resume,
      source: values.source ?? '../MFlow-baselines/sources/AFlow',
      python: values.python ?? '../MFlow-baselines/.venv-aflow/bin/python' });
    console.log(`Exported frozen strategy to ${join(required('out'), 'best.json')}`);
    if (values.test) {
      // Test is opened only after the controller has returned and frozen its selection.
      const testOut = join(required('out'), 'test');
      const resumeTest = await access(join(testOut, 'manifest.json')).then(() => true, () => false);
      const child = (await import('node:child_process')).spawn(process.execPath,
        [new URL('./cli.js', import.meta.url).pathname, 'evaluate', '--bundle', join(required('out'), 'best.json'),
          '--test', values.test, '--out', testOut, ...(resumeTest ? ['--resume'] : [])], { stdio: 'inherit' });
      await new Promise<void>((done, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? done() : reject(new Error(`Frozen test exited ${code}`)));
      });
    }
    return;
  }
  if (command === "legacy-search") {
    if (
      (values.protocol && values.protocol !== "standard") ||
      values.state ||
      values["state-out"]
    )
      throw new Error(
        "Strategy search uses a fixed standard pool; continual is an infer/evaluate protocol",
      );
    const config = searchConfigSchema.parse(
      values.config ? await json(values.config) : {},
    );
    const settings = model(config.seed),
      provider = new MeteredProvider(
        httpProvider(settings, process.env.MFLOW_API_KEY ?? ""),
      );
    const pool = values.pool
      ? profileSchema
          .array()
          .min(1)
          .parse(await json(values.pool))
      : [rootProfile];
    const runtime = new OrganizationRuntime(
      new DittoAgents(provider, settings),
      config.episode,
      pool,
    );
    const tasks = await readTasks(await datasetPath('search')),
      confirmation = values.confirmation
        ? await readTasks(values.confirmation)
        : [];
    await checkScoring([...tasks, ...confirmation]);
    const out = required("out");
    await outputDirectory(out);
    const bundle = await new Search(runtime, config, out).run(
      tasks,
      confirmation,
    );
    console.log(`Exported ${bundle.strategy.id} to ${join(out, "best.json")}`);
    return;
  }
  if (command === "evaluate" || command === "infer") {
    const bundle = await loadBundle(required("bundle"));
    const provider = new MeteredProvider(
      httpProvider(bundle.model, process.env.MFLOW_API_KEY ?? ""),
    );
    const protocol = values.protocol ?? "standard";
    if (!["standard", "continual"].includes(protocol))
      throw new Error("Unknown execution protocol");
    if (protocol === "standard" && (values.state || values["state-out"]))
      throw new Error("Canonical state requires --protocol continual");
    if (protocol === "continual") required("state-out");
    const agents = new DittoAgents(provider, bundle.model,
      bundle.pythonImage ? [arithmeticTool, createPythonTool(bundle.pythonImage), ...(bundle.webSearch?[createBenchmarkWebTool()]:[])] : undefined);
    // Independent held-out evaluation does not share the training execution cache.
    const canonical =
      protocol === "continual"
        ? new CanonicalPool(
            bundle.pool,
            stateDigest(bundle),
            values.state
              ? ((await json(values.state)) as StoreSnapshot)
              : undefined,
          )
        : undefined;
    const execute = async (task: { id: string; prompt: string }) => {
      canonical?.assertUnseen(task);
      return new OrganizationRuntime(
        agents,
        bundle.config.episode,
        canonical?.profiles() ?? bundle.pool,
      ).run(canonical ? { ...bundle.strategy, organization: undefined } : bundle.strategy, task);
    };
    const commit = async (
      execution: Awaited<ReturnType<typeof execute>>,
      task: { id: string; prompt: string },
    ) => {
      if (!canonical) return;
      await canonical.commit(execution, task, agents, bundle.config.episode);
      await save(required("state-out"), canonical.snapshot());
    };
    if (command === "infer") {
      const task = {
        id: `inference:${digest(required("question"))}`,
        prompt: required("question"),
      };
      const execution = await execute(task);
      await commit(execution, task);
      console.log(
        JSON.stringify(
          { protocol, execution, usage: provider.records },
          null,
          2,
        ),
      );
      return;
    }
    const tasks = await readTasks(await datasetPath('test'));
    if (protocol === 'continual' && tasks.some(t => t.metric === 'automationbench'))
      throw new Error('AutomationBench uses fresh standard task worlds; continual evaluation is not supported');
    const knownSourceOverlaps = assertTestDisjoint(tasks, bundle);
    if (knownSourceOverlaps.length)
      console.log(`Retaining ${knownSourceOverlaps.length} documented AFlow DROP prompt overlaps for exact split replication.`);
    await checkScoring(tasks);
    const out = required("out");
    if (protocol === "standard") {
      const manifest = {
        ...await gradingIdentity(tasks),
        bundleHash: digest(bundle), testDataHash: digest(tasks), protocol,
        gradingCode: digest(await readFile(new URL("./grading.js", import.meta.url), "utf8")),
        mathGrader: digest(await readFile("scripts/grade_math.py", "utf8")),
        dependencies: digest(await readFile("package-lock.json", "utf8")),
        benchmarkPython: process.env.MFLOW_BENCH_PYTHON ?? "python3",
        pythonEnvironment: (await promisify(execFile)(process.env.MFLOW_BENCH_PYTHON ?? "python3", ["-c",
          "import sys,json,importlib.metadata as m; print(json.dumps([sys.version, sorted((p.metadata['Name'],p.version) for p in m.distributions())]))"])).stdout.trim(),
      };
      const concurrency = z.coerce.number().int().positive().parse(values.concurrency ?? 1);
      const serial = () => evaluateFrozen({ out, resume: !!values.resume, manifest, tasks, provider,
        evaluate: async (task) => {
          const execution = await checkpointExecution(join(out, 'executions', `${digest(task.id)}.json`), task.id,
            () => executeBenchmark(task, agents, bundle.strategy, bundle.config.episode, bundle.pool));
          return { taskId: task.id, ...await grade(task, execution.answer, execution, agents), execution };
        },
      });
      const concurrent = async () => {
        if (values.resume) {
          if (digest(await json(join(out, 'manifest.json'))) !== digest(manifest)) throw new Error('Evaluation resume manifest mismatch');
        } else { await mkdir(out, {recursive:false}); await save(join(out,'manifest.json'), manifest); }
        const dir = join(out, 'task-usage'); await mkdir(dir, {recursive:true});
        const result = await evaluateConcurrent({out,tasks,concurrency,evaluate:async task => {
          const usagePath = join(dir,`${digest(task.id)}.json`);
          const previous = await json(usagePath).catch((e: NodeJS.ErrnoException) => {if(e.code!=='ENOENT')throw e;return [];}) as typeof provider.records;
          const meter = new MeteredProvider(httpProvider(bundle.model,process.env.MFLOW_API_KEY??'',{
            onProgress:p=>save(join(out,'requests',`${p.id}.json`),{taskId:task.id,...p}),
          }),undefined,records=>save(usagePath,[...previous,...records]));
          const local = new DittoAgents(meter,bundle.model,bundle.pythonImage?[arithmeticTool,createPythonTool(bundle.pythonImage),...(bundle.webSearch?[createBenchmarkWebTool()]:[])]:[]);
          const execution = await checkpointExecution(join(out,'executions',`${digest(task.id)}.json`),task.id,
            ()=>executeBenchmark(task,local,bundle.strategy,bundle.config.episode,bundle.pool));
          return {taskId:task.id,...await grade(task,execution.answer,execution,local),execution};
        }});
        const records = (await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).map(n=>json(join(dir,n))))).flat() as typeof provider.records;
        const unknownCalls=records.filter(r=>r.status!=='known').length,knownTokens=records.filter(r=>r.status==='known').reduce((n,r)=>n+r.charged,0);
        await save(join(out,'usage.json'),records);
        if (result.errors.length) throw new Error(`${result.errors.length} test tasks failed; saved results can be resumed`);
        return {...result,usage:records,actualTokens:unknownCalls?null:knownTokens,accounting:{knownTokens,unknownCalls,chargedTokens:records.reduce((n,r)=>n+r.charged,0)}};
      };
      const result = await (concurrency > 1 ? concurrent() : serial());
      await save(join(out, "summary.json"), {
        strategy: bundle.strategy.id, count: result.rows.length,
        accuracy: mean(result.rows.map((r) => r.score)),
        ...(result.rows.some((r) => r.f1 !== undefined) ? { meanF1: mean(result.rows.map((r) => r.f1 ?? 0)) } : {}),
        ...(result.rows.some(r => r.partialCredit !== undefined) ? { meanPartialCredit: mean(result.rows.map(r => r.partialCredit ?? 0)), passRate: mean(result.rows.map(r => r.score)) } : {}),
        meanTokens: mean(result.rows.map((r) => r.execution.tokens)),
        testDataHash: digest(tasks), knownSourceOverlaps, protocol,
        actualTokens: result.actualTokens, accounting: result.accounting, usage: result.usage,
      });
      console.log(`Test results written to ${out}`);
      return;
    }
    await outputDirectory(out);
    const results = [];
    try {
    for (const task of tasks) {
      const execution = await execute({
        id: task.id,
        prompt: task.prompt,
      });
      const result = {
        taskId: task.id,
        ...await grade(task, execution.answer, execution, agents),
        execution,
      };
      results.push(result);
      await append(join(out, "test.jsonl"), result);
      await commit(execution, { id: task.id, prompt: task.prompt });
    }
    await save(join(out, "summary.json"), {
      strategy: bundle.strategy.id,
      count: results.length,
      accuracy: mean(results.map((r) => r.score)),
      ...(results.some((r) => r.f1 !== undefined) ? { meanF1: mean(results.map((r) => r.f1 ?? 0)) } : {}),
      meanTokens: mean(results.map((r) => r.execution.tokens)),
      testDataHash: digest(tasks),
      knownSourceOverlaps,
      protocol,
      actualTokens: provider.tokens,
      usage: provider.records,
    });
    } finally {
      await save(join(out, "usage.json"), provider.records);
    }
    console.log(`Test results written to ${out}`);
    return;
  }
  console.log(`MFlow (Node 24+, published Ditto 0.1.2)
  doctor
  benchmarks --name all [--verify]
  seed --benchmark hle|automationbench --out runs/seed.json
  prepare --input tasks.jsonl --out data/prepared --seed 42
  search --search data/benchmarks/math/search.jsonl --config configs/aflow-search.json --out runs/search-1 [--test data/benchmarks/math/test.jsonl] [--resume]
  legacy-search --search data/prepared/search.jsonl --config configs/search.json --out runs/legacy-1
  evaluate --bundle runs/search-1/best.json --test data/prepared/test.jsonl --out runs/test-1 [--resume]
  infer --bundle runs/search-1/best.json --question "..."
Default search reuses the official AFlow controller and fully reexecutes every validation pass.
For continual infer/evaluate: --protocol continual --state-out state.json [--state previous-state.json].`);
}
async function loadBundle(path: string): Promise<Bundle> {
  const raw = (await json(path)) as Bundle;
  if (
    raw.version !== 3 ||
    raw.executionVersion !== executionVersion ||
    raw.dittoVersion !== "0.1.2" ||
    raw.experimentalScope !== "standard-isolated-state-v2"
  )
    throw new Error("Incompatible strategy bundle");
  strategySchema.parse(raw.strategy);
  profileSchema.array().min(1).parse(raw.pool);
  searchConfigSchema.parse(raw.config);
  for (const key of [
    "selectionTaskIds",
    "selectionPromptHashes",
    "selectionGroups",
  ] as const)
    if (!Array.isArray(raw[key]) || raw[key].some((v) => typeof v !== "string"))
      throw new Error("Invalid split provenance");
  return raw;
}
void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

// Exporting no mutable search state keeps inference independent of the search tree.
export type { SearchConfig };
