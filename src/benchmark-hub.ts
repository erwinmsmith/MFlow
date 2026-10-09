import { readFile, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';

export function benchmarkHome() {
  return resolve(process.env.BENCHMARK_HOME ?? '../Benchmarks');
}

const aliases: Record<string, string> = { 'humaneval+': 'humaneval_plus', 'τ³': 'tau3', bfcl_v4: 'bfcl' };
export function benchmarkName(name: string) { return aliases[name.toLowerCase()] ?? name.toLowerCase(); }

export function sharedPath(home: string, relative: string) {
  const path = resolve(home, relative);
  if (!path.startsWith(resolve(home) + sep)) throw new Error('Benchmark path escapes shared home');
  return path;
}

/** Catalog paths are local configuration; hashes remain part of the immutable protocol lock. */
export async function benchmarkPath(name: string, split: 'search' | 'test') {
  const home = benchmarkHome();
  const catalog = JSON.parse(await readFile(join(home, 'catalog.json'), 'utf8'));
  const record = catalog.benchmarks[benchmarkName(name)];
  if (!record) throw new Error(`Unknown shared benchmark: ${name}`);
  const protocol=benchmarkName(name)==='hle'?(process.env.MFLOW_HLE_PROTOCOL??record.defaultProtocol):record.defaultProtocol;
  const view = record.views?.[protocol];
  if (!view || view.format !== 'mflow-jsonl')
    throw new Error(`${name}: shared assets are installed, but the MFlow interactive adapter is not implemented`);
  if (record.runtime === 'access-pending') throw new Error(`${name}: official dataset access is pending`);
  if (benchmarkName(name) === 'hle' && split === 'search' && protocol!=='hle-full-holdout-v1') throw new Error('HLE has only official test data; no search split');
  const path = sharedPath(home, `${view.path}/${split}.jsonl`);
  await access(path);
  return path;
}

export async function extraBenchmarkIdentity(name: 'hle' | 'automationbench' | 'bfcl', protocol?: string) {
  const locks = JSON.parse(await readFile(new URL('../data/extended-benchmarks.lock.json', import.meta.url), 'utf8'));
  const lock = protocol?Object.values(locks).find((l:any)=>l.protocol===protocol) as any:locks[name];
  if(!lock)throw new Error('Unknown benchmark protocol');
  const installed = JSON.parse(await readFile(sharedPath(benchmarkHome(), `views/${lock.protocol}/manifest.json`), 'utf8'));
  if (JSON.stringify(installed) !== JSON.stringify(lock)) throw new Error(`${name}: benchmark protocol lock mismatch`);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(process.env.MFLOW_BENCH_PYTHON ?? 'python3',
    ['benchmark-hub/bench.py', '--root', benchmarkHome(), 'verify', '--name', name]);
  return lock;
}

export async function evalplusEnvironment() {
  const home = benchmarkHome();
  const lock = JSON.parse(await readFile(new URL('../data/humaneval-plus.lock.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(join(home, 'catalog.json'), 'utf8'));
  const record = catalog.benchmarks.humaneval_plus;
  if (record.source.evaluator_revision !== lock.evaluatorRevision || record.source.data_version_from_loader !== lock.dataVersion)
    throw new Error('EvalPlus evaluator/data revision mismatch');
  const raw = sharedPath(home, `${record.raw}/HumanEvalPlus-${lock.dataVersion}.jsonl.gz`);
  if (createHash('sha256').update(await readFile(raw)).digest('hex') !== lock.sourceSha256)
    throw new Error('HumanEval+ source checksum mismatch');
  return { raw, image: process.env.MFLOW_EVALPLUS_IMAGE ?? 'mflow-evalplus:0.1.10' };
}
