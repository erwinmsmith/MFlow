import { Sandbox, createLocalSandboxExecutor, type RegisteredTool } from '@codesoul-co/ditto';
import { z } from 'zod';

export const dockerCommand = process.env.MFLOW_DOCKER ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/docker' : 'docker');
export function pythonExecutor() {
  const env: Record<string, string> = {};
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  else if (process.platform === 'darwin' && process.env.USER)
    env.DOCKER_HOST = `unix:///Users/${process.env.USER}/.docker/run/docker.sock`;
  return createLocalSandboxExecutor({ commands: [dockerCommand], env, timeoutMs: 40_000, maxOutputBytes: 1_048_576 });
}
export async function pythonImage() {
  const sandbox = new Sandbox(process.cwd(), { execute: true }, pythonExecutor());
  const result = await sandbox.run({ command: dockerCommand, args: ['image', 'inspect', process.env.MFLOW_PYTHON_IMAGE ?? 'python:3.12-alpine', '--format', '{{.Id}}'] });
  if (result.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim()))
    throw new Error('Python tool requires a running Docker daemon and local MFLOW_PYTHON_IMAGE (default python:3.12-alpine)');
  return result.stdout.trim();
}
const argsSchema = z.object({ code: z.string().min(1) }).strict();
export function createPythonTool(image: string): RegisteredTool {
  return {
    name: 'python', description: 'Execute Python 3 code in a fresh isolated container. Print the result. Standard library math, fractions, decimal, itertools and statistics are available. No network, host files or persistent state. Execution timeout 30 seconds.',
    effects: ['execute'], inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    validate(args) { argsSchema.parse(args); },
    async execute(args, context) {
      const { code } = argsSchema.parse(args);
      const result = await context.services.sandbox.run({ command: dockerCommand, args: [
        'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m',
        '--cpus', '1', '--user', '65534:65534', '--tmpfs', '/tmp:rw,nosuid,size=16m',
        image, 'timeout', '-s', 'KILL', '30', 'python', '-B', '-I', '-c', code,
      ] }, context.signal);
      return result.exitCode === 0 ? { status: 'success', content: result.stdout } :
        { status: 'failed', content: result.stderr, error: { code: 'PYTHON_EXECUTION', message: `Python exited ${result.exitCode}` } };
    },
  };
}
