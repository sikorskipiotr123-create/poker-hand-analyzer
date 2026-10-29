const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const {
  ANALYZE_RATE_LIMIT,
  ANALYZE_RATE_WINDOW_SECONDS,
  GLOBAL_ANALYZE_DAILY_LIMIT,
  ATOMIC_RATE_LIMIT_SCRIPT, ATOMIC_DAILY_ANALYSIS_SCRIPT,
  checkAnalyzeRateLimit,
  createInMemoryRateLimiter,
} = require('./analyze-rate-limit.ts');

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

function makeRequest(ip = '203.0.113.10') {
  return new Request('https://example.test/api/analyze', { headers: { 'x-vercel-forwarded-for': ip } });
}

function makeRedisMock() {
  const ipCounters = new Map();
  const dailyCounters = new Map();
  const calls = [];
  const days = new Map();
  let responseOverride;
  let errorOverride;
  const fetch = async (url, options) => {
    const args = JSON.parse(options.body);
    calls.push({ url: String(url), options, args });
    if (errorOverride) throw errorOverride;
    if (responseOverride) return responseOverride();
    if (args[1] === ATOMIC_DAILY_ANALYSIS_SCRIPT) return new Response(JSON.stringify({ result: require('./test-support/daily-admission.cjs').dailyReply(args, ipCounters, dailyCounters, days, Math.floor(Date.now() / 1000)) }), { status: 200 });
    const [command, script, keyCount, ipKey, dailyKey, ipLimitRaw, _ipTtl, dailyLimitRaw, _dailyExpiry] = args;
    assert.equal(command, 'EVAL');
    assert.equal(keyCount, '2');
    assert.match(script, /redis\.call\('MGET', KEYS\[1\], KEYS\[2\]\)/);
    assert.match(script, /redis\.call\('INCR', KEYS\[1\]\)/);
    assert.match(script, /redis\.call\('INCR', KEYS\[2\]\)/);
    const ipLimit = Number(ipLimitRaw);
    const dailyLimit = Number(dailyLimitRaw);
    const ipCount = ipCounters.get(ipKey) ?? 0;
    const dailyCount = dailyCounters.get(dailyKey) ?? 0;
    if (ipCount >= ipLimit) return new Response(JSON.stringify({ result: [1, ipCount, dailyCount] }), { status: 200 });
    if (dailyCount >= dailyLimit) return new Response(JSON.stringify({ result: [2, ipCount, dailyCount] }), { status: 200 });
    ipCounters.set(ipKey, ipCount + 1);
    dailyCounters.set(dailyKey, dailyCount + 1);
    return new Response(JSON.stringify({ result: [0, ipCount + 1, dailyCount + 1] }), { status: 200 });
  };
  return {
    fetch,
    calls,
    ipCounters,
    dailyCounters, days,
    setResponseOverride(fn) { responseOverride = fn; },
    setErrorOverride(error) { errorOverride = error; },
  };
}

async function withProductionRedis(mock, now, run) {
  const originalFetch = global.fetch;
  const oldNow = Date.now;
  global.fetch = mock.fetch;
  Date.now = () => now;
  try {
    return await withEnvironment({
      NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', AI_CLIENT_IP_POLICY: 'vercel',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'test-only-token',
    }, run);
  } finally {
    global.fetch = originalFetch;
    Date.now = oldNow;
  }
}

test('local limiter allows its configured burst, blocks excess within a fixed window, then resets', () => {
  let now = 12_000;
  const limit = createInMemoryRateLimiter(2, 1_000, () => now);
  assert.deepEqual(limit('client-a'), { status: 'allowed' });
  assert.deepEqual(limit('client-a'), { status: 'allowed' });
  assert.deepEqual(limit('client-a'), { status: 'limited', scope: 'ip', retryAfterSeconds: 1 });
  assert.deepEqual(limit('client-b'), { status: 'allowed' });
  now += 1_000;
  assert.deepEqual(limit('client-a'), { status: 'allowed' });
});

test('production limiter fails closed without shared configuration or a client IP', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('must not call Redis'); };
  try {
    for (const changes of [
      { UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: 'test-only-token' },
      { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: undefined },
    ]) {
      await withEnvironment({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', AI_CLIENT_IP_POLICY: 'vercel', ...changes }, async () => {
        assert.deepEqual(await checkAnalyzeRateLimit(makeRequest()), { status: 'unavailable' });
      });
    }
    await withEnvironment({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', AI_CLIENT_IP_POLICY: 'vercel', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, async () => {
      assert.deepEqual(await checkAnalyzeRateLimit(new Request('https://example.test/api/analyze')), { status: 'unavailable' });
    });
    assert.equal(fetchCalls, 0);
  } finally { global.fetch = originalFetch; }
});

test('validated admission sends one Redis-clock atomic daily EVAL with hashed IP and fixed global key', async () => {
  const mock = makeRedisMock();
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), async () => assert.equal((await checkAnalyzeRateLimit(makeRequest())).status, 'allowed'));
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].args[1], ATOMIC_DAILY_ANALYSIS_SCRIPT);
  assert.match(mock.calls[0].args[3], /^poker-analyze:daily:ip:v2:[a-f0-9]{64}$/);
  assert.equal(mock.calls[0].args[4], 'poker-analyze:daily:global:v2');
  assert.ok(!mock.calls[0].args.join('').includes('203.0.113.10'));
});

test('per-IP limit allows five validated attempts and rejects the sixth without spending daily capacity', async () => {
  const mock = makeRedisMock();
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), async () => {
    for (let i = 0; i < ANALYZE_RATE_LIMIT; i++) assert.deepEqual(await checkAnalyzeRateLimit(makeRequest()), { status: 'allowed' });
    const limited = await checkAnalyzeRateLimit(makeRequest());
    assert.equal(limited.status, 'limited');
    assert.equal(limited.scope, 'ip');
    assert.ok(limited.retryAfterSeconds > 0 && limited.retryAfterSeconds <= 86_400);
  });
  assert.equal(mock.dailyCounters.values().next().value, ANALYZE_RATE_LIMIT);
  assert.equal(mock.calls.length, ANALYZE_RATE_LIMIT + 1);
});

test('global daily limit is shared across IPs and permits exactly 100 concurrent requests', async () => {
  const mock = makeRedisMock();
  const decisions = await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), async () => Promise.all(
    Array.from({ length: GLOBAL_ANALYZE_DAILY_LIMIT + 35 }, (_, i) => checkAnalyzeRateLimit(makeRequest(`198.51.100.${i + 1}`))),
  ));
  assert.equal(decisions.filter((d) => d.status === 'allowed').length, GLOBAL_ANALYZE_DAILY_LIMIT);
  assert.equal(decisions.filter((d) => d.status === 'limited' && d.scope === 'global').length, 35);
  assert.equal(mock.calls.length, GLOBAL_ANALYZE_DAILY_LIMIT + 35);
  assert.equal([...mock.dailyCounters.values()][0], GLOBAL_ANALYZE_DAILY_LIMIT);
  assert.ok(decisions.filter((d) => d.status === 'limited').every((d) => d.retryAfterSeconds > 0 && d.retryAfterSeconds <= 86_400));
});

test('global daily counter resets at UTC midnight and uses a new date key', async () => {
  const mock = makeRedisMock();
  const firstDay = Date.UTC(2026, 11, 31, 23, 59, 59);
  mock.dailyCounters.set('poker-analyze:daily:global:v2', GLOBAL_ANALYZE_DAILY_LIMIT);
  mock.days.set('poker-analyze:daily:global:v2', Math.floor(firstDay / 86400000));
  const first = await withProductionRedis(mock, firstDay, () => checkAnalyzeRateLimit(makeRequest('198.51.100.20')));
  assert.equal(first.status, 'limited');
  assert.equal(first.scope, 'global');
  const next = await withProductionRedis(mock, Date.UTC(2027, 0, 1, 0, 0, 1), () => checkAnalyzeRateLimit(makeRequest('198.51.100.20')));
  assert.deepEqual(next, { status: 'allowed' });
  assert.equal(mock.calls[0].args[4], 'poker-analyze:daily:global:v2');
  assert.equal(mock.calls[1].args[4], 'poker-analyze:daily:global:v2');
});

test('production limiter fails closed for non-HTTPS URLs, Redis errors, malformed data, and timeouts', async () => {
  const originalFetch = global.fetch;
  try {
    await withEnvironment({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', AI_CLIENT_IP_POLICY: 'vercel', UPSTASH_REDIS_REST_URL: 'http://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, async () => {
      global.fetch = async () => { throw new Error('must not call Redis over HTTP'); };
      assert.deepEqual(await checkAnalyzeRateLimit(makeRequest()), { status: 'unavailable' });
    });
    const cases = [
      async () => new Response('unavailable', { status: 503 }),
      async () => new Response('{broken', { status: 200 }),
      async () => new Response(JSON.stringify({ result: [0, '1', 1] }), { status: 200 }),
      async () => new Response(JSON.stringify({ result: [0, 1, Number.MAX_SAFE_INTEGER + 10] }), { status: 200 }),
      async () => new Response(JSON.stringify({ result: [-1, 0, 0, 0, 86400] }), { status: 200 }),
      async () => new Response(JSON.stringify({ result: [7, 0, 0] }), { status: 200 }),
      async () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; },
    ];
    for (const respond of cases) {
      const mock = makeRedisMock();
      mock.setResponseOverride(respond);
      await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), async () => {
        assert.deepEqual(await checkAnalyzeRateLimit(makeRequest()), { status: 'unavailable' });
      });
    }
  } finally { global.fetch = originalFetch; }
});

test('rate-limit failures log only a safe category and HTTP status metadata', async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(' '));
  try {
    const cases = [
      { label: 'missing_environment_variable', env: { UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: 'test-only-token' } },
      { label: 'missing_client_ip', env: { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, request: new Request('https://example.test/api/analyze') },
      { label: 'invalid_redis_url', env: { UPSTASH_REDIS_REST_URL: 'http://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' } },
      { label: 'redis_timeout', env: { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, fetch: async () => { const e = new Error('private timeout detail'); e.name = 'TimeoutError'; throw e; } },
      { label: 'redis_network_error', env: { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, fetch: async () => { throw new Error('private network detail'); } },
      { label: 'redis_http_401_403', env: { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, fetch: async () => new Response('', { status: 403 }) },
      { label: 'redis_http_other', env: { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, fetch: async () => new Response('', { status: 503 }) },
      { label: 'malformed_redis_response', env: { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, fetch: async () => new Response('{bad', { status: 200 }) },
      { label: 'invalid_lua_result', env: { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, fetch: async () => new Response(JSON.stringify({ result: [-1, 0, 0, 0, 86400] }), { status: 200 }) },
    ];
    for (const item of cases) {
      await withEnvironment({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', AI_CLIENT_IP_POLICY: 'vercel', ...item.env }, async () => {
        global.fetch = item.fetch || (async () => { throw new Error('should not fetch'); });
        await checkAnalyzeRateLimit(item.request || makeRequest());
      });
    }
  } finally { global.fetch = originalFetch; console.error = originalError; }

  assert.equal(logs.length, 9);
  const records = logs.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.category), [
    'missing_environment_variable', 'missing_client_ip', 'invalid_redis_url', 'redis_timeout',
    'redis_network_error', 'redis_http_401_403', 'redis_http_other', 'malformed_redis_response', 'invalid_lua_result',
  ]);
  assert.equal(records[5].httpStatus, 403);
  assert.equal(records[6].httpStatus, 503);
  const serialized = JSON.stringify(records);
  for (const privateValue of ['203.0.113.10', 'test-only-token', 'redis.example.test', 'private timeout detail', 'private network detail']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

const { normalizeClientIP, trustedClientAddress } = require('./analyze-rate-limit.ts');
for (const [input, expected] of [
  ['203.0.113.10', '203.0.113.10'], ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
  ['2001:db8::1', '2001:db8::1'], ['::1', '::1'],
  ['::ffff:203.0.113.10', '203.0.113.10'], ['0:0:0:0:0:ffff:cb00:710a', '203.0.113.10'],
]) test(`canonical IP: ${input}`, () => assert.equal(normalizeClientIP(input), expected));
for (const value of ['', 'unknown', '203.0.113.256', '203.000.113.10', '2130706433', '0x7f000001',
  '203.0.113.10:443', '[2001:db8::1]', '[::1]:443', 'fe80::1%eth0', '2001:::1',
  '203.0.113.10, 10.0.0.1', '203.0.113.10,203.0.113.10', ' 203.0.113.10', '203.0.113.10 ', 'a'.repeat(1000), '::ffff:192.168.01.1'])
  test(`reject non-single IP: ${JSON.stringify(value).slice(0, 70)}`, () => assert.equal(normalizeClientIP(value), null));

test('trusted Vercel IP ignores conflicting spoofed forwarding headers and request deployment markers', async () => {
  const mock = makeRedisMock();
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), async () => {
    for (let i = 0; i < 6; i++) {
      const request = new Request('https://example.test/api/analyze', { headers: {
        'x-vercel-forwarded-for': i % 2 ? '::ffff:203.0.113.10' : '203.0.113.10',
        'x-forwarded-for': `198.51.100.${i}, 10.0.0.1`, 'x-real-ip': `192.0.2.${i}`,
        forwarded: `for=192.0.2.${i}`, 'cf-connecting-ip': `192.0.2.${i}`, 'x-vercel-id': 'spoof',
      } });
      assert.equal((await checkAnalyzeRateLimit(request)).status, i < 5 ? 'allowed' : 'limited');
    }
  });
  assert.equal(mock.ipCounters.size, 1); assert.equal([...mock.dailyCounters.values()][0], 5);
});

test('equivalent IPv6 spellings share a Redis quota key', async () => {
  const mock = makeRedisMock();
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), async () => {
    for (const ip of ['2001:DB8::1', '2001:0db8:0:0:0:0:0:1']) assert.equal((await checkAnalyzeRateLimit(makeRequest(ip))).status, 'allowed');
  });
  assert.equal(mock.ipCounters.size, 1);
});

test('missing, malformed, duplicate and chained Vercel IPs never consume Redis quota', async () => {
  const mock = makeRedisMock();
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), async () => {
    for (const value of [null, '', 'unknown', '203.0.113.10, 10.0.0.1', '::1%lo', '[::1]', '203.0.113.10:443']) {
      const headers = new Headers({ 'x-forwarded-for': '203.0.113.10', 'x-real-ip': '203.0.113.10', forwarded: 'for=203.0.113.10' });
      if (value !== null) headers.set('x-vercel-forwarded-for', value);
      assert.deepEqual(await checkAnalyzeRateLimit(new Request('https://example.test/api/analyze', { headers })), { status: 'unavailable' });
    }
    const headers = new Headers(); headers.append('x-vercel-forwarded-for', '203.0.113.10'); headers.append('x-vercel-forwarded-for', '203.0.113.10');
    assert.deepEqual(await checkAnalyzeRateLimit(new Request('https://example.test', { headers })), { status: 'unavailable' });
  });
  assert.equal(mock.calls.length, 0);
});

for (const changes of [
  { VERCEL: undefined }, { VERCEL: '0' }, { VERCEL_ENV: undefined }, { VERCEL_ENV: 'development' },
  { AI_CLIENT_IP_POLICY: undefined }, { AI_CLIENT_IP_POLICY: 'local' }, { AI_CLIENT_IP_POLICY: 'vercel ' },
  { NODE_ENV: 'development', AI_CLIENT_IP_POLICY: 'local' }, { NODE_ENV: 'test', AI_CLIENT_IP_POLICY: 'local' },
]) test(`untrusted deployment fails closed: ${JSON.stringify(changes)}`, async () => {
  const mock = makeRedisMock();
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), () => withEnvironment(changes, async () => {
    assert.deepEqual(await checkAnalyzeRateLimit(makeRequest()), { status: 'unavailable' });
  }));
  assert.equal(mock.calls.length, 0);
});

test('preview uses trusted Vercel policy and shared Redis, never local fallback', async () => {
  const mock = makeRedisMock();
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), () => withEnvironment({ VERCEL_ENV: 'preview' }, async () => {
    assert.deepEqual(await checkAnalyzeRateLimit(makeRequest()), { status: 'allowed' });
  }));
  assert.equal(mock.calls.length, 1);
});

test('local dev/test ignores spoofed headers and missing IP shares one bounded bucket', async () => {
  const originalFetch = global.fetch, oldNow = Date.now; let calls = 0;
  global.fetch = async () => { calls++; throw new Error('must not use Redis'); }; Date.now = () => 1200000;
  try {
    await withEnvironment({ NODE_ENV: 'development', VERCEL: undefined, VERCEL_ENV: undefined, AI_CLIENT_IP_POLICY: 'local' }, async () => {
      for (let i = 0; i < 5; i++) assert.equal((await checkAnalyzeRateLimit(makeRequest(`192.0.2.${i}`))).status, 'allowed');
      assert.equal((await checkAnalyzeRateLimit(new Request('http://localhost/api/analyze'))).status, 'limited');
    });
    Date.now = () => 86400000;
    await withEnvironment({ NODE_ENV: 'test', VERCEL: undefined, VERCEL_ENV: undefined, AI_CLIENT_IP_POLICY: undefined }, async () => {
      assert.equal((await checkAnalyzeRateLimit(new Request('http://localhost/api/analyze'))).status, 'allowed');
      assert.throws(() => trustedClientAddress(makeRequest()), /untrusted_client_ingress/);
    });
    await withEnvironment({ NODE_ENV: 'production', VERCEL: undefined, VERCEL_ENV: undefined, AI_CLIENT_IP_POLICY: 'local' }, async () => {
      assert.deepEqual(await checkAnalyzeRateLimit(makeRequest()), { status: 'unavailable' });
    });
  } finally { global.fetch = originalFetch; Date.now = oldNow; }
  assert.equal(calls, 0);
});

const { checkAnalyzeAttemptLimit, ANALYZE_ATTEMPT_IP_LIMIT, ANALYZE_ATTEMPT_GLOBAL_LIMIT } = require('./analyze-rate-limit.ts');
test('attempt protection has separate atomic counters, exact bounds, TTLs and normalized IP identity', async () => {
  const mock = makeRedisMock(), now = Date.UTC(2026, 3, 8, 12, 2);
  await withProductionRedis(mock, now, async () => {
    for (let i = 0; i < ANALYZE_ATTEMPT_IP_LIMIT; i++) assert.equal((await checkAnalyzeAttemptLimit(makeRequest(i % 2 ? '::ffff:203.0.113.10' : '203.0.113.10'))).status, 'allowed');
    const blocked = await checkAnalyzeAttemptLimit(makeRequest());
    assert.equal(blocked.status, 'limited'); assert.equal(blocked.scope, 'ip'); assert.equal(blocked.retryAfterSeconds, 480);
    assert.equal((await checkAnalyzeRateLimit(makeRequest())).status, 'allowed');
  });
  const a = mock.calls[0].args;
  assert.match(a[3], /^poker-analyze:attempt:ip:v1:[a-f0-9]{64}:\d+$/);
  assert.match(a[4], /^poker-analyze:attempt:global:v1:\d+$/);
  assert.equal(a[5], '20'); assert.equal(a[6], '602'); assert.equal(a[7], '1000');
  assert.equal(Number(a[8]), Math.floor(Date.UTC(2026, 3, 8, 12, 10) / 1000) + 2);
  assert.equal(mock.ipCounters.size, 2); // one attempt key and one unchanged analysis key
});

test('atomic concurrent attempt admission across instances cannot exceed global ceiling', async () => {
  const mock = makeRedisMock();
  const decisions = await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), () => Promise.all(
    Array.from({ length: 1050 }, (_, i) => checkAnalyzeAttemptLimit(makeRequest(`2001:db8::${(i + 1).toString(16)}`))),
  ));
  assert.equal(decisions.filter(d => d.status === 'allowed').length, ANALYZE_ATTEMPT_GLOBAL_LIMIT);
  assert.equal(decisions.filter(d => d.status === 'limited' && d.scope === 'global').length, 50);
  assert.ok([...mock.dailyCounters.keys()].every(k => k.startsWith('poker-analyze:attempt:')));
});

test('attempt window resets independently of daily analysis allowance', async () => {
  const mock = makeRedisMock();
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12), async () => {
    for (let i = 0; i < 20; i++) await checkAnalyzeAttemptLimit(makeRequest());
    assert.equal((await checkAnalyzeAttemptLimit(makeRequest())).status, 'limited');
  });
  await withProductionRedis(mock, Date.UTC(2026, 3, 8, 12, 10), async () => assert.equal((await checkAnalyzeAttemptLimit(makeRequest())).status, 'allowed'));
  assert.equal(mock.dailyCounters.size, 2);
});
