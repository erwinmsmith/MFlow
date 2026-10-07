import { strategySchema, type Strategy } from './types.js';

/** Frozen routing ablations; profiles, agent programs and prompts stay inherited. */
export function ablationStrategy(source: Strategy, variant: 'single' | 'fixed-full' | 'fixed-uniform' | 'fixed-heterogeneous' | 'fixed-homogeneous'): Strategy {
  const templates = source.organization?.agentTemplates ?? [];
  const paired = variant === 'fixed-heterogeneous' || variant === 'fixed-homogeneous';
  const required = variant === 'single' ? ['solver'] : paired ? ['solver', 'verifier'] : ['solver', 'reviewer', 'independent', 'checker'];
  if (source.organization?.initialBindings?.root !== 'solver' ||
      source.organization.initialAgents.length !== 1 || !source.prompts ||
      required.some(id => !templates.some(template => template.id === id)))
    throw new Error('Ablation requires the frozen solver-bound root and requested templates');
  const candidate = structuredClone(source);
  if (variant === 'fixed-uniform' || variant === 'fixed-homogeneous') {
    const shared = templates.find(template => template.id === (paired ? 'solver' : 'independent'))!;
    for (const template of candidate.organization!.agentTemplates!) {
      template.composition = shared.composition;
      Object.assign(template.profile, { tools: [...shared.profile.tools], nodes: [...shared.profile.nodes!], reasoning: shared.profile.reasoning });
    }
    for (const profile of candidate.organization!.initialAgents)
      Object.assign(profile, { tools: [...shared.profile.tools], nodes: [...shared.profile.nodes!], reasoning: shared.profile.reasoning });
  }
  const composition = variant === 'single' ? String.raw`return loop({id:'single',plan:function*(ctx){
    const result=yield* ctx.runAgent('root','','agent');
    return result.candidate_answer;
  }});` : paired ? String.raw`return loop({id:'fixed-pair',plan:function*(ctx){
    const first=yield* ctx.runAgent('root','','agent');
    ctx.spawnTemplate('verifier','verifier','root');
    const verification=yield* ctx.runAgent('verifier',{candidate:first.candidate_answer,outputs:ctx.outputs,
      instruction:'Independently re-read the affected records via api_search/api_fetch and confirm each postcondition. Report observed identifiers and any mismatch. Do not perform any write.'},'agent');
    ctx.dormant('verifier');
    const final=yield* ctx.runAgent('root',{previous:ctx.outputs,verification,
      instruction:'Inspect current state and recover only unfinished work using your bound program. Preserve all observed successful effects; never repeat a successful write. Return a complete answer or an explicit blocker.'},'agent');
    return final.candidate_answer || first.candidate_answer;
  }});` : String.raw`function solution(output){
    return output.artifacts.filter(a=>a.type==='solution').map(a=>a.content).join('\n');
  }
  return loop({id:'fixed-full',plan:function*(ctx){
    const first=yield* ctx.runAgent('root','','agent');
    ctx.spawnTemplate('reviewer','reviewer','root');
    const review=yield* ctx.runAgent('reviewer','Initial solution:\n'+solution(first),'review');
    ctx.dormant('reviewer');
    ctx.spawnTemplate('independent','independent','root');
    const independent=yield* ctx.runAgent('independent','Solve independently; verify consequential calculations with available tools when useful.','agent');
    ctx.dormant('independent');
    const complete=[first,review,independent].filter(x=>x.candidate_answer);
    ctx.spawnTemplate('checker','checker','root');
    const check=yield* ctx.runAgent('checker',complete.map((x,i)=>'Derivation '+(i+1)+':\n'+solution(x)).join('\n\n'),'review');
    ctx.dormant('checker');
    const evidence=[...complete,check].filter(x=>x.candidate_answer);
    const final=yield* ctx.runAgent('root',evidence.map((x,i)=>'Derivation '+(i+1)+':\n'+solution(x)).join('\n\n'),'integrate');
    return final.candidate_answer || check.candidate_answer || review.candidate_answer || independent.candidate_answer || first.candidate_answer;
  }});`;
  return strategySchema.parse({ ...candidate, id: `${source.id}-${variant}`,
    composition: variant === 'fixed-uniform' ? composition.replace("id:'fixed-full'", "id:'fixed-uniform'") : composition });
}
