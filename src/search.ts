import { join } from "node:path";
import { z } from "zod";
import { OrganizationRuntime } from "./runtime.js";
import {
  type Mutation,
  decide,
  mutations,
  policyHash,
  sameDecision,
} from "./policy.js";
import {
  initialStrategy,
  type Evaluated,
  type SearchConfig,
  type Strategy,
  type Task,
  type AgentProfile,
} from "./types.js";
import { acquisition, Posterior } from "./mia.js";
import { assertDisjoint, assertDatasetRole, promptKey } from "./data.js";
import { grade, checkScoring } from "./grading.js";
import { BudgetExhausted, type ModelSettings } from "./ditto.js";
import { Random, append, digest, mean, save } from "./util.js";

export interface SearchNode {
  id: string;
  parent?: string;
  mutation?: Omit<Mutation, "strategy">;
  strategy: Strategy;
  status: "evaluated" | "rejected" | "budget_exhausted" | "failed";
  results: Evaluated[];
  utility?: number;
  feasible?: boolean;
  confirmation?: Evaluated[];
  reason?: string;
}
export interface Bundle {
  version: 2;
  dittoVersion: "0.1.1";
  strategy: Strategy;
  pool: AgentProfile[];
  model: ModelSettings;
  config: SearchConfig;
  searchDataHash: string;
  confirmationDataHash?: string;
  selectionTaskIds: string[];
  selectionPromptHashes: string[];
  selectionGroups: string[];
  experimentalScope: "standard-isolated-state-v2";
}
export function affected(
  candidate: Strategy,
  results: Evaluated[],
): Set<string> {
  return new Set(
    results
      .filter((r) =>
        r.execution.trace.some(
          (t) => !sameDecision(decide(candidate, t.state), t.decision),
        ),
      )
      .map((r) => r.taskId),
  );
}
export function feasible(results: Evaluated[], config: SearchConfig): boolean {
  return (
    results.length > 0 &&
    mean(results.map((r) => r.execution.tokens)) <= config.meanTokenLimit &&
    mean(results.map((r) => r.execution.peakActive)) <=
      config.meanActiveAgentLimit &&
    results.every(
      (r) =>
        r.execution.depth <= config.episode.maxDepth &&
        r.execution.tokens <= config.episode.maxTokens &&
        r.execution.peakActive <= config.episode.maxActiveAgents,
    )
  );
}
export class Search {
  readonly posterior = new Posterior();
  readonly nodes: SearchNode[] = [];
  private executions = 0;
  private rng: Random;
  private used = new Set<string>();
  private seen = new Set<string>();
  constructor(
    readonly runtime: OrganizationRuntime,
    readonly config: SearchConfig,
    readonly out: string,
  ) {
    this.rng = new Random(config.seed);
    runtime.captureCheckpoints = config.prefixCache;
    runtime.agents.cacheEnabled = config.agentCache;
    runtime.agents.assertReplaySafe();
  }
  private async execute(
    strategy: Strategy,
    task: Task,
    parent?: Evaluated,
  ): Promise<Evaluated> {
    if (
      this.executions >= this.config.maxExecutions ||
      this.runtime.agents.provider.tokens >= this.config.maxSearchTokens
    )
      throw new BudgetExhausted("Search budget exhausted");
    this.executions++;
    const before = this.runtime.agents.provider.tokens;
    try {
      const divergence =
        parent?.execution.trace.findIndex(
          (t) => !sameDecision(decide(strategy, t.state), t.decision),
        ) ?? -1;
      const checkpoint =
        this.config.prefixCache && divergence >= 0
          ? parent?.execution.checkpoints[divergence]
          : undefined;
      const execution = await this.runtime.run(
        strategy,
        {
          id: task.id,
          prompt: task.prompt,
        },
        checkpoint
          ? {
              checkpoint,
              prefix: parent!.execution.checkpoints.slice(0, divergence),
            }
          : undefined,
      );
      const result: Evaluated = {
        taskId: task.id,
        ...await grade(task, execution.answer),
        execution,
      };
      await append(join(this.out, "executions.jsonl"), result);
      return result;
    } catch (error) {
      await append(join(this.out, "errors.jsonl"), {
        strategyId: strategy.id,
        taskId: task.id,
        error: String(error),
        tokens: this.runtime.agents.provider.tokens - before,
      });
      throw error; // Infrastructure failures are not fabricated correctness observations.
    }
  }
  async run(tasks: Task[], confirmation: Task[] = []): Promise<Bundle> {
    assertDatasetRole(tasks, "search");
    assertDatasetRole(confirmation, "confirmation");
    if (tasks.some((task) => task.aflowSplit) && confirmation.length)
      throw new Error("AFlow search uses the complete validate split without separate confirmation");
    assertDisjoint(tasks, confirmation);
    if (!tasks.length) throw new Error("Empty search reservoir");
    if (this.config.maxExecutions < tasks.length + confirmation.length)
      throw new Error(
        "Budget cannot cover initial search and confirmation baselines",
      );
    await checkScoring([...tasks, ...confirmation]);
    this.runtime.agents.provider.tokenLimit = this.config.maxSearchTokens;
    await save(join(this.out, "config.json"), {
      config: this.config,
      model: this.runtime.agents.model,
      pool: this.runtime.pool,
      ditto: "0.1.1",
      searchDataHash: digest(tasks),
      confirmationDataHash: digest(confirmation),
    });
    const root: SearchNode = {
      id: "s0",
      strategy: initialStrategy,
      status: "evaluated",
      results: [],
    };
    this.nodes.push(root);
    try {
      for (const t of tasks)
        root.results.push(await this.execute(root.strategy, t));
      root.utility = mean(root.results.map((r) => r.score));
      root.feasible = feasible(root.results, this.config);
      root.confirmation = [];
      for (const t of confirmation)
        root.confirmation.push(await this.execute(root.strategy, t));
    } catch (error) {
      root.status =
        this.runtime.agents.provider.tokens >= this.config.maxSearchTokens ||
        error instanceof BudgetExhausted
          ? "budget_exhausted"
          : "failed";
      root.reason = String(error);
      await this.persist();
      throw error;
    }
    await this.persist();
    this.seen.add(policyHash(root.strategy));
    let incumbent: SearchNode | undefined =
      root.feasible &&
      (!confirmation.length || feasible(root.confirmation!, this.config))
        ? root
        : undefined;
    let stale = 0,
      stopReason = "iterations";
    const filtered = ["mia-space", "mia-full"].includes(this.config.variant),
      active = ["mia-acq", "mia-full"].includes(this.config.variant);
    for (
      let iteration = 1;
      iteration <= this.config.maxIterations;
      iteration++
    ) {
      const fullFrontier = this.nodes
        .filter((n) => n.status === "evaluated" && (n.feasible || n === root))
        .map((parent) => {
          const observed = new Set<string>();
          for (const r of parent.results)
            for (const t of r.execution.trace) {
              for (const d of t.state.deficits) observed.add(d.status);
              if (!t.state.deficits.some((d) => d.status !== "RESOLVED"))
                observed.add("NONE");
            }
          const edits = mutations(parent.strategy, observed, filtered)
            .filter(
              (e) =>
                !this.used.has(e.id) && !this.seen.has(policyHash(e.strategy)),
            )
            .map((edit) => ({
              edit,
              affected: affected(edit.strategy, parent.results),
            }))
            .filter((x) => x.affected.size);
          return { parent, edits };
        })
        .filter((x) => x.edits.length)
        .sort((a, b) => (b.parent.utility ?? 0) - (a.parent.utility ?? 0));
      const frontier = fullFrontier.slice(0, this.config.topParents);
      if (!frontier.length) {
        stopReason = "grammar-exhausted";
        break;
      }
      if (
        this.executions >= this.config.maxExecutions ||
        this.runtime.agents.provider.tokens >= this.config.maxSearchTokens
      ) {
        stopReason = "budget";
        break;
      }
      const best = frontier[0].parent.utility ?? 0,
        weights = frontier.map((f) =>
          Math.exp(((f.parent.utility ?? 0) - best) / this.config.temperature),
        ),
        sum = weights.reduce((a, b) => a + b, 0);
      const { parent, edits } = this.rng.weighted(
        frontier,
        weights.map(
          (w) =>
            ((1 - this.config.exploration) * w) / sum +
            this.config.exploration / frontier.length,
        ),
      );
      const experiments = edits.map((e) => ({
        key: e.edit.posteriorKey,
        triggerRate: e.affected.size / tasks.length,
      }));
      const eig = active
        ? acquisition(
            experiments,
            this.posterior,
            this.rng,
            this.config.monteCarloSamples,
          )
        : edits.map(() => 0);
      let index: number;
      const bootstrap = edits
        .map((e, i) => ({
          i,
          n: this.posterior.observations(e.edit.posteriorKey),
          coverage: e.affected.size,
        }))
        .filter((e) => e.n < this.config.minObservations)
        .sort((a, b) => a.n - b.n || b.coverage - a.coverage);
      if (active && bootstrap.length) index = bootstrap[0].i;
      else if (active) index = eig.indexOf(Math.max(...eig));
      else if (this.config.variant === "llm-guided") {
        try {
          const selection = await this.runtime.agents.structured(
            "mutation-selection",
            "Choose exactly one legal strategy edit to test based on the observed organization states. Return its id only. Do not estimate quality or information gain.",
            {
              strategy: parent.strategy,
              states: parent.results.flatMap((r) =>
                r.execution.trace.map((t) => t.state),
              ),
              edits: edits.map((e) => ({
                id: e.edit.id,
                description: e.edit.description,
              })),
            },
            z.object({ id: z.string() }).strict(),
            this.config.episode,
          );
          index = edits.findIndex((e) => e.edit.id === selection.value.id);
          if (index < 0) throw new Error("LLM selected an illegal mutation");
        } catch (error) {
          await append(join(this.out, "errors.jsonl"), {
            phase: "mutation-selection",
            error: String(error),
          });
          await this.persist();
          if (error instanceof BudgetExhausted) {
            stopReason = "budget";
            break;
          }
          throw error;
        }
      } else index = Math.floor(this.rng.next() * edits.length);
      const choice = edits[index],
        edit = choice.edit;
      this.used.add(edit.id);
      this.seen.add(policyHash(edit.strategy));
      const { strategy: generated, ...editRecord } = edit;
      const child: SearchNode = {
        id: `s${this.nodes.length}`,
        parent: parent.id,
        mutation: editRecord,
        strategy: { ...generated, id: `s${this.nodes.length}` },
        status: "evaluated",
        results: [],
      };
      this.nodes.push(child);
      await append(join(this.out, "decisions.jsonl"), {
        iteration,
        parent: parent.id,
        child: child.id,
        edit: editRecord,
        affectedIds: [...choice.affected],
        acquisition: eig[index],
        bootstrap: active && bootstrap.length > 0,
        triggerRate: choice.affected.size / tasks.length,
      });
      child.results = parent.results
        .filter((r) => !choice.affected.has(r.taskId))
        .map((r) => ({
          ...r,
          execution: { ...r.execution, actualTokens: 0, actualCalls: 0 },
          inheritedFrom: parent.id,
        }));
      const scheduled = this.rng.shuffle(
        tasks.filter((t) => choice.affected.has(t.id)),
      );
      try {
        let batchEnd = this.config.batchSize,
          corrections = 0,
          harms = 0;
        for (let i = 0; i < scheduled.length; i++) {
          const result = await this.execute(
            child.strategy,
            scheduled[i],
            parent.results.find((r) => r.taskId === scheduled[i].id),
          );
          child.results.push(result);
          const before = parent.results.find(
            (r) => r.taskId === result.taskId,
          )!;
          this.posterior.observe(edit.posteriorKey, before.score, result.score);
          if (result.score > before.score) corrections++;
          if (result.score < before.score) harms++;
          if (i + 1 === batchEnd && i + 1 < scheduled.length) {
            // Deterministic racing rule: >= 3 net harms rejects; it never promotes.
            if (harms - corrections >= 3) {
              child.status = "rejected";
              child.reason =
                "At least three net harms in the progressive batch";
              break;
            }
            batchEnd = Math.min(scheduled.length, batchEnd * 2);
          }
        }
        if (child.status === "evaluated") {
          child.utility = mean(child.results.map((r) => r.score));
          child.feasible = feasible(child.results, this.config);
          const improves =
            child.utility > (incumbent?.utility ?? -1) &&
            child.utility > (parent.utility ?? -1);
          if (child.feasible && improves) {
            child.confirmation = [];
            for (const t of confirmation)
              child.confirmation.push(await this.execute(child.strategy, t));
            const confirmed =
              !confirmation.length ||
              (feasible(child.confirmation, this.config) &&
                mean(child.confirmation.map((r) => r.score)) >=
                  mean(incumbent?.confirmation?.map((r) => r.score) ?? []));
            if (confirmed) {
              incumbent = child;
              stale = -1;
            } else child.reason = "Search improvement failed confirmation";
          }
        }
      } catch (error) {
        child.status =
          this.runtime.agents.provider.tokens >= this.config.maxSearchTokens ||
          error instanceof BudgetExhausted
            ? "budget_exhausted"
            : "failed";
        child.reason = String(error);
        await this.persist();
        if (
          error instanceof BudgetExhausted ||
          this.runtime.agents.provider.tokens >= this.config.maxSearchTokens
        ) {
          stopReason = "budget";
          break;
        }
        throw error;
      }
      stale++;
      await this.persist();
      await append(join(this.out, "curve.jsonl"), {
        iteration,
        executions: this.executions,
        tokens: this.runtime.agents.provider.tokens,
        bestUtility: incumbent?.utility ?? null,
        bestConfirmation: incumbent?.confirmation?.length
          ? mean(incumbent.confirmation.map((r) => r.score))
          : null,
        incumbent: incumbent?.id ?? null,
      });
      // An evaluated child opens a new frontier; do not infer its saturation from its parent's EIG.
      if (
        active &&
        stale >= this.config.patience &&
        child.status === "rejected" &&
        fullFrontier.length === 1
      ) {
        const remaining = edits.filter(
          (e) =>
            !this.used.has(e.edit.id) &&
            !this.seen.has(policyHash(e.edit.strategy)),
        );
        if (
          remaining.every(
            (e) =>
              this.posterior.observations(e.edit.posteriorKey) >=
              this.config.minObservations,
          )
        ) {
          const nextEig = acquisition(
            remaining.map((e) => ({
              key: e.edit.posteriorKey,
              triggerRate: e.affected.size / tasks.length,
            })),
            this.posterior,
            this.rng,
            this.config.monteCarloSamples,
          );
          if (Math.max(0, ...nextEig) < this.config.informationThreshold) {
            stopReason = "utility-stable-and-information-saturated";
            break;
          }
        }
      }
    }
    await this.persist();
    if (!incumbent)
      throw new Error(
        "No fully evaluated strategy met resource constraints; no deployable bundle exported",
      );
    const selection = [...tasks, ...confirmation];
    const bundle: Bundle = {
      version: 2,
      dittoVersion: "0.1.1",
      strategy: incumbent.strategy,
      pool: structuredClone([...this.runtime.pool]),
      model: this.runtime.agents.model,
      config: this.config,
      searchDataHash: digest(tasks),
      ...(confirmation.length
        ? { confirmationDataHash: digest(confirmation) }
        : {}),
      selectionTaskIds: selection.map((t) => t.id),
      selectionPromptHashes: selection.map((t) => digest(promptKey(t))),
      selectionGroups: [
        ...new Set(selection.flatMap((t) => (t.group ? [t.group] : []))),
      ],
      experimentalScope: "standard-isolated-state-v2",
    };
    await save(join(this.out, "best.json"), bundle);
    await save(join(this.out, "summary.json"), {
      stopReason,
      executions: this.executions,
      tokens: this.runtime.agents.provider.tokens,
      incumbent: incumbent.id,
      utility: incumbent.utility,
    });
    return bundle;
  }
  private async persist() {
    await save(join(this.out, "tree.json"), this.nodes);
    await save(join(this.out, "posterior.json"), this.posterior.counts);
    await save(
      join(this.out, "usage.json"),
      this.runtime.agents.provider.records,
    );
  }
}
