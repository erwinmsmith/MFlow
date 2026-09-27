import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeteredProvider } from "./ditto.js";
import type { Evaluated, Task } from "./types.js";
import { append, digest, save } from "./util.js";

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
