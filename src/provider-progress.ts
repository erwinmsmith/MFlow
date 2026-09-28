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
}
export interface TransportOptions {
  stream?: boolean;
  onProgress?: (progress: ProviderProgress) => Promise<void>;
}

/** Consume the published provider's stream; Ditto owns SSE parsing, tool assembly and cancellation. */
export function observableProvider(provider: ModelProvider, options: TransportOptions): ModelProvider {
  return { async invoke(input, callOptions) {
    const progress: ProviderProgress = { id: randomUUID(), kind: String(input.metadata?.kind ?? 'inference'),
      state: 'started', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), textChars: 0, nonWhitespaceChars: 0 };
    const publish = async () => { progress.updatedAt = new Date().toISOString(); await options.onProgress?.({ ...progress }); };
    await publish();
    try {
      let result: SampleOutput | undefined, lastSaved = 0;
      if (options.stream) {
        if (!provider.stream) throw new ProviderFailure('STREAM_UNAVAILABLE', 'Published provider has no stream interface');
        for await (const event of provider.stream(input, callOptions)) {
          if (event.type === 'result') { result = event.output; continue; }
          progress.state = 'streaming'; progress.textChars += event.delta.length;
          progress.nonWhitespaceChars += event.delta.replace(/\s/g, '').length;
          progress.lastTextAt = new Date().toISOString();
          if (Date.now() - lastSaved >= 2000) { await publish(); lastSaved = Date.now(); }
        }
        if (!result) throw new ProviderFailure('INCOMPLETE_MODEL_OUTPUT', 'Stream ended without a final result');
      } else result = await provider.invoke(input, callOptions);
      progress.state = 'completed'; progress.finishReason = result.finishReason; progress.usage = result.usage;
      await publish();
      return result;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'PROVIDER_FAILURE';
      const failure = error instanceof ProviderFailure ? error : new ProviderFailure(code, error instanceof Error ? error.message : String(error), error);
      progress.state = 'failed'; progress.error = failure.message; progress.code = failure.code;
      await publish();
      throw failure;
    }
  } };
}
