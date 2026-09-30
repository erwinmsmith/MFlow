import { strategySchema, type Strategy } from './types.js';

/** Frozen routing ablations; profiles, agent programs and prompts stay inherited. */
export function ablationStrategy(source: Strategy, variant: 'single' | 'fixed-full'): Strategy {
  const templates = source.organization?.agentTemplates ?? [];
  const required = variant === 'single' ? ['solver'] : ['solver', 'reviewer', 'independent', 'checker'];
  if (source.organization?.initialBindings?.root !== 'solver' ||
      source.organization.initialAgents.length !== 1 || !source.prompts ||
      required.some(id => !templates.some(template => template.id === id)))
    throw new Error('Ablation requires the frozen solver-bound root and requested templates');
  const composition = variant === 'single' ? String.raw`return loop({id:'single',plan:function*(ctx){
    const result=yield* ctx.runAgent('root','','agent');
    return result.candidate_answer;
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
  return strategySchema.parse({ ...structuredClone(source), id: `${source.id}-${variant}`, composition });
}
