# Public-release source preparation

Implemented locally; not deployed. Existing production project, staging deployments and Desktop staging-upload folder were not changed. The old upload folder is a protected/private snapshot, not this updated release.

## Access policy

`APPLICATION_ACCESS_MODE` is server-only: unset or exactly `private` retains both Basic gates. Exactly `public` removes Basic from documents and `/api/analyze`; no accounts, login, payments or browser token are added. Blank/padded/case-variant/unknown values fail closed with 503. Never select the mode via a request, client flag, hosting environment or missing secret. Private mode still requires the existing `DEPLOYMENT_ACCESS_SECRET`; public mode does not require that secret. Public/private API security headers, nonce generation, dynamic rendering and no-store remain active. Client-side Mathematical Analysis is free and unlimited, including when AI is disabled or Redis unavailable.

No administrative/Redis/OpenAI credential endpoint is introduced. `/api/analyze` is intentionally public in public mode; absence of Basic is not unauthorized there. Cross-origin/suspicious/unsupported requests remain forbidden. Protected deployments still reject missing/wrong Basic before body/Redis/provider work. Secret environment files and server source modules are not public routes.

## Quota contract

Only validated AI admissions count, after shape/deterministic validation, concurrency admission, bounded equity verification and shutdown recheck. Limits are **5/IP/UTC day and 100 globally/UTC day** in both access modes. Exact checkable contradictions and malformed requests consume no daily analysis quota. Expensive/unverifiable equity remains explicitly unknown and does not certify client assertions; qualitative reviews remain allowed.

`ATOMIC_DAILY_ANALYSIS_SCRIPT` reads Redis TIME, computes `day=floor(seconds/86400)` and `reset=(day+1)*86400`, and atomically checks/increments two hashes:

- `poker-analyze:daily:ip:v2:<HMAC>`
- `poker-analyze:daily:global:v2`

Each stores `day` and `count`. An older stored day logically counts as zero; a future/malformed/partial state fails closed. Both hashes expire at next UTC midnight + 2 seconds; the grace is cleanup, not an extension of the allowance. Stable keys avoid an application clock/key selection race at midnight. A blocked operation changes neither counter. Additional Redis permissions: **HMGET/HSET**, with EVAL/TIME/EXPIREAT and existing attempt/concurrency commands. Schema is a hash, not the previous string counter; never reuse old keys for this script.

HTTP 429 uses `ip_daily_limit_reached` or `daily_limit_reached`, a PL/EN message stating the 00:00 UTC reset, Retry-After from Redis time, and ISO resetAt. Attempt throttling remains separate (`rate_limited`, 20/IP and 1,000 globally per fixed ten minutes). Local-only dev/test uses a bounded daily process bucket plus attempt bucket; it is not the distributed production policy. Every Vercel deployment uses fail-closed shared Redis and the existing explicit trusted-IP policy, irrespective of public/private mode.

Admission counts at Redis commit, not successful response. Provider errors, incomplete/malformed output, timeout, cancellation and ambiguous lost replies after commit remain charged. No quota refunds, automatic retries, success-only accounting or stored hand histories. Concurrent instances cannot exceed the daily counters under a healthy shared Redis. Changing credentials used as the HMAC key, Redis state loss/eviction or separate databases for the same public deployment can defeat continuity; stable configuration and shared state are operational requirements.

## Later staging deployment — separate authorization required

1. Preserve the existing staging deployment/project, production project and Desktop upload folder. Create a **new protected release-validation project/snapshot**, with a dedicated staging Redis and no production bindings. Use Preview scope and Vercel Authentication **All Deployments**. Application public mode does not disable platform protection. Review identity/access settings before any upload.
2. Prepare a fresh clean source snapshot of this updated tree (including uncommitted changes); exclude real env files, `.git`, `.vercel`, node_modules, `.next`, logs and caches. Keep lockfile, source, docs and placeholder example. Record manifest/project ID. Never deploy the old `abad973` HEAD alone or overwrite the existing Desktop staging folder.
3. Set Node **22.x**, Next.js framework, `npm ci`, `npm run build`, framework-managed output, and verify the 65 s route limit. Preview-only variables: `APPLICATION_ACCESS_MODE=public`, `AI_CLIENT_IP_POLICY=vercel`, dedicated `UPSTASH_REDIS_REST_URL/TOKEN`, `AI_ANALYSIS_DISABLED=true`, `AI_MAX_OUTPUT_TOKENS=16000`, `AI_MAX_CONCURRENT_REQUESTS=3`, explicit `OPENAI_MODEL=gpt-5.6-terra`; omit real OpenAI key initially. No Basic secret is needed for this application's public path. Enable exposed platform variables and verify `VERCEL=1`, `VERCEL_ENV=preview`; never fake them. Omit `AI_TRUSTED_ORIGINS` for direct same-origin Preview.
4. After separate approval, link only the fresh snapshot to the new release-validation project/team. Confirm target identity. Use `vercel deploy --cwd <new-clean-release-snapshot> --scope <team> --target=preview`. No --prod/promotion/production alias; do not reuse existing production links. These placeholders were not executed.
5. Verify external visitors are blocked by Vercel; approved testers reach pages/AI boundary without Basic. Test both languages, unlimited math, nonce/CSP/cache/secret-file rejection and AI-off messages. Separately test `private` and malformed access settings on new isolated Preview artifacts; they must reject unauthenticated access/fail closed. No changes to existing protected artifacts.
6. Prepare a separately reviewed staging-only provider harness for real Redis EVAL/quota/concurrency failure tests; runtime has no mock-provider environment option. Test five/six IP admissions across ten-minute boundaries, 100/101 global, parallel last-slot races, Redis-driven midnight/year rollover, malformed hashes, attempts, cancellation and ambiguous admissions. Use disposable staging state; never seed/reset/delete production keys or make 100 paid calls. Unit backend models are not live Lua verification.
7. Vercel cancellation is opt-in. Separately review `supportsCancellation:true` for the Next API route, verify accepted route mapping in the actual Vercel build and disconnect behavior. No vercel.json was added here. Body buffering before handler deadlines remains unresolved; verify upstream upload limits/deadlines. Existing work/body/provider/Redis deadlines 60/10/60/2 s, cleanup 1 s and lease 75 s are unchanged.
8. Only after separate paid-test approval, use a dedicated staging OpenAI project/key for at most two attempted sequential synthetic PL/EN reviews; confirm model/schema access, latency/token adequacy and daily admission. Stop on errors without retrying. Return to AI-disabled protected artifacts and retire old enabled URLs. No real OpenAI calls are part of local verification.

## Eventual public deployment and cutover

Requires another approval. To preserve current production, choose a separate public-release project and resource bindings. Set APPLICATION_ACCESS_MODE=public only there. The public production domain must not require Vercel login: Standard Protection leaves production domains public while protecting previews; use All Deployments on the separate staging project. Confirm actual scope/domain behavior externally. GitHub visibility is independent and is not changed by this plan. [Vercel protection scopes](https://vercel.com/docs/deployment-protection).

Old deployments use 5/IP/10-minute string counters; v2 daily hashes do not import those admissions. **Do not mix old and new AI-enabled serving versions or claim continuous quotas across both namespaces.** Preferred cutover: retire/block old AI-enabled paths and launch the new quota namespace at a planned UTC midnight after old requests/leases have drained. If continuity within a current day is required, an explicitly reviewed migration would be necessary; it is not implemented. Separate staging state does not establish continuity for a public database.

Keep a protected AI-disabled release artifact for rollback. Restrict/remove enabled immutable URLs, stop test clients and wait for work/leases to drain; alias/env changes alone do not disable old URLs or in-flight work. Do not decrement counts or flush Redis. A rollback to older quota code can reopen allowance; keep AI disabled until a reviewed consistent version is restored.

## Remaining risks

No-login bots may spoof browser headers or rotate IPs; origin checks are not bot authentication. NAT users share allowance. Attempt floods still incur HTTP/Redis/CPU costs, and distributed valid traffic can exhaust the global daily budget. Cooperative CPU bounds and lease recovery are not guarantees about upstream billing. CSP may need staging verification with injected platform scripts; do not weaken it to accommodate a toolbar. No live Redis, Vercel topology, cancellation, model access or paid usage verification occurred. The application remains a poker analysis aid, not a GTO solver.
