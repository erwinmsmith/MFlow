import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import type { ModelProvider, SampleOutput } from '@codesoul-co/ditto/worker/infer';

// Ditto/caller AbortSignal owns the deadline, including time queued for local inference.
const modelDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
export const modelFetch: typeof globalThis.fetch = async (input, init) => {
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
