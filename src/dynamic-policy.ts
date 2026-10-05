/** Editable seed source: all inference, graph execution and tools remain Ditto operations. */
export const dynamicPolicyPrompt = `Design the next execution stage of this MAS from the original task, current population, actual prior outputs, tools, internal programs and executed topology. Return JSON {stop:boolean,reason:string,gap:string,composition:string,answer:string}.
Stop when observed evidence supports completion or an honest irreducible blocker; never spawn solely to increase population. On stop, composition is empty and answer summarizes only observed effects. Otherwise explain a concrete unresolved gap and return executable composition for the next stage, not its answer. Reconsider this decision after the stage finishes. A failed stage must be repaired from current state, preserving completed writes.
composition returns native loop({id,plan:function*(ctx){...}}) whose generator returns an AgentOutput object. It runs as root with ctx.self, ctx.evidence and the supplied Ditto guide. You may reuse templates, ctx.spawn(profile,parentId,newProgram) for genuinely different internal graphs, ctx.reconfigure capabilities, ctx.bindProgram for future runs, or execute cross-agent graph dependencies directly. Decide when to add, reuse, retire, reconnect or revise agents based on this task's current evidence. IDs must be unique or reuse an existing member. Never ctx.runAgent('root') from root's bound program: that recurses into itself; build root's native nodes directly or call a different agent.
EXECUTABLE BINDINGS: ctx.spawnTemplate, spawn, bindProgram, bindTemplate, publish and the other helpers are SYNCHRONOUS; call them directly, never yield*. Only ctx.runAgent and graphStep return delegable generators. Re-entering the same agent's active bound program (directly or through a child) is a recursive execution error; perform its nodes directly or bind a different internal program. ctx.agents is an ARRAY property: use ctx.agents.some(a=>a.profile.id===id), never ctx.agents(). ctx.spawn(profile,parentId) alone has NO internal program and cannot be runAgent'ed. Either use spawnTemplate, or pass a complete SOURCE STRING as the third spawn argument (or bindProgram). Never pass a function, generator, object, or function.toString() as a program. To adapt a library program, use ctx.templates.find(t=>t.id===templateId).composition, a source string, then bind it explicitly. Reuse or bind an existing member after a failed stage; do not spawn its ID twice. Anonymous and named plan generators are both supported; do not invent VM restrictions from previous model guesses. Read the actual exception and correct that contract. Do not repeat a failed program or keep reformulating its rationale without changing the failing operation.
Independent read-only branches can run concurrently; serialize conflicting writes and pass observed identifiers/results along explicit dependencies. Agents may have different node graphs, reasoning strategies and tool permissions. Each may create tools during execution. Prefer a new graph when the library cannot address the gap, and an existing agent when it can. Use stage-local/context evidence for execution, not embedded task answers or cached state in reusable program source. Do not force verifier roles; retrieval, entity resolution, reasoning, recovery and tool-building are possible responsibilities.
Before designing a member, inspect the supplied node contracts, profile permissions and exact available tool schemas. Choose its own node types, input configuration, dependencies, evidence and stopping rule for the assigned gap; do not merely copy root's entire profile and rename its role. Reasoning-only, context-routing and tool-using programs may differ. For a useful repeated computation or action sequence, an executing agent may create a parameterized tool and invoke it through TOOL/OBSERVE; registration alone is not completed work. Share it only with members holding its dependencies. Start from the current population and derive complementary agents when decomposition, a different reasoning method or evidence exchange is useful; existing templates are optional examples, not the permitted space.
Use SAMPLE -> TOOL -> OBSERVE -> SAMPLE loops for real actions, and handle actionRequests before forwarding results. REFLECT criteria must be [{id,description}]; status errors are feedback. The returned stage should finish once its stated gap is resolved or its obstacle is observed, so the outer policy can reassess the evolving MAS. Do not replace every stage with a complete re-solve or repeat already completed effects.`;

export function dynamicPolicyComposition(initial?: string) {
  return `return loop({id:'dynamic-mas-policy',plan:function*(ctx){
    let last,failedStages=0;
    const recoveryTemplate=ctx.agents.find(a=>a.profile.id==='root').templateId;
    function* recover(reason){
      ctx.recordDecision({stop:true,reason:'Execution repair exhausted',error:reason,recoveryTemplate});
      if(!recoveryTemplate)return ctx.failedAgent('root',reason).candidate_answer;
      const observations=ctx.graphs.flatMap(g=>g.nodes.filter(n=>n.type==='INTERACTION.OBSERVE').map(n=>g.outputs[n.id]));
      ctx.bindTemplate('root',recoveryTemplate);
      const result=yield* ctx.runAgent('root',{error:reason,previous:ctx.outputs,observations,
        instruction:'The generated execution stage failed. Inspect current state and recover only unfinished work using your bound program. Preserve all observed successful effects; never repeat a successful write. Return a complete answer or an explicit blocker.'},'agent');
      return result.candidate_answer;
    }
    ${initial ? `const initial=(()=>{${initial}\n})();
    try{last={answer:yield* initial.plan(ctx)};}catch(error){last={error:String(error)};}` : ''}
    for(let stage=0;;stage++){
      const state={stage,last,outputs:ctx.outputs,structure:ctx.structure,tools:ctx.tools};
      const messages=ctx.textMessages('root',state,'factory');
      let decision;
      for(let attempt=0;attempt<3;attempt++){
        const node='root/policy';
        const out=yield* graphStep(graph('policy-'+stage).node(node,'INFER.REASONING.SAMPLE',[],()=>ctx.request('root',messages,false,'json')),null);
        if(out[node].status!=='success'){last={error:out[node].error};if(out[node].error?.code==='MODEL_CONTEXT_LIMIT')break;continue;}
        const response=ctx.unwrap(out[node]);
        try{
          const d=JSON.parse(response.message.content);
          if(typeof d.stop!=='boolean'||typeof d.reason!=='string'||typeof d.gap!=='string'||typeof d.composition!=='string'||typeof d.answer!=='string')throw new Error('Expected stop,reason,gap,composition,answer');
          if(d.stop&&!ctx.outputs.length)throw new Error('Execute a stage before claiming completion');
          if(!d.stop){if(!d.composition.trim())throw new Error('Continuing requires a native stage program');ctx.bindProgram('root',d.composition);}
          decision=d;break;
        }catch(error){last={error:String(error)};messages.push(response.message,{role:'user',content:'Repair only the decision/program contract, preserve the task state and intended next step: '+String(error)});}
      }
      if(!decision){
        return yield* recover(last?.error||'Invalid decision');
      }
      ctx.recordDecision({stage,stop:decision.stop,reason:decision.reason,gap:decision.gap});
      if(decision.stop)return decision.answer||ctx.outputs.filter(o=>o.output.candidate_answer).at(-1)?.output.candidate_answer||'';
      try{last={output:yield* ctx.runAgent('root',state,'agent')};failedStages=0;}
      catch(error){last={error:String(error)};
        // Code-execution protection: bound consecutive broken stages, not successful work or search rounds.
        if(++failedStages>=3)return yield* recover(last.error);
      }
    }
  }});`;
}
