import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProvider, SampleInput } from '@codesoul-co/ditto/worker/infer';
import { ablationStrategy } from '../src/ablations.js';
import { textOrganization, textPrompts, textSolver } from '../src/aflow-seed.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { initialStrategy, limitsSchema, type Strategy } from '../src/types.js';

const source = (): Strategy => {
  const organization = structuredClone(textOrganization);
  for (const template of organization.agentTemplates!) template.profile.tools = ['arithmetic'].filter(t => template.profile.tools.includes(t));
  const independent = organization.agentTemplates!.find(t => t.id === 'independent')!;
  organization.agentTemplates!.push({ ...structuredClone(independent), id: 'checker', composition: textSolver,
    profile: { ...independent.profile, objective: 'Check problem constraints.', capability: 'Constraint checking' } });
  return { ...initialStrategy, id: 's2', organization, prompts: textPrompts };
};
const run = (candidate: Strategy, provider: ModelProvider) => new OrganizationRuntime(
  new DittoAgents(new MeteredProvider(provider), { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 }),
  limitsSchema.parse({ maxSteps: 40, maxTokens: 100000 })).run(candidate,
  { id: 'synthetic', prompt: 'Compute 2 + 3.', answer: 'HIDDEN-REFERENCE' } as any);

for (const variant of ['single', 'fixed-full', 'fixed-uniform'] as const) {
  test(`${variant} preserves capabilities and executes its frozen path even when answers agree`, async () => {
    const original = source(), candidate = ablationStrategy(original, variant), calls: SampleInput[] = [];
    if (variant === 'fixed-uniform') {
      const shared = original.organization!.agentTemplates!.find(t => t.id === 'independent')!;
      for (const template of candidate.organization!.agentTemplates!) {
        assert.equal(template.composition, shared.composition);
        assert.deepEqual(template.profile.tools, shared.profile.tools);
        assert.deepEqual(template.profile.nodes, shared.profile.nodes);
        assert.equal(template.profile.objective, original.organization!.agentTemplates!.find(t => t.id === template.id)!.profile.objective);
      }
      assert.deepEqual(candidate.organization!.initialAgents[0].tools, shared.profile.tools);
    } else assert.deepEqual(candidate.organization, original.organization);
    assert.deepEqual(candidate.prompts, original.prompts);
    const result = await run(candidate, { async invoke(input) {
      calls.push(input);
      if (variant === 'fixed-uniform') assert.ok(input.actions?.some(action => action.name === 'arithmetic'));
      if (input.metadata?.agentId === 'independent') assert.ok(!JSON.stringify(input.messages).includes('PROOF-EVIDENCE'));
      if (calls.length === 5) assert.ok(JSON.stringify(input.messages).includes('PROOF-EVIDENCE'));
      return { message: { role: 'assistant', content: 'PROOF-EVIDENCE: 2 + 3 = 5. \\boxed{5}' }, finishReason: 'stop', usage: { totalTokens: 20 } };
    } });
    assert.deepEqual(calls.map(c => c.metadata?.agentId), variant === 'single' ? ['root'] : ['root', 'reviewer', 'independent', 'checker', 'root']);
    assert.equal(result.answer, String.raw`\boxed{5}`);
    assert.ok(!JSON.stringify(calls).includes('HIDDEN-REFERENCE'));
    assert.equal(result.agents.length, variant === 'single' ? 1 : 4);
  });
}
