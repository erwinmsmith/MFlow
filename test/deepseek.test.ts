import test from "node:test";
import assert from "node:assert/strict";
import { httpProvider } from "../src/ditto.js";

test("DeepSeek requests use the published Ditto provider with supported fields", async () => {
  const previous = globalThis.fetch;
  let body: Record<string, unknown> = {};
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://api.deepseek.com/chat/completions");
      body = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const provider = httpProvider({ model: "deepseek-flash", baseUrl: "https://api.deepseek.com", temperature: 0, seed: 42 }, "fixture-key");
    const result = await provider.invoke({
      model: { provider: "mflow", model: "deepseek-flash" },
      messages: [{ role: "user", content: "Reply OK" }],
      generation: { temperature: 0, maxTokens: 40 },
    }, { signal: AbortSignal.timeout(1000) });
    assert.equal(result.message.content, "OK");
    assert.equal(body.max_tokens, 40);
    assert.equal(body.max_completion_tokens, undefined);
    assert.deepEqual(body.thinking, { type: "disabled" });
  } finally {
    globalThis.fetch = previous;
  }
});
