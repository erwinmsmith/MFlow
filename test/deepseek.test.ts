import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from 'node:http';
import { Agent } from 'undici';
import { modelFetch, ProviderFailure, observableProvider, type ProviderProgress } from "../src/provider-progress.js";
import { httpProvider } from "../src/ditto.js";

test('local provider options reach the published Ditto transport', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.model, 'qwen3.5-9b');
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
      assert.equal(body.thinking, undefined);
      assert.equal(body.stream, true);
      assert.ok(options && 'dispatcher' in options);
      return new Response('data: '+JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const provider = httpProvider({ model: 'qwen3.5-9b', baseUrl: 'http://127.0.0.1:11434/v1', temperature: 0,
      seed: 42, providerOptions: { chat_template_kwargs: { enable_thinking: false } } }, 'local');
    assert.equal((await provider.invoke({ model: { model: 'qwen3.5-9b' },
      messages: [{ role: 'user', content: 'fixture' }], generation: { maxTokens: 16 } },
    { signal: AbortSignal.timeout(1000) })).message.content, 'OK');
  } finally { globalThis.fetch = previous; }
});

test('public provider retains HTTP rejection details needed for recovery', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({error:{message:'maximum context length exceeded: fixture'}}), {status:400});
    const provider = httpProvider({model:'deepseek-flash',baseUrl:'https://api.deepseek.com',temperature:0,seed:42}, 'fixture-key');
    await assert.rejects(provider.invoke({model:{model:'deepseek-flash'},messages:[{role:'user',content:'fixture'}]},
      {signal:AbortSignal.timeout(1000)}), (error:unknown) => {
        assert.ok(error instanceof ProviderFailure); assert.equal(error.code,'MODEL_CONTEXT_LIMIT');
        assert.match(error.message,/HTTP 400: maximum context length exceeded: fixture/); return true;
      });
    for (const [status,message] of [[400,'Unsupported option'],[401,'Invalid authentication']] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify({error:{message}}), {status});
      await assert.rejects(provider.invoke({model:{model:'deepseek-flash'},messages:[{role:'user',content:'fixture'}]},
        {signal:AbortSignal.timeout(1000)}), (error:unknown) => {
          assert.ok(error instanceof ProviderFailure); assert.equal(error.code,'PROVIDER_HTTP_ERROR'); return true;
        });
    }
  } finally { globalThis.fetch = previous; }
});

test('model transport waits for headers/body while preserving caller cancellation', async () => {
  const short = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
  const server = createServer((request, response) => {
    if (request.url === '/body') { response.writeHead(200); response.write('O'); }
    setTimeout(() => response.end(request.url === '/body' ? 'K' : 'OK'), 1500).unref();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(globalThis.fetch(url+'/headers', { dispatcher: short } as RequestInit), /fetch failed/);
    const body = await globalThis.fetch(url+'/body', { dispatcher: short } as RequestInit);
    await assert.rejects(body.text(), /terminated/);
    for (const path of ['/headers', '/body'])
      assert.equal(await (await modelFetch(url+path, { signal: AbortSignal.timeout(5000) })).text(), 'OK');
    await assert.rejects(modelFetch(url+'/headers', { signal: AbortSignal.timeout(20) }), /timeout/i);
  } finally {
    await short.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

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
    const jsonMessages = body.messages as { content: string }[];
    assert.match(jsonMessages[0].content, /JSON object/);
    assert.equal(jsonMessages.at(-1)!.content, 'Reply OK');
    await provider.invoke({model:{provider:'mflow',model:'deepseek-flash',providerOptions:{response_format:{type:'text'}}},
      messages:[{role:'user',content:'Solve in prose'}],generation:{temperature:0,maxTokens:40}}, {signal:AbortSignal.timeout(1000)});
    assert.deepEqual(body.response_format,{type:'text'});
    assert.deepEqual(body.thinking,{type:'disabled'});
    assert.deepEqual(body.messages,[{role:'user',content:'Solve in prose'}]);

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

test('exact output cycles abort through public cancellation without accepting partial text', async () => {
  const events: ProviderProgress[] = [];
  let signal: AbortSignal | undefined;
  let closed = false;
  const provider = observableProvider({
    async invoke() { throw new Error('not used'); },
    async *stream(_input, options) {
      signal = options.signal;
      try { for (let i = 0; i < 100; i++) yield { type: 'text_delta' as const, delta: 'Repeated derivation with no new information.\n'.repeat(100) }; }
      finally { closed = true; }
    },
  }, { stream: true, onProgress: async p => { events.push(p); } });
  await assert.rejects(provider.invoke({ model: { model: 'fixture' }, messages: [{ role: 'user', content: 'fixture' }] },
    { signal: AbortSignal.timeout(1000) }), /DEGENERATE_OUTPUT/);
  assert.equal(signal?.aborted, true); assert.equal(closed, true);
  assert.equal(events.at(-1)?.usage, undefined);
  assert.ok(events.at(-1)?.outputTail?.includes('Repeated derivation'));
});

test('long distinct output is not subject to a length or context cutoff', async () => {
  const text = Array.from({ length: 10000 }, (_, i) => `Unique item ${i}: ${i * 37}\n`).join('');
  const provider = observableProvider({
    async invoke() { throw new Error('not used'); },
    async *stream() {
      for (let i = 0; i < text.length; i += 1000) yield { type: 'text_delta' as const, delta: text.slice(i, i + 1000) };
      yield { type: 'result' as const, output: { message: { role: 'assistant' as const, content: text }, finishReason: 'stop' as const, usage: { totalTokens: 123 } } };
    },
  }, { stream: true });
  const result = await provider.invoke({ model: { model: 'fixture' }, messages: [{ role: 'user', content: 'fixture' }] }, { signal: AbortSignal.timeout(1000) });
  assert.equal(result.message.content, text); assert.equal(result.usage?.totalTokens, 123);
});
