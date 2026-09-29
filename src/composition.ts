import { createContext, Script } from 'node:vm';
import { graph, loop, graphStep, type ExecutionGraph, type GraphInvocation, type GraphPlan,
  type LoopPlanDefinition, type NodeType } from '@codesoul-co/ditto';
import { z } from 'zod';
import { EpisodeExhausted, type DittoAgents } from './ditto.js';
import { agentOutputSchema, profileSchema, compositionNodes, type AgentProfile, type Execution, type Limits,
  type Strategy, type TaskInput } from './types.js';
import { PolicyContractError } from './strategy-program.js';

/** The seed is itself a searched artifact, not a hidden fixed agent executor. */
const initialTurn = `
function* turn(ctx, id, evidence = [], prompt = 'agent') {
  const messages = ctx.messages(id, evidence, prompt);
  for (;;) {
    const load = id + '/context', sample = id + '/sample';
    const plan = graph(id + '/turn')
      .node(load, 'CONTEXT.LOAD', [], () => ({ sources: messages }))
      .node(sample, 'INFER.REASONING.SAMPLE', [load], (_, out) => ctx.request(id,
        out[load].items.map((item, i) => ({ ...messages[i], content: item.content }))));
    const out = yield* graphStep(plan, null);
    const response = ctx.unwrap(out[sample]);
    if (!response.actionRequests?.length) {
      try { return ctx.publish(id, ctx.decode(response.message.content)); }
      catch (error) {
        const repair = graph(id + '/format').node(id + '/repair', 'INFER.REASONING.SAMPLE', [],
          () => ctx.request(id, ctx.formatMessages(response.message.content), false));
        const fixed = yield* graphStep(repair, null);
        return ctx.publish(id, ctx.decode(ctx.unwrap(fixed[id + '/repair']).message.content));
      }
    }
    messages.push({ ...response.message, metadata: { actionRequests: response.actionRequests } });
    for (const call of response.actionRequests) {
      const act = id + '/tool', observe = id + '/observe';
      const tools = graph(id + '/tools')
        .node(act, 'INTERACTION.ACT.TOOL', [], () => ({ call }))
        .node(observe, 'INTERACTION.OBSERVE', [act], (_, out) => ({ result: out[act] }));
      const results = yield* graphStep(tools, null);
      messages.push({ role: 'tool', content: results[observe].message.content,
        metadata: { actionRequestId: call.id, name: call.name } });
    }
  }
}
`.trim();
export const initialComposition = initialTurn + `
return loop({ id: 'mas', plan: function* (ctx) {
  const answer = yield* turn(ctx, 'root');
  return answer.candidate_answer;
} });`;

export const initialAgentComposition = initialTurn + `
return loop({ id: 'solver', plan: function* (ctx) {
  return yield* turn(ctx, ctx.self, ctx.evidence, ctx.prompt);
} });`;

export const initialVerifierComposition = `return loop({ id: 'verifier', plan: function* (ctx) {
  const id = ctx.self, node = id + '/verify';
  const plan = graph(id + '/verify').node(node, 'INFER.REASONING.REFLECT', [], () => ({
    ...ctx.request(id, [{ role: 'user', content: JSON.stringify({
      task: ctx.task, profile: ctx.profile(id), evidence: ctx.evidence
    }) }], false),
    mode: 'verify', target: { artifact: ctx.evidence }
  }));
  const result = yield* graphStep(plan, null);
  const review = ctx.unwrap(result[node]);
  return ctx.publish(id, { candidate_answer: '', claims: [], open_deficits: [], resolved_deficits: [],
    artifacts: [{id: id + '/review', type: 'verification', content: JSON.stringify(review), deficit_refs: []}] });
} });`;

/** Both this outer policy and every template below are editable search artifacts. */
export const initialLibraryComposition = `return loop({ id: 'mas', plan: function* (ctx) {
  const first = yield* ctx.runAgent('root');
  if (!first.open_deficits.length) return first.candidate_answer;
  const evidence = [];
  for (const deficit of first.open_deficits) {
    const id = 'verifier-' + evidence.length;
    ctx.spawnTemplate('verifier', id, 'root');
    const result = yield* ctx.runAgent(id, { candidate: first, deficit });
    evidence.push({ deficit, result });
    ctx.dormant(id);
  }
  const final = yield* ctx.runAgent('root', { candidate: first, evidence }, 'integrate');
  return final.candidate_answer;
} });`;


// These are the Worker capabilities configured by this application. No private
// Ditto entrypoints or application implementations of Worker nodes are involved.
const nodes = new Set<NodeType>(compositionNodes);

function compile(source: string, context = createContext({ graph, loop, graphStep }, { codeGeneration: { strings: false, wasm: false } })) {
  // VM deadlines guard synchronous candidate code only; model execution is owned
  // by Ditto and has its separately configured deadline. This is not an OS sandbox.
  const evaluate = (code: string) => new Script(code).runInContext(context, { timeout: 250 });
  try {
    const definition = evaluate(`(function(){'use strict';\n${source}\n})()`) as LoopPlanDefinition<unknown, string>;
    if (!definition || typeof definition.id !== 'string' || typeof definition.plan !== 'function')
      throw new Error('composition must return loop({id, plan: function* (ctx) {...}})');
    return { context, evaluate, definition };
  } catch (error) { throw new PolicyContractError(`Composition contract: ${String(error)}`); }
}
export function validateComposition(source: string) { compile(source); }

export async function runComposition(agents: DittoAgents, limits: Limits, strategy: Strategy, task: TaskInput): Promise<Execution> {
  if (!strategy.composition || !strategy.organization || !strategy.prompts)
    throw new PolicyContractError('Native composition requires complete code, population and prompts');
  const machine = compile(strategy.composition);
  const templates = new Map((strategy.organization.agentTemplates ?? []).map(t => [t.id, t]));
  const definitions = new Map([...templates].map(([id, t]) => [id, compile(t.composition, machine.context).definition]));
  const population = new Map<string, { profile: AgentProfile; status: 'ACTIVE' | 'DORMANT'; depth: number; templateId?: string }>();
  const orchestration: NonNullable<Execution['orchestration']> = { graphs: [], lifecycle: [] };
  const outputs: Execution['outputs'] = [], toolEvents: unknown[] = [];
  let peakActive = 0, toolCalls = 0;
  const event = (action: string, agentId: string, parentId?: string) => {
    orchestration.lifecycle.push({ action, agentId, ...(parentId ? { parentId } : {}), afterGraph: orchestration.graphs.length,
      ...(population.get(agentId)?.templateId ? { templateId: population.get(agentId)!.templateId } : {}),
      ...(['INITIAL', 'SPAWN', 'RECONFIGURE'].includes(action) ? { profile: structuredClone(population.get(agentId)!.profile) } : {}) });
    peakActive = Math.max(peakActive, [...population.values()].filter(a => a.status === 'ACTIVE').length);
  };
  const member = (id: string) => {
    const agent = population.get(id);
    if (!agent) throw new PolicyContractError(`Unknown agent ${id}`);
    return agent;
  };
  const add = (profile: AgentProfile, parentId?: string, templateId?: string) => {
    if (templateId && !templates.has(templateId)) throw new PolicyContractError(`Unknown template ${templateId}`);
    const parsed = profileSchema.parse(profile); agents.validateProfile(parsed);
    if (!parsed.nodes?.length) throw new PolicyContractError('Native agent profiles must declare available nodes');
    if (parsed.id.includes('/') || population.has(parsed.id)) throw new PolicyContractError('Agent IDs must be unique and cannot contain /');
    const depth = parentId ? member(parentId).depth + 1 : 0;
    if (depth > limits.maxDepth || population.size >= limits.maxPoolAgents)
      throw new EpisodeExhausted('Population/depth limit reached');
    population.set(parsed.id, { profile: parsed, status: 'DORMANT', depth, ...(templateId ? { templateId } : {}) });
    event(parentId ? 'SPAWN' : 'INITIAL', parsed.id, parentId);
    return structuredClone(parsed);
  };
  for (const profile of strategy.organization.initialAgents) add(profile, undefined, strategy.organization.initialBindings?.[profile.id]);
  const schema = JSON.stringify(z.toJSONSchema(agentOutputSchema));
  const api = {
    task: { id: task.id, prompt: task.prompt }, // Deliberately strip all labels/references.
    get templates() { return structuredClone([...templates.values()]); },
    get agents() { return structuredClone([...population.values()]); },
    get outputs() { return structuredClone(outputs); },
    get graphs() { return structuredClone(orchestration.graphs); },
    profile: (id: string) => structuredClone(member(id).profile),
    spawn: (profile: AgentProfile, parentId = 'root') => add(profile, parentId),
    spawnTemplate: (templateId: string, id: string, parentId = 'root') => {
      const template = templates.get(templateId);
      if (!template) throw new PolicyContractError(`Unknown template ${templateId}`);
      return add({ ...template.profile, id }, parentId, templateId);
    },
    bindTemplate: (id: string, templateId: string) => {
      const template = templates.get(templateId);
      if (!template) throw new PolicyContractError(`Unknown template ${templateId}`);
      const profile = profileSchema.parse({ ...template.profile, id });
      agents.validateProfile(profile);
      if (!profile.nodes?.length) throw new PolicyContractError('Native agent profiles must declare available nodes');
      Object.assign(member(id), { templateId, profile }); event('RECONFIGURE', id);
    },
    runAgent: function* (id: string, evidence: unknown = [], prompt = 'agent'): Generator<GraphInvocation, z.infer<typeof agentOutputSchema>, any> {
      const templateId = member(id).templateId;
      const definition = templateId && definitions.get(templateId);
      if (!definition) throw new PolicyContractError(`Agent ${id} has no bound template`);
      event('RUN_TEMPLATE', id);
      const local = Object.assign(Object.create(api), { self: id, evidence, prompt });
      // Delegation yields native graphStep invocations to the same Ditto loop.
      // The outer VM deadline also covers nested generator execution/bindings.
      return agentOutputSchema.parse(yield* definition.plan(local));
    },
    reconfigure: (id: string, profile: AgentProfile) => {
      const parsed = profileSchema.parse(profile); agents.validateProfile(parsed);
      if (!parsed.nodes?.length) throw new PolicyContractError('Native agent profiles must declare available nodes');
      if (parsed.id !== id) throw new PolicyContractError('Reconfigure must preserve agent identity');
      member(id).profile = parsed; event('RECONFIGURE', id);
    },
    dormant: (id: string) => { member(id).status = 'DORMANT'; event('DORMANT', id); },
    messages: (id: string, evidence: unknown = [], prompt: keyof NonNullable<Strategy['prompts']> = 'agent') => {
      const instruction = strategy.prompts![prompt];
      if (!instruction) throw new PolicyContractError(`Unknown prompt ${prompt}`);
      return [{ role: 'system', content: instruction + '\nReturn one JSON object matching this schema:\n' + schema },
        { role: 'user', content: JSON.stringify({ kind: 'agent', payload: { task: api.task, profile: member(id).profile, evidence } }) }];
    },
    formatMessages: (output: unknown) => [
      { role: 'system', content: 'Repair JSON syntax/schema only. Preserve the supplied answer and claims; do not solve again. JSON schema:\n' + schema },
      { role: 'user', content: JSON.stringify({ kind: 'agent-format-repair', output }) }],
    request: (id: string, messages: unknown, useTools = true) => ({
      messages, model: { provider: 'mflow', model: agents.model.model },
      generation: { temperature: agents.model.temperature, maxTokens: limits.maxOutputTokens,
        ...(new URL(agents.model.baseUrl).hostname === 'api.deepseek.com' ? {} : { seed: agents.model.seed }) },
      actions: useTools ? agents.tools.filter(t => member(id).profile.tools.includes(t.name)).map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema, target: { kind: 'tool', toolName: t.name },
      })) : [], metadata: { kind: 'agent', agentId: id },
    }),
    unwrap: (value: { status: string; output?: unknown; error?: unknown }) => {
      if (value.status !== 'success') throw new Error(`Ditto node failed: ${JSON.stringify(value.error)}`);
      return value.output;
    },
    decode: (content: string) => agentOutputSchema.parse(JSON.parse(content.trim().replace(/^```(?:json)?\s*\n|\n```$/g, ''))),
    publish: (id: string, output: unknown) => {
      member(id); const parsed = agentOutputSchema.parse(output);
      outputs.push({ agentId: id, output: parsed }); event('PUBLISH', id);
      return structuredClone(parsed);
    },
  };
  machine.context.api = api;
  machine.context.definition = machine.definition;
  machine.evaluate('iterator = definition.plan(api)');
  const advance = (value?: unknown): IteratorResult<GraphInvocation, string> => {
    machine.context.feedback = value;
    try { return machine.evaluate('iterator.next(feedback)'); }
    catch (error) { throw new PolicyContractError(`Composition plan: ${String(error)}`); }
  };
  // Wrap bindings for contract enforcement and synchronous VM deadlines. Graph
  // dependency scheduling, concurrent nodes, tools and inference remain Ditto's.
  const bind = (task: ExecutionGraph<unknown>['tasks'][number], input: unknown, output: unknown) => {
    machine.context.binding = task.bind; machine.context.graphInput = input; machine.context.nodeOutputs = output;
    let value: Record<string, any>;
    try { value = machine.evaluate('binding(graphInput, nodeOutputs)'); }
    catch (error) { throw new PolicyContractError(`Node ${task.id} binding: ${String(error)}`); }
    const id = task.id.split('/')[0], agent = member(id);
    if (!agent.profile.nodes!.includes(task.node as typeof compositionNodes[number]))
      throw new PolicyContractError(`Agent ${id} cannot execute node ${task.node}`);
    if (agent.status !== 'ACTIVE') {
      if ([...population.values()].filter(a => a.status === 'ACTIVE').length >= limits.maxActiveAgents)
        throw new EpisodeExhausted('Active population limit reached');
      agent.status = 'ACTIVE'; event('ACTIVATE', id);
    }
    if (task.node.startsWith('INFER.')) {
      for (const action of value.actions ?? []) {
        if (!agent.profile.tools.includes(action.name) || action.target?.kind !== 'tool')
          throw new PolicyContractError(`Agent ${id} requested an unavailable action`);
      }
      // Deployment settings cannot be optimized into another provider/model.
      value = { ...value, model: { provider: 'mflow', model: agents.model.model },
        generation: { ...value.generation, temperature: agents.model.temperature, maxTokens: limits.maxOutputTokens },
        metadata: { ...value.metadata, kind: 'agent', agentId: id } };
      if (task.node === 'INFER.REASONING.TRAJECTORY')
        value.constraints = { maxSteps: limits.maxSteps, maxTotalTokens: limits.maxTokens,
          timeoutMs: limits.timeoutMs, ...value.constraints };
    }
    if (task.node === 'INTERACTION.ACT.TOOL') {
      if (!agent.profile.tools.includes(value.call?.name)) throw new PolicyContractError(`Agent ${id} cannot use tool ${value.call?.name}`);
      if (++toolCalls > limits.maxToolCalls) throw new EpisodeExhausted('Tool call limit reached');
    }
    return value;
  };
  const before = agents.provider.tokens, callsBefore = agents.provider.calls;
  agents.provider.beginEpisode(limits.maxTokens, { runId: task.id, branchId: strategy.id });
  const runtime = agents.runtime(agents.tools.map(t => t.name), limits.timeoutMs);
  const signal = AbortSignal.timeout(limits.timeoutMs);
  try {
    const native = loop({ id: machine.definition.id, maxIterations: Math.min(limits.maxSteps, machine.definition.maxIterations ?? limits.maxSteps), plan: function* (): GraphPlan<string> {
      let next = advance();
      while (!next.done) {
        const invocation = next.value;
        if (invocation?.kind !== 'graph' || !Array.isArray(invocation.graph?.tasks))
          throw new PolicyContractError('Loop must yield public Ditto graphStep invocations');
        let checked: ExecutionGraph<unknown, Record<string, unknown>> = graph(invocation.graph.id);
        const bindings: Record<string, unknown> = {};
        const topology = [];
        for (const node of invocation.graph.tasks) {
          if (!nodes.has(node.node)) throw new PolicyContractError(`Unconfigured node type ${node.node}`);
          if (!node.id.includes('/')) throw new PolicyContractError('Node IDs must be agentId/localName');
          const owner = member(node.id.split('/')[0]);
          if (!owner.profile.nodes!.includes(node.node as typeof compositionNodes[number]))
            throw new PolicyContractError(`Agent ${owner.profile.id} cannot execute node ${node.node}`);
          checked = checked.node(node.id, node.node, node.dependencies, (input, output) => {
            const value = bind(node, input, output);
            bindings[node.id] = structuredClone(value);
            return value;
          });
          topology.push({ id: node.id, type: node.node, dependencies: [...node.dependencies] });
        }
        const result = yield* graphStep(checked, invocation.input, { concurrency: invocation.options.concurrency, signal });
        orchestration.graphs.push({ id: checked.id, nodes: topology, inputs: bindings, outputs: structuredClone(result) });
        for (const node of topology) {
          const output = result[node.id] as any;
          if (node.type.startsWith('INFER.')) {
            if (output?.status !== 'success') throw new Error(`Ditto node ${node.id}: ${JSON.stringify(output?.error)}`);
            if (output.output?.finishReason === 'length' || output.output?.stopReason === 'max_tokens')
              throw new EpisodeExhausted('Model output limit reached', 'output_limit');
            if (['cancelled', 'error'].includes(output.output?.finishReason) || ['partial', 'failed'].includes(output.output?.status))
              throw new Error(`Ditto node ${node.id} did not complete`);
          }
          if (node.type === 'INTERACTION.OBSERVE') toolEvents.push(output);
        }
        next = advance(result);
      }
      if (typeof next.value !== 'string') throw new PolicyContractError('MAS loop must return the final answer string');
      return next.value;
    } });
    const answer = await runtime.loop(native, undefined, { signal });
    return { taskId: task.id, strategyId: strategy.id, answer, orchestration,
      trace: [], agents: [...population.values()].map(a => a.profile), outputs,
      artifacts: [], edges: [], toolEvents, tokens: agents.provider.tokens - before,
      calls: agents.provider.calls - callsBefore, actualTokens: agents.provider.tokens - before,
      actualCalls: agents.provider.calls - callsBefore, reusedPrefixSteps: 0, checkpoints: [],
      peakActive, depth: Math.max(...[...population.values()].map(a => a.depth)), stopReason: 'strategy' };
  } catch (error) { throw agents.provider.lastFailure ?? error; }
  finally { agents.provider.endEpisode(); await runtime.close(); }
}
