# AI cost controls and concurrency

These controls are implemented in the current local source. They are not a claim about the live deployment. Mathematical Analysis stays available when AI is shut down; the existing private-deployment Basic gates still apply until their separate, reviewed public-launch transition.

## Configuration

All variables are server-only; never use `NEXT_PUBLIC_` names or send them in a hand payload.

| Variable | Unset default | Allowed values | Effect |
| --- | --- | --- | --- |
| `AI_ANALYSIS_DISABLED` | `false` | Exactly `true` or `false` | `true` rejects new AI requests with 503 before reading the body, mathematical work, Redis or OpenAI. Checked again before the provider, and by the provider adapter. |
| `AI_MAX_OUTPUT_TOKENS` | `16000` | Integer 8192–25000 | Total generated-token cap sent to the Responses API. |
| `AI_MAX_CONCURRENT_REQUESTS` | `3` | Integer 1–10 | Maximum shared active Redis leases across application instances. |
| `UPSTASH_REDIS_REST_URL` | No default | HTTPS REST endpoint | Existing shared Redis database, now also used for concurrency. |
| `UPSTASH_REDIS_REST_TOKEN` | No default | Existing read/write token | Requires EVAL and the commands listed below. Never log it. |

Blank, whitespace-padded, non-integer or out-of-range cost-control values fail closed with 503. Unset values use the defaults above. The existing `OPENAI_API_KEY` and `OPENAI_MODEL` remain unchanged, including the `gpt-5.6-terra` model fallback and low reasoning effort. No production variables were changed.

## Output-budget rationale and tradeoff

The previous cap was 25,000. The new default is **16,000**, a 36% reduction in the maximum generated tokens per call, with a configurable ceiling retaining the previous 25,000 maximum. The runtime schema permits roughly 21,000 prose characters across all fields at their maximum lengths, plus JSON overhead; those are rejection ceilings, not a target answer length. The prompt now requests approximately 600–900 words, concise coverage of every applicable street, and 3–6 takeaways. The cap leaves substantial reasoning headroom rather than cutting it to a small visible-text-only budget.

Available usage evidence is **synthetic regression data**, not production measurements: completed mocked responses report 800/1,200 output tokens; an intentionally incomplete mock reports 25,000 including 12,000 reasoning tokens. These fixtures do not establish real model usage percentiles or prove that 16,000 is sufficient for every hand, language or model. No paid requests or production logs were retrieved for calibration.

[OpenAI documents](https://developers.openai.com/api/docs/guides/reasoning) that `max_output_tokens` includes reasoning and visible output, and exhaustion produces an incomplete response. Existing incomplete-output rejection and sanitized usage diagnostics remain. There are no automatic provider retries or quota refunds. Before rollout, inspect safe `outputTokens`/`reasoningTokens` diagnostics and incomplete-output categories for representative Polish/English reviews; raise the server cap within the documented range if necessary. Avoid choosing the 8192 floor without that evidence.

For 100 admitted provider calls, the default allows at most 1.6 million generated tokens versus the prior 2.5 million, assuming the provider honors the cap. This excludes input tokens, is not a dollar budget or a guarantee about calendar-day billing, and does not prove model quality. Schema-maximal or reasoning-heavy responses may still exhaust the cap.

## Admission, ownership and recovery

The order is authentication/origin checks → shutdown/configuration check → **atomic attempt protection** → bounded body and deterministic validation → **concurrency lease** → bounded equity verification → shutdown recheck/prompt → atomic analysis admission → shutdown recheck → OpenAI → release. A saturated concurrency gate returns **429 `ai_busy`** with `Retry-After`, before quota admission. An attempt was counted; no analysis quota was consumed or refunded on that path. See [Task 12 quota semantics](ai-quota-accounting.md). Once quota admission occurs, subsequent errors, cancellation or shutdown do not refund it. Limits remain **5/IP per UTC day and 100 globally per UTC day**; daily accounting uses Redis TIME and two atomic hash counters.

The concurrency script uses Redis `TIME`, removes expired members from the sorted set `poker-analyze:openai:active:v1`, checks capacity, and adds a private random ownership token atomically via EVAL. Slots expire after **75 seconds**, longer than the 65-second platform function limit and the 60-second application deadline. The key itself also expires after abandoned traffic stops. No process-local capacity fallback, polling queue, heartbeat or retry loop exists; Redis unavailability fails closed in development as well as production.

One idempotent release attempt runs on success, provider/validation/quota errors, timeout and cancellation. Its separate **one-second cleanup deadline** is independent of the disconnected client. Release removes only its ownership token; an expired owner cannot delete a replacement slot. Lost admission responses trigger the same owned cleanup. If a release fails, the process is terminated, or cleanup races a late Redis commit, expiration recovers capacity conservatively. Immediate release cannot be guaranteed during an outage. The main work deadline remains 60 seconds; cleanup can add at most one second, retaining a four-second margin below the platform limit.

Leases briefly include quota/equity preparation, so capacity is conservative. Cancellation can stop application-side I/O but does not prove that upstream OpenAI generation or billing immediately stopped. TTL-based leases cannot provide a hard bound on upstream jobs that ignore cancellation or survive the application. Do not extend function/provider lifetimes beyond the lease without redesigning recovery.

Do not flush or evict the concurrency key while jobs are active. Redis state loss or failover that loses writes can forget live leases; the limiter cannot reconstruct upstream jobs from missing Redis state. Monitor the database and retain provider-side spending controls.

Redis stores only existing counters and short-lived random lease metadata, not cards, hands, users or hand histories. EVAL serialization provides the cross-instance boundary; all production regions must share the same writable Redis database. See [Redis EVAL](https://redis.io/docs/latest/commands/eval/), [Redis TIME](https://redis.io/docs/latest/commands/time/) and [Upstash EVAL](https://upstash.com/docs/redis/sdks/ts/commands/scripts/eval).

## Vercel operational setup and remaining risks

1. Configure the three server variables for the intended Vercel environment and redeploy through the normal reviewed workflow. For emergency shutdown set `AI_ANALYSIS_DISABLED=true`; malformed values also block AI. Environment updates do not instantly change already running deployments. Retire old deployments and verify the new deployment; this switch does not terminate in-flight jobs or replace provider/platform emergency controls.
2. Use one Redis database for every production instance/region. Use a separate database for previews/staging so their limits and leases do not contend with production. Permit EVAL, TIME, ZREMRANGEBYSCORE, ZCARD, ZRANGE, ZADD, PEXPIRE, ZREM and DEL in addition to the existing quota commands. Do not grant browser access to Redis. Verify real scripts against staging before release.
3. Check request-cancellation opt-in for the deployed analyze function (`supportsCancellation`) and disconnect behavior on Vercel. Check actual route duration and ingress upload limits. The local Next.js 15.5.27 middleware buffers incoming bodies **before** the handler: Task 9's HTTP stall test did not reach its 10-second body deadline. Concurrency limiting does not fix this pre-handler buffering or bound its memory/socket work.
4. Exercise parallel requests from separate function instances, lease ownership/expiry, Redis failure, cancellation, normal full PL/EN reviews, token exhaustion, busy retry messages, shutdown, both authentication gates and mathematical mode. Review safe usage/error metadata without adding hand logs or analytics. Drain old instances when changing concurrency configuration; mixed configurations during rollouts are not an instantaneous fleet-wide policy change.
5. Keep operational spending alerts and provider/platform spend controls. Distributed bots can exhaust all 100 admitted daily requests. Origin/CSP checks do not authenticate bots. Repeated busy requests, invalid-request floods and rejected quota attempts can still consume HTTP, CPU and Redis resources. An expired lease is recovery, not a cost refund. Shared NAT users can hit the IP quota.
6. Task 11 now requires an explicit Vercel policy and a single normalized platform `x-vercel-forwarded-for` identity; other IP headers are ignored. Verify header replacement and exclusive ingress using [the trusted-IP staging plan](trusted-client-ip.md). This does not authenticate identity outside a verified ingress. Use upstream abuse/upload controls without lowering the specified application quotas or adding accounts, tracking or persistent histories.

Local tests use synthetic credentials, simulated shared Redis and mocked OpenAI. They are not live Vercel/Redis/OpenAI verification. Documentation and `.env.example` describe setup; no deployment or production configuration change was made.

## Task 10 changed files

- `.env.example`
- `README.md`
- `app/ai-mode.tsx`
- `docs/ai-cost-controls.md`
- `lib/ai-analysis.test.cjs`
- `lib/ai-analysis.ts`
- `lib/ai-cost-controls.test.cjs`
- `lib/ai-cost-controls.ts`
- `lib/ai-form-validation.test.cjs`
- `lib/ai-provider.ts`
- `lib/analyze-concurrency.ts`
- `lib/analyze-handler.ts`
- `lib/analyze-rate-limit.ts`
- `lib/i18n.test.cjs`
- `lib/i18n.ts`
- `lib/request-deadlines.test.cjs`
- `lib/security-hardening.test.cjs`
- `lib/test-support/analyze-handler.cjs`
- `lib/verify-analysis-math.test.cjs`
