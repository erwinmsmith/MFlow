import type { SampleInput } from '@codesoul-co/ditto/worker/infer';

/** Validate generated message bindings before admitting a paid inference call. */
export function assertCompleteToolHistory(messages: SampleInput['messages']): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.metadata?.actionRequestId;
      if (typeof id !== 'string' || !pending.delete(id))
        throw new Error('Tool observation has no matching pending actionRequestId');
      continue;
    }
    if (pending.size) throw new Error('Assistant tool calls are missing observations: ' + [...pending].join(', '));
    const calls = message.metadata?.actionRequests as {id: string}[] | undefined;
    if (calls?.length) {
      if (message.role !== 'assistant') throw new Error('Only assistant messages may declare actionRequests');
      for (const call of calls) {
        if (typeof call.id !== 'string' || !call.id || pending.has(call.id)) throw new Error('Invalid or duplicate action request ID');
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error('Assistant tool calls are missing observations: ' + [...pending].join(', '));
}
