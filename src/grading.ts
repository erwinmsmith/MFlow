import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Sandbox, createLocalSandboxExecutor } from "@codesoul-co/ditto";
import { score } from "./data.js";
import type { Task } from "./types.js";

const exec = promisify(execFile);
const docker = process.env.MFLOW_DOCKER ?? (process.platform === "darwin" ? "/opt/homebrew/bin/docker" : "docker");
const image = "python:3.12-alpine";
const python = process.env.MFLOW_BENCH_PYTHON ?? "python3";

function normalized(text: string): string {
  return text.toLowerCase().split(/[ -]/).map((part) => {
    const clean = Number.isFinite(Number(part)) && part.trim() ? part : part.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~]/g, "");
    const value = Number.isFinite(Number(clean)) && clean.trim() ? String(Number(clean)) : clean;
    return value.replace(/\b(a|an|the)\b/g, " ").trim();
  }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
function splitSpans(text: string): string[] {
  return text.trim().split(/\s*\|\s*/).map(normalized);
}
// AFlow treats | as alternative answers and reports maximum token F1, not span alignment.
function aflowDropScore(gold: string, prediction: string): { score: 0 | 1; f1: number } {
  const tokens = (text: string) => text.toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "")
    .replace(/\b(a|an|the)\b/g, " ").trim().split(/\s+/).filter(Boolean);
  let f1 = 0;
  for (const answer of gold.split("|").filter((s) => s.trim())) {
    const expected = tokens(answer);
    for (const part of prediction.split("|")) {
      const actual = tokens(part), remaining = [...expected];
      let common = 0;
      for (const token of actual) {
        const index = remaining.indexOf(token);
        if (index >= 0) { common++; remaining.splice(index, 1); }
      }
      if (common) f1 = Math.max(f1, 2 * common / (expected.length + actual.length));
    }
  }
  return { score: f1 === 1 ? 1 : 0, f1 };
}
function dropScore(answer: string, aliases: string[][]): { score: 0 | 1; f1: number } {
  const predicted = splitSpans(answer);
  let exact: 0 | 1 = 0, bestF1 = 0;
  for (const alias of aliases) {
    const gold = alias.map(normalized);
    if (predicted.length === gold.length) {
      const sortedGold = [...gold].sort();
      if ([...predicted].sort().every((item, i) => item === sortedGold[i])) exact = 1;
    }
    if (predicted.length > 12 || gold.length > 12) continue;
    const bag = (s: string) => new Set(s.split(" ").filter(Boolean));
    const p = predicted.map(bag), g = gold.map(bag);
    const memo = new Map<string, number>();
    const align = (i: number, mask: number): number => {
      if (i === p.length) return 0;
      const key = `${i}:${mask}`;
      if (memo.has(key)) return memo.get(key)!;
      let best = align(i + 1, mask);
      for (let j = 0; j < g.length; j++) {
        if (mask & (1 << j)) continue;
        const gn = [...g[j]].filter((token) => Number.isFinite(Number(token)) && token.trim());
        if (gn.length && !gn.some((token) => p[i].has(token))) continue;
        const common = [...p[i]].filter((token) => g[j].has(token)).length;
        const precision = p[i].size ? common / p[i].size : 1;
        const recall = g[j].size ? common / g[j].size : 1;
        const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
        best = Math.max(best, f1 + align(i + 1, mask | (1 << j)));
      }
      memo.set(key, best);
      return best;
    };
    bestF1 = Math.max(bestF1, Math.round(100 * align(0, 0) / Math.max(p.length, g.length)) / 100);
  }
  return { score: exact, f1: bestF1 };
}

function cleanCode(answer: string, completion = false): string {
  const trimmed = answer.trim();
  const fence = /^```(?:python)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fence ? fence[1] : completion ? answer.trimEnd() : trimmed;
}

function sandbox(): Sandbox {
  const env: Record<string, string> = {};
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  else if (process.platform === "darwin" && process.env.USER)
    env.DOCKER_HOST = `unix:///Users/${process.env.USER}/.docker/run/docker.sock`;
  return new Sandbox(process.cwd(), { execute: true }, createLocalSandboxExecutor({
    commands: [docker], timeoutMs: 20_000, maxOutputBytes: 65_536, env,
  }));
}

export async function checkScoring(tasks: Task[]): Promise<void> {
  const metrics = new Set(tasks.map((task) => task.metric));
  if (metrics.has("math")) {
    try {
      await exec(python, ["-c", "import math_verify"], { timeout: 10_000 });
    } catch {
      throw new Error("MATH scoring needs math-verify in MFLOW_BENCH_PYTHON; install requirements-benchmarks.txt");
    }
  }
  if (metrics.has("python")) {
    const result = await sandbox().run({ command: docker, args: ["image", "inspect", image] });
    if (result.exitCode !== 0)
      throw new Error(`Python scoring needs a running Docker daemon and local ${image} image`);
  }
}

async function gradePython(task: Task, answer: string): Promise<0 | 1> {
  const ref = task.reference!;
  let code = cleanCode(answer, !!ref.prefix);
  if (ref.prefix && !code.startsWith(ref.prefix) &&
      (/^[ \t]/.test(code) || !/^(?:def |from |import |class )/.test(code.trimStart())))
    code = ref.prefix + code;
  const test = ref.entryPoint
    ? `${ref.tests![0]}\ncheck(${ref.entryPoint})\n`
    : ref.tests!.join("\n") + "\n";
  const marker = `MFLOW_PASS_${randomUUID()}`;
  const preamble = task.aflowSplit
    ? "import math, hashlib, re\nfrom typing import Any, Dict, List, Optional, Tuple\n"
    : "";
  const script = `${preamble}${code}\n${ref.setup ?? ""}\n${test}\nprint(${JSON.stringify(marker)})\n`;
  const dir = await mkdtemp(join(process.cwd(), ".benchmark-sandbox-"));
  try {
    await writeFile(join(dir, "check.py"), script, { mode: 0o444 });
    const result = await sandbox().run({ command: docker, args: [
      "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m",
      "--cpus", "1", "--user", "65534:65534", "--mount", `type=bind,source=${dir},target=/work,readonly`,
      "--workdir", "/work", "--tmpfs", "/tmp:rw,nosuid,size=16m", image,
      "timeout", "-s", "KILL", "10", "python", "-B", "-I", "/work/check.py",
    ] });
    if (result.exitCode >= 125)
      throw new Error(`Docker grading failed: ${result.stderr.slice(0, 500)}`);
    return result.exitCode === 0 && result.stdout.trimEnd().endsWith(marker) ? 1 : 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function grade(task: Task, answer: string): Promise<{ score: 0 | 1; f1?: number }> {
  if (task.aflowSplit && task.metric === "drop") return aflowDropScore(task.answer, answer);
  if (task.aflowSplit && task.benchmark === "gsm8k") {
    const lastNumber = (text: string) => text.match(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?|\d+\.\d+/g)?.at(-1) ?? "";
    return { score: score({ ...task, answer: lastNumber(task.answer) }, lastNumber(answer)) };
  }
  if (task.metric === "exact" || task.metric === "numeric") return { score: score(task, answer) };
  if (task.metric === "drop") return dropScore(answer, task.reference!.answers!);
  if (task.metric === "python") return { score: await gradePython(task, answer) };
  const { stdout } = await exec(python, [resolve("scripts/grade_math.py"), JSON.stringify({ gold: task.answer, answer })], { timeout: 10_000 });
  return { score: stdout.trim() === "1" ? 1 : 0 };
}
