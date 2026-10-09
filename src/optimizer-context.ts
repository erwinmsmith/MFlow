/** Keep all search evidence; fit only the output reservation to a reported model limit. */
export async function withOptimizerOutputBudget<T>(requested: number, invoke: (maxTokens: number) => Promise<T>,
  record: (adjustment: { requested: number; adjusted: number; contextTokens: number; inputTokens: number }) => Promise<void> = async () => {}) {
  try { return await invoke(requested); }
  catch (error) {
    const message = String(error);
    const match = /maximum context length is (\d+) tokens[\s\S]*?\((\d+) in the messages,\s*(\d+) in the completion\)/i.exec(message);
    if (!/MODEL_CONTEXT_LIMIT|HTTP 400/.test(message) || !match) throw error;
    const contextTokens = Number(match[1]), inputTokens = Number(match[2]), completion = Number(match[3]);
    const adjusted = contextTokens - inputTokens;
    if (![contextTokens, inputTokens, completion, requested].every(Number.isSafeInteger) ||
        completion !== requested || inputTokens < 0 || adjusted <= 0 || adjusted >= requested) throw error;
    await record({ requested, adjusted, contextTokens, inputTokens });
    // One correction only. Oversized input, billing and other failures remain explicit.
    return invoke(adjusted);
  }
}
