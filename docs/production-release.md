# Production release — 29 October 2026

The full application was deployed to https://poker-hand-analyzer-seven.vercel.app. The owner confirmed that the interface and a real AI analysis worked. The release includes previously local validation, trusted IP handling, UTC-day AI admission limits (5 per IP and 100 globally), concurrency control, cancellation and fail-closed Redis handling. Earlier validation notes describe their respective historical snapshots.

## Persistent Vercel configuration

Project: `poker-hand-analyzer`, team: `poker-hand-analyzers`. Production tracks `main` and automatically assigns the primary domain after a successful deployment. The following non-secret values are stored for Production, rather than depending on one deployment's command-line overrides:

- `APPLICATION_ACCESS_MODE=public`
- `AI_ANALYSIS_DISABLED=false`
- `AI_CLIENT_IP_POLICY=vercel`
- `OPENAI_MODEL=gpt-5.6-terra`

The existing Production secrets `OPENAI_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` and `DEPLOYMENT_ACCESS_SECRET` stay in Vercel. Do not commit or print their values. Preview environments do not receive these Production secrets. `.env.example` is a template and does not configure Vercel.

To stop future AI admissions, set `AI_ANALYSIS_DISABLED=true` for Production and deploy a new version; this does not terminate provider requests already in flight or change older immutable deployments.

## Security dependency update

The initial pull-request dependency audit detected GHSA-2464-fhr4-w9xw and GHSA-p3m5-59mp-jv5r in Next.js 15.5.27. Next.js and its ESLint configuration are pinned to 15.5.28, the patched 15.x release. The lockfile was regenerated without lifecycle scripts. The updated production dependency audit reports zero vulnerabilities.

Sources: https://github.com/advisories/GHSA-2464-fhr4-w9xw and https://github.com/advisories/GHSA-p3m5-59mp-jv5r.
