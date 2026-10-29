# Protected staging deployment plan — Task 13

Current source supports explicit public/private access mode with private as default. Existing deployed artifacts remain unchanged. See [public-release policy and daily quotas](public-launch.md); Basic requirements below apply to protected/private mode.


**Verdict: CONDITIONALLY READY for a protected, AI-disabled pilot. Full AI staging sign-off is pending.** This is a plan for review, not deployment authorization. No platform settings, credentials, production resources, application code or repository visibility were changed.

## Source review and boundaries

The current local tree includes Tasks 1–5 and 7–12. HEAD is still `abad973`; deploying that commit alone would omit uncommitted hardening. Record a source snapshot hash manifest and deployment ID; do not label the new artifact as merely `abad973`.

There is no tracked `vercel.json`, no package Node `engines` pin and no runtime mock-provider flag. The API exports Node runtime and `maxDuration=65`; Next 15.5.27 is locked. Root documents render dynamically with nonce CSP/no-store. Both middleware and handler require the same Basic configuration. Middleware excludes some static routes: Basic alone does not make all assets private.

Remote Vercel configuration, plan entitlements, Git deployment hooks, domains, protection exceptions, runtime markers, Redis bindings and OpenAI project access were **not inspected**. Do not infer any are already correct. Production remains untouched.

## Recommended isolation and manual setup

Use a **new, separate Vercel project**, with Preview deployments only, dedicated staging Upstash Redis, and an isolated OpenAI project/credential for the later paid smoke test. Do not import/clone production environment variables, shared environment groups, marketplace resource bindings or production project links. A Redis key prefix alone is insufficient: analysis and concurrency keys are fixed/shared. Verify staging resource ownership in the consoles without printing values. Never point a staging integration at production Redis.

1. After separate approval, create the empty staging project without a Git integration (CLI project creation is possible without deploying). Set Next.js framework, root to the app root, **Node 22.x**, install `npm ci`, build `npm run build`, and framework-managed output. Verify the account supports the existing 65-second Node route duration. Do not override `NODE_ENV`. [Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [project creation](https://vercel.com/docs/cli/project).
2. Before first deployment, configure **Vercel Authentication + All Deployments** under the new project's Settings → Deployment Protection. Confirm coverage of deployment URLs, aliases and static assets; remove staging exceptions/share links/unneeded bypasses. Give only designated testers access. Do not change team defaults or production settings. [Protection scopes](https://vercel.com/docs/deployment-protection).
3. Create a separate Upstash database and scope its integration/variables to **this staging project's Preview environment only**. Preserve production bindings. Enable the existing script commands: EVAL, MGET, INCR, EXPIRE, EXPIREAT, TIME, ZREMRANGEBYSCORE, ZCARD, ZRANGE, ZADD, PEXPIRE, ZREM and DEL. All staging instances share this database; no independent per-instance DBs. No browser Redis credential.
4. Enter the server variables below in that project's Preview scope. Verify the dashboard shows no inherited production secrets/resource groups. Leave its Production scope unconfigured; never promote this pilot. Platform authentication supplements, never replaces, both Basic gates.
5. GitHub: no connection/push is needed for an explicitly approved local CLI Preview later. Keep the repository private. If Git integration is introduced later, use a reviewed non-main staging branch in the staging project; inspect auto-deploy/production-branch settings first. Current GitHub CI runs on main pushes/PRs, not arbitrary branch pushes. Do not add deployment tokens or secret-bearing workflows for this pilot.

## Preview environment checklist

All operator-managed values below belong **only to the new staging project's Preview scope**. Do not download production environment files, copy values into Git or use `NEXT_PUBLIC_` prefixes. Provisioning new staging-only credentials is a future manual step, not performed here; existing production credentials must not be reused/rotated by this plan.

| Variable | Staging value / requirement |
| --- | --- |
| `APPLICATION_ACCESS_MODE` | `private` for existing protected workflow; only test explicit public mode in a separate protected Preview. |
| `DEPLOYMENT_ACCESS_SECRET` | Staging-only random secret, at least 32 characters, no surrounding whitespace; Basic username `access`. Both gates use this one value. |
| `AI_CLIENT_IP_POLICY` | Exactly `vercel`; direct managed Vercel ingress, no external proxy/Trusted Proxy assumptions. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Matching HTTPS endpoint/token for the dedicated staging database. |
| `OPENAI_API_KEY` | Omit initially. Later configure a dedicated staging OpenAI project credential for separately approved paid checks. |
| `OPENAI_MODEL` | Explicit `gpt-5.6-terra`, matching current code. Confirm staging account access and compatibility with Responses, strict Structured Outputs and `reasoning.effort=low` before paid checks; do not substitute a model silently. [Model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-terra). |
| `AI_ANALYSIS_DISABLED` | Exactly `true` for first pilot; `false` only for the approved testing phase. Malformed values fail closed. |
| `AI_MAX_OUTPUT_TOKENS` | `16000` (server bounds 8192–25000); retain current cap, including reasoning tokens. |
| `AI_MAX_CONCURRENT_REQUESTS` | `3` (server bounds 1–10); preserve normal configuration while testing. |
| `AI_TRUSTED_ORIGINS` | Omit for direct same-origin Preview. Only add exact controlled origins if a reviewed URL mismatch requires it; no wildcard or permissive CORS. |
| `VERCEL` / `VERCEL_ENV` | Platform-generated: `1` / `preview`. Enable Automatically expose System Environment Variables; verify runtime presence without exposing secrets. Never fabricate these markers. [System variables](https://vercel.com/docs/environment-variables/system-environment-variables). |

Timeouts are code constants, not new environment variables: whole request **60 s**, body **10 s**, provider **60 s within the whole deadline**, Redis operation **2 s**, lease cleanup **1 s**, concurrency lease **75 s**, platform route **65 s**. Browser timeout is 70 s. Do not extend the route/provider lifetime past the lease.

**Cancellation blocker:** Vercel cancellation is opt-in and this tree has no opt-in configuration. Before cancellation sign-off, separately review a staging-only snapshot `vercel.json` using the documented functions configuration (candidate key `app/api/analyze/route.ts`, `supportsCancellation: true`), verify the Vercel build accepts/applies that Next route mapping, then test actual disconnect propagation. No configuration file was added in Task 13. [Cancellation reference](https://vercel.com/docs/functions/functions-api-reference), [function configuration](https://vercel.com/docs/project-configuration/vercel-json).

## Deployment sequence — execute only after approval

1. Establish the project/protection/resources above before uploading. Record the separate staging project ID and owner; independently confirm it differs from production.
2. Prepare a clean local source snapshot including all current uncommitted source/docs and lockfile. Exclude every real `.env*` file, `.git`, `.vercel`, node_modules, build outputs, logs and private test artifacts; `.env.example` contains placeholders only. Do not deploy from an existing production-linked checkout or use `git archive HEAD` that drops local changes. Save a non-secret file-hash manifest outside the upload.
3. Explicitly link **that snapshot directory** to the new staging project/team. Inspect only its project identity to confirm the target; do not run `env pull`. Stop on any production project link or automatic production-resource attachment.
4. Later approved deployment command: `vercel deploy --cwd <clean-staging-snapshot> --scope <staging-team> --target=preview`. These are placeholders, not commands executed here. Never use `--prod`, promotion or production aliases. Review CLI options/target identity before execution. [CLI deployment targets](https://vercel.com/docs/cli/deploy).
5. Verify build/runtime Node, duration and Preview settings; record immutable deployment URL/ID/manifest. Confirm an unauthenticated external browser cannot access it **before distributing the URL**. If access is open, stop access immediately and correct protection rather than continuing tests.
6. Run Phase A, then complete the separate mock/harness and cancellation preparation before Phase B. Enable the approved limited paid Phase C only after those gates pass. Return to AI-disabled staging afterward. Every env change needs a new deployment and old enabled URLs remain a risk: retire/restrict old artifacts.

## Staging test checklist and evidence

Record deployment ID, synthetic case, status, elapsed time and counter/lease outcomes only. Never retain Authorization headers, raw IPs, hand content, Redis tokens or full provider payloads in artifacts.

**A — AI disabled, no paid calls**

- [ ] External unauthenticated browser blocked by Vercel; authenticated Vercel user without Basic gets 401 for pages/API. Wrong/missing Basic never reaches Redis/OpenAI. Verify the independent API gate with existing tests; live middleware interception alone cannot prove it.
- [ ] Correct Basic loads full-page UI in Polish/English; language preference, fonts, hydration, poker table/ranges/math and action editing work. No CSP console errors or permissive production `unsafe-eval`; fresh nonces on separate HTML responses, `frame-ancestors 'none'`, no-store and other security headers. Test a direct browser tab: framing is deliberately blocked.
- [ ] Normal raises/calls/checks/folds, short blind all-ins, unmatched-chip returns, completed all-ins, board transitions, ties and unknown equity work. Invalid minimum raise, skipped street/unresolved wager disables submission with localized messages.
- [ ] AI shutdown displays localized unavailable state; Mathematical Analysis remains usable. **Shutdown occurs before Redis, so this phase cannot prove quotas or scripts.**
- [ ] Inspect browser requests/source maps/bundles/errors/screenshots for secret/personal data without copying credentials. No hand-history database, analytics or tracking introduced. Language localStorage and Google Fonts remain documented external/browser boundaries; `store:false` is not a provider-wide zero-retention promise.

**B — real staging Redis, mock provider / isolated test harness required**

There is **no runtime mock-provider setting**. A missing key produces an error *after analysis admission*, and shutdown bypasses Redis; neither is a substitute. A separately reviewed staging-only harness can inject the existing handler/provider test seam while retaining all production gates. It must be isolated to the staging snapshot/project, protected, free of production bindings, and excluded from the eventual app artifact. Until prepared, full HTTP concurrency/provider failure testing is blocked. Standalone scripts importing the existing Redis limiter/lease functions can validate real EVALs safely but cannot prove Vercel HTTP identity or disconnect propagation. Record those limits distinctly.

- [ ] Execute actual atomic quota and ownership scripts; verify TTLs, expiry, malformed counters and race boundaries. Use real Redis TIME for lease assertions, not local fake time.
- [ ] Test actual server-visible normalized IPv4/IPv6 with absent/spoofed/duplicate/chained forwarding headers on deployment URLs. Spoofing must not choose buckets; malformed/missing platform identity fails closed. Do not create a public IP echo route. Follow [trusted-IP plan](trusted-client-ip.md).
- [ ] Malformed JSON/incomplete input/bad replay/fabricated river equity increments attempt counters only; zero analysis admissions/provider calls. Test 20/21 per-IP attempts, 1,000/1,001 global attempts, 5/6 validated per-IP and 100/101 UTC-day admissions, including parallel instances and last-slot races. [Exact semantics and TTLs](ai-quota-accounting.md).
- [ ] Three concurrent mock calls; fourth busy, no analysis charge. Release on success/error/timeout/cancellation, owner cannot release another slot, abandoned slot expires after 75 s. No unbounded retries/refunds. [Lease policy](ai-cost-controls.md).
- [ ] Slow/stalled/oversized upload, client disconnect before/after admission, 60-second deadline, provider timeout/error/incomplete response and Redis outage at each gate. Verify cancellations prevent later dispatch; ambiguous committed admissions stay charged. Verify release recovery without deleting an active owner's slot.
- [ ] Check transport deadlines independently. Previous local Next production testing had a stalled upload exceed 12 s before reaching the 10 s handler body deadline, due to middleware buffering. This is unresolved; require a verified upstream size/upload deadline or document the gap before AI/public sign-off. Cancellation opt-in alone does not fix it.

Do not run floods, counter seeding/deletion, TTL expiry, deliberate outages, malformed Redis state, lease interference or deadline/provider-failure experiments against production or shared Redis. Boundary testing should use a dedicated disposable test database and stub, not 100 paid requests. If manually seeding counters, positively identify the disposable database; never FLUSHDB or reset counters while any real request is active. Seed/delete only known staging test keys, then wait for leases/work to drain before reuse. No production quota refunds or secret rotation.

**C — real OpenAI, maximum two attempted provider dispatches**

- [ ] Obtain separate cost approval and confirm isolated OpenAI project/model access and billing controls in its dashboard. Alerts/budgets are not assumed hard spend caps. Restrict testers to one operator, isolate/drain all test leases, record initial counters and do not run automatic retries or background tests.
- [ ] Restore the reviewed real-provider snapshot, retain protection/Basic, staging Redis, cap 16000 and concurrency 3; deploy Preview with AI enabled only for this window. Confirm Phase A still passes.
- [ ] Make one complete synthetic English review and one Polish review sequentially. Check exact river math/unknown equity presentation, all applicable streets, schema acceptance, localization, safe usage counters, latency and two charged admissions. Maximum 32,000 generated tokens for two capped dispatches, plus input costs; no exact currency-cost guarantee. An uncertain reply/error counts toward the two-call budget; **stop, do not retry**. Never test live provider cancellation with extra paid calls.
- [ ] Return to `AI_ANALYSIS_DISABLED=true` in a fresh protected Preview; retire/restrict old AI-enabled URLs. Verify new requests cannot dispatch and math remains functional. Do not change production or call this public-launch approval.

## Rollback and blockers

Before each phase, retain the protected **AI-off deployment ID** as the known-good staging fallback. Stop test clients; restrict access to the failed/AI-enabled staging artifact immediately. Revert only the staging alias (if one exists) to the known-good protected Preview or redeploy its reviewed AI-off snapshot. Alias rollback does not disable immutable old URLs: remove or otherwise deny access to every enabled staging deployment. Verify those URLs directly. Environment changes do not stop already-running requests; wait for the 60-second work deadline plus cleanup/75-second lease recovery and check counter/lease state. Do not decrement admissions or flush Redis to force recovery. If this is the first pilot, remove access to the failed deployment and leave staging offline until corrected. Production needs no rollback because it was never targeted.

Outstanding gates: manual account/protection/resource isolation and 65 s duration verification; platform IP overwrite; cancellation opt-in/Next mapping; unresolved upstream body buffering; reviewed mock/harness for full failure tests; authorized two-call OpenAI test and model access/token adequacy. Real Redis Lua, live CSP injection/toolbar compatibility and billing/cancellation were not verified. Do not relax CSP merely to allow the preview toolbar: use direct tabs/disable toolbar injection on staging if necessary, retaining protection.

Local Task 12 evidence: 493 tests, lint, typecheck and production build passed on the isolated source copied back to this tree. Task 13 verifies source matching and documentation links/diff only; it does not rerun expensive checks for documentation-only changes. Re-run full CI/security audit before a later release if source/dependencies change or the audit becomes stale.
