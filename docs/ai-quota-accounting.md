# AI attempts and analysis admission (Task 12 local source)

Implemented locally; not deployed or verified against live Vercel/Upstash. No quota refund operation, automatic retry or success-only accounting is introduced.

## Lifecycle and exact accounting

Previously deterministic/schema failures were free, but equity verification occurred after atomic per-IP/daily quota consumption. A mathematically contradictory river could spend a daily admission without a provider call. The new order is:

1. Whole-request deadline, existing Basic gate, media type/origin/Fetch Metadata checks and shutdown/configuration check.
2. **Cheap atomic attempt admission**, using Task 11 trusted normalized IP. This is before request-body reading, parsing, replay, equity or concurrency acquisition. Missing/untrusted identity or Redis failure returns 503. Attempts rejected by authentication/origin/shutdown do not reach this gate.
3. Existing bounded body reading, schema validation and deterministic replay. Malformed, incomplete and deterministic contradictions spend an attempt only.
4. Existing global concurrency lease, then bounded equity verification (1,000 cases / 250 ms cooperative budget / one job per process). Busy lease rejection and checkable equity contradictions spend an attempt only. A lease covers verification through provider completion; it still releases on every exit.
5. Shutdown recheck and server prompt construction, then **atomic validated-analysis admission**: **5 per normalized IP per UTC day and 100 globally per UTC day**, incremented together by the existing Lua script. Analysis-quota rejection increments neither analysis counter. This gate occurs only after all available mathematical verification has completed.
6. Shutdown/cancellation recheck, provider dispatch under whole-request/provider deadlines, response validation and lease release.

A daily analysis counts when step 5's Redis EVAL commits, **not** on response success. Invalid inputs rejected in steps 3–4 never reach it. There is no decrement/refund. A provider error, malformed/incomplete provider response, timeout, disconnected client, configuration error or shutdown discovered after commitment remains charged, even if dispatch is prevented. An admission's lost response is conservatively charged if Redis committed, while the application fails closed and makes no provider call. Redis/provider dispatch cannot be one atomic transaction: cancellation may land between them. Guaranteeing only successful or actually dispatched calls without durable transactional coordination would introduce unsafe ambiguity. Request retries are new attempts and may be new admissions; no deduplication of hands or persistent histories is added.

Unknown equity is allowed for qualitative reviews as before. Over-budget, busy, interrupted exact computation and Auto ranges produce explicitly unknown server facts; client numbers are discarded. “Fully validated” means all deterministic checks passed and the bounded verification policy was applied, not that unknown equity was proven exact. Detectable contradictions reject without analysis admission; assertions that cannot be verified within the budget are never promoted to facts. Cancellation is checked before analysis admission, including after equity yields.

## Cheap flood protection

Server constants allow **20 attempts/IP and 1,000 attempts globally per fixed ten-minute window**, distinct from the unchanged 5/100 analysis limits. Twenty permits correction/retry headroom while bounding repeated invalid hands; 1,000 bounds distributed verification demand per window while exceeding the entire daily analysis allowance tenfold. These are additional abuse controls, not reduced AI-analysis quotas. They are conservative initial operational choices, not traffic-calibrated guarantees. Both attempt counters are incremented together by atomic EVAL; rejection increments neither. No attempt refunds or retries occur on failures. The attempt gate cannot prevent pre-handler ingress/middleware buffering or network floods.

Users may see the existing localized `rate_limited` HTTP 429 with window-based `Retry-After` after repeated invalid, busy, stalled or failed submissions; global attempt exhaustion uses this code too, not the UTC-day error. Once attempts exhaust, even valid input must wait for the ten-minute reset. The AI analysis daily error remains `daily_limit_reached`. Correcting an invalid hand does not spend an analysis allowance until it is admitted. Both 429 controls can affect shared NAT users. No account, payment or hand-history storage is required.

## Redis keys and expiration

The original string-counter script remains for attempts. Validated analyses use a separate atomic Redis TIME/HMGET/HSET script with fixed server limits. Scripts are not request-controlled.

| Key | Counter | Expiration |
| --- | --- | --- |
| `poker-analyze:attempt:ip:v1:<HMAC>:<window>` | 20 attempts/IP | EXPIRE 602 seconds from first increment; old keys become inactive at window boundary. |
| `poker-analyze:attempt:global:v1:<window>` | 1,000 total attempts | EXPIREAT at the next fixed-window boundary + 2 seconds. |
| `poker-analyze:daily:ip:v2:<HMAC>` | Hash: UTC epoch day and 5 daily analysis admissions/IP | EXPIREAT next UTC midnight + 2 seconds; logical reset at midnight. |
| `poker-analyze:daily:global:v2` | Hash: UTC epoch day and 100 global admissions/day | EXPIREAT next UTC midnight + 2 seconds; logical reset at midnight. |

Window ID is floor(server Unix milliseconds / 600000). Attempt windows assume synchronized platform clocks. Daily admissions use Redis TIME inside the script, with stable keys and logical UTC-day rollover. HMAC is the existing Redis-token keyed digest of normalized address; no raw IP or hand data is stored. Attempts add up to two new counter keys and one EVAL per admitted/rejected HTTP attempt, before any analysis EVAL. Concurrency uses its existing lease key and ownership release. Daily accounting additionally requires HMGET/HSET; no paid API calls are needed.

Malformed counters, invalid results, transport failures and timeouts fail closed. Cancellation before an operation prevents it; cancellation or lost replies while EVAL is in flight cannot roll back a possible commit. There is no retry of ambiguous EVALs. Late responses cannot start later provider work. Quota scripts atomically check both counters before increments, preserving concurrency boundaries; concurrency leases never refund counters. Tests model a shared atomic Redis backend, not live Lua execution. Redis state loss/eviction/failover can lose limits as before; a healthy shared database and controlled rollouts remain operational assumptions.

## Operations and remaining verification

Use one shared production Redis database across instances/regions; isolate preview/staging databases. All serving deployments must contain this version to establish the new pre-verification gate. The daily v2 keys intentionally differ from the old window keys. Coordinate cutover as described in [public launch](public-launch.md); no automatic migration or retroactive refund is implemented. Drain old versions before relying on invalid-input exemption. Keep synchronized runtime clocks and monitor safe failure categories; do not add hand/IP/credential logs. Configurable trusted-ingress and existing shutdown/token/concurrency settings are unchanged.

On protected staging with a stub provider and isolated Redis, run real EVALs: malformed JSON/schema/action arithmetic, original fabricated 0% river equity, valid PL/EN hands, five/six per-IP and 100/101 daily boundaries, 20/21 and 1,000/1,001 attempts, window/midnight expiry, parallel instances, cancellation at body/verification/admission/provider, Redis errors and lost admission replies. Inspect counter increments and absence of provider calls for invalid input. Confirm Vercel header replacement, transport cancellation and upstream buffering independently. No live deployment or actual Upstash scripts were exercised locally.

Botnets/IP rotation can exhaust attempts and the 100 valid daily admissions; global attempt protection can itself deny legitimate traffic for the remaining window. Invalid-request and rejected-attempt floods still generate HTTP and Redis costs. Authentication/origin/CSP are not public bot authentication. Per-process synchronous math batches remain cooperatively bounded, not hard-preemptible. Unknown equity does not certify client assertions. Provider cancellation may not stop upstream billing. These controls bound admitted work under their trust assumptions, not all infrastructure spending.
