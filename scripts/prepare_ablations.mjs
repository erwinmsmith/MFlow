// Prepare comparison bundles without reading test tasks or making model calls.
import { parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ablationStrategy } from '../dist/src/ablations.js';
import { digest, save } from '../dist/src/util.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, variant: { type: 'string' } } });
if (!values.source || !values.out) throw new Error('--source and --out are required');
if (values.variant && !['single', 'fixed-full', 'fixed-uniform', 'fixed-heterogeneous', 'fixed-homogeneous'].includes(values.variant)) throw new Error('Unknown ablation variant');
const source = JSON.parse(await readFile(values.source, 'utf8'));
const out = resolve(values.out);
await mkdir(out, { recursive: false });
for (const variant of values.variant ? [values.variant] : ['single', 'fixed-full']) {
  const bundle = { ...structuredClone(source), strategy: ablationStrategy(source.strategy, variant) };
  bundle.pool = structuredClone(bundle.strategy.organization.initialAgents);
  await save(join(out, variant, 'best.json'), bundle);
  await save(join(out, variant, 'ablation.json'), {
    preparedAt: new Date().toISOString(), variant, source: resolve(values.source),
    sourceBundleHash: digest(source), sourceStrategyHash: digest(source.strategy), bundleHash: digest(bundle),
    inherited: ['fixed-uniform','fixed-homogeneous'].includes(variant) ? ['model', 'prompts', 'role objectives and private method instructions', 'grading', 'episode limits']
      : ['model', 'prompts', 'agent profiles', 'agent graph/loop programs', 'tools', 'grading', 'episode limits'],
    change: variant === 'fixed-heterogeneous' ? 'Always run root solver, verifier, then root repair; inherit both frozen template programs and capabilities'
      : variant === 'fixed-homogeneous' ? 'Same fixed root/verifier/root route and role instructions; both agents share the frozen solver graph, node permissions, reasoning mode and tool permissions'
      : variant === 'single' ? 'Only run the original root solver' : variant === 'fixed-full'
      ? 'Always run all four agents and the final root integration; remove agreement early exits'
      : 'Same fixed five-turn route; all agents share the independent agent graph/loop, node permissions, reasoning mode and tool permissions',
    searched: false, testFeedbackMayAffectSearch: false, protocol: 'standard',
  });
}
console.log(out);
