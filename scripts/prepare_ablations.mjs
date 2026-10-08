// Prepare comparison bundles without reading test tasks or making model calls.
import { parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ablationStrategy } from '../dist/src/ablations.js';
import { digest, save } from '../dist/src/util.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, variant: { type: 'string' } } });
if (!values.source || !values.out) throw new Error('--source and --out are required');
if (values.variant && !['single', 'fixed-full', 'fixed-uniform', 'fixed-heterogeneous', 'fixed-homogeneous', 'fixed-drop-heterogeneous', 'fixed-drop-homogeneous'].includes(values.variant)) throw new Error('Unknown ablation variant');
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
    ...(variant.startsWith('fixed-drop-') ? { contractRepair: 'R26 independent/span_extractor TRAJECTORY result is a Message; read result.content instead of String(result). Recorded original and prepared program hashes follow.',
      programs: bundle.strategy.organization.agentTemplates.map(t=>({id:t.id,sourceHash:digest(source.strategy.organization.agentTemplates.find(s=>s.id===t.id).composition),preparedHash:digest(t.composition)})) } : {}),
    inherited: ['fixed-uniform','fixed-homogeneous','fixed-drop-homogeneous'].includes(variant) ? ['model', 'prompts', 'role objectives and private method instructions', 'grading', 'episode limits']
      : ['model', 'prompts', 'agent profiles', 'agent graph/loop programs', 'tools', 'grading', 'episode limits'],
    change: variant === 'fixed-drop-heterogeneous' ? 'Fixed full DROP library: root, independent, calculator, span_extractor, root integration, normalizer. Inherit frozen profiles and programs; topology is a prescribed ablation, not a separately searched static graph.'
      : variant === 'fixed-drop-homogeneous' ? 'Same fixed full DROP library route and role prompts; all five members use the frozen solver program, node permissions, reasoning and tools, including the normalizer.'
      : variant === 'fixed-heterogeneous' ? 'Always run root solver, verifier, then root repair; inherit both frozen template programs and capabilities'
      : variant === 'fixed-homogeneous' ? 'Same fixed root/verifier/root route and role instructions; both agents share the frozen solver graph, node permissions, reasoning mode and tool permissions'
      : variant === 'single' ? 'Only run the original root solver' : variant === 'fixed-full'
      ? 'Always run all four agents and the final root integration; remove agreement early exits'
      : 'Same fixed five-turn route; all agents share the independent agent graph/loop, node permissions, reasoning mode and tool permissions',
    searched: false, testFeedbackMayAffectSearch: false, protocol: 'standard',
  });
}
console.log(out);
