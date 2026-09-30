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
  const view = record.views?.[record.defaultProtocol];
  if (!view || view.format !== 'mflow-jsonl')
    throw new Error(`${name}: shared assets are installed, but the MFlow interactive adapter is not implemented`);
  const path = sharedPath(home, `${view.path}/${split}.jsonl`);
  await access(path);
  return path;
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
