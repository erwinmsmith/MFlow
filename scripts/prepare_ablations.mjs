// Prepare comparison bundles without reading test tasks or making model calls.
import { parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ablationStrategy } from '../dist/src/ablations.js';
import { digest, save } from '../dist/src/util.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' } } });
if (!values.source || !values.out) throw new Error('--source and --out are required');
const source = JSON.parse(await readFile(values.source, 'utf8'));
const out = resolve(values.out);
await mkdir(out, { recursive: false });
for (const variant of ['single', 'fixed-full']) {
  const bundle = { ...structuredClone(source), strategy: ablationStrategy(source.strategy, variant) };
  await save(join(out, variant, 'best.json'), bundle);
  await save(join(out, variant, 'ablation.json'), {
    preparedAt: new Date().toISOString(), variant, source: resolve(values.source),
    sourceBundleHash: digest(source), sourceStrategyHash: digest(source.strategy), bundleHash: digest(bundle),
    inherited: ['model', 'prompts', 'agent profiles', 'agent graph/loop programs', 'tools', 'grading', 'episode limits'],
    change: variant === 'single' ? 'Only run the original root solver' : 'Always run all four agents and the final root integration; remove agreement early exits',
    searched: false, testFeedbackMayAffectSearch: false, protocol: 'standard',
  });
}
console.log(out);
