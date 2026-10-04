import { organizationSchema, rootProfile, compositionNodes, type Task } from './types.js';
import { FACTORY_PROMPT } from './prompts.js';
import { dynamicPolicyComposition, dynamicPolicyPrompt } from './dynamic-policy.js';

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

// Search-visible continuation shared by seed programs; all execution remains native Ditto graphs.
export const toolContinuation = `function* finishText(ctx,id,messages,response){
  while(response.actionRequests?.length){
    messages.push({...response.message,metadata:{...response.message.metadata,actionRequests:response.actionRequests}});
    for(const call of response.actionRequests){
      const act=id+'/tool',observe=id+'/observe';
      const g=graph(id+'/tools')
        .node(act,'INTERACTION.ACT.TOOL',[],()=>({call}))
        .node(observe,'INTERACTION.OBSERVE',[act],(_,out)=>({result:out[act]}));
      const result=yield* graphStep(g,null);
      messages.push({role:'tool',content:result[observe].message.content,metadata:{actionRequestId:call.id,name:call.name}});
    }
    const sample=id+'/continue';
    const out=yield* graphStep(graph(id+'/continue').node(sample,'INFER.REASONING.SAMPLE',[],()=>ctx.request(id,messages,true,'text')),null);
    if(out[sample].status!=='success'){ctx.failedAgent(id,out[sample].error);return '';}
    response=ctx.unwrap(out[sample]);
  }
  return response.message.content;
}
`;

export const textSolver = toolContinuation + `return loop({id:'solve',plan:function*(ctx){
  const id=ctx.self,messages=ctx.textMessages(id,ctx.evidence,ctx.prompt);
  const load=id+'/context',sample=id+'/sample';
  const g=graph(id+'/solve')
    .node(load,'CONTEXT.LOAD',[],()=>({sources:messages}))
    .node(sample,'INFER.REASONING.SAMPLE',[load],(_,out)=>ctx.request(id,
      out[load].items.map((item,i)=>({...messages[i],content:item.content})),true,'text'));
  const out=yield* graphStep(g,null);
  if(out[sample].status!=='success') return ctx.failedAgent(id,out[sample].error);
  return ctx.publishText(id,yield* finishText(ctx,id,messages,ctx.unwrap(out[sample])));
}});`;

export const textReviewer = toolContinuation + `return loop({id:'revise',plan:function*(ctx){
  const id=ctx.self,node=id+'/revise',messages=ctx.textMessages(id,ctx.evidence,ctx.prompt);
  const g=graph(id+'/revise').node(node,'INFER.REASONING.SAMPLE',[],()=>ctx.request(id,messages,true,'text'));
  const out=yield* graphStep(g,null);
  if(out[node].status!=='success') return ctx.failedAgent(id,out[node].error);
  return ctx.publishText(id,yield* finishText(ctx,id,messages,ctx.unwrap(out[node])));
}});`;

const profile = { ...rootProfile, tools: [], nodes: ['CONTEXT.LOAD', 'INFER.REASONING.SAMPLE'], reasoning: 'cot',
  expected_output: 'Complete mathematical solution ending in a boxed final answer.', stop_condition: 'A complete solution or a concrete unresolved obstacle is stated.' };
const { id: _id, ...capability } = profile;
export const automationInstruction = `Complete the requested business workflow in the official simulated APIs.
Discover precise endpoints with api_search; read each endpoint's method, parameter names and response schema before api_fetch.
api_fetch params and body must be JSON-encoded strings or null, never JSON objects. api_search requires an integer top_k. When a tool reports invalid arguments, correct the request and retry its intended action; preserve already successful effects.
Resolve names to real record IDs; follow pagination and cross-application identifiers. Keep filters, exact values, recipients, formatting, dates and conditions from the user's task.
Copy source field values exactly, including punctuation in phone numbers and identifiers. Do not normalize or reformat values unless the task explicitly requests it. Verify documented response field names before treating an absent or differently named field as a failed write.
Inspect current state before writes; every agent shares this task's world. Reuse completed work, never recreate records or repeat successful sends.
After each consequential write, inspect the resulting state and verify every requested postcondition. Repair concrete missing effects; do not replace tool execution with prose.
Only API observations and the user's request are evidence. Grading references and hidden world snapshots are unavailable. Summarize completed effects, identifiers and any specific blocker concisely. Planning, role-design and ranking stages must follow their requested control format, propose concrete dependencies and checks, and never claim unexecuted effects.`;
export const hleInstruction = `Solve the original expert-level academic question, including any supplied image. Respect its exact definitions, assumptions, units and requested precision; for multiple choice give the option letter.
Choose a subject-appropriate method. Separate established facts from speculation, and check the decisive step with an independent argument or exact computation when useful. Inspect supplied images directly; do not pretend to see labels or details that are not present.
Available external tools are arithmetic, isolated Python and web_search. Use web results as cited evidence, verify their relevance, and do not seek benchmark answer keys or author rationales. State a concrete blocker if the evidence is insufficient; do not repeatedly cycle through the same conjecture or computation.
Use focused subject queries and primary sources, not the whole question. Tool actions must be actual structured calls, never prose such as "I will search". After a failed tool call, inspect its error and change the query or computation; do not infer that all tools are unavailable. Python has no internet: retrieve evidence with web_search and compute with Python. Repeatedly announcing or reconsidering the same action is not progress; execute the decisive check or state the unresolved gap. Each additional reasoning step or tool call should resolve a named uncertainty; when a route fails, change method or report that uncertainty. Do not expand repeated speculative reasoning into a longer answer. A short justified answer is preferable to unsupported elaboration.
For final solution responses, return these sections (framework control, role-design and operator-format stages must instead follow their requested schema exactly): Explanation: your reasoning; Answer: the precise final answer, without extra alternatives; Confidence: your estimated probability of correctness from 0% to 100%. Confidence reflects evidence, not the number of agents that agree.`;
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
export function benchmarkSeed(tasks: Pick<Task, 'benchmark' | 'metric'>[]) {
  const benchmarks = new Set(tasks.map(t => t.benchmark ?? t.metric));
  if (benchmarks.size !== 1) throw new Error('A search run must use one benchmark and scoring protocol');
  const benchmark = [...benchmarks][0];
  const dataset = ({ math: 'MATH', gsm8k: 'GSM8K', drop: 'DROP', humaneval: 'HumanEval',
    humaneval_plus: 'HumanEvalPlus', mbpp: 'MBPP', hle: 'HLE', automationbench: 'AutomationBench' } as Record<string, string>)[benchmark] ?? 'Custom';
  if (benchmark === 'math' || benchmark === 'gsm8k' || benchmark === 'numeric') return {
    dataset, kind: 'mathematical reasoning', composition: aflowInspiredComposition,
    organization: textOrganization, prompts: textPrompts,
    provenance: 'AFlow MATH round-12 solve/revise prompts, with adaptive independent reasoning; validation-informed transfer, no test data',
  };
  const code = tasks[0].metric === 'python' || tasks[0].metric === 'evalplus';
  const workflow = benchmark === 'automationbench';
  const academic = benchmark === 'hle';
  const contract = code
    ? 'Return the complete executable Python solution with the requested function signature and any needed imports. No Markdown fences, explanations or boxed answers. Only public examples from the problem may be used as checks; hidden evaluation tests are not available.'
    : workflow ? automationInstruction
    : academic ? hleInstruction
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
    profile.objective = code ? 'Implement the requested Python function correctly.' : workflow ? 'Execute and verify the requested business workflow.' : academic ? 'Solve the academic question accurately.' : 'Answer the supplied reading-comprehension question accurately.';
    profile.capability = code ? 'Python programming and specification checking' : workflow ? 'Cross-application API orchestration' : academic ? 'Academic knowledge and reasoning' : 'Evidence-grounded reading comprehension';
    if (workflow) { profile.tools = ['api_search', 'api_fetch', 'base64_encode']; profile.nodes = [...compositionNodes]; }
    if (academic) { profile.tools=['arithmetic','python','web_search']; profile.nodes=[...compositionNodes]; }
    profile.expected_output = contract;
    profile.stop_condition = 'A complete answer or a concrete unresolved obstacle is stated.';
  }
  if (workflow || academic) for (const template of organization.agentTemplates!) {
    // All agents use the same task world. Review may inspect or repair concrete effects.
    template.composition = textSolver;
    template.description = `${template.id}: workflow execution and state verification`;
  }
  for (const template of organization.agentTemplates!) {
    // Code and QA answers are raw output, even if their content contains a literal boxed expression.
    template.composition = template.composition.replace(/ctx\.publishText\(id,([^\n;]+)\)/g, "ctx.publishText(id,$1,'raw')");
    template.description = `${template.id}: ${code ? 'Python implementation and review' : workflow ? 'API workflow execution and state repair' : academic ? 'Subject-specific reasoning and independent evidence checking' : 'Reading comprehension and evidence checking'}`;
    if (template.id === 'reviewer') template.profile.objective = 'Find and correct specific errors in the supplied candidate.';
    if (template.id === 'independent') template.profile.objective = 'Solve independently using a complementary method and the original specification.';
  }
  const composition = workflow ? `return loop({id:'workflow-mas',plan:function*(ctx){
  const first=yield* ctx.runAgent('root','','agent');
  ctx.spawnTemplate('reviewer','reviewer','root');
  const review=yield* ctx.runAgent('reviewer',{candidate:first,instruction:'Inspect the existing resulting state. Repair only missing or incorrect effects. Do not repeat successful writes or create duplicate records.'},'review');
  ctx.dormant('reviewer');
  return review.candidate_answer || first.candidate_answer;
}});` : `function solution(output){
  return output.artifacts.filter(a=>a.type==='solution').map(a=>a.content).join('\\n');
}

return loop({id:'adaptive-mas',plan:function*(ctx){
  const first=yield* ctx.runAgent('root','','agent');
  ctx.spawnTemplate('reviewer','reviewer','root');
  const review=yield* ctx.runAgent('reviewer','Initial candidate:\\n'+solution(first),'review');
  ctx.dormant('reviewer');
  function answer(text){return ${academic ? String.raw`(text.match(/(?:^|\n)Answer:\s*([\s\S]*?)(?=\nConfidence:|$)/i)?.[1] ?? '').trim().replace(/\s+/g,' ')` : "text.trim()"};}
  if(answer(first.candidate_answer) && answer(first.candidate_answer)===answer(review.candidate_answer)) return review.candidate_answer;
  ctx.spawnTemplate('independent','independent','root');
  const independent=yield* ctx.runAgent('independent','Solve independently from the original task.','agent');
  ctx.dormant('independent');
  const complete=[first,review,independent].filter(x=>x.candidate_answer);
  if(!complete.length) return '';
  if(complete.length===1) return complete[0].candidate_answer;
  const final=yield* ctx.runAgent('root',complete.map((x,i)=>'Candidate '+(i+1)+':\\n'+solution(x)).join('\\n\\n'),'integrate');
  return final.candidate_answer || review.candidate_answer || independent.candidate_answer || first.candidate_answer;
}});`;
  return { dataset, kind: code ? 'code generation' : workflow ? 'workflow automation' : academic ? 'academic reasoning' : 'reading comprehension', composition, organization, prompts,
    provenance: 'Dataset-specific editable MFlow seed; official AFlow optimization controller; no MATH round-12 initialization or test data' };
}

/** Multiple measured roots; selection and all descendants use search data only. */
export function benchmarkSeeds(tasks: Pick<Task, 'benchmark' | 'metric'>[], names?: string[]) {
  const seed = structuredClone(benchmarkSeed(tasks));
  seed.organization.toolCreation = true;
  const extended=['automationbench','hle'].includes(tasks[0].metric);
  const academic=tasks[0].metric!=='automationbench';
  const availableTools=[...new Set(seed.organization.agentTemplates!.flatMap(t=>t.profile.tools))];
  const planAssignment=academic?`Plan this ${seed.kind} task: identify exact assumptions, specification constraints, viable approaches and decisive checks. Do not invent external evidence or hidden tests.`:'Produce a dependency plan and verification checklist.';
  const executeAssignment=academic?'Solve the original question using the plan as a proposal; verify its decisive steps and preserve the original task output contract.':'Execute the plan against the actual APIs and verify requested effects.';
  const auditAssignment=academic?'Identify alternative methods, ambiguous assumptions, counterexamples and exact checks for this question.':'Plan exact postcondition checks and protection against duplicate effects.';
  const planningPrompts={...seed.prompts,retrieve:`Analyze the supplied ${seed.kind} task and assigned branch only. Return a concrete plan, dependency analysis or critique. Do not produce the final task answer or claim unexecuted tool effects. Respect original constraints; the executor will produce the final answer.`};
  const single = `return loop({id:'single',plan:function*(ctx){return (yield* ctx.runAgent('root')).candidate_answer;}});`;
  const planned = structuredClone(seed.organization);
  const planner = { ...planned.agentTemplates![0], id: 'planner', description: academic?'Design a subject-specific method and decisive checks.':'Plan exact dependencies and postconditions without making writes.',
    profile: { ...planned.agentTemplates![0].profile, tools: availableTools.filter(t=>t!=='api_fetch'), nodes: ['CONTEXT.LOAD','INFER.REASONING.SAMPLE'] as ['CONTEXT.LOAD','INFER.REASONING.SAMPLE'],
      objective: planAssignment, capability: academic?'Subject-specific method selection':'Workflow decomposition and API dependency planning', expected_output: academic?'A concrete solution plan and decisive verification checks.':'Dependency plan and exact verification checklist, without claims of execution.', stop_condition: 'The plan and unresolved lookup requirements are clearly stated.' },
    composition: textReviewer.replace('ctx.publishText(id,yield* finishText(ctx,id,messages,ctx.unwrap(out[node])))', "ctx.publishText(id,yield* finishText(ctx,id,messages,ctx.unwrap(out[node])),'raw')") };
  planned.agentTemplates!.push(planner);
  planned.initialAgents.push({ id: 'planner', ...planner.profile });
  planned.initialBindings!.planner = 'planner';
  const planExecute = `return loop({id:'plan-execute',plan:function*(ctx){
    const plan=yield* ctx.runAgent('planner',${JSON.stringify(planAssignment)},'retrieve'); ctx.dormant('planner');
    return (yield* ctx.runAgent('root',{plan,instruction:${JSON.stringify(executeAssignment)}})).candidate_answer;
  }});`;
  const parallel = structuredClone(planned);
  parallel.initialAgents.push({...parallel.initialAgents[1],id:'auditor',objective:auditAssignment,capability:academic?'Independent method and assumption checking':'Independent effect and consistency planning'});
  parallel.initialBindings!.auditor='planner';
  const parallelPlan = toolContinuation + `return loop({id:'parallel-plan',plan:function*(ctx){
    const messages={planner:ctx.textMessages('planner',${JSON.stringify(planAssignment)},'retrieve'),auditor:ctx.textMessages('auditor',${JSON.stringify(auditAssignment)},'retrieve')};
    const g=graph('parallel-planning').node('planner/plan','INFER.REASONING.SAMPLE',[],()=>ctx.request('planner',messages.planner,true,'text'))
      .node('auditor/plan','INFER.REASONING.SAMPLE',[],()=>ctx.request('auditor',messages.auditor,true,'text'));
    const out=yield* graphStep(g,null,{concurrency:2}),plans=[];
    for(const id of ['planner','auditor'])plans.push(ctx.publishText(id,yield* finishText(ctx,id,messages[id],ctx.unwrap(out[id+'/plan'])),'raw'));
    ctx.dormant('planner');ctx.dormant('auditor');
    return (yield* ctx.runAgent('root',{plans,instruction:${JSON.stringify(executeAssignment)}})).candidate_answer;
  }});`;
  const adaptive = structuredClone(seed);
  adaptive.prompts.factory = `Design a task-local subagent for this ${seed.kind} task. Return JSON {profile,composition} only.
profile has exactly id (use specialist), objective, capability, private_context, tools, nodes, reasoning, expected_output, stop_condition. reasoning must be one of cot, long-cot, react, tot, got, self-consistency. private_context contains brief method instructions, never a solved answer, long derivation or copy of the task. Do not solve the question during design. Available tools: ${availableTools.join(', ')}. Available nodes: ${compositionNodes.join(', ')}.
composition is JavaScript source returning a public Ditto loop({id,plan:function*(ctx){...}}); the generator returns an AgentOutput object, never a string. Use ctx.self for node IDs; ctx.task contains only id/prompt, ctx.evidence the assignment.
Build graph/loop structure and reasoning appropriate to this task's ${academic?'subject, uncertainties and competing approaches':'concrete API dependencies'}. It may delegate recursively with ctx.spawn(profile,parentId,composition) and yield* ctx.runAgent. Every generated member can optionally call create_tool during its tool loop, or ctx.registerTool(ctx.self,definition) between graph invocations; creation is not reserved for a factory or root. Generate parameterized definitions using only that member's dependency tools and feed registration feedback back to SAMPLE. Tools execute only through native INTERACTION.ACT.TOOL and INTERACTION.OBSERVE; no imports/process/network/eval.
For SAMPLE use ctx.request(id,ctx.textMessages(id,ctx.evidence,ctx.prompt),true,'text'); ctx.unwrap checks node success. Preserve assistant actionRequests metadata and tool actionRequestId. ctx.publishText(id,text,'raw') returns AgentOutput.
Return valid JSON with exactly profile and composition; JSON-escape the full source string. Use the supplied loop/graph/graphStep helpers; never redefine them. End with the closing quote and braces of the JSON object.
This valid JSON example illustrates the interface. Adapt the profile and graph to the task; keep program logic executable rather than embedding a long answer in it:
${JSON.stringify({profile:{id:'specialist',...seed.organization.agentTemplates![0].profile,private_context:'Choose a method and use actual tools for decisive checks; preserve observed evidence.'},composition:seed.organization.agentTemplates![0].composition})}`;
  adaptive.composition = `return loop({id:'adaptive-factory',plan:function*(ctx){
    const node='root/factory';
    let messages=ctx.textMessages('root',${JSON.stringify(academic?'Design a task-specific subagent and internal graph; preserve the original output contract and use only available tools to resolve the decisive uncertainty.':'Design a distinct subagent to execute this task; choose its actual internal graph and capability.')},'factory'),design;
    for(let attempt=0;attempt<3;attempt++){
      const g=graph('factory').node(node,'INFER.REASONING.SAMPLE',[],()=>ctx.request('root',messages,false,'json'));
      const result=yield* graphStep(g,null);
      if(result[node].status!=='success'){ctx.failedAgent('root',result[node].error);break;}
      const response=ctx.unwrap(result[node]);
      try{const proposal=JSON.parse(response.message.content);ctx.spawn(proposal.profile,'root',proposal.composition);design=proposal;break;}
      catch(error){if(attempt===2){ctx.failedAgent('root',String(error));break;}messages.push(response.message,{role:'user',content:'Repair the JSON/profile/program interface only; preserve the intended specialist and method. Error: '+String(error)});}
    }
    const id=design?.profile.id || 'root';
    const executed=yield* ctx.runAgent(id,${JSON.stringify(executeAssignment)});
    if(id!=='root')ctx.dormant(id);
    ctx.spawnTemplate('reviewer','reviewer','root');
    const review=yield* ctx.runAgent('reviewer',{candidate:executed,instruction:${JSON.stringify(academic ? 'Verify the decisive step using independent evidence or computation when useful. Correct concrete errors; do not restate speculation as fact.' : 'Inspect actual effects against the original task. Repair only missing or incorrect effects; preserve successful writes and never duplicate records.') }},'review');
    ctx.dormant('reviewer');
    ${academic ? `function answer(text){return ${seed.dataset==='HLE' ? String.raw`(text.match(/(?:^|\n)Answer:\s*([\s\S]*?)(?=\nConfidence:|$)/i)?.[1] ?? '').trim().replace(/\s+/g,' ')` : seed.kind==='mathematical reasoning' ? "ctx.answerKey(text)" : "text.trim()"};}
    if(executed.candidate_answer && review.candidate_answer && (!answer(executed.candidate_answer) || answer(executed.candidate_answer)!==answer(review.candidate_answer))){
      const final=yield* ctx.runAgent('root',{candidate:executed,review,instruction:'Resolve the concrete disagreement by a decisive check, not majority agreement.'},'integrate');
      return final.candidate_answer || review.candidate_answer;
    }` : ''}
    return review.candidate_answer || executed.candidate_answer;
  }});`;
  // Cross-agent dependencies are native edges in one graph, not a serial role list.
  const diamond = toolContinuation + `return loop({id:'cross-review',plan:function*(ctx){
    const messages={planner:ctx.textMessages('planner',${JSON.stringify(planAssignment)},'retrieve'),auditor:ctx.textMessages('auditor',${JSON.stringify(auditAssignment)},'retrieve')};
    let g=graph('proposals');
    for(const id of ['planner','auditor'])g=g.node(id+'/propose','INFER.REASONING.SAMPLE',[],()=>ctx.request(id,messages[id],true,'text'));
    const out=yield* graphStep(g,null,{concurrency:2}),proposals={},checks={};
    for(const id of ['planner','auditor'])proposals[id]=yield* finishText(ctx,id,messages[id],ctx.unwrap(out[id+'/propose']));
    // Resolve requested tools before passing completed evidence across the diamond.
    g=graph('cross-review');
    for(const id of ['planner','auditor'])g=g.node(id+'/propose','CONTEXT.LOAD',[],()=>({sources:[{role:'user',content:proposals[id]}]}));
    for(const id of ['planner','auditor']){
      const other=id==='planner'?'auditor':'planner';
      g=g.node(id+'/check','INFER.REASONING.SAMPLE',[other+'/propose'],(_,out)=>{
        checks[id]=ctx.textMessages(id,{proposal:out[other+'/propose'].items[0].content,instruction:'Find concrete gaps, counterexamples or missing postconditions in the other branch. Provide corrections.'},'retrieve');
        return ctx.request(id,checks[id],true,'text');
      });
    }
    const reviewed=yield* graphStep(g,null,{concurrency:2}),evidence={};
    for(const id of ['planner','auditor'])evidence[id+'/check']=yield* finishText(ctx,id,checks[id],ctx.unwrap(reviewed[id+'/check']));
    ctx.dormant('planner');ctx.dormant('auditor');
    return (yield* ctx.runAgent('root',{proposals,evidence,instruction:${JSON.stringify(executeAssignment)}})).candidate_answer;
  }});`;
  const treeOrganization=structuredClone(planned);
  treeOrganization.initialAgents=treeOrganization.initialAgents.filter(a=>a.id==='root');
  treeOrganization.initialBindings={root:'solver'};
  const tree = toolContinuation + `return loop({id:'task-tree',plan:function*(ctx){
    const messages=[{role:'system',content:'Decompose the supplied task into complementary branches. Return JSON {branches:[{objective:string,subtasks:string[]}]}. Choose the number of branches and subtasks to fit this task; do not solve it or claim tool actions. Respect its original output contract.'},
      {role:'user',content:JSON.stringify(ctx.task)}];
    let plan;
    for(let attempt=0;attempt<3;attempt++){
      const split=graph('decompose').node('root/decompose','INFER.REASONING.SAMPLE',[],()=>ctx.request('root',messages,false,'json'));
      const out=yield* graphStep(split,null);
      if(out['root/decompose'].status!=='success'){ctx.failedAgent('root',out['root/decompose'].error);break;}
      const response=ctx.unwrap(out['root/decompose']);
      try{
        const proposed=JSON.parse(response.message.content);
        if(!proposed || !Array.isArray(proposed.branches) || proposed.branches.some(b=>!b || typeof b.objective!=='string' || !Array.isArray(b.subtasks) || b.subtasks.some(x=>typeof x!=='string')))throw new Error('Expected branches:[{objective:string,subtasks:string[]}]');
        plan=proposed;break;
      }catch(error){if(attempt===2){ctx.failedAgent('root',String(error));break;}messages.push(response.message,{role:'user',content:'Repair only the decomposition JSON contract: '+String(error)});}
    }
    if(!plan)return (yield* ctx.runAgent('root','Decomposition failed; solve directly with the available capabilities.')).candidate_answer;
    let g=graph('tree-branches');const branches=[],branchMessages={},parents={};
    for(const [index,branch] of plan.branches.entries()){
      const id='branch-'+index;ctx.spawnTemplate('planner',id,'root');
      ctx.reconfigure(id,{...ctx.profile(id),objective:branch.objective});
      branchMessages[id]=ctx.textMessages(id,branch.objective,'retrieve');
      g=g.node(id+'/plan','INFER.REASONING.SAMPLE',[],()=>ctx.request(id,branchMessages[id],true,'text'));
    }
    if(plan.branches.length){
      const out=yield* graphStep(g,null,{concurrency:plan.branches.length});
      for(const [index] of plan.branches.entries()){
        const id='branch-'+index;parents[id]=yield* finishText(ctx,id,branchMessages[id],ctx.unwrap(out[id+'/plan']));
        branches.push({id:id+'/plan',analysis:parents[id]});
      }
    }
    g=graph('tree-leaves');const leaves=[];
    for(const [index,branch] of plan.branches.entries()){
      const id='branch-'+index;
      g=g.node(id+'/plan','CONTEXT.LOAD',[],()=>({sources:[{role:'user',content:parents[id]}]}));
      for(const [part,assignment] of branch.subtasks.entries()){
        const child=id+'-leaf-'+part;ctx.spawnTemplate('planner',child,id);
        ctx.reconfigure(child,{...ctx.profile(child),objective:assignment});
        g=g.node(child+'/analyze','INFER.REASONING.SAMPLE',[id+'/plan'],(_,out)=>{
          branchMessages[child]=ctx.textMessages(child,{assignment,parentPlan:out[id+'/plan'].items[0].content},'retrieve');
          return ctx.request(child,branchMessages[child],true,'text');
        });
        leaves.push(child);
      }
    }
    if(leaves.length){
      const out=yield* graphStep(g,null,{concurrency:leaves.length});
      for(const id of leaves)branches.push({id:id+'/analyze',analysis:yield* finishText(ctx,id,branchMessages[id],ctx.unwrap(out[id+'/analyze']))});
    }
    for(const agent of ctx.agents)if(agent.profile.id!=='root')ctx.dormant(agent.profile.id);
    return (yield* ctx.runAgent('root',{branches,instruction:${JSON.stringify(executeAssignment)}})).candidate_answer;
  }});`;
  const all = [{name:'single',...seed,composition:single}, {name:'review',...seed},
    {name:'plan-execute',...seed,prompts:planningPrompts,organization:planned,composition:planExecute},
    {name:'parallel-plan',...seed,prompts:planningPrompts,organization:parallel,composition:parallelPlan}, {name:'adaptive',...adaptive},
    {name:'tree',...seed,prompts:planningPrompts,organization:treeOrganization,composition:tree},
    {name:'cross-review',...seed,prompts:planningPrompts,organization:parallel,composition:diamond}];
  const dynamic = all.filter(s=>s.name!=='adaptive').map(s=>({...s,name:'dynamic-'+s.name,
    prompts:{...s.prompts,factory:dynamicPolicyPrompt},composition:dynamicPolicyComposition(s.composition)}));
  all.push({name:'dynamic-policy',...seed,prompts:{...seed.prompts,factory:dynamicPolicyPrompt},composition:dynamicPolicyComposition()},...dynamic);
  if(!extended)all.unshift({name:'default',...seed});
  if (names?.some(name => !all.some(s => s.name === name)) || names?.length === 0) throw new Error('Unknown or empty MAS initialization');
  return names ? names.map(name => all.find(s => s.name === name)!) : all.filter(s => !s.name.startsWith('dynamic-') && (extended || s.name !== 'review'));
}
