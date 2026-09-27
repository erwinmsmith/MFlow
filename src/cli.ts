import { parseArgs } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
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
import { DittoAgents, MeteredProvider, httpProvider } from "./ditto.js";
import { prepare, readTasks, promptKey } from "./data.js";
import { grade, checkScoring } from "./grading.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  searchConfigSchema,
  strategySchema,
  profileSchema,
  rootProfile,
  type SearchConfig,
} from "./types.js";
import { OrganizationRuntime } from "./runtime.js";
import { CanonicalPool } from "./canonical.js";
import { Search, type Bundle } from "./search.js";
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
    "search-size": { type: "string" },
    "confirmation-size": { type: "string" },
  },
});
const required = (key: keyof typeof values) => {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
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
  };
}
async function outputDirectory(path: string) {
  await mkdir(path, { recursive: false });
}
async function run() {
  const command = positionals[0];
  if (command === "benchmarks") {
    const exec = promisify(execFile);
    const args = ["scripts/benchmarks.py", "--name", values.name ?? "all",
      "--out", values.out ?? "data/benchmarks", "--seed", values.seed ?? "42",
      "--search-size", values["search-size"] ?? "64",
      "--confirmation-size", values["confirmation-size"] ?? "16"];
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
            ditto: "0.1.1",
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
    const tasks = await readTasks(required("search")),
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
    const agents = new DittoAgents(provider, bundle.model);
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
      ).run(bundle.strategy, task);
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
    const tasks = await readTasks(required("test"));
    await checkScoring(tasks);
    for (const t of tasks)
      if (
        bundle.selectionTaskIds.includes(t.id) ||
        bundle.selectionPromptHashes.includes(digest(promptKey(t))) ||
        (t.group && bundle.selectionGroups.includes(t.group))
      )
        throw new Error(`Test overlaps strategy selection data: ${t.id}`);
    const out = required("out");
    await outputDirectory(out);
    const results = [];
    for (const task of tasks) {
      const execution = await execute({
        id: task.id,
        prompt: task.prompt,
      });
      const result = {
        taskId: task.id,
        ...await grade(task, execution.answer),
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
      protocol,
      actualTokens: provider.tokens,
      usage: provider.records,
    });
    console.log(`Test results written to ${out}`);
    return;
  }
  console.log(`MFlow (Node 24+, published Ditto 0.1.1)
  doctor
  prepare --input tasks.jsonl --out data/prepared --seed 42
  search --search data/prepared/search.jsonl --confirmation data/prepared/confirmation.jsonl --config configs/search.json --out runs/search-1
  evaluate --bundle runs/search-1/best.json --test data/prepared/test.jsonl --out runs/test-1
  infer --bundle runs/search-1/best.json --question "..."
Optional search --pool profiles.json; each invocation resets the frozen profile pool.
Search supports prefixCache and agentCache.
For continual infer/evaluate: --protocol continual --state-out state.json [--state previous-state.json].`);
}
async function loadBundle(path: string): Promise<Bundle> {
  const raw = (await json(path)) as Bundle;
  if (
    raw.version !== 2 ||
    raw.dittoVersion !== "0.1.1" ||
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
