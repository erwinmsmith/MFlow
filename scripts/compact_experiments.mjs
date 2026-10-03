// Run only after stopping this experiment's writers. Never traverses code or datasets.
import { open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { compactExecution, digest } from '../dist/src/util.js';

const run = resolve(process.argv[2] ?? '');
if (process.argv.length !== 4 || process.argv[3] !== '--offline' || !run.includes('/runs/'))
  throw new Error('Usage: node scripts/compact_experiments.mjs <stopped run directory> --offline');
await stat(join(run, 'experiment-manifest.json'));
const report = { removedFiles: 0, beforeBytes: 0, afterBytes: 0, completedRows: 0, recoveredPartialRows: [] };
async function remove(path) {
  const info = await stat(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (!info) return;
  report.beforeBytes += info.size; report.removedFiles++; await rm(path);
}
const compact = row => row.execution ? { ...row, execution: compactExecution(row.execution) } : compactExecution(row);
async function rewrite(path, value) {
  const text = JSON.stringify(value) + '\n';
  report.beforeBytes += (await stat(path)).size; report.afterBytes += Buffer.byteLength(text);
  await writeFile(path + '.compact', text); await rename(path + '.compact', path);
}
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
for await (const path of walk(join(run, 'MFlow'))) {
  if (basename(path) !== 'test.jsonl') continue;
  const rows = new Map(), input = await open(path), output = await open(path + '.compact', 'w');
  report.beforeBytes += (await input.stat()).size;
  let recoveredTail = false;
  try {
    for await (const line of input.readLines()) if (line.trim()) {
      if (recoveredTail) throw new Error('Corruption before the end of the aggregate');
      let value;
      try { value = JSON.parse(line); }
      catch {
        const match = line.match(/^\{"taskId":("(?:[^"\\]|\\.)*")/);
        if (!match) throw new Error('Invalid aggregate row; no recovery identity');
        const id = JSON.parse(match[1]);
        value = JSON.parse(await readFile(join(dirname(path), 'rows', digest(id) + '.json'), 'utf8'));
        if (value.taskId !== id || !JSON.stringify(value).startsWith(line)) throw new Error('Partial row does not match its checkpoint');
        recoveredTail = true; report.recoveredPartialRows.push(id);
      }
      const row = compact(value);
      if (rows.has(row.taskId)) throw new Error('Duplicate task result');
      rows.set(row.taskId, digest(row));
      await output.write(JSON.stringify(row) + '\n'); report.completedRows++;
    }
    await output.sync(); report.afterBytes += (await output.stat()).size;
  } finally { await input.close(); await output.close(); }
  await rename(path + '.compact', path);
  const dir = dirname(path);
  for (const entry of await readdir(join(dir, 'rows')).catch(e => { if (e.code !== 'ENOENT') throw e; return []; })) {
    const file = join(dir, 'rows', entry), row = compact(JSON.parse(await readFile(file, 'utf8')));
    if (rows.has(row.taskId)) {
      if (rows.get(row.taskId) !== digest(row)) throw new Error('Conflicting committed result');
      await remove(file);
    } else await rewrite(file, row);
  }
  for (const id of rows.keys()) await remove(join(dir, 'executions', digest(id) + '.json'));
}
for await (const path of walk(run)) {
  if (basename(dirname(path)) === 'requests') {
    let value;
    try { value = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (value?.state !== 'failed') await remove(path);
    continue;
  }
  if (!path.includes('/MFlow/') || !path.endsWith('.json')) continue;
  if (path.endsWith('.execution.json') || basename(dirname(path)) === 'executions') {
    if (path.endsWith('.execution.json') && await stat(path.replace(/\.execution\.json$/, '.json')).catch(() => false)) await remove(path);
    else await rewrite(path, compactExecution(JSON.parse(await readFile(path, 'utf8'))));
  }
}
// Raw baseline responses duplicate checkpoints; retain call attribution and hashes.
const responses = join(run, 'responses.jsonl');
if (await stat(responses).catch(() => false)) {
  const input = await open(responses), output = await open(responses + '.compact', 'w');
  report.beforeBytes += (await input.stat()).size;
  try {
    for await (const line of input.readLines()) if (line.trim()) {
      const { message, ...row } = JSON.parse(line);
      await output.write(JSON.stringify({ ...row, ...(message !== undefined ? { outputHash: digest(message) } : {}) }) + '\n');
    }
    await output.sync(); report.afterBytes += (await output.stat()).size;
  } finally { await input.close(); await output.close(); }
  await rename(responses + '.compact', responses);
}
await writeFile(join(run, 'storage-cleanup.json'), JSON.stringify({ ...report, at: new Date().toISOString(), policy: 'compact-native-evidence-v1' }) + '\n');
console.log(JSON.stringify({ run, ...report, reclaimedGiB: (report.beforeBytes - report.afterBytes) / 1024 ** 3 }));
