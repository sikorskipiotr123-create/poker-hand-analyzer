const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};

const { GET } = require('../app/api/diagnostics/redis/route.ts');
const { NextRequest } = require('next/server');
const { middleware, config } = require('../middleware.ts');

const testSecret = 'test-only-deployment-secret-with-at-least-32-characters';
const basicHeader = 'Basic ' + Buffer.from('access:' + testSecret).toString('base64');
const request = (authorization) => new NextRequest('https://preview.example.test/api/diagnostics/redis', {
  headers: { ...(authorization ? { authorization } : {}), 'x-vercel-forwarded-for': '203.0.113.9' },
});

async function withEnvironment(changes, run) {
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { await run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('Redis diagnostic endpoint is protected by the existing Basic Auth middleware', async () => {
  const original = process.env.DEPLOYMENT_ACCESS_SECRET;
  process.env.DEPLOYMENT_ACCESS_SECRET = testSecret;
  try {
    const denied = await middleware(request());
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /^Basic realm=/);
    const allowed = await middleware(request(basicHeader));
    assert.equal(allowed.headers.get('x-middleware-next'), '1');
    assert.match(config.matcher[0], /_next\/static/);
    assert.equal(config.matcher.length, 1);
  } finally {
    if (original === undefined) delete process.env.DEPLOYMENT_ACCESS_SECRET;
    else process.env.DEPLOYMENT_ACCESS_SECRET = original;
  }
});

test('diagnostic route is unavailable outside production and always disables caching', async () => {
  await withEnvironment({ NODE_ENV: 'test' }, async () => {
    const response = await GET(new Request('https://example.test/api/diagnostics/redis'));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private, max-age=0');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('expires'), '0');
    assert.deepEqual(await response.json(), { status: 'FAIL', failures: ['diagnostic_unavailable_outside_production'] });
  });
});

test('production diagnostic response exposes no config, IP, or raw Redis data', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    return new Response(JSON.stringify({ result: command[0] === 'PING' ? 'PONG' : 1 }), { status: 200 });
  };
  try {
    await withEnvironment({
      NODE_ENV: 'production',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'test-only-token',
    }, async () => {
      const response = await GET(new Request('https://example.test/api/diagnostics/redis', { headers: { 'x-real-ip': '198.51.100.8' } }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private, max-age=0');
      const body = await response.text();
      assert.deepEqual(JSON.parse(body), {
        status: 'PASS',
        checks: { redisPing: { status: 'PASS' }, readOnlyLuaEval: { status: 'PASS' }, clientIpHeaderPresent: 'PASS' },
        failures: [],
      });
      for (const privateValue of ['redis.example.test', 'test-only-token', '198.51.100.8', 'PONG']) assert.equal(body.includes(privateValue), false);
    });
  } finally { global.fetch = originalFetch; }
});

test('diagnostic endpoint identifies missing client-IP header without disclosing request metadata', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    return new Response(JSON.stringify({ result: command[0] === 'PING' ? 'PONG' : 1 }), { status: 200 });
  };
  try {
    await withEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, async () => {
      const result = await GET(new Request('https://example.test/api/diagnostics/redis'));
      assert.equal(result.status, 503);
      assert.deepEqual(await result.json(), {
        status: 'FAIL',
        checks: { redisPing: { status: 'PASS' }, readOnlyLuaEval: { status: 'PASS' }, clientIpHeaderPresent: 'FAIL' },
        failures: ['missing_client_ip'],
      });
    });
  } finally { global.fetch = originalFetch; }
});

test('diagnostic endpoint categorizes Lua permission failure without exposing provider details', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    if (command[0] === 'PING') return new Response(JSON.stringify({ result: 'PONG' }), { status: 200 });
    return new Response('', { status: 403 });
  };
  try {
    await withEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-only-token' }, async () => {
      const result = await GET(new Request('https://example.test/api/diagnostics/redis', { headers: { 'x-real-ip': '192.0.2.1' } }));
      assert.equal(result.status, 503);
      assert.deepEqual(await result.json(), {
        status: 'FAIL',
        checks: { redisPing: { status: 'PASS' }, readOnlyLuaEval: { status: 'FAIL', category: 'redis_http_401_403' }, clientIpHeaderPresent: 'PASS' },
        failures: ['redis_http_401_403'],
      });
    });
  } finally { global.fetch = originalFetch; }
});
