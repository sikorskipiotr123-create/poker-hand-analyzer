# Private-deployment defense in depth and public-launch transition

Current source supports explicit public/private access mode with private as default. Existing deployed artifacts remain unchanged. See [public-release policy and daily quotas](public-launch.md); Basic requirements below apply to protected/private mode.


## Paid API authentication

`handleAnalyzeRequest` independently calls the private-deployment policy in `lib/analyze-access.ts` before reading the body, doing mathematical work, consuming Redis quota or invoking the AI provider. Middleware still authenticates pages and the API. Both checks use the existing `DEPLOYMENT_ACCESS_SECRET`, the fixed username `access`, and `checkDeploymentAccess` with its SHA-256 digest/fixed-width comparison. No second password, credential database or user account system exists.

The digest comparison avoids early-exit character comparison of secrets; JavaScript is not a formal constant-time execution environment. Authorization parsing retains bounded header length and strict UTF-8/base64 handling. No credential values are logged or returned.

Missing, weak or whitespace-padded server configuration fails closed with HTTP 503. Missing/invalid authorization returns HTTP 401 with the existing Basic challenge. Both are no-store responses with security headers. Polish and English UI messages handle these API errors. Proxy headers, middleware-skip headers, `NODE_ENV`, request flags and a missing secret cannot opt out of authentication.

The dedicated `checkAnalyzeAccess` function is the intentional future replacement point. There is **no runtime public-mode switch** that can accidentally disable the private deployment gate.

Cross-origin checks, strict JSON, the 32 KiB body cap, server mathematical verification, the OpenAI provider deadline and shared Redis limits remain unchanged: **5 validated requests per IP per UTC day and 100 globally per UTC day**. Unauthorized requests never consume that quota. Authentication-failure throttling is a separate deployment concern; this change does not add or reduce application quotas.

## Headers and CSP

Every route receives a baseline from Next configuration, including assets excluded from middleware. Middleware also sets headers on authorized and denied responses; the API handler applies them directly, even when tested/called without middleware:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`
- `X-Frame-Options: DENY`
- CSP `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`

Documents additionally use `default-src 'self'`, a fresh 128-bit random script nonce and `strict-dynamic`. Script attributes are blocked. Production permits neither inline scripts without a nonce nor `unsafe-eval`. Next reads the nonce-bearing CSP from the internally forwarded request and attaches the nonce to its bootstrap scripts. Incoming CSP/report-only/nonce metadata is replaced or removed; callers do not choose the nonce.

The root layout uses `dynamic = 'force-dynamic'`. HTML is private/no-store: do not statically export, enable ISR/static page caching, or let a CDN cache nonce-bearing HTML. This adds server-rendering work per page request. Public static scripts/CSS keep their usual asset caching.

`style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` preserves React progress-bar style attributes and existing styling. Inline CSS is an explicit remaining relaxation, not permission for inline scripts. `font-src 'self' https://fonts.gstatic.com` permits the app's existing Google Fonts import. No new third-party host, tracking or analytics is added. Google Fonts remains an external dependency that receives browser requests; self-hosting fonts could eliminate it later.

Images permit self/data; browser connections permit self only. Frames, media and workers are disabled. OpenAI/Redis are server-side integrations and require no browser CSP allowance. In development only, script eval and WebSocket connections are enabled for Next HMR. Deploy production builds with `NODE_ENV=production`; do not serve `next dev` publicly.

API JSON and authentication-error responses use `default-src 'none'`. Global static-asset headers use the baseline policy; the nonce policy applies to HTML. CSP is an extra containment layer, not input sanitization or a guarantee against XSS. Older CSP implementations may not implement `strict-dynamic`; `'self'` is its compatibility fallback. Permissions-Policy support also varies by browser.

## Future public, account-free launch

Make a reviewed code change that replaces the private policy in `lib/analyze-access.ts` and removes the middleware Basic gate **while preserving nonce generation and all response headers**. Update authentication regression tests to assert the intended public policy. Merely deleting `DEPLOYMENT_ACCESS_SECRET` or changing repository visibility does not launch the app publicly: both gates continue to fail closed or require authorization.

Retain request-origin/Fetch Metadata checks, server mathematical verification, Redis fail-closed behavior, the exact existing quotas, body limits and provider timeouts. Verify the production ingress replaces untrusted forwarding headers before IP/origin decisions. No login, registration or persistent hand-history storage is required for this design.

Before intentionally opening paid analysis to anonymous clients, evaluate abuse/cost controls at the hosting/provider boundary. Origin/CSP controls do not authenticate bots. IP limits can affect shared NAT users and distributed clients can exhaust the global daily budget. Consider edge filtering, operational spend alerts and provider budget controls without reducing the specified API limits or adding tracking. A client-visible/shared browser token is not a secret and is not an adequate replacement for the private password.

## Remaining deployment risks and verification limits

- Basic credentials are reusable bearer-equivalent credentials. Require HTTPS at production ingress; HTTP localhost is only for testing. This change does not inspect or change TLS, HSTS, Vercel settings or real secrets.
- No authentication-attempt rate limiter was added; use hosting-layer protections if needed. Never use a short/shared-public password for the private deployment.
- Existing Task 1 dependency findings and Task 3 mathematical model/computation limits are not eliminated by headers or authentication.
- Live OpenAI, Redis and Vercel configurations were not exercised. No paid requests were made.
- Nonces require dynamic HTML; verify CDN behavior, future scripts/styles and any deployment-injected toolbar/analytics before adding them. Do not relax script CSP broadly to accommodate optional tooling.

## Verification performed

The final source passed the complete automated suite, lint, typecheck and production build in an isolated copy using the unchanged locked dependencies. Tests exercise direct-handler authentication bypass attempts and prove zero body reads, quota calls and provider calls for rejected authentication. Existing request security, math and rate-limit suites continue to run with synthetic valid credentials.

A local production server with synthetic Basic credentials and no OpenAI/Redis credentials passed 26 HTTP checks covering nonce-bearing HTML, fresh nonces, spoofed CSP rejection, API errors, challenges, 404 and public static JS/CSS headers. Browser checks confirmed hydration through PL/EN switching, demo-hand calculation and AI-form navigation, with no warnings/errors in the captured console. This is not cross-browser certification or a test of live deployment-injected scripts.

## Task 4 files changed

- `lib/verify-analysis-math.test.cjs`
- `README.md`
- `app/ai-mode.tsx`
- `app/layout.tsx`
- `lib/ai-analysis.test.cjs`
- `lib/analyze-handler.ts`
- `lib/i18n.test.cjs`
- `lib/i18n.ts`
- `middleware.ts`
- `next.config.ts`
- `lib/analyze-access.ts`
- `lib/security-headers.ts`
- `lib/security-hardening.test.cjs`
- `lib/test-support/deployment-auth.cjs`
- `docs/security-hardening.md`
