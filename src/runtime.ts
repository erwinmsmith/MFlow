import { checkpointState, restoreState, stateDigest } from "@codesoul-co/ditto";
import { DittoAgents, EpisodeExhausted } from "./ditto.js";
import { decide, sameDecision } from "./policy.js";
import {
  type EpisodeCheckpoint,
  type AgentProfile,
  type AgentState,
  type Artifact,
  type Deficit,
  type Edge,
  type Execution,
  type Limits,
  type PolicyState,
  type Strategy,
  type TaskInput,
  rootProfile,
} from "./types.js";
import { digest } from "./util.js";
import { runComposition } from "./composition.js";

/** Portable explicit episode state, checkpointed only between fully settled Ditto calls. */
export class OrganizationRuntime {
  constructor(
    readonly agents: DittoAgents,
    readonly limits: Limits,
    readonly pool: readonly AgentProfile[] = [rootProfile],
  ) {
    if (
      !pool.some((p) => p.id === "root") ||
      new Set(pool.map((p) => p.id)).size !== pool.length
    )
      throw new Error("Pool needs exactly one root and unique IDs");
  }
  captureCheckpoints = false;
  async run(
    strategy: Strategy,
    task: TaskInput,
    reuse?: { checkpoint: EpisodeCheckpoint; prefix: EpisodeCheckpoint[] },
  ): Promise<Execution> {
    if (strategy.composition) {
      if (reuse || this.captureCheckpoints)
        throw new Error("Native compositions resume completed tasks, not legacy action checkpoints");
      return runComposition(this.agents, this.limits, strategy, task);
    }
    this.agents.prompts = strategy.prompts;
    const pool = strategy.organization?.initialAgents ?? this.pool;
    for (const profile of pool) this.agents.validateProfile(profile);
    if (reuse || this.captureCheckpoints) this.agents.assertReplaySafe();
    const version = stateDigest({
      code: "mflow-episode-v3-mas",
      limits: this.limits,
      pool,
      model: this.agents.model,
      resources: this.agents.resourceVersion,
      task,
    });
    const restored = reuse
      ? restoreState(reuse.checkpoint, `episode:${task.id}`, version)
      : undefined;
    if (
      restored &&
      (restored.step !== restored.trace.length ||
        reuse!.prefix.length !== restored.step ||
        restored.step >= this.limits.maxSteps)
    )
      throw new Error("Invalid episode checkpoint boundary");
    if (
      restored?.trace.some(
        (t) => !sameDecision(decide(strategy, t.state), t.decision),
      )
    )
      throw new Error(
        "Strategy changes a preceding decision before this checkpoint",
      );
    const startedLogical = this.agents.provider.logicalTokens,
      startedLogicalCalls = this.agents.provider.logicalCalls;
    const checkpoints: EpisodeCheckpoint[] = reuse
      ? structuredClone(reuse.prefix)
      : [];
    this.agents.provider.beginEpisode(
      this.limits.maxTokens - (restored?.tokens ?? 0),
      { runId: task.id, branchId: strategy.id },
    );
    const startedTokens = this.agents.provider.tokens,
      startedCalls = this.agents.provider.calls;
    const population: AgentState[] =
      restored?.population ??
      structuredClone(pool).map((profile) => ({
        profile,
        status: profile.id === "root" ? "ACTIVE" : "DORMANT",
        depth: 0,
        turns: 0,
        stalled: false,
        episode: [],
        inbox: [],
      }));
    const deficits: Deficit[] = restored?.deficits ?? [],
      artifacts: Artifact[] = restored?.artifacts ?? [],
      edges: Edge[] = restored?.edges ?? [];
    const trace: Execution["trace"] = restored?.trace ?? [],
      outputs: Execution["outputs"] = restored?.outputs ?? [],
      toolEvents: unknown[] = restored?.toolEvents ?? [];
    const retrievalAttempts = new Set<string>(restored?.retrievalAttempts);
    let peakActive = restored?.peakActive ?? 1,
      stopReason: Execution["stopReason"] = "steps";
    let stopDetail: Execution["stopDetail"];
    const tokens = () =>
      (restored?.tokens ?? 0) +
      this.agents.provider.logicalTokens -
      startedLogical;
    const calls = () =>
      (restored?.calls ?? 0) +
      this.agents.provider.logicalCalls -
      startedLogicalCalls;
    const active = () => population.filter((a) => a.status === "ACTIVE").length;
    const remaining = (): Limits => ({
      ...this.limits,
      maxTokens: Math.max(1, this.limits.maxTokens - tokens()),
      maxOutputTokens: Math.min(
        this.limits.maxOutputTokens,
        Math.max(1, this.limits.maxTokens - tokens()),
      ),
    });
    const state = (): PolicyState =>
      structuredClone({
        availableTools: this.agents.tools.map(t => t.name),
        ...(strategy.program ? { task, step: trace.length, outputs, artifacts, edges, toolEvents, usage: { tokens: tokens(), calls: calls() } } : {}),
        deficits,
        agents: population.map((a) => ({
          id: a.profile.id,
          status: a.status,
          depth: a.depth,
          turns: a.turns,
          stalled: a.stalled,
          reviewed: a.reviewed ?? false,
          challenged: a.challenged ?? false,
          ...(strategy.program ? { profile: a.profile, assigned: a.assigned } : {}),
        })),
        maxDepth: this.limits.maxDepth,
      });
    const execute = async (agent: AgentState, review = false) => {
      if (tokens() >= this.limits.maxTokens) return;
      const before = digest({
        answer: agent.output?.candidate_answer,
        deficits: deficits
          .filter((d) => d.owner === agent.profile.id)
          .map((d) => ({ id: d.id, status: d.status })),
        artifacts: artifacts
          .filter((a) => a.source === agent.profile.id)
          .map((a) => a.content),
      });
      const result = await this.agents.execute(
        agent,
        task,
        deficits,
        artifacts.filter((a) => agent.inbox.includes(a.id)),
        remaining(),
        review,
      );
      toolEvents.push(...result.toolEvents);
      agent.turns++;
      if (review) agent.reviewed = true;
      agent.output = result.value;
      outputs.push({ agentId: agent.profile.id, output: result.value });
      agent.episode.push(JSON.stringify(result.value));
      for (const item of result.value.open_deficits) {
        const id = item.id.startsWith(agent.profile.id + ":")
          ? item.id
          : `${agent.profile.id}:${item.id}`;
        const existing = deficits.find((d) => d.id === id);
        if (existing) {
          if (existing.owner !== agent.profile.id)
            throw new Error("Deficit owner mismatch");
          existing.text = item.text;
          if (existing.status === "RESOLVED") {
            existing.status = "MISSING";
            delete existing.source;
            existing.artifactIds = [];
            existing.deliveredIds = [];
          }
          continue;
        }
        deficits.push({
          id,
          text: item.text,
          owner: agent.profile.id,
          status: "MISSING",
          artifactIds: [],
          deliveredIds: [],
        });
      }
      for (const item of result.value.artifacts) {
        const id = `${agent.profile.id}:${agent.turns}:${item.id}`;
        const refs = item.deficit_refs.map(
          (ref) =>
            deficits.find((d) => d.id === ref)?.id ??
            `${agent.profile.id}:${ref}`,
        );
        // Assigned outputs are explicitly routed evidence; they do not resolve the owner's deficit.
        if (agent.assigned && !refs.includes(agent.assigned))
          refs.push(agent.assigned);
        artifacts.push({
          id,
          source: agent.profile.id,
          type: item.type,
          content: item.content,
          deficitRefs: refs,
        });
        for (const d of deficits.filter(
          (d) =>
            refs.includes(d.id) &&
            d.owner !== agent.profile.id &&
            d.status !== "RESOLVED",
        )) {
          d.source = agent.profile.id;
          d.status = "ACTIVE";
          d.artifactIds.push(id);
        }
      }
      for (const ref of result.value.resolved_deficits) {
        const d = deficits.find(
          (d) => d.id === ref || d.id === `${agent.profile.id}:${ref}`,
        );
        if (d?.owner === agent.profile.id) d.status = "RESOLVED";
      }
      const after = digest({
        answer: agent.output?.candidate_answer,
        deficits: deficits
          .filter((d) => d.owner === agent.profile.id)
          .map((d) => ({ id: d.id, status: d.status })),
        artifacts: artifacts
          .filter((a) => a.source === agent.profile.id)
          .map((a) => a.content),
      });
      agent.stalled = before === after;
    };
    try {
      if (!restored)
        await execute(population.find((a) => a.profile.id === "root")!);
      for (
        let step = restored?.step ?? 0;
        step < this.limits.maxSteps;
        step++
      ) {
        if (tokens() >= this.limits.maxTokens) {
          stopReason = "tokens";
          break;
        }
        if (!restored || step !== restored.step)
          for (const d of deficits.filter(
            (d) => d.status === "MISSING" && !d.source,
          )) {
            const reusable = population.filter(
              (a) => a.status === "DORMANT" && a.profile.id !== d.owner,
            );
            const retrievalKey = digest({
              deficit: d,
              profiles: reusable.map((a) => a.profile),
            });
            if (retrievalAttempts.has(retrievalKey)) continue;
            retrievalAttempts.add(retrievalKey);
            const id = await this.agents.retrieve(
              d,
              reusable.map((a) => a.profile),
              remaining(),
            );
            if (id) {
              d.source = id;
              d.status = "LATENT";
            }
          }
        if (tokens() >= this.limits.maxTokens) {
          stopReason = "tokens";
          break;
        }
        if (this.captureCheckpoints)
          checkpoints.push(
            checkpointState(`episode:${task.id}`, version, {
              step,
              population,
              deficits,
              artifacts,
              edges,
              trace,
              outputs,
              toolEvents,
              retrievalAttempts: [...retrievalAttempts],
              peakActive,
              tokens: tokens(),
              calls: calls(),
            }),
          );
        const snapshot = state(),
          decision = decide(strategy, snapshot);
        let d = deficits.find((d) => d.id === decision.deficitId);
        if (decision.request) {
          const id = `policy:${step}:${deficits.length}`;
          d = { id, text: decision.request, owner: decision.agentId ?? "root",
            status: "MISSING", artifactIds: [], deliveredIds: [] };
          deficits.push(d);
          decision.deficitId = id;
        }
        const owner =
          population.find((a) => a.profile.id === (d?.owner ?? decision.agentId ?? "root"))!;
        let event: string = decision.action;
        if (decision.action === "STOP") {
          trace.push({ state: snapshot, decision, event });
          stopReason = "strategy";
          break;
        }
        if (decision.action === "RECONFIGURE") {
          const target = population.find(a => a.profile.id === decision.agentId)!;
          const profile = { ...decision.profile!, id: target.profile.id };
          this.agents.validateProfile(profile);
          target.profile = profile;
          target.reviewed = false;
          retrievalAttempts.clear();
        } else if (decision.action === "CONTINUE" || decision.action === "REVIEW") {
          const target = population.find(
            (a) => a.profile.id === decision.agentId,
          );
          if (target?.status === "ACTIVE") await execute(target, decision.action === "REVIEW");
          else event = "CONTINUE:no-active-target";
        } else if (decision.action === "DERIVE" || decision.action === "CHALLENGE") {
          const challenge = decision.action === "CHALLENGE";
          if (
            (!d && !challenge) ||
            d?.status === "RESOLVED" ||
            (challenge && owner.challenged) ||
            active() >= this.limits.maxActiveAgents ||
            population.length >= this.limits.maxPoolAgents ||
            owner.depth >= this.limits.maxDepth
          )
            event = "DERIVE:resource-limit-or-no-deficit";
          else {
            let requested = d;
            if (challenge) {
              let id = `${owner.profile.id}:independent-check`;
              while (deficits.some((item) => item.id === id)) id += "-next";
              requested = { id, owner: owner.profile.id, status: "MISSING", artifactIds: [], deliveredIds: [],
                text: "Solve the original task independently from its constraints and return a compact derivation or exhaustive check of the decisive result. The owner will compare your evidence with its own solution. This is a strategy-requested independent check, not a known error." };
              deficits.push(requested);
            }
            const assignment = requested!;
            let n = population.length;
            while (population.some((a) => a.profile.id === `agent-${n}`)) n++;
            const profile = decision.profile
              ? { ...decision.profile, id: `agent-${n}` }
              : await this.agents.derive(
              assignment,
              owner.profile,
              task,
              `agent-${n}`,
              remaining(),
              challenge ? undefined : owner.output,
            );
            this.agents.validateProfile(profile);
            const agent: AgentState = {
              profile,
              status: "ACTIVE",
              depth: owner.depth + 1,
              assigned: assignment.id,
              turns: 0,
              stalled: false,
              episode: [],
              inbox: [],
            };
            population.push(agent);
            if (challenge) owner.challenged = true;
            assignment.source = profile.id;
            assignment.status = "ACTIVE";
            assignment.artifactIds = [];
            assignment.deliveredIds = [];
            peakActive = Math.max(peakActive, active());
            await execute(agent);
          }
        } else if (decision.action === "REACTIVATE") {
          const source = population.find((a) => a.profile.id === (decision.agentId ?? d?.source));
          if (
            !d ||
            !source ||
            source.status !== "DORMANT" ||
            active() >= this.limits.maxActiveAgents ||
            owner.depth >= this.limits.maxDepth
          )
            event = "REACTIVATE:unavailable";
          else {
            d.source = source.profile.id;
            source.status = "ACTIVE";
            source.depth = owner.depth + 1;
            source.assigned = d.id;
            d.status = "ACTIVE";
            peakActive = Math.max(peakActive, active());
            await execute(source);
          }
        } else if (decision.action === "CONNECT") {
          if (
            !d?.source ||
            d.status === "RESOLVED" ||
            !d.artifactIds.some((id) => !d.deliveredIds.includes(id))
          )
            event = "CONNECT:no-pending-artifact";
          else {
            const pending = d.artifactIds.filter(
              (id) => !d.deliveredIds.includes(id),
            );
            owner.inbox = [...new Set([...owner.inbox, ...pending])];
            d.deliveredIds.push(...pending);
            d.status = "DELIVERED";
            edges.push({
              source: d.source,
              target: d.owner,
              deficitId: d.id,
              artifactIds: pending,
            });
          }
        } else if (decision.action === "DISCONNECT") {
          if (d) {
            for (let i = edges.length - 1; i >= 0; i--)
              if (edges[i].deficitId === d.id) edges.splice(i, 1);
          }
          // Already delivered evidence is not erased by removing a communication edge.
        } else if (decision.action === "DORMANT") {
          const target = population.find(
            (a) => a.profile.id === decision.agentId,
          );
          if (
            target &&
            target.profile.id !== "root" &&
            !deficits.some(
              (x) =>
                x.status !== "RESOLVED" &&
                (x.owner === target.profile.id ||
                  x.source === target.profile.id),
            )
          )
            target.status = "DORMANT";
          else event = "DORMANT:active-dependency";
        }
        trace.push({ state: snapshot, decision, event });
      }
    } catch (error) {
      if (error instanceof EpisodeExhausted) { stopReason = "tokens"; stopDetail = error.reason; }
      else throw error;
    } finally {
      this.agents.provider.endEpisode();
    }
    if (tokens() >= this.limits.maxTokens) stopReason = "tokens";
    if (stopReason === "tokens" && !stopDetail) stopDetail = "episode_budget";
    return {
      taskId: task.id,
      strategyId: strategy.id,
      answer:
        population.find((a) => a.profile.id === "root")!.output
          ?.candidate_answer ?? "",
      trace,
      agents: population.map((a) => a.profile),
      artifacts,
      edges,
      outputs,
      toolEvents,
      tokens: tokens(),
      calls: calls(),
      actualTokens: this.agents.provider.tokens - startedTokens,
      actualCalls: this.agents.provider.calls - startedCalls,
      reusedPrefixSteps: restored?.step ?? 0,
      checkpoints,
      peakActive,
      depth: Math.max(...population.map((a) => a.depth)),
      stopReason,
      ...(stopDetail ? { stopDetail } : {}),
    };
  }
}
