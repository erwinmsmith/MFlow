import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import aflow from "../data/aflow.lock.json" with { type: "json" };
import evalplus from '../data/humaneval-plus.lock.json' with { type: 'json' };
import extended from '../data/extended-benchmarks.lock.json' with { type: 'json' };
import { taskSchema, type TaskInput, type Task } from "./types.js";
import { Random, digest, save } from "./util.js";
import { benchmarkPath, benchmarkHome, sharedPath } from './benchmark-hub.js';
import type { Message } from '@codesoul-co/ditto/worker/infer';

export async function readTasks(path: string): Promise<Task[]> {
  const shared = /^benchmark:([^/]+)\/(search|test)$/.exec(path);
  if (shared) path = await benchmarkPath(shared[1], shared[2] as 'search' | 'test');
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
  if (tasks.some((t) => t.aflowSplit)) {
    const first = tasks[0];
    const key = `${first.benchmark}_${first.aflowSplit}.jsonl` as keyof typeof aflow.files;
    const pinned = aflow.files[key];
    if (!pinned || createHash("sha256").update(text).digest("hex") !== pinned.convertedSha256)
      throw new Error("AFlow data must match the complete pinned split; run benchmarks --verify");
  }
  if (tasks.some(t => t.dataset)) {
    const first = tasks[0];
    const split = first.dataset?.split;
    const protocol = first.dataset?.protocol;
    const lock = protocol === evalplus.protocol ? evalplus : Object.values(extended).find(l => l.protocol === protocol);
    const splits = lock?.splits as Record<string, {sha256: string}> | undefined;
    if (!split || tasks.some(t => t.dataset?.split !== split || t.dataset.protocol !== protocol) ||
        createHash('sha256').update(text).digest('hex') !== splits?.[split]?.sha256)
      throw new Error('Benchmark data must match the complete locked split');
  }
  assertDisjoint(tasks);
  return tasks;
}
export const promptKey = (task: TaskInput) =>
  task.prompt.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()+(task.images?.length?'\nImages:'+task.images.map(i=>i.sha256).join(','):'');

/** Load only public question images; labels/rationales never enter the actor input. */
export async function actorInput(task: Task): Promise<TaskInput> {
  const imageParts=await Promise.all((task.images??[]).map(async image=>{
    const bytes=await readFile(sharedPath(benchmarkHome(),image.path));
    if(createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw new Error('Question image checksum mismatch');
    // Some official data URLs declare JPEG while carrying PNG/WebP bytes. Keep the bytes; normalize the transport MIME.
    const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':undefined;
    if(!mime)throw new Error('Unsupported question image bytes');
    return {type:'image_url' as const,image_url:{url:`data:${mime};base64,${bytes.toString('base64')}`,detail:'original' as const}};
  }));
  return {id:task.id,prompt:task.prompt,...(imageParts.length?{images:task.images,imageParts}:{})};
}
export function withTaskImages(messages: Message[], task?: TaskInput): Message[] {
  return task?.imageParts?.length?[...messages,{role:'user',content:[{type:'text',text:'Images supplied with this original question. Inspect them directly; do not invent missing visual details.'},...task.imageParts]}]:messages;
}

/** Logs retain asset identity instead of duplicating base64 in every node/turn. */
export function imageLog(value: unknown, task: TaskInput): unknown {
  const assets=new Map(task.imageParts?.map((p,i)=>[p.image_url.url,`benchmark-asset:${task.images![i].path}#sha256=${task.images![i].sha256}`]));
  return JSON.parse(JSON.stringify(value,(_key,v)=>typeof v==='string'?(assets.get(v)??v):v));
}

export function assertDatasetRole(tasks: Task[], role: "search" | "confirmation" | "test" | "prepare") {
  for (const task of tasks) {
    if (task.aflowSplit && task.aflowSplit !== ({ search: "validate", test: "test" } as Record<string, string>)[role])
      throw new Error(`AFlow ${task.aflowSplit} cannot be used for ${role}: ${task.id}`);
    if (task.dataset && task.dataset.split !== role)
      throw new Error(`${task.dataset.protocol} ${task.dataset.split} cannot be used for ${role}: ${task.id}`);
  }
}

/** HumanEval and its expanded tests are the same task family across protocols. */
const familyId = (id: string) => id.replace(/^humaneval_plus:/, 'humaneval:');

/** Preserve only the five prompt collisions already present in AFlow's pinned DROP split. */
export function assertTestDisjoint(tasks: Task[], selection: {
  selectionTaskIds: string[]; selectionPromptHashes: string[]; selectionGroups: string[];
}) {
  assertDatasetRole(tasks, "test");
  const knownOverlaps: typeof aflow.knownPromptOverlaps = [];
  for (const task of tasks) {
    const group = task.group;
    if (selection.selectionTaskIds.some(id => familyId(id) === familyId(task.id)) ||
        (group && selection.selectionGroups.some(id => familyId(id) === familyId(group))))
      throw new Error(`Test overlaps strategy selection data: ${task.id}`);
    const hash = digest(promptKey(task));
    selection.selectionPromptHashes.forEach((promptHash, i) => {
      if (promptHash !== hash) return;
      const known = task.aflowSplit === "test" && aflow.knownPromptOverlaps.find((entry) =>
        entry.testId === task.id && entry.searchId === selection.selectionTaskIds[i] && entry.promptHash === hash);
      if (!known) throw new Error(`Test overlaps strategy selection data: ${task.id}`);
      knownOverlaps.push(known);
    });
  }
  return knownOverlaps;
}
export function assertDisjoint(...splits: Task[][]) {
  const ids = new Set<string>(),
    prompts = new Map<string, number>(),
    groups = new Map<string, number>();
  splits.forEach((tasks, index) =>
    tasks.forEach((t) => {
      if (ids.has(familyId(t.id)) || (prompts.has(promptKey(t)) && prompts.get(promptKey(t)) !== index))
        throw new Error(`Duplicate task ID or normalized prompt: ${t.id}`);
      if (t.group && groups.has(t.group) && groups.get(t.group) !== index)
        throw new Error(`Group crosses splits: ${t.group}`);
      ids.add(familyId(t.id));
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
  assertDatasetRole(tasks, "prepare");
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
