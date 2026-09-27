import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { taskSchema, type TaskInput, type Task } from "./types.js";
import { Random, digest, save } from "./util.js";

export async function readTasks(path: string): Promise<Task[]> {
  const text = await readFile(path, "utf8");
  const tasks = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, i) => {
      try {
        return taskSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`${path}:${i + 1}: ${error}`);
      }
    });
  if (!tasks.length) throw new Error("Dataset must not be empty");
  assertDisjoint(tasks);
  return tasks;
}
export const promptKey = (task: TaskInput) =>
  task.prompt.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
export function assertDisjoint(...splits: Task[][]) {
  const ids = new Set<string>(),
    prompts = new Map<string, number>(),
    groups = new Map<string, number>();
  splits.forEach((tasks, index) =>
    tasks.forEach((t) => {
      if (ids.has(t.id) || (prompts.has(promptKey(t)) && prompts.get(promptKey(t)) !== index))
        throw new Error(`Duplicate task ID or normalized prompt: ${t.id}`);
      if (t.group && groups.has(t.group) && groups.get(t.group) !== index)
        throw new Error(`Group crosses splits: ${t.group}`);
      ids.add(t.id);
      prompts.set(promptKey(t), index);
      if (t.group) groups.set(t.group, index);
    }),
  );
}
/** Fixed seed, group-preserving split. Explicit manifest makes preparation reproducible. */
export async function prepare(
  input: string,
  out: string,
  seed = 42,
  searchFraction = 0.6,
  confirmationFraction = 0.2,
) {
  if (
    searchFraction <= 0 ||
    confirmationFraction <= 0 ||
    searchFraction + confirmationFraction >= 1
  )
    throw new Error("Need positive search/confirmation/test fractions");
  const tasks = await readTasks(input),
    groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.group ? `group:${task.group}` : `task:${task.id}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  if (groups.size < 3)
    throw new Error("Need at least three independent task groups");
  const shuffled = new Random(seed).shuffle([...groups.values()]),
    a = Math.max(
      1,
      Math.min(
        shuffled.length - 2,
        Math.floor(shuffled.length * searchFraction),
      ),
    ),
    b = Math.max(
      a + 1,
      Math.min(
        shuffled.length - 1,
        Math.floor(shuffled.length * (searchFraction + confirmationFraction)),
      ),
    );
  const splits = {
    search: shuffled.slice(0, a).flat(),
    confirmation: shuffled.slice(a, b).flat(),
    test: shuffled.slice(b).flat(),
  };
  assertDisjoint(splits.search, splits.confirmation, splits.test);
  await mkdir(out, { recursive: true });
  for (const [name, rows] of Object.entries(splits))
    await writeFile(
      join(out, `${name}.jsonl`),
      rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
      { flag: "wx" },
    );
  await save(join(out, "manifest.json"), {
    version: 1,
    seed,
    sourceHash: digest(tasks),
    fractions: { searchFraction, confirmationFraction },
    grouped: true,
    splits: Object.fromEntries(
      Object.entries(splits).map(([name, rows]) => [
        name,
        { count: rows.length, ids: rows.map((t) => t.id), hash: digest(rows) },
      ]),
    ),
  });
  return splits;
}
export function score(task: Task, answer: string): 0 | 1 {
  if (task.metric !== "exact" && task.metric !== "numeric")
    throw new Error(`Use benchmark grader for ${task.metric}`);
  if (task.metric === "numeric") {
    const parse = (s: string) => {
      const clean = s.trim().replaceAll(",", "");
      return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(clean)
        ? Number(clean)
        : NaN;
    };
    const a = parse(answer),
      b = parse(task.answer);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6
      ? 1
      : 0;
  }
  const clean = (s: string) =>
    s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return clean(answer) === clean(task.answer) ? 1 : 0;
}
