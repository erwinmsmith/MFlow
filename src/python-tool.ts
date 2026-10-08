import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { TaskInput } from './types.js';
import { resolve } from 'node:path';
import { Sandbox, createLocalSandboxExecutor, createWebSearchTool, type RegisteredTool } from '@codesoul-co/ditto';
import { z } from 'zod';

export const dockerCommand = process.env.MFLOW_DOCKER ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/docker' : 'docker');
export function pythonExecutor() {
  const env: Record<string, string> = {};
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  else if (process.platform === 'darwin' && process.env.USER)
    env.DOCKER_HOST = `unix:///Users/${process.env.USER}/.docker/run/docker.sock`;
  return createLocalSandboxExecutor({ commands: [dockerCommand], env, timeoutMs: 40_000, maxOutputBytes: 1_048_576 });
}
export async function pythonImage(image = process.env.MFLOW_PYTHON_IMAGE ?? 'python:3.12-alpine') {
  const sandbox = new Sandbox(process.cwd(), { execute: true }, pythonExecutor());
  const result = await sandbox.run({ command: dockerCommand, args: ['image', 'inspect', image, '--format', '{{.Id}}'] });
  if (result.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim()))
    throw new Error('Python tool requires a running Docker daemon and local MFLOW_PYTHON_IMAGE (default python:3.12-alpine)');
  return result.stdout.trim();
}
const argsSchema = z.object({ code: z.string().min(1) }).strict();
export function createPythonTool(image: string): RegisteredTool {
  return {
    name: 'python', description: 'Execute Python 3 code in a fresh isolated container. Print the result. Standard library math, fractions, decimal, itertools and statistics are available. No network, host files or persistent state. Execution timeout 30 seconds.',
    effects: ['execute'], inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    // RegisteredTool validation throws abort the node in Ditto 0.1.1. Return
    // malformed model arguments as an observation from the tool instead.
    validate() {},
    async execute(args, context) {
      const parsed = argsSchema.safeParse(args);
      if (!parsed.success) return { status: 'failed', content: 'Python requires exactly one field: code, a non-empty string containing Python source. Supply corrected arguments.',
        error: { code: 'PYTHON_ARGUMENTS', message: 'Invalid Python arguments' } };
      const { code } = parsed.data;
      const container = `mflow-tool-${randomUUID()}`;
      const result = await context.services.sandbox.run({ command: dockerCommand, args: [
        'run', '--rm', '--init', '--name', container, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m',
        '--cpus', '1', '--user', '65534:65534', '--tmpfs', '/tmp:rw,nosuid,size=16m',
        image, 'timeout', '-s', 'KILL', '30', 'python', '-B', '-I', '-c', code,
      ] }, context.signal).catch(error => {
        // Preserve user/runtime cancellation. A local command deadline is a
        // tool failure the agent can observe and correct, not a lost episode.
        if (context.signal?.aborted) throw error;
        if (error instanceof Error && error.name === 'TimeoutError') return undefined;
        throw error;
      }).finally(async () => {
        // Cleanup must survive cancellation of the original tool request.
        await context.services.sandbox.run({ command: dockerCommand, args: ['rm', '-f', container] }).catch(() => {});
      });
      if (!result || [124, 137, 143].includes(result.exitCode)) return { status: 'failed', content: 'Python sandbox timed out or was killed. Diagnose termination and change the computation before retrying; an unchanged retry cannot make progress.',
        error: { code: 'PYTHON_TIMEOUT', message: 'Python execution timed out' } };
      return result.exitCode === 0 ? { status: 'success', content: result.stdout } :
        { status: 'failed', content: result.stderr, error: { code: 'PYTHON_EXECUTION', message: `Python exited ${result.exitCode}` } };
    },
  };
}

/** External search provider; execution and permissions remain public Ditto tools. */
export function createBenchmarkWebTool(task?: TaskInput) {
  const tool = createWebSearchTool({provider:{origin:'https://www.bing.com',async search({query,limit},options){
    const {stdout}=await promisify(execFile)(resolve(process.cwd(),'../MFlow-baselines/.venv-legacy/bin/python'),
      [new URL('../../baselines/search_provider.py',import.meta.url).pathname,query,String(limit),...(task?[task.prompt,task.id]:[])],
      {signal:options?.signal,maxBuffer:8*1024*1024});
    return JSON.parse(stdout);
  }}});
  return { ...tool, validate() {}, async execute(args, context) {
    try { tool.validate(args); }
    catch { return { status: 'failed' as const, content: 'Use a nonempty single-line query of at most 600 characters and 75 words, and an integer limit from 1 to 20. Correct the arguments and retry.', error: { code: 'WEB_SEARCH_ARGUMENTS', message: 'Invalid web search arguments' } }; }
    return tool.execute(args, context);
  } } satisfies RegisteredTool;
}
