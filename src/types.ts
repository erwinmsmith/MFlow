import type { StateCheckpoint } from "@codesoul-co/ditto";
import { z } from "zod";

export const actions = [
  "CONTINUE",
  "REACTIVATE",
  "DERIVE",
  "CONNECT",
  "DISCONNECT",
  "DORMANT",
  "STOP",
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
] as const;
export const ruleSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum([...statuses, "ANY", "NONE"]),
    guards: z.array(z.enum(guards)),
    action: z.enum(actions),
  })
  .strict();
export const strategySchema = z
  .object({
    id: z.string().min(1),
    rules: z.array(ruleSchema).min(1).max(24),
    fallback: z.enum(actions),
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

export const profileSchema = z
  .object({
    id: z.string().min(1),
    objective: z.string().min(1),
    capability: z.string().min(1),
    private_context: z.string(),
    tools: z.array(z.string()),
    reasoning: z.enum(["cot", "long-cot", "react"]),
    expected_output: z.string().min(1),
    stop_condition: z.string().min(1),
  })
  .strict();
export type AgentProfile = z.infer<typeof profileSchema>;
export const agentOutputSchema = z
  .object({
    candidate_answer: z.string(),
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
  deficits: Deficit[];
  agents: {
    id: string;
    status: "ACTIVE" | "DORMANT";
    depth: number;
    turns: number;
    stalled: boolean;
  }[];
  maxDepth: number;
}
export interface Decision {
  action: Action;
  agentId?: string;
  deficitId?: string;
  ruleId: string;
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
  actualTokens: number;
  actualCalls: number;
  reusedPrefixSteps: number;
  checkpoints: EpisodeCheckpoint[];
  peakActive: number;
  depth: number;
  stopReason: "strategy" | "steps" | "tokens";
}

export const taskSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    answer: z.string(),
    metric: z.enum(["exact", "numeric", "drop", "math", "python"]).default("exact"),
    benchmark: z.enum(["drop", "humaneval", "mbpp", "gsm8k", "math"]).optional(),
    reference: z.object({
      answers: z.array(z.array(z.string())).optional(),
      tests: z.array(z.string()).optional(),
      setup: z.string().optional(),
      prefix: z.string().optional(),
      entryPoint: z.string().optional(),
    }).strict().optional(),
    group: z.string().optional(),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.metric === "drop" && !task.reference?.answers?.length)
      ctx.addIssue({ code: "custom", message: "DROP needs reference.answers" });
    if (task.metric === "python" && !task.reference?.tests?.length)
      ctx.addIssue({ code: "custom", message: "Python needs reference.tests" });
  });
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = Pick<Task, "id" | "prompt">;
export interface Evaluated {
  taskId: string;
  score: 0 | 1;
  f1?: number;
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
