import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { MeteredProvider } from "./ditto.js";
import type { Evaluated, Task, Execution } from "./types.js";
import { append, digest, save } from "./util.js";

/** Persist model work before grading, including across a failed grading/resume. */
export async function checkpointExecution(path: string, taskId: string, execute: () => Promise<Execution>): Promise<Execution> {
  try {
    const execution = JSON.parse(await readFile(path, 'utf8')) as Execution;
    if (execution.taskId !== taskId || typeof execution.answer !== 'string') throw new Error('Invalid execution checkpoint');
    return execution;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const execution = await execute();
  await mkdir(dirname(path), { recursive: true });
  await save(path, execution);
  return execution;
}

/** Frozen standard evaluation: persist failures/usage and resume completed tasks exactly once. */
export async function evaluateFrozen(options: {
  out: string; resume: boolean; manifest: unknown; tasks: Task[];
  provider: MeteredProvider; evaluate: (task: Task) => Promise<Evaluated>;
}) {
  const { out, resume, manifest, tasks, provider, evaluate } = options;
  let rows: Evaluated[] = [], previousUsage: typeof provider.records = [];
  if (resume) {
    const saved = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    if (digest(saved) !== digest(manifest)) throw new Error("Evaluation resume manifest mismatch");
    const readOrEmpty = async (name: string) => readFile(join(out, name), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    rows = (await readOrEmpty("test.jsonl")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const usage = await readOrEmpty("usage.json");
    previousUsage = usage ? JSON.parse(usage) : [];
    if (new Set(rows.map((r) => r.taskId)).size !== rows.length ||
        rows.some((r, i) => r.taskId !== tasks[i]?.id)) throw new Error("Invalid completed evaluation prefix");
  } else {
    await mkdir(out, { recursive: false });
    await save(join(out, "manifest.json"), manifest);
  }
  const usage = () => [...previousUsage, ...provider.records];
  for (const task of tasks.slice(rows.length)) {
    await append(join(out, "attempts.jsonl"), { taskId: task.id, event: "started", at: new Date().toISOString() });
    try {
      const result = await evaluate(task);
      // Write cost first: an interruption must not leave a completed row without known cost.
      await save(join(out, "usage.json"), usage());
      await append(join(out, "test.jsonl"), result);
      rows.push(result);
      await append(join(out, "attempts.jsonl"), { taskId: task.id, event: "completed", at: new Date().toISOString() });
    } catch (error) {
      await save(join(out, "usage.json"), usage());
      await append(join(out, "errors.jsonl"), { taskId: task.id, error: String(error), at: new Date().toISOString() });
      await save(join(out, "status.json"), { status: "failed", taskId: task.id, completed: rows.length, planned: tasks.length, error: String(error) });
      throw error;
    }
  }
  await save(join(out, "status.json"), { status: "completed", completed: rows.length, planned: tasks.length });
  const records = usage(), unknownCalls = records.filter((r) => r.status !== "known").length;
  const knownTokens = records.filter((r) => r.status === "known").reduce((sum, r) => sum + r.charged, 0);
  const chargedTokens = records.reduce((sum, r) => sum + r.charged, 0);
  return { rows, usage: records, actualTokens: unknownCalls ? null : knownTokens,
    accounting: { knownTokens, unknownCalls, chargedTokens } };
}

/** Independent episodes; out-of-order completion and failures never block other tasks. */
export async function evaluateConcurrent(options: {
  out: string; tasks: Task[]; concurrency: number;
  evaluate: (task: Task) => Promise<Evaluated>;
}) {
  const { out, tasks, concurrency, evaluate } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  const rowDir = join(out, 'rows');
  await mkdir(rowDir, { recursive: true });
  const valid = new Set(tasks.map(t => t.id)), rows = new Map<string, Evaluated>();
  if (valid.size !== tasks.length) throw new Error('Duplicate test task');
  const accept = (row: Evaluated) => {
    if (!valid.has(row.taskId) || row.execution.taskId !== row.taskId) throw new Error('Unexpected test result');
    const previous = rows.get(row.taskId);
    if (previous && digest(previous) !== digest(row)) throw new Error('Conflicting test result');
    rows.set(row.taskId, row);
  };
  const previous = await readFile(join(out, 'test.jsonl'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  for (const line of previous.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as Evaluated;
    if (rows.has(row.taskId)) throw new Error('Duplicate completed test result');
    accept(row);
  }
  // Recover a row saved just before a process interruption, without rerunning the model.
  for (const name of await readdir(rowDir)) {
    if (!name.endsWith('.json')) continue;
    const row = JSON.parse(await readFile(join(rowDir, name), 'utf8')) as Evaluated;
    const logged = rows.has(row.taskId);
    accept(row);
    if (!logged) await append(join(out, 'test.jsonl'), row);
  }
  const remaining = tasks.filter(t => !rows.has(t.id));
  let next = 0, active = 0, writes = Promise.resolve();
  const errors: { taskId: string; error: string }[] = [];
  const persist = (operation: () => Promise<void>) => {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  };
  const status = (state: string) => save(join(out, 'status.json'), {
    status: state, completed: rows.size, planned: tasks.length, active,
    concurrency, failed: errors.length, updatedAt: new Date().toISOString(),
  });
  await status('running');
  await Promise.all(Array.from({ length: Math.min(concurrency, remaining.length) }, async () => {
    while (next < remaining.length) {
      const task = remaining[next++];
      active++;
      await persist(() => append(join(out, 'attempts.jsonl'), { taskId: task.id, event: 'started', at: new Date().toISOString() }));
      try {
        const row = await evaluate(task);
        if (row.taskId !== task.id) throw new Error('Task result mismatch');
        await save(join(rowDir, `${digest(task.id)}.json`), row);
        await persist(async () => {
          accept(row);
          await append(join(out, 'test.jsonl'), row);
          await append(join(out, 'attempts.jsonl'), { taskId: task.id, event: 'completed', at: new Date().toISOString() });
        });
      } catch (error) {
        const failure = { taskId: task.id, error: String(error) };
        errors.push(failure);
        await persist(() => append(join(out, 'errors.jsonl'), { ...failure, at: new Date().toISOString() }));
      } finally {
        active--;
        await persist(() => status('running'));
      }
    }
  }));
  await status(rows.size === tasks.length ? 'completed' : 'incomplete');
  return { rows: tasks.flatMap(t => rows.has(t.id) ? [rows.get(t.id)!] : []), errors };
}
