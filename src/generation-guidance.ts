/** Request guidance only: Ditto still serializes, streams and executes every node. */
export const generationGuidanceVersion = 'finite-programs-v1';
const marker = `[MFLOW ${generationGuidanceVersion}]`;
const pythonGuidance = 'Write a finite executable Python program. Express repeated calculations and checks with loops, comprehensions or helper functions, not thousands of copied statements or enumerated test cases. Generate any large synthetic inputs inside Python instead of spelling them out in tool arguments. Put only runnable code in the code field, without commentary or an ongoing debate. Check the stated specification and public examples; do not invent additional requirements. After a decisive check, use its result or correct the implementation rather than expanding the same test indefinitely.';
const jsonGuidance = 'Follow exactly the requested JSON schema; when a JSON object is requested, return one valid JSON object and finish after its closing brace. Decision fields such as reason and gap should state the concrete evidence and chosen next action briefly, without an ongoing discussion of alternatives. Code and composition strings must contain the finite executable program, not narration or unrolled demonstrations. Keep substantive work in the requested execution nodes and tools; preserve the requested agent capabilities, branching and tool creation.';

export function withGenerationGuidance(init?: RequestInit): RequestInit | undefined {
  if (typeof init?.body !== 'string') return init;
  let body;
  try { body = JSON.parse(init.body); } catch { return init; }
  if (!body || !Array.isArray(body.messages)) return init;
  if (body.messages.some((m: { content?: unknown }) => typeof m.content === 'string' && m.content.startsWith(marker))) return init;
  const python = Array.isArray(body.tools) && body.tools.some((t: { function?: { name?: string } }) => t.function?.name === 'python');
  const json = ['json_object', 'json_schema'].includes(body.response_format?.type);
  if (!python && !json) return init;
  const guidance = [marker, ...(python ? [pythonGuidance] : []), ...(json ? [jsonGuidance] : [])];
  if (json && body.messages.some((m: { content?: unknown }) => typeof m.content === 'string' && m.content.includes('SEARCH OBJECT: a complete dynamic MAS')))
    guidance.push('The outer MAS composition receives the population context and returns a final answer STRING. It has no ctx.self, ctx.evidence or ctx.prompt: use an explicit root ID or delegate with yield* ctx.runAgent("root"). Those three bound fields belong only to an agent template or dynamically bound stage, whose program returns AgentOutput. Preserve the parent dynamic routing; do not replace the outer MAS with an internal stage.');
  body.messages.unshift({ role: 'system', content: guidance.join('\n') });
  return { ...init, body: JSON.stringify(body) };
}

/** Opt-in repair for existing application processes; in-flight fetches are untouched. */
export function installGenerationGuidance() {
  const key = Symbol.for('mflow.generation-guidance');
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = globals[key];
  if (existing) return existing;
  const original = globalThis.fetch;
  const state = { version: generationGuidanceVersion, installedAt: new Date().toISOString(), modifiedRequests: 0 };
  globalThis.fetch = (input, init) => {
    const updated = withGenerationGuidance(init);
    if (updated !== init) state.modifiedRequests++;
    return original(input, updated);
  };
  globals[key] = state;
  return state;
}
