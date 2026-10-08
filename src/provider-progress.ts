import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import type { ModelProvider, SampleOutput, SampleInput } from '@codesoul-co/ditto/worker/infer';

// Ditto/caller AbortSignal owns the deadline, including time queued for local inference.
const modelDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
export const modelFetch: typeof globalThis.fetch = async (input, init) => {
  // Check the resolved wire format, including provider-level defaults. Ditto
  // still owns serialization and transport; this only supplies the required
  // JSON instruction when a generated node omitted it.
  if (typeof init?.body === 'string') {
    const body = JSON.parse(init.body);
    if (body.response_format?.type === 'json_object' && Array.isArray(body.messages) &&
        !body.messages.some((m: { content?: unknown }) => /json/i.test(JSON.stringify(m.content)))) {
      body.messages.unshift({ role: 'system', content: 'Return a valid JSON object matching the requested output schema.' });
      init = { ...init, body: JSON.stringify(body) };
    }
  }
  const response = await globalThis.fetch(input, { ...init, dispatcher: modelDispatcher } as RequestInit);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { message?: string; code?: string } } | undefined;
    const detail = body?.error?.message ?? response.statusText;
    const contextLimit = response.status === 400 && (body?.error?.code === 'context_length_exceeded' ||
      /(?:maximum|max) context length|context (?:length|window).*(?:exceed|limit)|exceed.*context/i.test(detail));
    throw new ProviderFailure(contextLimit ? 'MODEL_CONTEXT_LIMIT' : 'PROVIDER_HTTP_ERROR', `HTTP ${response.status}: ${detail}`);
  }
  return response;
};

export class ProviderFailure extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(`[${code}] ${message}`, { cause });
    this.name = 'ProviderFailure';
  }
}
export interface ProviderProgress {
  id: string; kind: string; state: 'started' | 'streaming' | 'completed' | 'failed';
  startedAt: string; updatedAt: string; textChars: number; nonWhitespaceChars: number;
  lastTextAt?: string; finishReason?: string; usage?: SampleOutput['usage']; error?: string; code?: string;
  actionChars?: number; reasoningChars?: number; lastGenerationAt?: string; method?: string; phase?: string; taskId?: string;
  agentId?: string; nodeId?: string; outputHead?: string; outputTail?: string;
  toolCycle?: { kind: 'action-result' | 'unchanged-computation'; repeats: number };
}
export interface TransportOptions {
  stream?: boolean;
  onProgress?: (progress: ProviderProgress) => Promise<void>;
}

/** A long exact cycle is an output fault, not a response-length budget. */
export function repeatedOutput(tail: string): boolean {
  if (tail.length < 8192) return false;
  const anchor = tail.slice(-128);
  let previous = tail.lastIndexOf(anchor, tail.length - 129);
  while (previous >= 0) {
    const period = tail.length - 128 - previous;
    if (period > 32768) break;
    const span = Math.max(8192, period * 8);
    if (tail.length >= span + period) {
      let matches = true;
      for (let i = tail.length - span; i < tail.length; i++) {
        if (tail[i] !== tail[i - period]) { matches = false; break; }
      }
      if (matches) return true;
    }
    // A repeated phrase inside a larger cycle is not necessarily its period.
    previous = tail.lastIndexOf(anchor, previous - 1);
  }
  return false;
}

/** Only identical completed action/result cycles count; useful new work has no quota. */
export function repeatedToolCycles(messages: SampleInput['messages'], computationsOnly = false): number {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
  const calls = new Map<string, [string, unknown]>(), completed: string[] = [];
  for (const message of messages.slice(-64)) {
    const metadata = message.metadata as { actionRequests?: { id: string; name: string; arguments: unknown }[]; actionRequestId?: string } | undefined;
    for (const call of metadata?.actionRequests ?? []) calls.set(call.id, [call.name, stable(call.arguments)]);
    if (message.role === 'tool' && metadata?.actionRequestId && calls.has(metadata.actionRequestId)) {
      const call = calls.get(metadata.actionRequestId)!;
      // Fresh Python sandboxes can produce different random counterexamples or
      // traceback details from the same unchanged faulty program. Requiring the
      // observation to match allowed these loops to run indefinitely. Stateful
      // API reads/writes are excluded from this computation-only check.
      completed.push(JSON.stringify(computationsOnly
        ? ['python', 'arithmetic'].includes(call[0]) ? call : ['non-computation', completed.length]
        : [call, message.content]));
    }
  }
  let best = 0;
  for (let period = 1; period <= 4; period++) {
    let count = 1;
    while (completed.length >= (count + 1) * period && completed.slice(-period).every((s, i) => s === completed[completed.length - (count + 1) * period + i])) count++;
    best = Math.max(best, count);
  }
  return best;
}

/** Consume the published provider's stream; Ditto owns SSE parsing, tool assembly and cancellation. */
export function observableProvider(provider: ModelProvider, options: TransportOptions): ModelProvider {
  return { async invoke(input, callOptions) {
    const progress: ProviderProgress = { id: randomUUID(), kind: String(input.metadata?.kind ?? 'inference'),
      state: 'started', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), textChars: 0, nonWhitespaceChars: 0,
      agentId: input.metadata?.agentId as string | undefined, nodeId: input.metadata?.nodeId as string | undefined,
      method: input.metadata?.method as string | undefined, phase: input.metadata?.phase as string | undefined, taskId: input.metadata?.taskId as string | undefined };
    const cancellation = new AbortController();
    const signal = AbortSignal.any([callOptions.signal, cancellation.signal]);
    let head = '', tail = '';
    const channels = new Map<string, { tail: string; chars: number; checkedAt: number }>();
    const publish = async () => { progress.updatedAt = new Date().toISOString(); await options.onProgress?.({ ...progress }); };
    await publish();
    try {
      if (input.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('TOOL_INFRASTRUCTURE')))
        throw new ProviderFailure('TOOL_INFRASTRUCTURE', 'Python execution service failed; resume the episode after recovery');
      const cycles = repeatedToolCycles(input.messages), computations = repeatedToolCycles(input.messages, true);
      const repeats = Math.max(cycles, computations);
      if (repeats >= 4) {
        progress.toolCycle = { kind: computations > cycles ? 'unchanged-computation' : 'action-result', repeats };
        await publish();
      }
      if (repeats >= 5) throw new ProviderFailure('DEGENERATE_OUTPUT', 'Unchanged tool computation or action/result cycle continued after recovery guidance; use existing evidence instead of repeating it');
      if (repeats >= 4) input = { ...input, messages: [...input.messages, { role: 'user', content: 'Execution diagnostic: the same tool operation and arguments have repeated four times. Randomized tests can return different counterexamples without changing the faulty program. Inspect the existing results, correct the implementation or assumptions, or finish with the supported answer. Do not rerun the unchanged computation; changing the actual method or test arguments is allowed.' }] };
      let result: SampleOutput | undefined, lastSaved = 0;
      if (options.stream) {
        if (!provider.stream) throw new ProviderFailure('STREAM_UNAVAILABLE', 'Published provider has no stream interface');
        for await (const event of provider.stream(input, { ...callOptions, signal })) {
          if (event.type === 'result') { result = event.output; continue; }
          if (!event.delta.length) continue;
          progress.state = 'streaming';
          progress.lastGenerationAt = new Date().toISOString();
          if (event.type === 'text_delta') {
            progress.textChars += event.delta.length;
            progress.nonWhitespaceChars += event.delta.replace(/\s/g, '').length;
            head = (head + event.delta).slice(0, 1024);
            tail = (tail + event.delta).slice(-2048);
            progress.lastTextAt = progress.lastGenerationAt;
          } else if (event.type === 'action_delta') progress.actionChars = (progress.actionChars ?? 0) + event.delta.length;
          else progress.reasoningChars = (progress.reasoningChars ?? 0) + event.delta.length;
          const key = event.type === 'action_delta' ? `action:${event.index}` : event.type;
          const channel = channels.get(key) ?? { tail: '', chars: 0, checkedAt: 0 };
          channel.tail = (channel.tail + event.delta).slice(-524288); channel.chars += event.delta.length;
          channels.set(key, channel);
          if (channel.chars - channel.checkedAt >= 4096) {
            channel.checkedAt = channel.chars;
            if (repeatedOutput(channel.tail)) {
              const error = new ProviderFailure('DEGENERATE_OUTPUT', `Provider repeated an exact ${event.type} cycle without progress`);
              cancellation.abort(error); throw error;
            }
          }
          if (Date.now() - lastSaved >= 2000) { await publish(); lastSaved = Date.now(); }
        }
        if (!result) throw new ProviderFailure('INCOMPLETE_MODEL_OUTPUT', 'Stream ended without a final result');
      } else result = await provider.invoke(input, callOptions);
      progress.state = 'completed'; progress.finishReason = result.finishReason; progress.usage = result.usage;
      if (result.finishReason === 'length') { progress.outputHead = head; progress.outputTail = tail.slice(-2048); }
      await publish();
      return result;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'PROVIDER_FAILURE';
      const failure = error instanceof ProviderFailure ? error : new ProviderFailure(code, error instanceof Error ? error.message : String(error), error);
      progress.state = 'failed'; progress.error = failure.message; progress.code = failure.code;
      progress.outputHead = head; progress.outputTail = tail.slice(-2048);
      await publish();
      throw failure;
    }
  } };
}
