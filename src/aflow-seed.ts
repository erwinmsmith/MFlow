import { organizationSchema, rootProfile, type Task } from './types.js';
import { FACTORY_PROMPT } from './prompts.js';

// Adapted from the actual AFlow MATH round-12 solve/revise candidate. These are
// editable seeds, not fixed roles or an application-owned reasoning engine.
export const textPrompts = {
  agent: String.raw`Solve the following math problem step by step. Provide a clear, detailed reasoning process and end with the final answer in the format: \boxed{answer}. Ensure the answer is concise and matches the expected format (e.g., a number, a fraction, or a list of letters separated by commas).

Problem:`,
  review: String.raw`You are given a math problem and an initial solution. Carefully review the initial solution for any errors in reasoning, calculation, or interpretation. If you find mistakes, correct them and provide the correct final answer. If the initial solution is correct, confirm it and restate the final answer. Always end with the final answer in the format: \boxed{answer}. Ensure the answer is concise and matches the expected format (e.g., a number, a fraction, or a list of letters separated by commas).

Check each consequential step once. Once the answer is established, finish the response; do not repeatedly re-derive or recheck it. If an approach stalls, state the concrete obstacle instead of cycling through the same calculations.

Problem and Initial Solution:`,
  integrate: String.raw`Solve the original math problem using the supplied full derivations as evidence. Identify the exact step behind any disagreement; check it by calculation or a different argument. Correct unsupported assertions rather than voting on wording. Return a self-contained solution ending with \boxed{answer}. Do not replace the stated problem with a remembered variant.

Problem:`,
  factory: FACTORY_PROMPT,
  retrieve: 'Choose a relevant reusable agent program and assign a concrete mathematical objective and method. Do not choose by a confidence score.',
};

export const textSolver = `return loop({id:'solve',plan:function*(ctx){
  const id=ctx.self, messages=ctx.textMessages(id,ctx.evidence,ctx.prompt);
  for(;;){
    const load=id+'/context',sample=id+'/sample';
    const g=graph(id+'/solve')
      .node(load,'CONTEXT.LOAD',[],()=>({sources:messages}))
      .node(sample,'INFER.REASONING.SAMPLE',[load],(_,out)=>ctx.request(id,
        out[load].items.map((item,i)=>({...messages[i],content:item.content})),true,'text'));
    const out=yield* graphStep(g,null);
    if(out[sample].status!=='success') return ctx.failedAgent(id,out[sample].error);
    const response=ctx.unwrap(out[sample]);
    if(!response.actionRequests?.length) return ctx.publishText(id,response.message.content);
    messages.push({...response.message,metadata:{actionRequests:response.actionRequests}});
    for(const call of response.actionRequests){
      const act=id+'/tool',observe=id+'/observe';
      const tools=graph(id+'/tools')
        .node(act,'INTERACTION.ACT.TOOL',[],()=>({call}))
        .node(observe,'INTERACTION.OBSERVE',[act],(_,out)=>({result:out[act]}));
      const result=yield* graphStep(tools,null);
      messages.push({role:'tool',content:result[observe].message.content,metadata:{actionRequestId:call.id,name:call.name}});
    }
  }
}});`;

export const textReviewer = `return loop({id:'revise',plan:function*(ctx){
  const id=ctx.self,node=id+'/revise';
  const g=graph(id+'/revise').node(node,'INFER.REASONING.SAMPLE',[],()=>
    ctx.request(id,ctx.textMessages(id,ctx.evidence,ctx.prompt),false,'text'));
  const out=yield* graphStep(g,null);
  if(out[node].status!=='success') return ctx.failedAgent(id,out[node].error);
  return ctx.publishText(id,ctx.unwrap(out[node]).message.content);
}});`;

const profile = { ...rootProfile, tools: [], nodes: ['CONTEXT.LOAD', 'INFER.REASONING.SAMPLE'], reasoning: 'cot',
  expected_output: 'Complete mathematical solution ending in a boxed final answer.', stop_condition: 'A complete solution or a concrete unresolved obstacle is stated.' };
const { id: _id, ...capability } = profile;
export const textOrganization = organizationSchema.parse({
  initialAgents: [profile], initialBindings: { root: 'solver' },
  agentTemplates: [
    { id: 'solver', description: 'Full mathematical derivation with context and sampling nodes.', profile: capability, composition: textSolver },
    { id: 'reviewer', description: 'Review a complete derivation against the original problem and revise it.',
      profile: { ...capability, objective: 'Find and correct concrete errors in the supplied derivation.', capability: 'Mathematical review and revision', nodes: ['INFER.REASONING.SAMPLE'] }, composition: textReviewer },
    { id: 'independent', description: 'Independent derivation with optional exact computation, enumeration or counterexample tools.',
      profile: { ...capability, objective: 'Derive a solution independently using a complementary method.', capability: 'Independent mathematical reasoning and executable checks', tools: ['arithmetic', 'python'],
        nodes: ['CONTEXT.LOAD','INFER.REASONING.SAMPLE','INTERACTION.ACT.TOOL','INTERACTION.OBSERVE'], reasoning: 'react' }, composition: textSolver },
  ],
});

export const aflowInspiredComposition = `function solution(output){
  return output.artifacts.filter(a=>a.type==='solution').map(a=>a.content).join('\\n');
}
return loop({id:'adaptive-mas',plan:function*(ctx){
  const first=yield* ctx.runAgent('root','','agent');
  ctx.spawnTemplate('reviewer','reviewer','root');
  const review=yield* ctx.runAgent('reviewer','Initial solution:\\n'+solution(first),'review');
  ctx.dormant('reviewer');
  const a=ctx.answerKey(first.candidate_answer),b=ctx.answerKey(review.candidate_answer);
  if(a && b && a===b) return review.candidate_answer;
  // Failure, missing final answer, or disagreement motivates a different method.
  ctx.spawnTemplate('independent','independent','root');
  const independent=yield* ctx.runAgent('independent','Solve independently; verify consequential calculations with available tools when useful.','agent');
  ctx.dormant('independent');
  const c=ctx.answerKey(independent.candidate_answer);
  if(c && (c===a || c===b)) return independent.candidate_answer;
  const complete=[first,review,independent].filter(x=>x.candidate_answer);
  if(!complete.length) return '';
  if(complete.length===1) return complete[0].candidate_answer;
  const final=yield* ctx.runAgent('root',complete.map((x,i)=>'Derivation '+(i+1)+':\\n'+solution(x)).join('\\n\\n'),'integrate');
  return final.candidate_answer || review.candidate_answer || independent.candidate_answer || first.candidate_answer;
}});`;

/** The search method is shared; its initialization and answer contract belong to the dataset. */
export function benchmarkSeed(tasks: Task[]) {
  const benchmarks = new Set(tasks.map(t => t.benchmark ?? t.metric));
  if (benchmarks.size !== 1) throw new Error('A search run must use one benchmark and scoring protocol');
  const benchmark = [...benchmarks][0];
  const dataset = ({ math: 'MATH', gsm8k: 'GSM8K', drop: 'DROP', humaneval: 'HumanEval',
    humaneval_plus: 'HumanEvalPlus', mbpp: 'MBPP' } as Record<string, string>)[benchmark] ?? 'Custom';
  if (benchmark === 'math' || benchmark === 'gsm8k' || benchmark === 'numeric') return {
    dataset, kind: 'mathematical reasoning', composition: aflowInspiredComposition,
    organization: textOrganization, prompts: textPrompts,
    provenance: 'AFlow MATH round-12 solve/revise prompts, with adaptive independent reasoning; validation-informed transfer, no test data',
  };
  const code = tasks[0].metric === 'python' || tasks[0].metric === 'evalplus';
  const contract = code
    ? 'Return the complete executable Python solution with the requested function signature and any needed imports. No Markdown fences, explanations or boxed answers. Only public examples from the problem may be used as checks; hidden evaluation tests are not available.'
    : 'Answer the question using only the supplied passage and question. Return only the concise final answer; multiple answer spans may be separated with |. Do not include a derivation, Markdown or a boxed answer.';
  const prompts = {
    agent: `Solve the original task accurately. ${contract}\n\nTask:`,
    review: `Review the supplied candidate against the ORIGINAL task. Correct concrete implementation, reasoning or interpretation errors. If it is correct, restate it unchanged. ${contract}\n\nTask and candidate:`,
    integrate: `Resolve disagreements by checking the original specification and the supplied candidates. Produce one correct solution, rather than voting on wording. ${contract}\n\nTask:`,
    factory: FACTORY_PROMPT,
    retrieve: 'Choose a relevant reusable agent and assign a concrete objective complementary to the current unresolved issue.',
  };
  const organization = structuredClone(textOrganization);
  for (const profile of [...organization.initialAgents, ...organization.agentTemplates!.map(t => t.profile)]) {
    profile.objective = code ? 'Implement the requested Python function correctly.' : 'Answer the supplied reading-comprehension question accurately.';
    profile.capability = code ? 'Python programming and specification checking' : 'Evidence-grounded reading comprehension';
    profile.expected_output = contract;
    profile.stop_condition = 'A complete answer or a concrete unresolved obstacle is stated.';
  }
  for (const template of organization.agentTemplates!) {
    // Code and QA answers are raw output, even if their content contains a literal boxed expression.
    template.composition = template.composition.replace(/ctx\.publishText\(id,([^\n;]+)\)/g, "ctx.publishText(id,$1,'raw')");
    template.description = `${template.id}: ${code ? 'Python implementation and review' : 'Reading comprehension and evidence checking'}`;
    if (template.id === 'reviewer') template.profile.objective = 'Find and correct specific errors in the supplied candidate.';
    if (template.id === 'independent') template.profile.objective = 'Solve independently using a complementary method and the original specification.';
  }
  const composition = `function solution(output){
  return output.artifacts.filter(a=>a.type==='solution').map(a=>a.content).join('\\n');
}
return loop({id:'adaptive-mas',plan:function*(ctx){
  const first=yield* ctx.runAgent('root','','agent');
  ctx.spawnTemplate('reviewer','reviewer','root');
  const review=yield* ctx.runAgent('reviewer','Initial candidate:\\n'+solution(first),'review');
  ctx.dormant('reviewer');
  if(first.candidate_answer && first.candidate_answer.trim()===review.candidate_answer.trim()) return review.candidate_answer;
  ctx.spawnTemplate('independent','independent','root');
  const independent=yield* ctx.runAgent('independent','Solve independently from the original task.','agent');
  ctx.dormant('independent');
  const complete=[first,review,independent].filter(x=>x.candidate_answer);
  if(!complete.length) return '';
  if(complete.length===1) return complete[0].candidate_answer;
  const final=yield* ctx.runAgent('root',complete.map((x,i)=>'Candidate '+(i+1)+':\\n'+solution(x)).join('\\n\\n'),'integrate');
  return final.candidate_answer || review.candidate_answer || independent.candidate_answer || first.candidate_answer;
}});`;
  return { dataset, kind: code ? 'code generation' : 'reading comprehension', composition, organization, prompts,
    provenance: 'Dataset-specific editable MFlow seed; official AFlow optimization controller; no MATH round-12 initialization or test data' };
}
