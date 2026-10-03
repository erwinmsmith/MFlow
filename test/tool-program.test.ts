import test from 'node:test';
import assert from 'node:assert/strict';
import { type RegisteredTool } from '@codesoul-co/ditto';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { benchmarkSeeds } from '../src/aflow-seed.js';
import { initialStrategy, limitsSchema, organizationSchema } from '../src/types.js';
import { toolProgramSchema, validateToolLibrary, type ToolProgram } from '../src/tool-program.js';
import { createPythonTool, pythonImage } from '../src/python-tool.js';
import { ScriptedProvider, output } from './fixtures.js';

const model = { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 };
const program: ToolProgram = { name:'generated_twice', description:'Add a parameter twice.',
  parameters:[{name:'x',description:'Value',type:'number',required:true}],
  implementation:{kind:'sequence',steps:[
    {tool:'arithmetic',arguments:{operation:'add',values:[{$input:'/x'},{$input:'/x'}]}},
  ]} };
const arithmetic: RegisteredTool = {name:'arithmetic',description:'Fixture addition',inputSchema:{type:'object'},validate(){},
  async execute(args,ctx){ assert.ok(ctx.signal); return {status:'success',content:{sum:(args.values as number[]).reduce((a,b)=>a+b,0)}}}};
const base = () => {
  const seed=benchmarkSeeds([{benchmark:'math',metric:'math'}],['single'])[0];
  for(const p of [...seed.organization.initialAgents,...seed.organization.agentTemplates!.map(t=>t.profile)]) p.tools=['arithmetic'];
  return {...initialStrategy,...seed};
};
const callCode = (registration: string, name=program.name, args:unknown={x:3}, owner='root') => `return loop({id:'tool-use',plan:function*(ctx){
  ${registration}
  const id=${JSON.stringify(owner+'/tool')};const result=yield* graphStep(graph('call').node(id,'INTERACTION.ACT.TOOL',[],()=>({call:{id:'use',name:${JSON.stringify(name)},arguments:${JSON.stringify(args)}}})),null);
  return JSON.stringify(result[id]);
}});`;
const runtime = (tools:RegisteredTool[]=[arithmetic], maxToolCalls=30) => new OrganizationRuntime(
  new DittoAgents(new MeteredProvider(new ScriptedProvider(()=>output('unused'))),model,tools),
  limitsSchema.parse({maxSteps:100,maxTokens:100000,maxToolCalls}));

test('task-local tools use Ditto, bind parameters/results, freeze as definitions and cannot leak across tasks',async()=>{
  const twice:ToolProgram={...program,name:'generated_four',implementation:{kind:'sequence',steps:[
    {tool:program.name,arguments:{x:{$input:'/x'}}},
    {tool:program.name,arguments:{x:{$step:'/0/sum'}}},
  ]}};
  const candidate=base();
  candidate.composition=callCode(`ctx.registerTool('root',${JSON.stringify(program)});ctx.registerTool('root',${JSON.stringify(twice)});ctx.spawn({...ctx.profile('root'),id:'consumer',tools:['${twice.name}']});`,twice.name,{x:3},'consumer');
  const before=JSON.stringify(candidate), tools=[arithmetic], runner=runtime(tools);
  const result=await runner.run(candidate,{id:'one',prompt:'Fixture'});
  assert.equal(JSON.parse(result.answer).content.sum,12);
  assert.equal(result.orchestration!.tools!.length,2);
  assert.equal(result.orchestration!.tools![0].origin,'generated');
  assert.equal(result.orchestration!.tools![0].creatorId,'root');
  assert.ok(result.orchestration!.tools![0].hash);
  assert.equal(JSON.stringify(candidate),before);assert.equal(tools.length,1);
  const frozen=base();frozen.organization.toolLibrary=[program,twice];
  frozen.organization.initialAgents[0].tools=[twice.name];
  frozen.composition=callCode('',twice.name);
  const reloaded={...frozen,organization:organizationSchema.parse(JSON.parse(JSON.stringify(frozen.organization)))};
  assert.equal(JSON.parse((await runner.run(reloaded,{id:'two',prompt:'New fixture'})).answer).content.sum,12);
  await assert.rejects(runner.run({...candidate,composition:callCode('')},{id:'three',prompt:'Fresh fixture'}),/cannot use tool/);
  await assert.rejects(runtime(tools,2).run(candidate,{id:'budget',prompt:'Fixture'}),/Tool call limit/);
});

test('tool contracts reject unavailable dependencies, collisions and invalid arguments; failed sequences stop before writes',async()=>{
  assert.throws(()=>validateToolLibrary([program],[]),/requires earlier registered/);
  assert.throws(()=>validateToolLibrary([program,program],['arithmetic']),/Duplicate tool/);
  assert.throws(()=>validateToolLibrary([{...program,implementation:{kind:'sequence',steps:[{tool:program.name,arguments:{}}]}}],['arithmetic']),/requires earlier/);
  assert.throws(()=>toolProgramSchema.parse({...program,parameters:[...program.parameters,...program.parameters]}),/Duplicate tool parameter/);
  const candidate=base();candidate.composition=callCode(`ctx.registerTool('root',${JSON.stringify(program)});`,program.name,{x:'bad'});
  const bad=JSON.parse((await runtime().run(candidate,{id:'bad-args',prompt:'Fixture'})).answer);
  assert.equal(bad.status,'failed');assert.equal(bad.error.code,'GENERATED_TOOL_ARGUMENTS');
  candidate.organization.initialAgents[0].tools=[];
  await assert.rejects(runtime().run(candidate,{id:'no-grant',prompt:'Fixture'}),/creator to hold/);
  let writes=0;
  const fail:RegisteredTool={...arithmetic,name:'read',async execute(){return {status:'failed',content:'Missing record',error:{code:'NOT_FOUND',message:'Missing record'}}}};
  const write:RegisteredTool={...arithmetic,name:'write',async execute(){writes++;return {status:'success',content:'saved'}}};
  const sequence:ToolProgram={...program,implementation:{kind:'sequence',steps:[{tool:'read',arguments:{}},{tool:'write',arguments:{}}]}};
  const stopped=base();stopped.organization.initialAgents[0].tools=['read','write'];
  stopped.composition=callCode(`ctx.registerTool('root',${JSON.stringify(sequence)});`);
  assert.equal(JSON.parse((await runtime([fail,write]).run(stopped,{id:'fail',prompt:'Fixture'})).answer).status,'failed');
  assert.equal(writes,0);
});

test('every MAS topology exposes optional native tool creation to roots, planners and generated subagents',async()=>{
  for(const name of ['single','review','plan-execute','parallel-plan','adaptive','tree','cross-review']){
    const seed=benchmarkSeeds([{benchmark:'math',metric:'math'}],[name])[0];
    for(const p of [...seed.organization.initialAgents,...seed.organization.agentTemplates!.map(t=>t.profile)])p.tools=['arithmetic'];
    const candidate={...initialStrategy,...seed},pristine=JSON.stringify(candidate),creators=new Set<string>();
    const provider=new MeteredProvider({async invoke(input){
      const id=String(input.metadata?.agentId),node=String(input.metadata?.nodeId);
      const response=(content:string,actionRequests?:{id:string;name:string;arguments:any}[])=>({message:{role:'assistant' as const,content},...(actionRequests?{actionRequests}:{}),finishReason:actionRequests?'action_request' as const:'stop' as const,usage:{totalTokens:10}});
      if(node==='root/factory')return response(JSON.stringify({profile:{id:'new-specialist',...seed.organization.agentTemplates![0].profile},composition:seed.organization.agentTemplates![0].composition}));
      if(node==='root/decompose')return response(JSON.stringify({branches:[{objective:'branch',subtasks:['leaf']}]}));
      assert.ok(input.actions?.some(a=>a.name==='create_tool'),node);
      const made='generated_'+id.replace(/-/g,'_');
      if(!input.actions?.some(a=>a.name===made)){
        // Create only after using an ordinary tool: not a mandatory initialization stage.
        if(!input.messages.some(m=>m.role==='tool'))return response('',[{id:'base',name:'arithmetic',arguments:{operation:'add',values:[1,2]}}]);
        creators.add(id);
        return response('',[{id:'create',name:'create_tool',arguments:{definition:{...program,name:made}}}]);
      }
      if(!input.messages.some(m=>m.role==='tool'&&m.metadata?.name===made))return response('',[{id:'use',name:made,arguments:{x:7}}]);
      assert.ok(JSON.stringify(input.messages).includes('14'));
      return response(String.raw`Evidence \boxed{14}`);
    }});
    const runner=new OrganizationRuntime(new DittoAgents(provider,model,[arithmetic]),limitsSchema.parse({maxSteps:200,maxToolCalls:100,maxTokens:100000,maxPoolAgents:20,maxActiveAgents:20,maxDepth:5}));
    for(const id of ['one','two']){
      const result=await runner.run(candidate,{id,prompt:'Fixture'});
      assert.equal(result.answer,String.raw`\boxed{14}`);
      assert.ok(result.orchestration!.tools!.length>0);
      assert.deepEqual(new Set(result.orchestration!.tools!.map(t=>t.creatorId)),creators);
      for(const creator of creators)assert.ok(result.orchestration!.toolCalls!.some(c=>c.agentId===creator&&c.name==='generated_'+creator.replace(/-/g,'_')&&c.status==='success'));
      if(name==='tree')assert.ok(creators.has('branch-0-leaf-0'));
      if(name==='adaptive')assert.ok(creators.has('new-specialist'));
      if(name==='review')assert.ok(creators.has('root')&&creators.has('reviewer'));
    }
    assert.equal(JSON.stringify(candidate),pristine);
  }
});

test('native creation reports repairable errors and derives creator identity from the Ditto node',async()=>{
  const candidate=base();let n=0;
  const provider=new MeteredProvider({async invoke(input){
    n++;
    if(n<4){
      const args=n===1?{definition:{...program,implementation:{kind:'sequence',steps:[{tool:'missing',arguments:{}}]}}}:n===2?{definition:program,agentId:'victim'}:{definition:program};
      if(n>1)assert.ok(JSON.stringify(input.messages).includes('TOOL_DEFINITION'));
      if(n===2)assert.match(JSON.stringify(input.messages), /Missing: missing.*Available dependencies: arithmetic/);
      assert.match(input.actions!.find(a=>a.name==='create_tool')!.description!, /Creator: root.*Available dependency tools: arithmetic.*Python definitions are unavailable/);
      return {message:{role:'assistant' as const,content:''},actionRequests:[{id:'create'+n,name:'create_tool',arguments:args}],finishReason:'action_request' as const,usage:{totalTokens:10}};
    }
    return {message:{role:'assistant' as const,content:String.raw`\boxed{42}`},finishReason:'stop' as const,usage:{totalTokens:10}};
  }});
  const result=await new OrganizationRuntime(new DittoAgents(provider,model,[arithmetic]),limitsSchema.parse({maxSteps:30,maxTokens:100000})).run(candidate,{id:'repair',prompt:'Fixture'});
  assert.equal(result.orchestration!.tools!.length,1);assert.equal(result.orchestration!.tools![0].creatorId,'root');
  assert.deepEqual(result.orchestration!.toolCalls!.map(c=>c.status),['failed','failed','success']);
  const baseline=base();baseline.organization.toolCreation=false;baseline.organization.initialAgents[0].nodes!.push('INTERACTION.ACT.TOOL');
  baseline.composition=callCode('','create_tool',{definition:program});
  await assert.rejects(runtime().run(baseline,{id:'disabled',prompt:'Fixture'}),/cannot use tool/);
});

test('generated Python tools execute in the existing public Ditto sandbox',async t=>{
  let image:string;try{image=await pythonImage();}catch{t.skip('Docker Python image unavailable');return;}
  const python:ToolProgram={...program,implementation:{kind:'python',source:'def run(args):\n    return {"twice": args["x"] * 2}'}};
  for (const owner of ['root','child']) {
    const candidate=base();candidate.organization.initialAgents[0].tools=[];
    candidate.composition=callCode(`${owner==='child'?"ctx.spawn({...ctx.profile('root'),id:'child',tools:[]});":''}ctx.registerTool('${owner}',${JSON.stringify(python)});`,python.name,{x:3},owner);
    const execution=await runtime([createPythonTool(image)]).run(candidate,{id:'python-'+owner,prompt:'Fixture'});
    const result=JSON.parse(execution.answer);
    assert.equal(result.status,'success');assert.equal(JSON.parse(result.content).twice,6);
    assert.deepEqual(execution.agents.find(a=>a.id===owner)!.tools.sort(),['create_tool',python.name,'python'].sort());
    assert.equal(execution.orchestration!.tools![0].creatorId,owner);
  }
});

test('malformed tree design repairs locally then solves without registering partial artifacts',async()=>{
  for(const name of ['tree']){
    const candidate=benchmarkSeeds([{benchmark:'math',metric:'math'}],[name])[0];let designs=0;
    const provider=new MeteredProvider({async invoke(input){
      const design=['root/design','root/decompose'].includes(String(input.metadata?.nodeId));
      if(design)designs++;
      return {message:{role:'assistant' as const,content:design?'{}':String.raw`\boxed{42}`},finishReason:'stop' as const,usage:{totalTokens:10}};
    }});
    const runner=new OrganizationRuntime(new DittoAgents(provider,model,[arithmetic,{...arithmetic,name:'python'}]),limitsSchema.parse({maxSteps:20,maxTokens:100000}));
    const result=await runner.run({...initialStrategy,...candidate},{id:name,prompt:'Fixture'});
    assert.equal(designs,3);assert.equal(result.answer,String.raw`\boxed{42}`);
    assert.equal(result.agents.length,1);assert.equal(result.orchestration!.tools!.length,0);
    assert.ok(result.outputs.some(o=>o.output.artifacts.some(a=>a.type==='execution_error')));
  }
});

test('tree roots really derive grandchildren; cross-review weaves nodes and runs independent branches concurrently',async()=>{
  for(const benchmark of ['math','hle','automationbench'] as const)for(const name of ['tree','cross-review']){
    const candidate=benchmarkSeeds([{benchmark,metric:benchmark as 'math'|'hle'|'automationbench'}],[name])[0];
    let active=0,peak=0;
    const provider=new MeteredProvider({async invoke(input){
      peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;
      const node=String(input.metadata?.nodeId);
      if(node==='root/decompose')return {message:{role:'assistant' as const,content:JSON.stringify({branches:[{objective:'FIRST',subtasks:['FIRST-CHECK']},{objective:'SECOND',subtasks:['SECOND-CHECK']}]})},finishReason:'stop' as const,usage:{totalTokens:10}};
      if(node.endsWith('/analyze'))assert.ok(JSON.stringify(input.messages).includes('parentPlan'));
      if(node==='root/sample')assert.ok(JSON.stringify(input.messages).includes(name==='tree'?'branch-1-leaf-0':'planner/check'));
      return {message:{role:'assistant' as const,content:String.raw`Evidence \boxed{42}`},finishReason:'stop' as const,usage:{totalTokens:10}};
    }});
    const tools=['arithmetic','python','web_search','api_search','api_fetch','base64_encode'].map(name=>({...arithmetic,name}));
    const result=await new OrganizationRuntime(new DittoAgents(provider,model,tools),limitsSchema.parse({maxSteps:30,maxTokens:100000,maxDepth:5,maxPoolAgents:20,maxActiveAgents:20})).run({...initialStrategy,...candidate},{id:name,prompt:'Fixture'});
    assert.ok(peak>=2);
    if(name==='tree') {
      assert.equal(result.depth,2);
      assert.ok(result.orchestration!.lifecycle.some(e=>e.action==='SPAWN'&&e.agentId==='branch-0-leaf-0'&&e.parentId==='branch-0'));
      assert.deepEqual(result.orchestration!.graphs.flatMap(g=>g.nodes).find(n=>n.id==='branch-1-leaf-0/analyze')!.dependencies,['branch-1/plan']);
    } else assert.deepEqual(result.orchestration!.graphs.flatMap(g=>g.nodes).find(n=>n.id==='planner/check')!.dependencies,['auditor/propose']);
  }
});
