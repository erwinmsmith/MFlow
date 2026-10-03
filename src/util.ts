import { createHash } from "node:crypto";
import { mkdir, writeFile, rename, appendFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Execution } from './types.js';

/** Disk evidence only; live graph inputs/outputs remain available to the strategy. */
export function compactExecution(execution: Execution): Execution {
  if (!execution.orchestration) return execution;
  return { ...execution, orchestration: { ...execution.orchestration,
    graphs: execution.orchestration.graphs.map(graph => ({ ...graph, inputs: {},
      outputs: Object.fromEntries(graph.nodes.map(node => {
        const result = (graph.outputs as Record<string, { status?: string; error?: unknown }>)[node.id];
        return [node.id, result ? { status: result.status, error: result.error } : {}];
      })),
    })),
  } };
}

function stored(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const row = value as { execution?: Execution; taskId?: string; answer?: string; orchestration?: unknown };
  if (row.execution) return { ...row, execution: compactExecution(row.execution) };
  if (row.taskId && typeof row.answer === 'string' && row.orchestration) return compactExecution(value as Execution);
  return value;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const saves = new Map<string, Promise<void>>();
export async function save(path: string, value: unknown) {
  path = resolve(path);
  const completedRequest = basename(dirname(path)) === 'requests' && (value as { state?: string })?.state === 'completed';
  const text = JSON.stringify(stored(value)) + "\n";
  // Parallel nodes share usage checkpoints. Commit snapshots in invocation order.
  const pending = (saves.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (completedRequest) { await rm(path, { force: true }); return; }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path + ".tmp", text);
    await rename(path + ".tmp", path);
  });
  saves.set(path, pending);
  try { await pending; }
  finally { if (saves.get(path) === pending) saves.delete(path); }
}
export async function append(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(stored(value)) + "\n");
}
export class Random {
  constructor(private seed: number) {}
  next(): number {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error("Cannot sample an empty set");
    return items[Math.floor(this.next() * items.length)];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  weighted<T>(items: readonly T[], weights: number[]): T {
    let n = this.next() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < items.length; i++) {
      n -= weights[i];
      if (n <= 0) return items[i];
    }
    return items[items.length - 1];
  }
  // Marsaglia-Tsang gamma sampler; all posterior shapes are >= 1.
  gamma(shape: number): number {
    const d = shape - 1 / 3,
      c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x =
        Math.sqrt(-2 * Math.log(Math.max(this.next(), Number.EPSILON))) *
        Math.cos(2 * Math.PI * this.next());
      let v = 1 + c * x;
      if (v <= 0) continue;
      v = v * v * v;
      const u = Math.max(this.next(), Number.EPSILON);
      if (
        u < 1 - 0.0331 * x ** 4 ||
        Math.log(u) < (x * x) / 2 + d * (1 - v + Math.log(v))
      )
        return d * v;
    }
  }
}
export const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
