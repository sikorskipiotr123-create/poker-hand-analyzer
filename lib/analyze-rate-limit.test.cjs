const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { ANALYZE_RATE_LIMIT, ANALYZE_RATE_WINDOW_SECONDS, checkAnalyzeRateLimit, createInMemoryRateLimiter } = require('./analyze-rate-limit.ts');

function withEnvironment(changes, run) {
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return Promise.resolve().then(run).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('local limiter allows the configured burst, blocks excess requests, then resets', () => {
  let now = 12_000;
  const limit = createInMemoryRateLimiter(2, 1_000, () => now);
  assert.deepEqual(limit('client-a'), { status: 'allowed' });
  assert.deepEqual(limit('client-a'), { status: 'allowed' });
  assert.deepEqual(limit('client-a'), { status: 'limited', retryAfterSeconds: 1 });
  assert.deepEqual(limit('client-b'), { status: 'allowed' });
  now += 1_000;
  assert.deepEqual(limit('client-a'), { status: 'allowed' });
});

test('production AI access fails closed without shared limiter configuration', async () => {
  await withEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }, async () => {
    const decision = await checkAnalyzeRateLimit(new Request('https://example.test/api/analyze', { headers: { 'x-forwarded-for': '203.0.113.10' } }));
    assert.deepEqual(decision, { status: 'unavailable' });
  });
});

test('production shared limiter uses an atomic Redis counter without exposing client IP in its key', async () => {
  const originalFetch = global.fetch;
  const oldNow = Date.now;
  const now = 1_900_000_000_000;
  const captured = [];
  Date.now = () => now;
  global.fetch = async (url, options) => {
    captured.push({ url: String(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ result: captured.length }), { status: 200 });
  };
  try {
    await withEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, async () => {
      const req = new Request('https://example.test/api/analyze', { headers: { 'x-vercel-forwarded-for': '203.0.113.10' } });
      for (let i = 0; i < ANALYZE_RATE_LIMIT; i++) assert.deepEqual(await checkAnalyzeRateLimit(req), { status: 'allowed' });
      const blocked = await checkAnalyzeRateLimit(req);
      assert.equal(blocked.status, 'limited');
      assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= ANALYZE_RATE_WINDOW_SECONDS);
    });
    assert.equal(captured.length, ANALYZE_RATE_LIMIT + 1);
    assert.equal(captured[0].options.headers.Authorization, 'Bearer test-only-token');
    assert.equal(captured[0].body[0], 'EVAL');
    assert.ok(!captured[0].body[3].includes('203.0.113.10'));
    assert.equal(captured[0].options.signal.aborted, false);
  } finally {
    global.fetch = originalFetch;
    Date.now = oldNow;
  }
});

test('production limiter fails closed on an unavailable or invalid HTTPS store', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    await withEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'http://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, async () => {
      assert.deepEqual(await checkAnalyzeRateLimit(new Request('https://example.test/', { headers: { 'x-real-ip': '203.0.113.11' } })), { status: 'unavailable' });
    });
    await withEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, async () => {
      assert.deepEqual(await checkAnalyzeRateLimit(new Request('https://example.test/', { headers: { 'x-real-ip': '203.0.113.11' } })), { status: 'unavailable' });
    });
  } finally { global.fetch = originalFetch; }
});
