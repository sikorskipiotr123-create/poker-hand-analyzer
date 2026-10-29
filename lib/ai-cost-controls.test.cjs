const { AUTHORIZATION } = require('./test-support/deployment-auth.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, known } = require('./test-support/analysis-fixture.cjs');
const { handleAnalyzeRequest } = require('./analyze-handler.ts');
const { requestOpenAIAnalysis, AnalysisServiceError } = require('./ai-provider.ts');
const { getAICostPolicy } = require('./ai-cost-controls.ts');
const { createRedisConcurrencyLimiter, ACQUIRE_AI_SLOT_SCRIPT, RELEASE_AI_SLOT_SCRIPT, AI_CONCURRENCY_KEY, AI_CONCURRENCY_LEASE_MS } = require('./analyze-concurrency.ts');
const { ATOMIC_RATE_LIMIT_SCRIPT, ATOMIC_DAILY_ANALYSIS_SCRIPT } = require('./analyze-rate-limit.ts');
const { OperationCancelledError, awaitWithSignal } = require('./request-cancellation.ts');
const { translate } = require('./i18n.ts');
const result = { situationSummary: 'Synthetic test review.', mathematicalContext: { summary: 'Ignored model math.' }, streetAnalysis: { preflop: null, flop: null, turn: null, river: null }, rangeAnalysis: { hero: 'Known cards.', villain: 'User assumption.', interaction: 'Qualitative interpretation.' }, opponentAnalysis: 'Unknown profile.', recommendedLine: { action: 'Review', explanation: 'Use verified facts.' }, keyTakeaways: ['Do not invent equity.'], confidence: 'low', missingInformation: [] };
const request = (context = fixture(), signal, ip = '203.0.113.10') => new Request('https://example.test/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'Content-Type': 'application/json', 'x-vercel-forwarded-for': ip }, body: JSON.stringify(context), signal });

async function environment(changes, run) {
  const saved = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
function redisBackend() {
  const backend = { now: 1000, days: new Map(), active: new Map(), ip: new Map(), daily: new Map(), attemptIp: new Map(), attemptGlobal: new Map(), calls: [], peak: 0, failure: null, commitThenAbort: null };
  backend.fetch = async (_url, options) => {
    await Promise.resolve(); // Simulate separate instances reaching the same atomic Redis operation.
    const args = JSON.parse(options.body); backend.calls.push(args);
    const [command, script, count, key] = args; assert.equal(command, 'EVAL');
    if (backend.failure?.(script)) throw new Error('Synthetic Redis failure');
    let reply;
    if (script === ACQUIRE_AI_SLOT_SCRIPT) {
      assert.equal(count, '1'); assert.equal(key, AI_CONCURRENCY_KEY);
      const maximum = Number(args[4]), lease = Number(args[5]), owner = args[6];
      assert.equal(lease, 75000); assert.match(owner, /^[a-f0-9-]{36}$/);
      for (const [token, expiry] of backend.active) if (expiry <= backend.now) backend.active.delete(token);
      if (backend.active.size >= maximum) reply = [1, Math.max(1, Math.ceil((Math.min(...backend.active.values()) - backend.now) / 1000))];
      else { backend.active.set(owner, backend.now + lease); backend.peak = Math.max(backend.peak, backend.active.size); reply = [0, 0]; }
      if (backend.commitThenAbort) { backend.commitThenAbort.abort(); backend.commitThenAbort = null; }
    } else if (script === RELEASE_AI_SLOT_SCRIPT) {
      assert.equal(count, '1'); assert.equal(key, AI_CONCURRENCY_KEY);
      reply = backend.active.delete(args[4]) ? 1 : 0;
    } else if (script === ATOMIC_DAILY_ANALYSIS_SCRIPT) {
      reply = require('./test-support/daily-admission.cjs').dailyReply(args, backend.ip, backend.daily, backend.days, Math.floor(Date.now() / 1000));
    } else {
      assert.equal(script, ATOMIC_RATE_LIMIT_SCRIPT); assert.equal(count, '2');
      const attempts = key.startsWith('poker-analyze:attempt:');
      const ips = attempts ? backend.attemptIp : backend.ip, globals = attempts ? backend.attemptGlobal : backend.daily;
      const dailyKey = args[4], ipCount = ips.get(key) ?? 0, dailyCount = globals.get(dailyKey) ?? 0;
      assert.equal(args[5], attempts ? '20' : '5'); assert.equal(args[7], attempts ? '1000' : '100');
      if (ipCount >= Number(args[5])) reply = [1, ipCount, dailyCount];
      else if (dailyCount >= Number(args[7])) reply = [2, ipCount, dailyCount];
      else { ips.set(key, ipCount + 1); globals.set(dailyKey, dailyCount + 1); reply = [0, ipCount + 1, dailyCount + 1]; }
    }
    return new Response(JSON.stringify({ result: reply }), { status: 200 });
  };
  return backend;
}
async function withRedis(backend, run) {
  const original = global.fetch; global.fetch = backend.fetch;
  try { return await environment({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', AI_CLIENT_IP_POLICY: 'vercel', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'synthetic-test-only-token', AI_ANALYSIS_DISABLED: undefined, AI_MAX_OUTPUT_TOKENS: undefined, AI_MAX_CONCURRENT_REQUESTS: undefined }, run); }
  finally { global.fetch = original; }
}

test('server policy has conservative defaults and documented configurable bounds', async () => {
  await environment({ AI_ANALYSIS_DISABLED: undefined, AI_MAX_OUTPUT_TOKENS: undefined, AI_MAX_CONCURRENT_REQUESTS: undefined }, async () => {
    assert.deepEqual(getAICostPolicy(), { disabled: false, maxOutputTokens: 16000, maxConcurrentRequests: 3 });
  });
  await environment({ AI_ANALYSIS_DISABLED: 'true', AI_MAX_OUTPUT_TOKENS: '25000', AI_MAX_CONCURRENT_REQUESTS: '10' }, async () => {
    assert.deepEqual(getAICostPolicy(), { disabled: true, maxOutputTokens: 25000, maxConcurrentRequests: 10 });
  });
});
for (const [key, value] of [['AI_ANALYSIS_DISABLED', 'TRUE'], ['AI_ANALYSIS_DISABLED', 'false '], ['AI_ANALYSIS_DISABLED', ''], ['AI_MAX_OUTPUT_TOKENS', '8191'], ['AI_MAX_OUTPUT_TOKENS', '25001'], ['AI_MAX_OUTPUT_TOKENS', '16000.5'], ['AI_MAX_OUTPUT_TOKENS', 'NaN'], ['AI_MAX_CONCURRENT_REQUESTS', '0'], ['AI_MAX_CONCURRENT_REQUESTS', '11'], ['AI_MAX_CONCURRENT_REQUESTS', '3 ']]) {
  test(`malformed ${key} fails closed before body/quota/provider work`, async () => environment({ [key]: value }, async () => {
    let reads = 0, quotas = 0, providers = 0, slots = 0;
    const req = request(); Object.defineProperty(req, 'body', { get() { reads++; throw new Error('Body must not be read'); } });
    const response = await handleAnalyzeRequest(req, async () => { providers++; }, async () => { quotas++; return { status: 'allowed' }; }, {}, async () => { slots++; return { status: 'unavailable' }; });
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'ai_limits_configuration_error');
    assert.deepEqual([reads, quotas, providers, slots], [0, 0, 0, 0]);
  }));
}

test('shutdown mode rejects new AI calls before body reading or Redis admission', async () => environment({ AI_ANALYSIS_DISABLED: 'true' }, async () => {
  let reads = 0, calls = 0;
  const req = request(); Object.defineProperty(req, 'body', { get() { reads++; throw new Error('Unexpected body read'); } });
  const response = await handleAnalyzeRequest(req, async () => { calls++; }, async () => { calls++; return { status: 'allowed' }; });
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'ai_disabled');
  assert.equal(reads, 0); assert.equal(calls, 0);
  await assert.rejects(requestOpenAIAnalysis({ system: 'Synthetic', user: 'Synthetic' }, new AbortController().signal), error => error.code === 'ai_disabled');
}));

test('independent instance factories share one atomic capacity across parallel requests', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    const instances = [createRedisConcurrencyLimiter(), createRedisConcurrencyLimiter(), createRedisConcurrencyLimiter()];
    const admissions = await Promise.all(Array.from({ length: 30 }, (_, i) => instances[i % 3](new AbortController().signal, 3)));
    assert.equal(admissions.filter(a => a.status === 'allowed').length, 3);
    assert.equal(admissions.filter(a => a.status === 'limited').length, 27);
    assert.equal(backend.peak, 3);
    await Promise.all(admissions.filter(a => a.status === 'allowed').map(a => a.release()));
    assert.equal(backend.active.size, 0);
  });
});

test('release is idempotent and cannot delete another request’s ownership token', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    const limiter = createRedisConcurrencyLimiter(), signal = new AbortController().signal;
    const a = await limiter(signal, 3), b = await limiter(signal, 3);
    await Promise.all([a.release(), a.release()]);
    assert.equal(backend.active.size, 1);
    assert.equal(backend.calls.filter(a => a[1] === RELEASE_AI_SLOT_SCRIPT).length, 1);
    await b.release(); assert.equal(backend.active.size, 0);
  });
});

test('abandoned leases expire using Redis time; stale owners cannot release replacements', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    const limiter = createRedisConcurrencyLimiter(), signal = new AbortController().signal;
    const old = await limiter(signal, 1);
    assert.equal((await limiter(signal, 1)).status, 'limited');
    backend.now += AI_CONCURRENCY_LEASE_MS;
    const replacement = await limiter(signal, 1); assert.equal(replacement.status, 'allowed');
    await old.release(); assert.equal(backend.active.size, 1);
    await replacement.release(); assert.equal(backend.active.size, 0);
  });
});

test('unknown Redis admission outcome triggers owned cleanup, never a provider call', async () => {
  const backend = redisBackend(), controller = new AbortController();
  await withRedis(backend, async () => {
    backend.commitThenAbort = controller;
    await assert.rejects(createRedisConcurrencyLimiter()(controller.signal, 3), error => error instanceof OperationCancelledError);
    assert.equal(backend.active.size, 0);
    assert.equal(backend.calls.length, 2);
  });
});

test('Redis release outages retain conservative capacity until lease expiration', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    const limiter = createRedisConcurrencyLimiter(), signal = new AbortController().signal;
    const slot = await limiter(signal, 1); backend.failure = script => script === RELEASE_AI_SLOT_SCRIPT;
    await slot.release(); assert.equal(backend.active.size, 1);
    assert.equal((await limiter(signal, 1)).status, 'limited');
    backend.failure = null; backend.now += 75000;
    const next = await limiter(signal, 1); assert.equal(next.status, 'allowed'); await next.release();
  });
});

test('missing Redis configuration and failed admission fail closed in every environment', async () => {
  await environment({ UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }, async () => {
    assert.equal((await createRedisConcurrencyLimiter()(new AbortController().signal, 3)).status, 'unavailable');
  });
  const backend = redisBackend(); backend.failure = () => true;
  await withRedis(backend, async () => {
    let providers = 0;
    const response = await handleAnalyzeRequest(request(), async () => { providers++; return result; });
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'rate_limit_unavailable');
    assert.equal(providers, 0); assert.equal(backend.daily.size, 0);
    assert.equal(backend.calls.length, 1); // Attempt admission fails closed before leases; no retries.
  });
});

test('busy admission gives Retry-After without consuming quota or performing equity/provider work', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => environment({ AI_MAX_CONCURRENT_REQUESTS: '1' }, async () => {
    const held = await createRedisConcurrencyLimiter()(new AbortController().signal, 1); let providers = 0;
    const response = await handleAnalyzeRequest(request(), async () => { providers++; return result; });
    assert.equal(response.status, 429); assert.equal((await response.json()).error, 'ai_busy'); assert.equal(response.headers.get('Retry-After'), '75');
    assert.equal(providers, 0); assert.equal(backend.daily.size, 0); await held.release();
  }));
});

for (const outcome of ['success', 'provider-error', 'malformed', 'timeout', 'whole-timeout', 'cancel', 'quota-error', 'math-error']) test(`handler releases its slot after ${outcome} without refunding admissions`, async () => {
  const backend = redisBackend(), controller = new AbortController();
  await withRedis(backend, async () => {
    const context = outcome === 'math-error' ? fixture({ equity: known(0) }) : fixture();
    let providers = 0, quotas = 0;
    const provider = async () => {
      providers++;
      if (outcome === 'provider-error') throw new AnalysisServiceError('provider_error');
      if (outcome === 'malformed') return {};
      if (outcome === 'cancel') setTimeout(() => controller.abort(), 5);
      if (outcome === 'timeout' || outcome === 'whole-timeout' || outcome === 'cancel') return new Promise(() => {});
      return result;
    };
    const response = await handleAnalyzeRequest(request(context, controller.signal), provider, async () => { quotas++; return { status: outcome === 'quota-error' ? 'unavailable' : 'allowed' }; }, outcome === 'whole-timeout' ? { requestMs: 100, providerMs: 500 } : { requestMs: 500, providerMs: 20 });
    assert.equal(response.status, { success: 200, 'provider-error': 502, malformed: 502, timeout: 504, 'whole-timeout': 504, cancel: 400, 'quota-error': 503, 'math-error': 400 }[outcome]);
    assert.equal(backend.active.size, 0); assert.equal(quotas, outcome === 'math-error' ? 0 : 1);
    assert.equal(providers, ['quota-error', 'math-error'].includes(outcome) ? 0 : 1);
    assert.equal(backend.calls.filter(a => a[1] === RELEASE_AI_SLOT_SCRIPT).length, 1);
  });
});

test('switch is checked again immediately before the provider, with lease cleanup', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    let providers = 0;
    const response = await handleAnalyzeRequest(request(), async () => { providers++; return result; }, async () => { process.env.AI_ANALYSIS_DISABLED = 'true'; return { status: 'allowed' }; });
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'ai_disabled');
    assert.equal(providers, 0); assert.equal(backend.active.size, 0);
  });
});

test('100/day and 5/IP quotas stay unchanged with concurrency integrated', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    let providers = 0;
    const provider = async () => { providers++; return result; };
    for (let i = 0; i < 100; i++) assert.equal((await handleAnalyzeRequest(request(fixture(), undefined, `203.0.113.${Math.floor(i / 5) + 1}`), provider)).status, 200);
    const blocked = await handleAnalyzeRequest(request(fixture(), undefined, '203.0.113.99'), provider);
    assert.equal(blocked.status, 429); assert.equal((await blocked.json()).error, 'daily_limit_reached');
    assert.equal(providers, 100); assert.equal([...backend.daily.values()][0], 100); assert.equal(backend.active.size, 0);
    const ipBlocked = await handleAnalyzeRequest(request(fixture(), undefined, '203.0.113.1'), provider);
    assert.equal((await ipBlocked.json()).error, 'ip_daily_limit_reached'); assert.equal([...backend.daily.values()][0], 100);
  });
});

test('configured output cap reaches OpenAI while model, schema and store:false remain unchanged', async () => {
  await environment({ OPENAI_API_KEY: 'synthetic-test-only-key', AI_MAX_OUTPUT_TOKENS: '18000' }, async () => {
    const original = global.fetch; let body;
    global.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(result) })); };
    try { await requestOpenAIAnalysis({ system: 'Synthetic', user: 'Synthetic' }, new AbortController().signal); }
    finally { global.fetch = original; }
    assert.equal(body.max_output_tokens, 18000); assert.equal(body.store, false); assert.equal(body.reasoning.effort, 'low'); assert.equal(body.text.format.strict, true);
  });
});

for (const key of ['errorAIDisabled', 'errorAILimitsConfiguration', 'errorAIBusy', 'errorAIConcurrencyUnavailable']) test(`${key} has clear Polish and English messages`, () => {
  const pl = translate('pl', key), en = translate('en', key); assert.ok(pl.length > 20 && en.length > 20); assert.notEqual(pl, en);
});

test('slot cleanup has a bounded independent deadline even when Redis never replies', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    const slot = await createRedisConcurrencyLimiter()(new AbortController().signal, 1);
    const original = global.fetch; let releaseCalls = 0;
    global.fetch = async (_url, options) => {
      if (JSON.parse(options.body)[1] === RELEASE_AI_SLOT_SCRIPT) { releaseCalls++; return new Promise(() => {}); }
      return original(_url, options);
    };
    const started = performance.now();
    try { await slot.release(); } finally { global.fetch = original; }
    assert.ok(performance.now() - started >= 900 && performance.now() - started < 2000);
    assert.equal(releaseCalls, 1); assert.equal(backend.active.size, 1);
  });
});

test('late injected admission after request timeout is released without quota/provider work', async () => {
  let releaseCalls = 0, quotas = 0, providers = 0;
  const concurrency = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { status: 'allowed', release: async () => { releaseCalls++; } };
  };
  const response = await handleAnalyzeRequest(request(), async () => { providers++; }, async () => { quotas++; return { status: 'allowed' }; }, { requestMs: 20 }, concurrency, async () => ({ status: 'allowed' }));
  assert.equal(response.status, 504);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(releaseCalls, 1); assert.equal(quotas, 0); assert.equal(providers, 0);
});

for (const reply of [null, [0], [0, 1], [1, 999], { result: 'invalid' }]) test(`malformed concurrency response ${JSON.stringify(reply)} never admits provider work`, async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    const original = global.fetch;
    global.fetch = async (url, options) => JSON.parse(options.body)[1] === ACQUIRE_AI_SLOT_SCRIPT ? new Response(JSON.stringify({ result: reply })) : original(url, options);
    assert.equal((await createRedisConcurrencyLimiter()(new AbortController().signal, 3)).status, 'unavailable');
    assert.equal(backend.active.size, 0);
  });
});

test('three active providers reject a delayed fourth handler from an independent instance', async () => {
  const backend = redisBackend();
  await withRedis(backend, async () => {
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    let active = 0, peak = 0, started = 0, ready, finish;
    const readyPromise = new Promise(resolve => { ready = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    const provider = async () => { active++; peak = Math.max(peak, active); if (++started === 3) ready(); await gate; active--; return result; };
    const pending = controllers.map((controller, i) => {
      const limiter = createRedisConcurrencyLimiter();
      // A later request may reach Redis only after the first three providers start.
      const concurrency = async (signal, maximum) => {
        if (i === 3) {
          await awaitWithSignal(signal, () => readyPromise);
          await new Promise(resolve => setImmediate(resolve));
        }
        return limiter(signal, maximum);
      };
      return handleAnalyzeRequest(request(fixture(), controller.signal, `203.0.113.${i + 1}`), provider, undefined, {}, concurrency);
    });
    let timer;
    try {
      // Keep the three providers blocked until the fourth request actually rejects.
      const [, rejected] = await Promise.race([
        Promise.all([readyPromise, Promise.race(pending)]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent admission decisions did not complete')), 2000); }),
      ]);
      assert.equal(rejected.status, 429); assert.equal((await rejected.json()).error, 'ai_busy');
      assert.equal(peak, 3); assert.equal(backend.peak, 3); assert.equal(backend.active.size, 3); assert.equal([...backend.daily.values()][0], 3);
      finish();
      const responses = await Promise.all(pending);
      assert.equal(responses.filter(r => r.status === 200).length, 3); assert.equal(responses.filter(r => r.status === 429).length, 1);
      assert.equal(backend.active.size, 0); assert.equal(started, 3);
    } finally { clearTimeout(timer); controllers.forEach(c => c.abort()); finish(); await Promise.allSettled(pending); }
  });
});

for (const ip of [undefined, '203.0.113.10, 192.0.2.1', 'invalid', '203.0.113.10:443']) test(`real handler rejects untrusted IP before quota/provider: ${ip}`, async () => {
  const backend = redisBackend(); let providerCalls = 0;
  await withRedis(backend, async () => {
    const req = request();
    if (ip === undefined) req.headers.delete('x-vercel-forwarded-for'); else req.headers.set('x-vercel-forwarded-for', ip);
    req.headers.set('x-forwarded-for', '203.0.113.10');
    const response = await handleAnalyzeRequest(req, async () => { providerCalls++; return result; });
    assert.equal(response.status, 503);
  });
  assert.equal(providerCalls, 0); assert.equal(backend.ip.size, 0); assert.equal(backend.daily.size, 0);
  assert.equal(backend.calls.filter(args => args[1] === ATOMIC_RATE_LIMIT_SCRIPT).length, 0);
  assert.equal(backend.active.size, 0);
});

for (const invalid of ['json', 'incomplete', 'deterministic', 'equity']) test(`invalid ${invalid} spends attempts but no analysis admission`, async () => {
  const backend = redisBackend(); let providers = 0;
  await withRedis(backend, async () => {
    let req;
    if (invalid === 'json') req = new Request('https://example.test/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.10' }, body: '{' });
    else {
      const context = invalid === 'equity' ? fixture({ equity: known(0) }) : fixture();
      if (invalid === 'incomplete') delete context.hero;
      if (invalid === 'deterministic') context.pot.currentPotBb += 1;
      req = request(context);
    }
    assert.equal((await handleAnalyzeRequest(req, async () => { providers++; return result; })).status, 400);
  });
  assert.equal([...backend.attemptGlobal.values()][0], 1); assert.equal(backend.daily.size, 0);
  assert.equal(backend.ip.size, 0); assert.equal(providers, 0); assert.equal(backend.active.size, 0);
});

test('invalid equity flood hits attempt ceiling without reducing five valid analysis admissions', async () => {
  const backend = redisBackend(); let providers = 0;
  await withRedis(backend, async () => {
    const provider = async () => { providers++; return result; };
    for (let i = 0; i < 15; i++) assert.equal((await handleAnalyzeRequest(request(fixture({ equity: known(0) })), provider)).status, 400);
    assert.equal(backend.daily.size, 0);
    for (let i = 0; i < 5; i++) assert.equal((await handleAnalyzeRequest(request(), provider)).status, 200);
    const calls = backend.calls.length;
    assert.equal((await handleAnalyzeRequest(request(fixture({ equity: known(0) })), provider)).status, 429);
    assert.equal(backend.calls.length, calls + 1); // only attempt EVAL; no lease/math/admission
  });
  assert.equal(providers, 5); assert.equal([...backend.daily.values()][0], 5); assert.equal([...backend.attemptGlobal.values()][0], 20);
});

for (const outcome of ['provider-error', 'malformed', 'cancel']) test(`real analysis admission is retained after ${outcome}`, async () => {
  const backend = redisBackend(), controller = new AbortController(); let providers = 0;
  await withRedis(backend, async () => {
    const response = await handleAnalyzeRequest(request(fixture(), controller.signal), async () => {
      providers++;
      if (outcome === 'provider-error') throw new AnalysisServiceError('provider_error');
      if (outcome === 'malformed') return {};
      controller.abort(); return new Promise(() => {});
    });
    assert.equal(response.status, outcome === 'cancel' ? 400 : 502);
  });
  assert.equal(providers, 1); assert.equal([...backend.daily.values()][0], 1); assert.equal([...backend.ip.values()][0], 1); assert.equal(backend.active.size, 0);
});

test('cancellation during equity verification never admits analysis or starts provider', async () => {
  const backend = redisBackend(), controller = new AbortController(); let providers = 0;
  await withRedis(backend, async () => {
    const concurrency = async (signal, maximum) => {
      const slot = await createRedisConcurrencyLimiter()(signal, maximum);
      setTimeout(() => controller.abort(), 0); // exact equity yields before work
      return slot;
    };
    const response = await handleAnalyzeRequest(request(fixture(), controller.signal), async () => { providers++; return result; }, undefined, {}, concurrency);
    assert.equal(response.status, 400);
  });
  assert.equal(providers, 0); assert.equal(backend.daily.size, 0); assert.equal(backend.active.size, 0);
});

for (const commit of [false, true]) test(`lost analysis admission response, committed=${commit}, fails closed without refunds/retries`, async () => {
  const backend = redisBackend(), controller = new AbortController(); let providers = 0, admissions = 0;
  await withRedis(backend, async () => {
    global.fetch = async (url, options) => {
      const args = JSON.parse(options.body);
      if (args[1] === ATOMIC_DAILY_ANALYSIS_SCRIPT) {
        admissions++;
        if (commit) await backend.fetch(url, options);
        setTimeout(() => controller.abort(), 0);
        return new Promise(() => {});
      }
      return backend.fetch(url, options);
    };
    assert.equal((await handleAnalyzeRequest(request(fixture(), controller.signal), async () => { providers++; return result; })).status, 400);
  });
  assert.equal(providers, 0); assert.equal(admissions, 1); assert.equal([...backend.daily.values()][0] ?? 0, commit ? 1 : 0); assert.equal(backend.active.size, 0);
});

test('Redis analysis-admission outage after valid math never invokes provider or refunds attempts', async () => {
  const backend = redisBackend(); let providers = 0;
  await withRedis(backend, async () => {
    global.fetch = async (url, options) => {
      const args = JSON.parse(options.body);
      if (args[1] === ATOMIC_DAILY_ANALYSIS_SCRIPT) throw new Error('synthetic admission outage');
      return backend.fetch(url, options);
    };
    assert.equal((await handleAnalyzeRequest(request(), async () => { providers++; return result; })).status, 503);
  });
  assert.equal(providers, 0); assert.equal(backend.daily.size, 0); assert.equal([...backend.attemptGlobal.values()][0], 1); assert.equal(backend.active.size, 0);
});

for (const cancel of [false, true]) test(`body ${cancel ? 'client cancellation' : 'timeout'} spends attempt only`, async () => {
  const backend = redisBackend(), controller = new AbortController(); let providers = 0;
  await withRedis(backend, async () => {
    const req = request(fixture(), controller.signal);
    Object.defineProperty(req, 'body', { value: new ReadableStream({ pull() { if (cancel) setTimeout(() => controller.abort(), 5); return new Promise(() => {}); } }) });
    const response = await handleAnalyzeRequest(req, async () => { providers++; return result; }, undefined, { bodyMs: 20 });
    assert.equal(response.status, cancel ? 400 : 408);
  });
  assert.equal([...backend.attemptGlobal.values()][0], 1); assert.equal(backend.daily.size, 0); assert.equal(backend.active.size, 0); assert.equal(providers, 0);
  assert.equal(backend.calls.length, 1);
});

test('global attempt ceiling blocks body reading, concurrency acquisition and provider before any analysis admission', async () => {
  const backend = redisBackend(); let reads = 0, providers = 0;
  await withRedis(backend, async () => {
    const window = Math.floor(Date.now() / 600000);
    backend.attemptGlobal.set(`poker-analyze:attempt:global:v1:${window}`, 1000);
    const req = request(); Object.defineProperty(req, 'body', { get() { reads++; throw new Error('must not read'); } });
    const response = await handleAnalyzeRequest(req, async () => { providers++; return result; });
    assert.equal(response.status, 429); assert.equal((await response.json()).error, 'rate_limited');
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
  });
  assert.equal(reads, 0); assert.equal(providers, 0); assert.equal(backend.daily.size, 0); assert.equal(backend.calls.length, 1);
});

test('aborted request before attempt admission performs no Redis/provider work', async () => {
  const backend = redisBackend(), controller = new AbortController(); controller.abort(); let providers = 0;
  await withRedis(backend, async () => assert.equal((await handleAnalyzeRequest(request(fixture(), controller.signal), async () => { providers++; return result; })).status, 400));
  assert.equal(backend.calls.length, 0); assert.equal(providers, 0);
});

test('concurrent malformed requests cannot race past attempt admission or spend analysis quota', async () => {
  const backend = redisBackend(); let providers = 0;
  await withRedis(backend, async () => {
    const responses = await Promise.all(Array.from({ length: 30 }, () => {
      const req = new Request('https://example.test/api/analyze', { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.10' }, body: '{' });
      return handleAnalyzeRequest(req, async () => { providers++; return result; });
    }));
    assert.equal(responses.filter(r => r.status === 400).length, 20);
    assert.equal(responses.filter(r => r.status === 429).length, 10);
  });
  assert.equal([...backend.attemptGlobal.values()][0], 20); assert.equal(backend.daily.size, 0); assert.equal(providers, 0); assert.equal(backend.active.size, 0);
});

test('independent full handlers racing for final daily admission start exactly one provider', async () => {
  const backend = redisBackend(); let providers = 0;
  await withRedis(backend, async () => {
    backend.daily.set('poker-analyze:daily:global:v2', 99);
    backend.days.set('poker-analyze:daily:global:v2', Math.floor(Date.now() / 86400000));
    const responses = await Promise.all([1, 2].map(i => handleAnalyzeRequest(request(fixture(), undefined, `203.0.113.${i}`), async () => { providers++; return result; }, undefined, {}, createRedisConcurrencyLimiter())));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    const rejected = responses.find(r => r.status === 429); assert.ok(rejected);
    assert.equal((await rejected.json()).error, 'daily_limit_reached');
  });
  assert.equal(providers, 1); assert.equal([...backend.daily.values()][0], 100); assert.equal(backend.active.size, 0);
});
