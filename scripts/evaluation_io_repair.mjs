// Apply only the recorded application I/O repair when resuming a frozen evaluator.
// Actor, grader and published Ditto modules continue to load from the frozen snapshot.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

if (process.argv.includes('evaluate') && process.env.MFLOW_EVALUATION_IO_REPAIR) {
  const receipt = JSON.parse(readFileSync(process.env.MFLOW_EVALUATION_IO_REPAIR, 'utf8'));
  if (!receipt.original.endsWith('/dist/src/evaluation.js')) throw new Error('Unexpected I/O repair target');
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
