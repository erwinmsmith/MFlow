import { randomUUID } from 'node:crypto';
import type { ModelProvider, SampleOutput } from '@codesoul-co/ditto/worker/infer';

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
  const previous = tail.lastIndexOf(anchor, tail.length - 129);
  const period = tail.length - 128 - previous;
  if (previous < 0 || period > 2048) return false;
  const span = Math.max(8192, period * 8);
  if (tail.length < span + period) return false;
  for (let i = tail.length - span; i < tail.length; i++)
    if (tail[i] !== tail[i - period]) return false;
  return true;
}

/** Consume the published provider's stream; Ditto owns SSE parsing, tool assembly and cancellation. */
export function observableProvider(provider: ModelProvider, options: TransportOptions): ModelProvider {
  return { async invoke(input, callOptions) {
    const progress: ProviderProgress = { id: randomUUID(), kind: String(input.metadata?.kind ?? 'inference'),
      state: 'started', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), textChars: 0, nonWhitespaceChars: 0,
      agentId: input.metadata?.agentId as string | undefined, nodeId: input.metadata?.nodeId as string | undefined };
    const cancellation = new AbortController();
    const signal = AbortSignal.any([callOptions.signal, cancellation.signal]);
    let head = '', tail = '', checkedAt = 0;
    const publish = async () => { progress.updatedAt = new Date().toISOString(); await options.onProgress?.({ ...progress }); };
    await publish();
    try {
      let result: SampleOutput | undefined, lastSaved = 0;
      if (options.stream) {
        if (!provider.stream) throw new ProviderFailure('STREAM_UNAVAILABLE', 'Published provider has no stream interface');
        for await (const event of provider.stream(input, { ...callOptions, signal })) {
          if (event.type === 'result') { result = event.output; continue; }
          progress.state = 'streaming'; progress.textChars += event.delta.length;
          progress.nonWhitespaceChars += event.delta.replace(/\s/g, '').length;
          head = (head + event.delta).slice(0, 1024);
          tail = (tail + event.delta).slice(-32768);
          if (progress.textChars - checkedAt >= 4096) {
            checkedAt = progress.textChars;
            if (repeatedOutput(tail)) {
              const error = new ProviderFailure('DEGENERATE_OUTPUT', 'Provider repeated an exact output cycle without progress');
              cancellation.abort(error);
              throw error;
            }
          }
          progress.lastTextAt = new Date().toISOString();
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
