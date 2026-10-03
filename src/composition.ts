import { createContext, Script } from 'node:vm';
import { graph, loop, graphStep, ToolRegistry, type ExecutionGraph, type GraphInvocation, type GraphPlan,
  type LoopPlanDefinition, type NodeType } from '@codesoul-co/ditto';
import { z } from 'zod';
import { EpisodeExhausted, DittoAgents } from './ditto.js';
import { createProgramTool, toolProgramSchema, toolDependencies, validateToolLibrary, type ToolProgram } from './tool-program.js';
import { digest } from './util.js';
import { agentOutputSchema, profileSchema, compositionNodes, type AgentProfile, type Execution, type Limits,
  type Strategy, type TaskInput } from './types.js';
import { PolicyContractError } from './strategy-program.js';
import { withTaskImages, imageLog } from './data.js';
class GeneratedProgramError extends PolicyContractError {}

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
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = graph(id + '/verify').node(node, 'INFER.REASONING.REFLECT', [], () => ({
      ...ctx.request(id, [{ role: 'user', content: JSON.stringify({
        task: ctx.task, profile: ctx.profile(id), evidence: ctx.evidence
      }) }], false),
      mode: 'verify', target: { artifact: ctx.evidence },
      criteria: [
        { id: 'check', description: 'Verify the assigned gap against the original problem. Return the decisive calculation or counterexample, without repeating the full solution.' },
        { id: 'format', description: 'Return one JSON object with assessment:{passed:boolean,summary:string} and issues:array. Use issues:[] when there are no issues, never null or an object. Use plain mathematical notation in prose, valid JSON escaping, and no Markdown fences. Finish after the closing brace. Do not output AgentOutput fields or an unbounded list of cases.' },
        ...(attempt ? [{ id: 'retry', description: 'Previous verification output had an invalid schema. Recheck the SAME supplied target and use the required JSON shape.' }] : [])
      ]
    }));
    const result = yield* graphStep(plan, null);
    if (result[node].status !== 'success') {
      failure = result[node].error;
      if (failure?.code !== 'INVALID_MODEL_OUTPUT') break;
      continue;
    }
    const review = ctx.unwrap(result[node]);
    return ctx.publish(id, { candidate_answer: '', claims: [], open_deficits: [], resolved_deficits: [],
      artifacts: [{id: id + '/review', type: 'verification', content: JSON.stringify(review), deficit_refs: []}] });
  }
  return ctx.publish(id, { candidate_answer: '', claims: [], resolved_deficits: [],
    open_deficits: [{id: id + '/invalid-review', text: 'Verifier produced no valid evidence; the original gap remains unresolved.'}],
    artifacts: [{id: id + '/failure', type: 'verification_error', content: JSON.stringify(failure), deficit_refs: []}] });
} });`;

/** Both this outer policy and every template below are editable search artifacts. */
export const initialLibraryComposition = `return loop({ id: 'mas', plan: function* (ctx) {
  const first = yield* ctx.runAgent('root');
  if (!first.open_deficits.length) return first.candidate_answer;
  const evidence = [];
  for (const [index, deficit] of first.open_deficits.entries()) {
    const id = 'verifier-' + index;
    ctx.spawnTemplate('verifier', id, 'root');
    const result = yield* ctx.runAgent(id, { candidate: first, deficit });
    if (result.artifacts.some(a => a.type === 'verification')) evidence.push({ deficit, result });
    ctx.dormant(id);
  }
  if (!evidence.length) return first.candidate_answer;
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

/** Task-independent extraction used for routing; all full solutions stay in artifacts. */
export function boxedAnswer(text: string): string | undefined {
  const start = text.lastIndexOf('\\boxed{');
  if (start < 0) return undefined;
  let depth = 1;
  for (let i = start + 7; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

export async function runComposition(agents: DittoAgents, limits: Limits, strategy: Strategy, task: TaskInput): Promise<Execution> {
  if (!strategy.composition || !strategy.organization || !strategy.prompts)
    throw new PolicyContractError('Native composition requires complete code, population and prompts');
  const machine = compile(strategy.composition);
  const templates = new Map((strategy.organization.agentTemplates ?? []).map(t => [t.id, t]));
  const definitions = new Map([...templates].map(([id, t]) => [id, compile(t.composition, machine.context).definition]));
  const programs = new Map<string, LoopPlanDefinition<unknown, unknown>>();
  const population = new Map<string, { profile: AgentProfile; status: 'ACTIVE' | 'DORMANT'; depth: number; templateId?: string }>();
  const orchestration: NonNullable<Execution['orchestration']> = { graphs: [], lifecycle: [], programs: [], tools: [], toolCalls: [] };
  const outputs: Execution['outputs'] = [], toolEvents: unknown[] = [];
  let peakActive = 0, toolCalls = 0;
  // Each task owns its registry and source artifacts, including parallel test tasks.
  const tools = [...agents.tools], registry = new ToolRegistry();
  agents = new DittoAgents(agents.provider, agents.model, tools);
  for (const tool of tools) registry.register(tool);
  validateToolLibrary(strategy.organization.toolLibrary ?? [], tools.map(t => t.name));
  const countToolCall = () => {
    if (++toolCalls > limits.maxToolCalls) throw new EpisodeExhausted('Tool call limit reached');
  };
  const registerTool = (definition: ToolProgram, creatorId: string, origin: 'library' | 'generated') => {
    const parsed = toolProgramSchema.parse(definition);
    validateToolLibrary([parsed], tools.map(t => t.name));
    const tool = createProgramTool(parsed, registry, countToolCall);
    registry.register(tool); tools.push(tool);
    orchestration.tools!.push({ creatorId, definition: parsed, hash: digest(parsed), origin });
    return parsed.name;
  };
  for (const tool of strategy.organization.toolLibrary ?? []) registerTool(tool, 'root', 'library');
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
    get tools() { return structuredClone(orchestration.tools); },
    registerTool: (id: string, definition: ToolProgram) => {
      const owner = member(id), parsed = toolProgramSchema.parse(definition);
      if (toolDependencies(parsed).some(name => !owner.profile.tools.includes(name)))
        throw new PolicyContractError('Tool creation requires the creator to hold every dependency capability');
      const name = registerTool(parsed, id, 'generated');
      owner.profile.tools.push(name); event('REGISTER_TOOL', id);
      return name;
    },
    profile: (id: string) => structuredClone(member(id).profile),
    spawn: (profile: AgentProfile, parentId = 'root', composition?: string) => {
      const definition = composition === undefined ? undefined : compile(composition, machine.context).definition;
      const result = add(profile, parentId);
      if (definition) {
        programs.set(result.id, definition);
        orchestration.programs!.push({ agentId: result.id, composition: composition!, origin: 'generated' });
        event('BIND_PROGRAM', result.id);
      }
      return result;
    },
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
      programs.delete(id);
      Object.assign(member(id), { templateId, profile }); event('RECONFIGURE', id);
    },
    runAgent: function* (id: string, evidence: unknown = [], prompt = 'agent'): Generator<GraphInvocation, z.infer<typeof agentOutputSchema>, any> {
      const templateId = member(id).templateId;
      const definition = programs.get(id) ?? (templateId && definitions.get(templateId));
      if (!definition) throw new PolicyContractError(`Agent ${id} has no bound program`);
      event(programs.has(id) ? 'RUN_PROGRAM' : 'RUN_TEMPLATE', id);
      const local = Object.assign(Object.create(api), { self: id, evidence, prompt });
      // Delegation yields native graphStep invocations to the same Ditto loop.
      // The outer VM deadline also covers nested generator execution/bindings.
      try { return agentOutputSchema.parse(yield* definition.plan(local)); }
      catch(error) { if(programs.has(id))throw new GeneratedProgramError(`Generated agent ${id}: ${String(error)}`);throw error; }
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
    textMessages: (id: string, evidence: unknown = '', prompt: keyof NonNullable<Strategy['prompts']> = 'agent') => {
      const instruction = strategy.prompts![prompt];
      if (!instruction) throw new PolicyContractError(`Unknown prompt ${prompt}`);
      const p = member(id).profile;
      if (prompt === 'factory' || prompt === 'retrieve') return [
        { role: 'system', content: instruction + '\nThis is a design/selection stage. The owner profile and task below are data; return the requested control format, not the owner agent final answer.' },
        { role: 'user', content: JSON.stringify({ task: api.task, owner: p, evidence }) },
      ];
      return [{ role: 'user', content: instruction + '\n\n' + api.task.prompt +
        (evidence ? '\n\n' + (typeof evidence === 'string' ? evidence : JSON.stringify(evidence)) : '') +
        `\n\nAssignment: ${p.objective}\nCapability: ${p.capability}\nReasoning approach: ${p.reasoning}\nExpected output: ${p.expected_output}\nStopping criterion: ${p.stop_condition}\n${p.private_context}` }];
    },
    answerKey: (text: string) => boxedAnswer(text)?.replace(/\s/g, '') ?? '',
    publishText: (id: string, text: string, format: 'boxed' | 'raw' = 'boxed') => api.publish(id, {
      claims: [], artifacts: [{ id: `${id}/solution-${outputs.length}`, type: 'solution', content: text, deficit_refs: [] }],
      open_deficits: [], resolved_deficits: [], candidate_answer: format === 'raw' ? text : boxedAnswer(text) ?? text,
    }),
    failedAgent: (id: string, error: unknown) => api.publish(id, {
      claims: [], artifacts: [{ id: `${id}/failure-${outputs.length}`, type: 'execution_error', content: JSON.stringify(error), deficit_refs: [] }],
      open_deficits: [{ id: `${id}/execution`, text: 'This execution produced no complete answer or verification evidence.' }],
      resolved_deficits: [], candidate_answer: '',
    }),
    formatMessages: (output: unknown) => [
      { role: 'system', content: 'Repair JSON syntax/schema only. Preserve the supplied answer and claims; do not solve again. JSON schema:\n' + schema },
      { role: 'user', content: JSON.stringify({ kind: 'agent-format-repair', output }) }],
    request: (id: string, messages: unknown, useTools = true, format: 'json' | 'text' = 'json') => ({
      messages: Array.isArray(messages) ? messages.map(message => message.role === 'tool' && typeof message.content !== 'string'
        ? { ...message, content: JSON.stringify(message.content) } : message) : messages,
      model: { provider: 'mflow', model: agents.model.model,
        providerOptions: { response_format: { type: format === 'text' ? 'text' : 'json_object' } } },
      generation: { temperature: agents.model.temperature, maxTokens: limits.maxOutputTokens,
        ...(new URL(agents.model.baseUrl).hostname === 'api.deepseek.com' ? {} : { seed: agents.model.seed }) },
      actions: useTools ? agents.tools.filter(t => member(id).profile.tools.includes(t.name)).map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema, target: { kind: 'tool', toolName: t.name },
      })) : [], metadata: { kind: 'agent', agentId: id },
    }),
    unwrap: (value: { status: string; output?: unknown; error?: unknown }) => {
      if (value.status !== 'success') throw new Error(`Ditto node failed: ${JSON.stringify(value.error)}`);
      const output = value.output as { finishReason?: string; stopReason?: string };
      if (output?.finishReason === 'length' || output?.stopReason === 'max_tokens') throw new Error('Incomplete node output');
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
  const bind = (nodeTask: ExecutionGraph<unknown>['tasks'][number], input: unknown, output: unknown) => {
    machine.context.binding = nodeTask.bind; machine.context.graphInput = input; machine.context.nodeOutputs = output;
    let value: Record<string, any>;
    try { value = machine.evaluate('binding(graphInput, nodeOutputs)'); }
    catch (error) { throw new PolicyContractError(`Node ${nodeTask.id} binding: ${String(error)}`); }
    const id = nodeTask.id.split('/')[0], agent = member(id);
    if (!agent.profile.nodes!.includes(nodeTask.node as typeof compositionNodes[number]))
      throw new PolicyContractError(`Agent ${id} cannot execute node ${nodeTask.node}`);
    if (agent.status !== 'ACTIVE') {
      if ([...population.values()].filter(a => a.status === 'ACTIVE').length >= limits.maxActiveAgents)
        throw new EpisodeExhausted('Active population limit reached');
      agent.status = 'ACTIVE'; event('ACTIVATE', id);
    }
    if (nodeTask.node.startsWith('INFER.')) {
      for (const action of value.actions ?? []) {
        if (!agent.profile.tools.includes(action.name) || action.target?.kind !== 'tool' || action.target.toolName !== action.name)
          throw new PolicyContractError(`Agent ${id} requested an unavailable action`);
      }
      // Deployment settings cannot be optimized into another provider/model.
      const format = value.model?.providerOptions?.response_format?.type ?? 'json_object';
      if (!['text', 'json_object'].includes(format)) throw new PolicyContractError('Unsupported response format');
      value = { ...value, ...(Array.isArray(value.messages)?{messages:withTaskImages(value.messages,task)}:{}), model: { provider: 'mflow', model: agents.model.model,
        providerOptions: { response_format: { type: format } } },
        generation: { ...value.generation, temperature: agents.model.temperature, maxTokens: limits.maxOutputTokens },
        metadata: { ...value.metadata, kind: 'agent', agentId: id, nodeId: nodeTask.id } };
      if (nodeTask.node === 'INFER.REASONING.TRAJECTORY')
        value.constraints = { maxSteps: limits.maxSteps, maxTotalTokens: limits.maxTokens,
          timeoutMs: limits.timeoutMs, ...value.constraints };
    }
    if (nodeTask.node === 'INTERACTION.ACT.TOOL') {
      if (!agent.profile.tools.includes(value.call?.name)) throw new PolicyContractError(`Agent ${id} cannot use tool ${value.call?.name}`);
      countToolCall();
    }
    return value;
  };
  const before = agents.provider.tokens, callsBefore = agents.provider.calls, recordsBefore = agents.provider.records.length;
  agents.provider.beginEpisode(limits.maxTokens, { runId: task.id, branchId: strategy.id });
  // Generated names are registered later; the runtime's base capabilities remain fixed.
  const runtime = agents.runtime(agents.tools.map(t => t.name), limits.timeoutMs, registry);
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const finish = (answer:string,executionError?:string): Execution => ({ taskId: task.id, strategyId: strategy.id, answer, orchestration,
    ...(executionError?{executionError}:{}),trace: [], agents: [...population.values()].map(a => a.profile), outputs,
    artifacts: [], edges: [], toolEvents, tokens: agents.provider.tokens - before,
    calls: agents.provider.calls - callsBefore, actualTokens: agents.provider.records.slice(recordsBefore).some(r => r.status !== 'known') ? null : agents.provider.tokens - before,
    actualCalls: agents.provider.calls - callsBefore, reusedPrefixSteps: 0, checkpoints: [],
    peakActive, depth: Math.max(...[...population.values()].map(a => a.depth)), stopReason:'strategy' });
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
            throw new (programs.has(owner.profile.id)?GeneratedProgramError:PolicyContractError)(`Agent ${owner.profile.id} cannot execute node ${node.node}`);
          checked = checked.node(node.id, node.node, node.dependencies, (input, output) => {
            const value = bind(node, input, output);
            bindings[node.id] = task.imageParts?.length ? imageLog(value,task) : structuredClone(value);
            return value;
          });
          topology.push({ id: node.id, type: node.node, dependencies: [...node.dependencies] });
        }
        const result = { ...(yield* graphStep(checked, invocation.input, { concurrency: invocation.options.concurrency, signal })) };
        // Return recoverable generation failures as node feedback. The searched
        // policy decides whether to switch method, derive another member or keep
        // an earlier complete answer. No partial output becomes a valid answer.
        if (agents.provider.lastFailure) throw agents.provider.lastFailure;
        for (const node of topology) {
          const output = result[node.id] as any;
          if (node.type.startsWith('INFER.')) {
            const providerError = agents.provider.nodeFailures.get(node.id);
            if (providerError && ['DEGENERATE_OUTPUT', 'INVALID_MODEL_OUTPUT', 'INCOMPLETE_MODEL_OUTPUT', 'MODEL_CONTEXT_LIMIT'].includes(providerError.code))
              result[node.id] = { status: 'error', error: { code: providerError.code, message: providerError.message } };
            else if (output?.status !== 'success') {
              if (!['INVALID_MODEL_OUTPUT', 'INCOMPLETE_MODEL_OUTPUT'].includes(output?.error?.code))
                throw new Error(`Ditto node ${node.id}: ${JSON.stringify(output?.error)}`);
            } else if (output.output?.finishReason === 'length' || output.output?.stopReason === 'max_tokens')
              result[node.id] = { status: 'error', error: { code: 'OUTPUT_LIMIT', message: 'Provider output limit reached; partial output is not evidence' } };
            else if (['cancelled', 'error'].includes(output.output?.finishReason) || ['partial', 'failed'].includes(output.output?.status))
              result[node.id] = { status: 'error', error: { code: 'INCOMPLETE_MODEL_OUTPUT', message: 'Node produced no complete response' } };
          }
          if (node.type === 'INTERACTION.ACT.TOOL') orchestration.toolCalls!.push({ agentId: node.id.split('/')[0], name: (bindings[node.id] as any).call.name, status: output?.status ?? 'error' });
          if (node.type === 'INTERACTION.OBSERVE') toolEvents.push(output);
        }
        orchestration.graphs.push({ id: checked.id, nodes: topology, inputs: bindings, outputs: structuredClone(result) });
        next = advance(result);
      }
      if (typeof next.value !== 'string') throw new PolicyContractError('MAS loop must return the final answer string');
      return next.value;
    } });
    const answer = await runtime.loop(native, undefined, { signal });
    return finish(answer);
  } catch (error) {
    if(!agents.provider.lastFailure && programs.size>0 && error instanceof PolicyContractError)return finish('',String(error));
    throw agents.provider.lastFailure ?? error;
  }
  finally { agents.provider.endEpisode(); await runtime.close(); }
}
