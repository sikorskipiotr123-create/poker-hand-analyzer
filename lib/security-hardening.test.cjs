const test = require('node:test');
const assert = require('node:assert/strict');
const { TEST_ACCESS_SECRET, AUTHORIZATION } = require('./test-support/deployment-auth.cjs');
const { fixture, known } = require('./test-support/analysis-fixture.cjs');
const { handleAnalyzeRequest } = require('./test-support/analyze-handler.cjs');
const { checkDeploymentAccess } = require('./deployment-access.ts');
const { documentSecurityHeaders, BASE_SECURITY_HEADERS, BASE_CSP, API_SECURITY_HEADERS } = require('./security-headers.ts');
const { middleware } = require('../middleware.ts');
const { NextRequest } = require('next/server');
const { translate } = require('./i18n.ts');
const nextConfig = require('../next.config.ts').default;
const basic = value => 'Basic ' + Buffer.from(value).toString('base64');
const request = headers => new Request('https://poker.example.test/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(fixture({ equity: known(1) })) });
function assertHeaders(response) {
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, name);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('cache-control'), /no-store/);
}

for (const [name, headers] of [
  ['missing authorization', {}],
  ['wrong password', { authorization: basic('access:wrong') }],
  ['wrong username', { authorization: basic('admin:' + TEST_ACCESS_SECRET) }],
  ['Bearer token', { authorization: 'Bearer synthetic-token' }],
  ['invalid base64', { authorization: 'Basic !!!' }],
  ['invalid UTF-8', { authorization: 'Basic /w==' }],
  ['missing separator', { authorization: basic(TEST_ACCESS_SECRET) }],
  ['combined credentials', { authorization: AUTHORIZATION + ', ' + AUTHORIZATION }],
  ['oversized header', { authorization: 'Basic ' + 'A'.repeat(8192) }],
  ['spoofed middleware/proxy flags', { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware', 'x-authenticated': 'true', 'x-forwarded-user': 'access', 'x-deployment-access': 'public' }],
  ['cross-site with no credentials', { origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' }],
]) test(`direct paid handler rejects ${name} without reading body, consuming quota or invoking provider`, async () => {
  let bodies = 0, quotas = 0, providers = 0;
  const req = request(headers);
  Object.defineProperty(req, 'body', { get() { bodies++; throw new Error('body must not be touched'); } });
  const response = await handleAnalyzeRequest(req, async () => { providers++; }, async () => { quotas++; return { status: 'allowed' }; });
  assert.equal(response.status, 401); assertHeaders(response);
  assert.equal((await response.json()).error, 'deployment_access_required');
  assert.match(response.headers.get('www-authenticate'), /^Basic realm=/);
  assert.deepEqual([bodies, quotas, providers], [0, 0, 0]);
});

for (const secret of [undefined, '', 'short', ' ' + TEST_ACCESS_SECRET, TEST_ACCESS_SECRET + ' ']) test(`missing/invalid private configuration fails closed (${secret === undefined ? 'absent' : secret.length + ' characters'})`, async () => {
  const previous = process.env.DEPLOYMENT_ACCESS_SECRET;
  if (secret === undefined) delete process.env.DEPLOYMENT_ACCESS_SECRET; else process.env.DEPLOYMENT_ACCESS_SECRET = secret;
  let calls = 0;
  try {
    const response = await handleAnalyzeRequest(request({ authorization: AUTHORIZATION }), async () => { calls++; }, async () => { calls++; });
    assert.equal(response.status, 503); assertHeaders(response);
    assert.equal((await response.json()).error, 'deployment_access_unavailable');
    assert.equal(response.headers.has('www-authenticate'), false); assert.equal(calls, 0);
  } finally { process.env.DEPLOYMENT_ACCESS_SECRET = previous; }
});

test('authorized direct handler reaches verified prompt and normal provider error handling', async () => {
  let quotas = 0, providers = 0;
  const response = await handleAnalyzeRequest(request({ authorization: AUTHORIZATION }), async prompt => { providers++; assert.match(prompt.user, /"value": 1/); throw new Error('synthetic provider failure'); }, async () => { quotas++; return { status: 'allowed' }; });
  assert.equal(response.status, 502); assertHeaders(response); assert.deepEqual([quotas, providers], [1, 1]);
});

test('auth comparison retains UTF-8 and colon-containing secret support', async () => {
  const secret = 'test-only:' + 'zażółć-gęślą-jaźń:'.repeat(3);
  assert.equal(await checkDeploymentAccess(basic('access:' + secret), secret), 'authorized');
  assert.equal(await checkDeploymentAccess(basic('access:' + secret + 'x'), secret), 'unauthorized');
});

for (const [name, headers, status] of [
  ['JSON check', { 'content-type': 'text/plain' }, 415],
  ['Origin check', { origin: 'https://untrusted.example' }, 403],
  ['Fetch Metadata check', { 'sec-fetch-site': 'cross-site' }, 403],
]) test(`valid authentication never bypasses ${name}`, async () => {
  let calls = 0;
  const response = await handleAnalyzeRequest(request({ authorization: AUTHORIZATION, ...headers }), async () => { calls++; }, async () => { calls++; });
  assert.equal(response.status, status); assertHeaders(response); assert.equal(calls, 0);
});

test('quota and unavailable responses retain security headers and unchanged limiter semantics', async () => {
  for (const decision of [{ status: 'limited', scope: 'ip', retryAfterSeconds: 600 }, { status: 'limited', scope: 'global', retryAfterSeconds: 86400 }, { status: 'unavailable' }]) {
    const response = await handleAnalyzeRequest(request({ authorization: AUTHORIZATION }), async () => assert.fail('provider must not run'), async () => decision);
    assert.equal(response.status, decision.status === 'limited' ? 429 : 503); assertHeaders(response);
    if (decision.status === 'limited') assert.equal(response.headers.get('retry-after'), String(decision.retryAfterSeconds));
  }
});

test('document CSP is nonce-based and production policy excludes inline scripts, eval and broad sources', () => {
  const nonce = 'YWJjZGVmZ2hpamtsbW5vcA==';
  const headers = documentSecurityHeaders(nonce, false);
  const csp = headers['Content-Security-Policy'];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' 'nonce-YWJjZGVmZ2hpamtsbW5vcA==' 'strict-dynamic'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.doesNotMatch(csp.match(/script-src [^;]+/)[0], /unsafe-inline|unsafe-eval|https:|\*/);
  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts.googleapis.com/);
  assert.match(csp, /font-src 'self' https:\/\/fonts.gstatic.com/);
  assert.match(csp, /connect-src 'self';/);
  assert.doesNotMatch(csp, /ws:|wss:/);
  assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.throws(() => documentSecurityHeaders("bad'; script-src *"), /Invalid CSP nonce/);
});

test('development-only CSP supports Next HMR without weakening production', () => {
  const nonce = 'YWJjZGVmZ2hpamtsbW5vcA==';
  assert.match(documentSecurityHeaders(nonce, true)['Content-Security-Policy'], /'unsafe-eval'/);
  assert.match(documentSecurityHeaders(nonce, true)['Content-Security-Policy'], /ws: wss:/);
  assert.doesNotMatch(documentSecurityHeaders(nonce, false)['Content-Security-Policy'], /unsafe-eval|ws:/);
});

test('middleware nonces are fresh and caller CSP/nonce headers cannot choose script authority', async () => {
  const req = () => new NextRequest('https://poker.example.test/', { headers: { authorization: AUTHORIZATION, 'x-nonce': 'attacker', 'content-security-policy': "script-src 'nonce-attacker'", 'content-security-policy-report-only': 'default-src *' } });
  const first = await middleware(req()), second = await middleware(req());
  assertHeaders(first); assertHeaders(second);
  const firstCsp = first.headers.get('content-security-policy');
  assert.notEqual(firstCsp, second.headers.get('content-security-policy'));
  assert.equal(first.headers.get('x-middleware-request-content-security-policy'), firstCsp);
  assert.equal(first.headers.has('x-middleware-request-x-nonce'), false);
  assert.equal(first.headers.has('x-middleware-request-content-security-policy-report-only'), false);
  assert.doesNotMatch(firstCsp, /attacker/);
  assert.equal(first.headers.get('x-middleware-next'), '1');
});

test('middleware success and denial both carry protections on page/API responses', async () => {
  for (const path of ['/', '/api/analyze']) for (const authorized of [false, true]) {
    const response = await middleware(new NextRequest('https://poker.example.test' + path, { headers: authorized ? { authorization: AUTHORIZATION } : {} }));
    assertHeaders(response);
    assert.equal(response.status, authorized ? 200 : 401);
    if (path.startsWith('/api')) assert.equal(response.headers.get('content-security-policy'), API_SECURITY_HEADERS['Content-Security-Policy']);
  }
});

test('Next global headers also cover assets excluded from authentication middleware', async () => {
  const rules = await nextConfig.headers(); assert.equal(rules[0].source, '/:path*');
  const headers = Object.fromEntries(rules[0].headers.map(({ key, value }) => [key, value]));
  for (const [key, value] of Object.entries(BASE_SECURITY_HEADERS)) assert.equal(headers[key], value);
  assert.equal(headers['Content-Security-Policy'], BASE_CSP);
});

test('new access errors remain localized in Polish and English', () => {
  for (const key of ['errorDeploymentAccess', 'errorDeploymentUnavailable']) {
    assert.notEqual(translate('pl', key), translate('en', key));
    assert.notEqual(translate('pl', key), key); assert.notEqual(translate('en', key), key);
  }
});
