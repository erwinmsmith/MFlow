import { z } from 'zod';
import { ToolRegistry, type RegisteredTool, type JsonValue } from '@codesoul-co/ditto';

export interface ToolProgram {
  name: string; description: string;
  parameters: { name: string; description: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'; required: boolean }[];
  implementation: { kind: 'python'; source: string } | { kind: 'sequence'; steps: { tool: string; arguments: Record<string, JsonValue> }[] };
}

const parameter = z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), description: z.string(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']), required: z.boolean() }).strict();
/** Search-owned mutation grammar; implementations execute through Ditto's public registry. */
export const toolProgramSchema: z.ZodType<ToolProgram> = z.object({
  name: z.string().regex(/^generated_[A-Za-z0-9_-]{1,54}$/), description: z.string().min(1),
  parameters: z.array(parameter),
  implementation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('python'), source: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('sequence'), steps: z.array(z.object({
      tool: z.string().min(1), arguments: z.record(z.string(), z.json()),
    }).strict()).min(1) }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.parameters.map(p => p.name)).size !== value.parameters.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate tool parameter' });
});
export const toolDependencies = (tool: ToolProgram) => tool.implementation.kind === 'python'
  ? ['python'] : [...new Set(tool.implementation.steps.map(step => step.tool))];

export function validateToolLibrary(library: ToolProgram[], base: string[]) {
  const names = new Set(base);
  for (const value of library) {
    const tool = toolProgramSchema.parse(value);
    if (toolDependencies(tool).includes('create_tool')) throw new Error('Tool definitions cannot depend on create_tool');
    if (names.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    for (const dependency of toolDependencies(tool))
      if (!names.has(dependency)) throw new Error(`Tool ${tool.name} requires earlier registered tool ${dependency}`);
    names.add(tool.name);
  }
  return names;
}

// JSON Pointer bindings, never executable JavaScript. Dependencies only refer backwards.
function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/')) throw new Error('Binding must be a JSON Pointer');
  for (const part of path.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`Missing tool binding ${path}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function bindings(value: unknown, input: unknown, results: unknown[]): any {
  if (Array.isArray(value)) return value.map(v => bindings(v, input, results));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  if (entries.length === 1 && entries[0][0] === '$input') return pointer(input, z.string().parse(entries[0][1]));
  if (entries.length === 1 && entries[0][0] === '$step') return pointer(results, z.string().parse(entries[0][1]));
  return Object.fromEntries(entries.map(([k, v]) => [k, bindings(v, input, results)]));
}

export function createProgramTool(definition: ToolProgram, registry: ToolRegistry,
  beforeCall: () => void): RegisteredTool {
  const tool = toolProgramSchema.parse(definition);
  const types = { string: z.string(), number: z.number(), integer: z.number().int(), boolean: z.boolean(),
    array: z.array(z.json()), object: z.record(z.string(), z.json()) };
  const schema = z.object(Object.fromEntries(tool.parameters.map(p => [p.name,
    (p.required ? types[p.type] : types[p.type].optional()).describe(p.description)]))).strict();
  return { name: tool.name, description: tool.description, inputSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(schema)),
    // Argument/code errors are observations the searched policy can respond to.
    validate() {},
    async execute(args, context) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { status: 'failed', content: parsed.error.message,
        error: { code: 'GENERATED_TOOL_ARGUMENTS', message: 'Arguments do not match the registered parameters' } };
      let step = 0;
      const call = async (name: string, arguments_: any) => {
        beforeCall();
        return registry.call({ id: `${tool.name}/${step++}`, name, arguments: arguments_ }, context);
      };
      if (tool.implementation.kind === 'python') {
        const payload = Buffer.from(JSON.stringify({ source: tool.implementation.source, arguments: parsed.data })).toString('base64');
        const code = `import base64,json\npayload=json.loads(base64.b64decode('${payload}'))\nnamespace={}\nexec(payload['source'],namespace)\nprint(json.dumps(namespace['run'](payload['arguments']),allow_nan=False))`;
        return call('python', { code });
      }
      const results: unknown[] = [];
      for (const operation of tool.implementation.steps) {
        let args;
        try { args = bindings(operation.arguments, parsed.data, results); }
        catch (error) { return { status: 'failed', content: String(error), error: { code: 'GENERATED_TOOL_BINDING', message: 'Invalid argument binding' } }; }
        const result = await call(operation.tool, args);
        if (result.status !== 'success') return result;
        let content = result.content;
        if (typeof content === 'string') { try { content = JSON.parse(content); } catch { /* Plain tool text stays text. */ } }
        results.push(content);
      }
      return { status: 'success', content: results.at(-1) as any };
    },
  };
}

export const toolDesignInstruction = `Create a small parameterized tool when it helps your current assignment. Call create_tool with {definition}; after successful registration its name is available on your next inference turn. Creation is optional, available throughout execution to every agent, and never a prerequisite for solving. Use existing tools directly when sufficient. Do not solve the benchmark in the definition or embed its question, answer or environment state. The tool must be generalizable, with task values supplied as parameters. Never invent an unavailable dependency or use create_tool as a dependency. Choose a unique generated_ name including your agent ID to avoid collisions with other members.
A definition has name (generated_ prefix), description, parameters:[{name,description,type,required}], implementation. Parameter types are string,number,integer,boolean,array,object. implementation is either {kind:'python',source:'def run(args): ...'} (only when python is available; return a JSON value, standard library, no network/files/persistent state) or {kind:'sequence',steps:[{tool,arguments}]} using existing tools. API names returned by api_search are NOT registered tools: invoke their URLs through api_fetch. Python example for a reusable transformation: {name:'generated_root_normalize',description:'Normalize whitespace',parameters:[{name:'text',description:'Input text',type:'string',required:true}],implementation:{kind:'python',source:'def run(args): return \" \".join(args[\"text\"].split())'}}. JSON argument bindings {$input:'/name'} read supplied parameters, {$step:'/0/path'} reads a prior step's JSON result. The sequence returns the final result, stops on a failed dependency and does not retry side effects. Creation is not correctness evidence: use generic checks for pure tools; for mutating tools check dependency schemas and read-only preconditions, then execute only intended task effects. Never create dummy records or send test messages. Registration and execution use Ditto; never generate host JavaScript, eval, imports or a replacement execution engine.`;
