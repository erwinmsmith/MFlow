import test from "node:test";
import assert from "node:assert/strict";
import { ProviderFailure, observableProvider, type ProviderProgress } from "../src/provider-progress.js";
import { httpProvider } from "../src/ditto.js";

test("DeepSeek requests use the published Ditto provider with supported fields", async () => {
  const previous = globalThis.fetch;
  let body: Record<string, unknown> = {};
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://api.deepseek.com/chat/completions");
      body = JSON.parse(String(options?.body));
      return new Response('data: ' + JSON.stringify({
        choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }) + '\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const provider = httpProvider({ model: "deepseek-flash", baseUrl: "https://api.deepseek.com", temperature: 0, seed: 42 }, "fixture-key");
    const result = await provider.invoke({
      model: { provider: "mflow", model: "deepseek-flash" },
      messages: [{ role: "user", content: "Reply OK" }],
      generation: { temperature: 0, maxTokens: 40 },
    }, { signal: AbortSignal.timeout(1000) });
    assert.equal(result.message.content, "OK");
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.max_tokens, 40);
    assert.equal(body.max_completion_tokens, undefined);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.response_format, { type: "json_object" });
  } finally {
    globalThis.fetch = previous;
  }
});


test('public Ditto stream exposes progress and classifies malformed tool arguments without silent retry', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  const events: ProviderProgress[] = [];
  try {
    globalThis.fetch = async () => {
      calls++;
      const chunks = [
        { choices: [{ delta: { content: 'Working' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad-tool', type: 'function', function: { name: 'arithmetic', arguments: 'null' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 10 } },
      ];
      return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});
    };
    const provider = httpProvider({model:'deepseek-flash',baseUrl:'https://api.deepseek.com',temperature:0,seed:42}, 'fixture-key', {onProgress:async e=>{events.push(e);}});
    await assert.rejects(provider.invoke({model:{provider:'mflow',model:'deepseek-flash'},messages:[{role:'user',content:'fixture'}]}, {signal:AbortSignal.timeout(1000)}), (error:unknown)=>{
      assert.ok(error instanceof ProviderFailure);assert.equal(error.code,'INVALID_MODEL_OUTPUT');assert.match(error.message,/must be an object/);return true;
    });
    assert.equal(calls,1);assert.equal(events[0].state,'started');
    assert.ok(events.some(e=>e.state==='streaming' && e.textChars===7));
    assert.equal(events.at(-1)!.state,'failed');
    assert.equal(events.at(-1)!.usage,undefined); // Parser failed before public result; never invent billing usage.
  } finally {globalThis.fetch=previous;}
});

test('partial stream is not a completed answer', async () => {
  const events: ProviderProgress[]=[];
  const provider=observableProvider({async invoke(){throw new Error('invoke must not be used');},async *stream(){yield {type:'text_delta' as const,delta:'partial'};}}, {stream:true,onProgress:async e=>{events.push(e);}});
  await assert.rejects(provider.invoke({model:{provider:'fixture',model:'fixture'},messages:[{role:'user',content:'fixture'}]}, {signal:AbortSignal.timeout(1000)}), /INCOMPLETE_MODEL_OUTPUT/);
  assert.equal(events.at(-1)!.state,'failed');
});
