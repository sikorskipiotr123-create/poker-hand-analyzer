const { AUTHORIZATION } = require('./test-support/deployment-auth.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./test-support/analysis-fixture.cjs');
const { handleAnalyzeRequest } = require('./test-support/analyze-handler.cjs');
const { requestOpenAIAnalysis } = require('./ai-provider.ts');
const { checkAnalyzeRateLimit } = require('./analyze-rate-limit.ts');
const { createDeadline, awaitWithSignal, OperationCancelledError, ANALYZE_REQUEST_DEADLINE_MS, ANALYZE_BODY_DEADLINE_MS, ANALYZE_PROVIDER_DEADLINE_MS } = require('./request-cancellation.ts');
const { MAX_ANALYSIS_BODY_BYTES } = require('./ai-analysis.ts');
const encoder = new TextEncoder();
const validBody = () => JSON.stringify(fixture());
const request = (body = validBody(), signal, headers = {}) => new Request('http://localhost/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json', ...headers }, body, signal, ...(typeof body === 'string' ? {} : { duplex: 'half' }) });
const result = { situationSummary: 'Synthetic test review.', mathematicalContext: { summary: 'Ignored model math.' }, streetAnalysis: { preflop: null, flop: null, turn: null, river: null }, rangeAnalysis: { hero: 'Known cards.', villain: 'User assumption.', interaction: 'Qualitative interpretation.' }, opponentAnalysis: 'Unknown profile.', recommendedLine: { action: 'Review', explanation: 'Use verified facts.' }, keyTakeaways: ['Do not invent equity.'], confidence: 'low', missingInformation: [] };
const timings = { requestMs: 1000, bodyMs: 30, providerMs: 500 };
function mocks() {
  const calls = { quotas: 0, providers: 0 };
  return { calls, quota: async () => { calls.quotas++; return { status: 'allowed' }; }, provider: async () => { calls.providers++; return result; } };
}
const never = () => new Promise(() => {});

for (const trickle of [false, true]) test(`${trickle ? 'trickled' : 'stalled'} body expires, cancels/releases reader and never consumes quota`, async () => {
  let cancelled = 0, interval;
  const body = new ReadableStream({ start(controller) {
    if (trickle) interval = setInterval(() => controller.enqueue(encoder.encode(' ')), 5);
  }, cancel() { cancelled++; clearInterval(interval); return never(); } });
  const m = mocks(), started = performance.now();
  const response = await handleAnalyzeRequest(request(body), m.provider, m.quota, timings);
  assert.equal(response.status, 408);
  assert.equal((await response.json()).error, 'timeout');
  assert.ok(performance.now() - started < 1000);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.deepEqual(m.calls, { quotas: 0, providers: 0 });
});

test('client cancellation during body reading terminates even a stalled cancel callback', async () => {
  const controller = new AbortController(); let cancelCalls = 0;
  const body = new ReadableStream({ cancel() { cancelCalls++; return never(); } });
  const m = mocks(); const timer = setTimeout(() => controller.abort(), 15);
  const response = await handleAnalyzeRequest(request(body, controller.signal), m.provider, m.quota, timings);
  clearTimeout(timer);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_request');
  assert.equal(cancelCalls, 1); assert.equal(body.locked, false);
  assert.deepEqual(m.calls, { quotas: 0, providers: 0 });
});

test('already cancelled request cannot start Redis admission or provider work', async () => {
  const controller = new AbortController(); controller.abort(); const m = mocks();
  assert.equal((await handleAnalyzeRequest(request(validBody(), controller.signal), m.provider, m.quota)).status, 400);
  assert.deepEqual(m.calls, { quotas: 0, providers: 0 });
});

test('whole deadline before admission prevents all Redis/OpenAI calls', async () => {
  const m = mocks();
  assert.equal((await handleAnalyzeRequest(request(), m.provider, m.quota, { requestMs: 0.001 })).status, 504);
  assert.deepEqual(m.calls, { quotas: 0, providers: 0 });
});

for (const declared of [false, true]) test(`oversized ${declared ? 'declared' : 'streamed'} body cancels without waiting and keeps 413`, async () => {
  let cancelled = 0;
  const body = new ReadableStream({ start(c) { if (!declared) c.enqueue(new Uint8Array(MAX_ANALYSIS_BODY_BYTES + 1)); }, cancel() { cancelled++; return never(); } });
  const m = mocks();
  const response = await handleAnalyzeRequest(request(body, undefined, declared ? { 'content-length': String(MAX_ANALYSIS_BODY_BYTES + 1) } : {}), m.provider, m.quota, timings);
  assert.equal(response.status, 413); assert.equal(cancelled, 1); assert.equal(body.locked, false);
  assert.deepEqual(m.calls, { quotas: 0, providers: 0 });
});

test('late Redis resolution after cancellation cannot invoke OpenAI or refund admission', async () => {
  const controller = new AbortController(); const m = mocks(); let finish;
  const quota = async (_request, signal) => {
    m.calls.quotas++;
    assert.equal(signal.aborted, false);
    setTimeout(() => controller.abort(), 10);
    return new Promise(resolve => { finish = resolve; });
  };
  const response = await handleAnalyzeRequest(request(validBody(), controller.signal), m.provider, quota, timings);
  assert.equal(response.status, 400);
  finish({ status: 'allowed' }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(m.calls, { quotas: 1, providers: 0 });
});

test('cancellation during provider work aborts its signal and rejects a late successful result', async () => {
  const controller = new AbortController(); const m = mocks(); let providerSignal, finish;
  const provider = async (_prompt, signal) => {
    m.calls.providers++; providerSignal = signal;
    setTimeout(() => controller.abort(), 10);
    return new Promise(resolve => { finish = resolve; });
  };
  const response = await handleAnalyzeRequest(request(validBody(), controller.signal), provider, m.quota, timings);
  assert.equal(response.status, 400); assert.equal(providerSignal.aborted, true);
  finish(result); await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(m.calls, { quotas: 1, providers: 1 });
});

for (const stage of ['body', 'redis', 'provider']) test(`whole-request deadline bounds ${stage} work`, async () => {
  const m = mocks(); let activeSignal;
  const body = stage === 'body' ? new ReadableStream({}) : validBody();
  const quota = stage === 'redis' ? async (_req, signal) => { m.calls.quotas++; activeSignal = signal; return never(); } : m.quota;
  const provider = async (_prompt, signal) => { m.calls.providers++; activeSignal = signal; return never(); };
  const response = await handleAnalyzeRequest(request(body), provider, quota, { requestMs: 40, bodyMs: 500, providerMs: 500 });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, 'timeout');
  if (activeSignal) assert.equal(activeSignal.aborted, true);
  assert.equal(m.calls.providers, stage === 'provider' ? 1 : 0);
});

test('provider-specific deadline remains an independent safeguard', async () => {
  const m = mocks(); let activeSignal;
  const response = await handleAnalyzeRequest(request(), async (_prompt, signal) => { m.calls.providers++; activeSignal = signal; return never(); }, m.quota, { requestMs: 1000, providerMs: 20 });
  assert.equal(response.status, 504); assert.equal(activeSignal.reason.source, 'provider');
  assert.deepEqual(m.calls, { quotas: 1, providers: 1 });
});

test('normal chunked request succeeds and disposes parent cancellation listeners', async () => {
  const controller = new AbortController(); const req = request(new ReadableStream({ start(c) { const bytes = encoder.encode(validBody()); c.enqueue(bytes.slice(0, 100)); c.enqueue(bytes.slice(100)); c.close(); } }), controller.signal);
  let listeners = 0;
  const add = req.signal.addEventListener.bind(req.signal), remove = req.signal.removeEventListener.bind(req.signal);
  req.signal.addEventListener = (...args) => { if (args[0] === 'abort') listeners++; return add(...args); };
  req.signal.removeEventListener = (...args) => { if (args[0] === 'abort') listeners--; return remove(...args); };
  const m = mocks(); const response = await handleAnalyzeRequest(req, m.provider, m.quota, timings);
  assert.equal(response.status, 200); assert.equal(listeners, 0);
  assert.ok((await response.json()).verifiedMath);
  assert.deepEqual(m.calls, { quotas: 1, providers: 1 });
});

test('abortable waits remove listeners on success, rejection and cancellation', async () => {
  for (const outcome of ['success', 'error', 'cancel']) {
    const controller = new AbortController(); let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { listeners++; return add(...args); };
    controller.signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
    const operation = awaitWithSignal(controller.signal, async () => {
      if (outcome === 'error') throw new Error('Synthetic failure');
      if (outcome === 'cancel') { controller.abort(); return never(); }
      return 'ok';
    });
    if (outcome === 'success') assert.equal(await operation, 'ok'); else await assert.rejects(operation);
    assert.equal(listeners, 0);
  }
});

test('deadline checks detect elapsed synchronous work and first cancellation reason wins', () => {
  const parent = new AbortController(); const scope = createDeadline(parent.signal, 1, 'request');
  const started = performance.now(); while (performance.now() - started < 3) { /* bounded synchronous work */ }
  assert.throws(scope.check, error => error instanceof OperationCancelledError && error.source === 'request');
  parent.abort(); assert.equal(scope.signal.reason.source, 'request'); scope.dispose();
  assert.equal(ANALYZE_REQUEST_DEADLINE_MS, 60000);
  assert.equal(ANALYZE_BODY_DEADLINE_MS, 10000);
  assert.equal(ANALYZE_PROVIDER_DEADLINE_MS, 60000);
});

async function withMocks(env, fetchMock, run) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); const originalFetch = global.fetch;
  Object.assign(process.env, env); global.fetch = fetchMock;
  try { return await run(); } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
for (const responseBody of [false, true]) test(`provider fetch ${responseBody ? 'body' : 'connection'} is abort-aware without real API calls`, async () => {
  const controller = new AbortController(); let fetchCalls = 0, signal;
  await withMocks({ OPENAI_API_KEY: 'synthetic-test-only-key' }, async (_url, options) => {
    fetchCalls++; signal = options.signal; setTimeout(() => controller.abort(), 10);
    return responseBody ? { ok: true, status: 200, json: never } : never();
  }, async () => {
    await assert.rejects(requestOpenAIAnalysis({ system: 'Synthetic', user: 'Synthetic' }, controller.signal), error => error instanceof OperationCancelledError);
    assert.equal(fetchCalls, 1); assert.equal(signal.aborted, true);
  });
});

test('already aborted provider never starts fetch, even when credentials are absent', async () => {
  const controller = new AbortController(); controller.abort(); let fetchCalls = 0;
  await withMocks({ OPENAI_API_KEY: '' }, async () => { fetchCalls++; return never(); }, async () => {
    await assert.rejects(requestOpenAIAnalysis({ system: 'Synthetic', user: 'Synthetic' }, controller.signal), error => error instanceof OperationCancelledError);
    assert.equal(fetchCalls, 0);
  });
});

for (const responseBody of [false, true]) test(`Redis ${responseBody ? 'response body' : 'connection'} receives parent cancellation and preserves admission semantics`, async () => {
  const controller = new AbortController(); let calls = 0, signal;
  await withMocks({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', AI_CLIENT_IP_POLICY: 'vercel', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'synthetic-test-only-token' }, async (_url, options) => {
    calls++; signal = options.signal; setTimeout(() => controller.abort(), 10);
    return responseBody ? { ok: true, status: 200, json: never } : never();
  }, async () => {
    await assert.rejects(checkAnalyzeRateLimit(new Request('https://example.test/api/analyze', { headers: { 'x-vercel-forwarded-for': '203.0.113.10' } }), controller.signal), error => error instanceof OperationCancelledError);
    assert.equal(signal.aborted, true); assert.equal(calls, 1);
  });
});

test('Redis admission is not invoked for an already aborted request', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await withMocks({ NODE_ENV: 'production' }, async () => { calls++; return never(); }, async () => {
    await assert.rejects(checkAnalyzeRateLimit(request(), controller.signal), error => error instanceof OperationCancelledError);
    assert.equal(calls, 0);
  });
});

test('cancellation immediately after analysis admission cannot start the provider', async () => {
  const controller = new AbortController(); const m = mocks();
  const quota = async () => { m.calls.quotas++; controller.abort(); return { status: 'allowed' }; };
  const response = await handleAnalyzeRequest(request(validBody(), controller.signal), m.provider, quota, timings);
  assert.equal(response.status, 400);
  assert.deepEqual(m.calls, { quotas: 1, providers: 0 });
});

test('a normally delayed body remains accepted within its reading budget', async () => {
  const body = new ReadableStream({ start(c) { const bytes = encoder.encode(validBody()); c.enqueue(bytes.slice(0, 100)); setTimeout(() => { c.enqueue(bytes.slice(100)); c.close(); }, 10); } });
  const m = mocks();
  assert.equal((await handleAnalyzeRequest(request(body), m.provider, m.quota, { ...timings, bodyMs: 200 })).status, 200);
  assert.deepEqual(m.calls, { quotas: 1, providers: 1 });
});

test('reader errors and invalid JSON remain safe 400 responses without admission', async () => {
  for (const body of [new ReadableStream({ start(c) { c.error(new Error('Synthetic stream failure')); } }), '{']) {
    const m = mocks();
    assert.equal((await handleAnalyzeRequest(request(body), m.provider, m.quota, timings)).status, 400);
    assert.deepEqual(m.calls, { quotas: 0, providers: 0 });
  }
});

for (const oversized of [false, true]) test(`stream cleanup that aborts its transport preserves the original ${oversized ? '413' : '408'} error`, async () => {
  const controller = new AbortController();
  const body = new ReadableStream({ start(c) { if (oversized) c.enqueue(new Uint8Array(MAX_ANALYSIS_BODY_BYTES + 1)); }, cancel() { controller.abort(); } });
  const m = mocks();
  const response = await handleAnalyzeRequest(request(body, controller.signal), m.provider, m.quota, timings);
  assert.equal(response.status, oversized ? 413 : 408);
  assert.deepEqual(m.calls, { quotas: 0, providers: 0 });
});
