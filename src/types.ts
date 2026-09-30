import type { StateCheckpoint } from "@codesoul-co/ditto";
import { z } from "zod";

export const actions = [
  "CONTINUE",
  "REVIEW",
  "CHALLENGE",
  "REACTIVATE",
  "DERIVE",
  "CONNECT",
  "DISCONNECT",
  "DORMANT",
  "STOP",
  "RECONFIGURE",
] as const;
export const statuses = [
  "MISSING",
  "LATENT",
  "ACTIVE",
  "DELIVERED",
  "RESOLVED",
] as const;
export const guards = [
  "stalled",
  "has_artifact",
  "depth_room",
  "overactive",
  "not_reviewed",
  "not_challenged",
] as const;
export const ruleSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum([...statuses, "ANY", "NONE"]),
    guards: z.array(z.enum(guards)),
    action: z.enum(actions),
  })
  .strict();
export const compositionNodes = [
  'CONTEXT.LOAD', 'CONTEXT.SELECT', 'CONTEXT.UPDATE', 'CONTEXT.COMPRESS',
  'INFER.REASONING.SAMPLE', 'INFER.REASONING.TRAJECTORY',
  'INFER.REASONING.REFLECT', 'INFER.REASONING.DELIBERATE',
  'INTERACTION.ACT.TOOL', 'INTERACTION.OBSERVE',
] as const;
export const profileSchema = z
  .object({
    id: z.string().min(1),
    objective: z.string().min(1),
    capability: z.string().min(1),
    private_context: z.string(),
    tools: z.array(z.string()),
    nodes: z.array(z.enum(compositionNodes)).min(1).optional(),
    reasoning: z.enum(["cot", "long-cot", "react", "tot", "got", "self-consistency"]),
    expected_output: z.string().min(1),
    stop_condition: z.string().min(1),
  })
  .strict();
export type AgentProfile = z.infer<typeof profileSchema>;
export const agentTemplateSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  profile: profileSchema.omit({ id: true }),
  composition: z.string().min(1),
}).strict();
export const organizationSchema = z.object({
  initialAgents: z.array(profileSchema).min(1),
  agentTemplates: z.array(agentTemplateSchema).optional(),
  initialBindings: z.record(z.string(), z.string()).optional(),
}).strict().superRefine(({ initialAgents, agentTemplates = [], initialBindings = {} }, ctx) => {
  if (initialAgents.filter(p => p.id === "root").length !== 1 ||
      new Set(initialAgents.map(p => p.id)).size !== initialAgents.length)
    ctx.addIssue({ code: "custom", message: "Organization needs exactly one root and unique agent IDs" });
  const ids = new Set(agentTemplates.map(t => t.id));
  if (ids.size !== agentTemplates.length)
    ctx.addIssue({ code: 'custom', message: 'Agent template IDs must be unique' });
  for (const [agent, template] of Object.entries(initialBindings))
    if (!initialAgents.some(p => p.id === agent) || !ids.has(template))
      ctx.addIssue({ code: 'custom', message: `Invalid initial template binding ${agent}: ${template}` });
});
export const capabilitySchema = profileSchema.omit({ id: true });
export const strategySchema = z
  .object({
    id: z.string().min(1),
    rules: z.array(ruleSchema).min(1).max(24),
    fallback: z.enum(actions),
    program: z.string().min(1).optional(),
    composition: z.string().min(1).optional(),
    organization: organizationSchema.optional(),
    prompts: z.object({
      agent: z.string().min(1), factory: z.string().min(1),
      review: z.string().min(1), integrate: z.string().min(1),
      retrieve: z.string().min(1),
    }).strict().optional(),
  })
  .strict()
  .refine(
    (s) => new Set(s.rules.map((r) => r.id)).size === s.rules.length,
    "Duplicate rule IDs",
  );
export type Strategy = z.infer<typeof strategySchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Action = (typeof actions)[number];
export type DeficitStatus = (typeof statuses)[number];

export const agentOutputSchema = z
  .object({
    claims: z.array(
      z
        .object({ text: z.string(), evidence_refs: z.array(z.string()) })
        .strict(),
    ),
    artifacts: z.array(
      z
        .object({
          id: z.string().min(1),
          type: z.string(),
          content: z.string(),
          deficit_refs: z.array(z.string()),
        })
        .strict(),
    ),
    open_deficits: z.array(
      z.object({ id: z.string().min(1), text: z.string().min(1) }).strict(),
    ),
    resolved_deficits: z.array(z.string()),
    candidate_answer: z.string(),
  })
  .strict();
export type AgentOutput = z.infer<typeof agentOutputSchema>;
export interface Deficit {
  id: string;
  text: string;
  owner: string;
  status: DeficitStatus;
  source?: string;
  artifactIds: string[];
  deliveredIds: string[];
}
export interface Artifact {
  id: string;
  source: string;
  type: string;
  content: string;
  deficitRefs: string[];
}
export interface AgentState {
  profile: AgentProfile;
  status: "ACTIVE" | "DORMANT";
  depth: number;
  assigned?: string;
  turns: number;
  stalled: boolean;
  reviewed?: boolean;
  challenged?: boolean;
  episode: string[];
  inbox: string[];
  output?: AgentOutput;
}
export interface Edge {
  source: string;
  target: string;
  deficitId: string;
  artifactIds: string[];
}
export interface PolicyState {
  task?: TaskInput;
  step?: number;
  outputs?: { agentId: string; output: AgentOutput }[];
  artifacts?: Artifact[];
  edges?: Edge[];
  toolEvents?: unknown[];
  usage?: { tokens: number; calls: number };
  availableTools?: string[];
  deficits: Deficit[];
  agents: {
    id: string;
    status: "ACTIVE" | "DORMANT";
    depth: number;
    turns: number;
    stalled: boolean;
    reviewed?: boolean;
    challenged?: boolean;
    profile?: AgentProfile;
    assigned?: string;
  }[];
  maxDepth: number;
}
export interface Decision {
  action: Action;
  agentId?: string;
  deficitId?: string;
  ruleId: string;
  request?: string;
  profile?: z.infer<typeof capabilitySchema>;
}
export interface TraceStep {
  state: PolicyState;
  decision: Decision;
  event: string;
}
export interface EpisodeState {
  step: number;
  population: AgentState[];
  deficits: Deficit[];
  artifacts: Artifact[];
  edges: Edge[];
  trace: TraceStep[];
  outputs: { agentId: string; output: AgentOutput }[];
  toolEvents: unknown[];
  retrievalAttempts: string[];
  peakActive: number;
  tokens: number;
  calls: number;
}
export type EpisodeCheckpoint = StateCheckpoint<EpisodeState>;
export interface Execution {
  executionError?: string;
  /** Grader-only world checkpoint; never included in agent inputs. */
  environment?: { contract: string; world: unknown };
  /** Native Ditto Graph/Loop invocations, independent of the legacy action trace. */
  orchestration?: {
    programs?: { agentId: string; composition: string; origin: 'template' | 'generated'; templateId?: string }[];
    graphs: { id: string; nodes: { id: string; type: string; dependencies: string[] }[]; inputs: Record<string, unknown>; outputs: unknown }[];
    lifecycle: { action: string; agentId: string; parentId?: string; afterGraph: number; profile?: AgentProfile; templateId?: string }[];
  };
  taskId: string;
  strategyId: string;
  answer: string;
  trace: TraceStep[];
  agents: AgentProfile[];
  artifacts: Artifact[];
  edges: Edge[];
  outputs: { agentId: string; output: AgentOutput }[];
  toolEvents: unknown[];
  tokens: number;
  calls: number;
  actualTokens: number | null;
  actualCalls: number;
  reusedPrefixSteps: number;
  checkpoints: EpisodeCheckpoint[];
  peakActive: number;
  depth: number;
  stopReason: "strategy" | "steps" | "tokens";
  stopDetail?: "episode_budget" | "output_limit" | "reasoning_token_limit";
}

export const taskSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    answer: z.string(),
    metric: z.enum(["exact", "numeric", "drop", "math", "python", "evalplus", "hle", "automationbench"]).default("exact"),
    benchmark: z.enum(["drop", "humaneval", "mbpp", "gsm8k", "math", "humaneval_plus", "hle", "automationbench"]).optional(),
    aflowSplit: z.enum(["validate", "test"]).optional(),
    dataset: z.object({ protocol: z.enum(['humaneval-plus-aflow-v1', 'hle-text-test-v1', 'automationbench-public-simple-v1']), split: z.enum(['search', 'test']) }).strict().optional(),
    reference: z.object({
      answers: z.array(z.array(z.string())).optional(),
      tests: z.array(z.string()).optional(),
      setup: z.string().optional(),
      prefix: z.string().optional(),
      entryPoint: z.string().optional(),
      evalplusTaskId: z.string().optional(),
      automationTaskId: z.string().optional(),
    }).strict().optional(),
    group: z.string().optional(),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.metric === "drop" && !task.reference?.answers?.length)
      ctx.addIssue({ code: "custom", message: "DROP needs reference.answers" });
    if (task.metric === "python" && !task.reference?.tests?.length)
      ctx.addIssue({ code: "custom", message: "Python needs reference.tests" });
    if (task.metric === 'evalplus' && (task.benchmark !== 'humaneval_plus' || !task.dataset ||
        !task.reference?.evalplusTaskId || !task.reference.entryPoint || !task.reference.prefix))
      ctx.addIssue({ code: 'custom', message: 'HumanEval+ requires a locked dataset and EvalPlus task reference' });
    const protocol = ({ evalplus: 'humaneval-plus-aflow-v1', hle: 'hle-text-test-v1', automationbench: 'automationbench-public-simple-v1' } as Record<string, string>)[task.metric];
    if ((protocol && (!task.dataset || task.dataset.protocol !== protocol || task.benchmark !== (task.metric === 'evalplus' ? 'humaneval_plus' : task.metric))) ||
        (task.dataset && (!protocol || task.aflowSplit)))
      ctx.addIssue({ code: 'custom', message: 'Benchmark metric needs matching locked protocol and benchmark metadata' });
    if (task.metric === 'hle' && task.dataset?.split !== 'test')
      ctx.addIssue({ code: 'custom', message: 'HLE official test cannot be used for search' });
    if (task.metric === 'automationbench' && !task.reference?.automationTaskId)
      ctx.addIssue({ code: 'custom', message: 'AutomationBench requires an official task reference' });
  });
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = Pick<Task, "id" | "prompt">;
export interface Evaluated {
  taskId: string;
  score: 0 | 1;
  f1?: number;
  partialCredit?: number;
  confidence?: number;
  judge?: unknown;
  execution: Execution;
  inheritedFrom?: string;
}

export const limitsSchema = z
  .object({
    maxSteps: z.number().int().positive().default(12),
    maxActiveAgents: z.number().int().positive().default(4),
    maxPoolAgents: z.number().int().positive().default(12),
    maxDepth: z.number().int().nonnegative().default(3),
    maxTokens: z.number().int().positive().default(16000),
    maxOutputTokens: z.number().int().positive().default(1200),
    maxToolCalls: z.number().int().nonnegative().default(4),
    timeoutMs: z.number().int().positive().default(90000),
  })
  .strict();
export type Limits = z.infer<typeof limitsSchema>;
export const searchConfigSchema = z
  .object({
    seed: z.number().int().default(42),
    variant: z
      .enum(["random", "llm-guided", "mia-space", "mia-acq", "mia-full"])
      .default("mia-full"),
    proposalMode: z.enum(["grammar", "aflow"]).default("grammar"),
    maxIterations: z.number().int().positive().default(20),
    maxExecutions: z.number().int().positive().default(200),
    maxSearchTokens: z.number().int().positive().default(1000000),
    batchSize: z.number().int().positive().default(5),
    minObservations: z.number().int().positive().default(3),
    monteCarloSamples: z.number().int().min(100).default(1000),
    exploration: z.number().min(0).max(1).default(0.3),
    temperature: z.number().positive().default(0.05),
    topParents: z.number().int().positive().default(4),
    patience: z.number().int().positive().default(5),
    convergence: z.boolean().default(false),
    minIterations: z.number().int().positive().default(8),
    informationThreshold: z.number().nonnegative().default(0.001),
    meanTokenLimit: z.number().positive().default(16000),
    meanActiveAgentLimit: z.number().positive().default(4),
    episode: limitsSchema.default(() => limitsSchema.parse({})),
    prefixCache: z.boolean().default(true),
    agentCache: z.boolean().default(false),
    protocol: z.literal("standard").default("standard"),
  })
  .strict();
export type SearchConfig = z.infer<typeof searchConfigSchema>;
export const rootProfile: AgentProfile = {
  id: "root",
  objective: "Solve the task and integrate relevant evidence.",
  capability: "General task reasoning and evidence integration",
  private_context: "",
  tools: [],
  reasoning: "cot",
  expected_output:
    "An answer supported by artifacts and explicit unresolved deficits.",
  stop_condition: "The task is answered and no task-relevant deficit remains.",
};
export const initialStrategy: Strategy = {
  id: "s0",
  rules: [{ id: "complete", status: "NONE", guards: [], action: "STOP" }],
  fallback: "CONTINUE",
};
