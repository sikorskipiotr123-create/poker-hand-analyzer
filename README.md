# Poker Hand Analyzer

Poker Hand Analyzer is a responsive Texas Hold’em analysis app for reviewing a hand, comparing ranges, and understanding the mathematical baseline for a decision. It separates deterministic poker calculations from optional AI-generated strategic commentary.

> **AI analysis is not a GTO solver.** It is a language-model interpretation of the context supplied by the user. Equity, pot odds, and EV come from the local poker engine and are not generated or changed by AI.

## Features

- Visual card selection with duplicate-card validation.
- **Mathematical Analysis** for known hands and selected ranges.
- A 13×13 starting-hand Range Matrix with pair, suited, and offsuit classes, presets, and card blockers.
- Exact enumeration when the legal outcome space is at or below 120,000 cases; otherwise a Monte Carlo estimate.
- Win, loss, tie, and equity results, plus the calculation method and number of evaluated cases or simulations.
- Pot odds, required equity, and call EV with the formulas shown in the interface.
- **AI Poker Analysis** with positions, opponent profiles, optional HUD statistics, independent Hero and Villain ranges, and action history. AI output is validated against a fixed structured schema.
- Starting and remaining stacks, effective stack, all-in handling, automatic street progression, and SPR.
- Polish and English interface and AI output.
- A demo hand for trying the main mathematical workflow.

## Mathematical Analysis and AI Poker Analysis

**Mathematical Analysis** uses cards, selected range combinations, and pot/call amounts. It does not use positions, player profiles, or AI output to change a calculation.

**AI Poker Analysis** provides strategic commentary from the supplied hand context: positions, ranges, action history, stacks, SPR, and opponent information. Auto ranges are qualitative assumptions, not probability distributions. Custom ranges are the user’s selected hand classes. The AI is not a solver, does not produce verified GTO frequencies, and cannot override engine facts.

Changing the interface language does not automatically submit an AI request. A new review is generated only after the user explicitly starts one.

## Poker calculations

### Hand evaluation and equity

The in-project evaluator ranks Hold’em hands from high card through straight flush, including kickers, ties, and the wheel straight (A-2-3-4-5). For known hands, the engine compares every legal remaining board runout while the full calculation remains within its exact-case limit.

The Range Matrix expands each class into physical combinations: a pair has 6 combinations, a suited hand 4, and an offsuit hand 12. Known Hero cards and board cards remove blocked combinations. Legal physical combinations receive equal weight; range classes are not equally weighted unless their combination counts happen to match.

When the exact-case limit would be exceeded, the browser runs a chunked Monte Carlo estimate. The default is 8,000 samples; the mathematical analysis controls expose additional sample counts. Cards are drawn without replacement after removing known cards. Results report Hero wins, Villain wins, ties, and Hero equity, where a tie contributes half a win.

### Pot odds and EV

- Final pot after calling = current pot + Villain’s contestable bet + Hero’s legal call.
- Required equity = call amount ÷ final pot after calling.
- EV(call) = equity × final pot after calling − call amount.

Positive EV supports a mathematical call, negative EV a fold, and values near zero are approximately break-even. The result is a math-only comparison and does not model future action, rake, or opponent behavior.

## Technology

- Next.js App Router
- React and TypeScript
- Tailwind CSS with project-specific styling
- Node.js API route and OpenAI Responses API with Structured Outputs
- Node’s built-in test runner
- No third-party poker-evaluation package; hand and equity logic is implemented in `lib/`

## Architecture

```text
app/
  api/analyze/route.ts       Server-only AI API route and execution limit
  ai-mode.tsx                AI analysis form and response presentation
  page.tsx                   Main application view
  range-matrix.tsx           Reusable starting-hand matrix
  globals.css                Application styling
  providers.tsx              Shared language/application state
lib/
  poker.ts                   Hand evaluation and known-hand equity
  range.ts                   Range combinations, blockers, and range equity
  calculations.ts            Pot odds and call EV
  action-state.ts            Action replay, stacks, all-ins, and SPR
  ai-analysis.ts             Request validation and prompt construction
  ai-provider.ts             Server-side Responses API adapter
  ai-response.ts             Structured response schema and validation
  analyze-handler.ts         API request handling and safe errors
  analyze-rate-limit.ts      Shared production/local development rate limiting
```

The browser never receives `OPENAI_API_KEY`. The AI route validates a request body of at most 32 KiB, validates the hand/action context, applies a usage limit, and uses a 60-second provider deadline. The Next.js route declares a 65-second maximum execution duration.

## Local setup

Requirements: Node.js 20 or later and npm.

```bash
npm install
cp .env.example .env.local
```

For local development, add an OpenAI API key to `.env.local` if you want to use AI analysis. Keep it server-side; do not use a `NEXT_PUBLIC_` prefix.

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Mathematical Analysis works without AI credentials.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | For AI analysis | Server-side credential for the OpenAI Responses API. Never commit it or expose it to browser code. |
| `OPENAI_MODEL` | No | Model name; defaults to `gpt-5.6-terra`. |
| `UPSTASH_REDIS_REST_URL` | In production for AI analysis | HTTPS REST endpoint for a shared Upstash Redis database used by the rate limiter. |
| `UPSTASH_REDIS_REST_TOKEN` | In production for AI analysis | Server-side Upstash credential. Keep it secret. |

In production, the AI endpoint fails closed with HTTP 503 if the shared rate limiter is missing, misconfigured, or unavailable. This prevents accidentally deploying an unprotected AI endpoint. Local development uses an in-memory per-process fallback; it is intended for development only.

## AI API protection and deployment requirements

`POST /api/analyze` is protected by the temporary deployment-wide HTTP Basic Auth gate and does not require a separate user account. In production it also enforces **5 valid analysis requests per client IP per 10-minute window** and **100 valid requests per UTC day globally** using atomic Redis counters shared between serverless instances. Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the production environment before enabling AI analysis. If Redis is unavailable, requests are rejected rather than sent to OpenAI.

An IP-based limit reduces accidental and basic automated abuse; it is not identity-based access control and can be bypassed with multiple IPs. Before operating a public app with a developer-owned OpenAI key, also configure a Vercel Firewall/WAF rate limit and OpenAI project usage limits/alerts. Add authentication or per-user quotas if the product needs stronger cost ownership. Do not treat the in-memory development limiter as production protection.

The API route uses the Next.js `maxDuration` setting of 65 seconds and aborts the OpenAI provider request after 60 seconds. Vercel must support the configured function duration for the selected plan. The API key, Upstash URL/token, and all other secrets belong only in server-side environment variables. No live AI request is required for tests or builds.

## Testing and checks

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Tests use Node’s built-in test runner and mock the AI provider. They cover hand rankings, deterministic equity cases, range combinations and blockers, action/stack calculations, validation, language handling, response schema, API errors, and rate limiting. The test suite does not make paid OpenAI calls.

## Screenshots

_Add screenshots here before publishing, for example:_

- Mathematical Analysis with a demo hand and result panel.
- Range Matrix with a selected range and blocker counts.
- AI Poker Analysis showing action history and a validated review.

## Known limitations

- AI reviews are contextual commentary, not solver output, guaranteed strategy, or guaranteed correct advice.
- Auto ranges are qualitative and do not have exact frequencies. Range equity is only calculated for explicit mathematical ranges or known cards.
- Range combinations are equally weighted physically; arbitrary per-combination frequencies are not supported.
- Monte Carlo output is an estimate and may vary between runs.
- The engine does not model rake, multiway pots, tournament ICM, future betting trees, or opponent-specific population data.
- Production rate limiting is IP-based. It should be combined with platform firewall controls and provider-side spend limits for a public deployment.
- At the release audit, `npm audit` reported one high-severity advisory affecting seven development-only lint/Tailwind transitive glob package entries; the current compatible package lines do not offer a patched fix. The production dependency audit reported no advisories. Re-run `npm audit` before release and plan a separately verified tooling upgrade.

## Vercel deployment

### Temporary deployment access gate

Before the first public Vercel deployment, set DEPLOYMENT_ACCESS_SECRET in Vercel Project Settings → Environment Variables for every environment that should be protected. Use a unique random value of at least 32 characters; for example, generate one locally with openssl rand -hex 32. Keep it server-side, never prefix it with NEXT_PUBLIC_, and do not commit the value. The repository's .env.example contains only an empty placeholder.

The temporary gate uses HTTP Basic Authentication at the Next.js middleware layer. Enter access as the username and the environment variable value as the password when the browser prompts. It protects page requests and all /api/* routes before they reach application handlers, so rejected requests cannot call OpenAI or consume the analysis limiter. Missing or too-short configuration fails closed with HTTP 503. Next.js static assets are excluded from the gate so CSS, scripts, and images load normally; do not place private data in public assets.

To remove this temporary protection later, remove middleware.ts, lib/deployment-access.ts, and lib/deployment-access.test.cjs, remove the DEPLOYMENT_ACCESS_SECRET placeholder and this subsection, then deploy that reviewed change. Removing only the environment variable leaves the middleware fail-closed and the site unavailable.

1. Push the project to a Git repository only after reviewing the repository and its full history for credentials.
2. Import it into Vercel as a Next.js application; use the detected `npm run build` command.
3. Set `OPENAI_API_KEY` and, optionally, `OPENAI_MODEL` in server-side Vercel Environment Variables.
4. Create an Upstash Redis database and configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the same production environment.
5. Configure Vercel Firewall/WAF request limits and OpenAI project spending alerts/limits before making the AI route publicly available.
6. Deploy only after the production environment variables and platform limits have been verified.

Do not commit `.env.local`, deploy credentials, or any real API key. `.env.example` contains only blank placeholders and the non-secret default model name.
