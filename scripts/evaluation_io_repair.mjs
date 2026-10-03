// Apply recorded application I/O repairs while preserving frozen actor modules.
// Actor, grader and published Ditto modules continue to load from the frozen snapshot.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

for (const [receiptPath, module] of [
  [process.argv.includes('evaluate') ? process.env.MFLOW_EVALUATION_IO_REPAIR : undefined, 'evaluation.js'],
  [process.env.MFLOW_STATE_IO_REPAIR, 'util.js'],
  [process.env.MFLOW_HLE_JUDGE_REPAIR, 'hle-grading.js'],
  [process.env.MFLOW_MODEL_OPTIONS_REPAIR, 'ditto.js'],
]) {
  if (!receiptPath) continue;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (!receipt.original.endsWith('/dist/src/' + module)) throw new Error('Unexpected I/O repair target');
  const readChecked = (path, sha) => {
    const source = readFileSync(path);
    if (createHash('sha256').update(source).digest('hex') !== sha) throw new Error('Evaluation I/O repair checksum mismatch');
    return source.toString('utf8');
  };
  readChecked(receipt.original, receipt.originalSha256);
  const source = readChecked(receipt.replacement, receipt.replacementSha256);
  const target = pathToFileURL(realpathSync(receipt.original)).href;
  registerHooks({ load(url, context, next) {
    return url === target ? { format: 'module', source, shortCircuit: true } : next(url, context);
  } });
}
