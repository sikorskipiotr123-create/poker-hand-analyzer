const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};

const { NextRequest } = require('next/server');
const { middleware, config } = require('../middleware.ts');

const testSecret = 'test-only-deployment-secret-with-at-least-32-characters';
const basicHeader = (username, password) => 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
const request = (pathname, authorization) => new NextRequest('https://preview.example.test' + pathname, {
  headers: authorization ? { authorization } : undefined,
});

async function withDeploymentSecret(secret, run) {
  const previous = process.env.DEPLOYMENT_ACCESS_SECRET;
  if (secret === undefined) delete process.env.DEPLOYMENT_ACCESS_SECRET;
  else process.env.DEPLOYMENT_ACCESS_SECRET = secret;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.DEPLOYMENT_ACCESS_SECRET;
    else process.env.DEPLOYMENT_ACCESS_SECRET = previous;
  }
}

test('unauthorized UI requests receive a Basic Auth challenge and never reach Next routing', async () => {
  await withDeploymentSecret(testSecret, async () => {
    const response = await middleware(request('/'));
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic realm=/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.has('x-middleware-next'), false);
  });
});

test('unauthorized API requests are rejected before an API route or rate limiter can run', async () => {
  await withDeploymentSecret(testSecret, async () => {
    for (const pathname of ['/api/analyze', '/api/diagnostics/redis']) {
      const response = await middleware(request(pathname, basicHeader('access', 'wrong-password')));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'deployment_access_required' });
      assert.equal(response.headers.has('x-middleware-next'), false);
    }
  });
});

test('authorized UI and API requests continue to Next routing', async () => {
  await withDeploymentSecret(testSecret, async () => {
    for (const pathname of ['/', '/api/analyze', '/api/diagnostics/redis']) {
      const response = await middleware(request(pathname, basicHeader('access', testSecret)));
      assert.equal(response.headers.get('x-middleware-next'), '1');
    }
  });
});

test('missing or weak deployment secret fails closed with 503', async () => {
  await withDeploymentSecret(undefined, async () => {
    const response = await middleware(request('/api/analyze'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'deployment_access_unavailable' });
  });
  await withDeploymentSecret('too-short', async () => {
    assert.equal((await middleware(request('/'))).status, 503);
  });
});

test('malformed and oversized authorization headers are rejected', async () => {
  await withDeploymentSecret(testSecret, async () => {
    assert.equal((await middleware(request('/', 'Bearer not-basic-auth'))).status, 401);
    assert.equal((await middleware(request('/', 'Basic ' + 'A'.repeat(9_000)))).status, 401);
  });
});

test('Next static assets required by the protected UI are excluded from middleware matching', () => {
  const matcher = config.matcher[0];
  assert.match(matcher, /_next\/static/);
  assert.match(matcher, /_next\/image/);
  assert.match(matcher, /favicon\.ico/);
});
