# Security policy

## Scope

Security maintenance focuses on the latest reviewed `main` revision. Older snapshots and deployed revisions are not guaranteed to contain local fixes. No independent security certification or guaranteed response/fix deadline is claimed.

## Reporting a vulnerability

Do not publish exploit details, credentials, hand data or sensitive infrastructure information in public issues, discussions or pull requests. Use synthetic examples and redact secrets.

1. Open the repository's [Security → Advisories](https://github.com/sikorskipiotr123-create/poker-hand-analyzer/security/advisories) page.
2. **If “Report a vulnerability” is available**, use it to submit a private report. Include the affected commit/version, reproduction steps, expected/actual behavior, impact and a minimal synthetic proof of concept. Do not test paid APIs, brute-force credentials or access other people's data without explicit authorization.
3. If that button is absent, private vulnerability reporting has not been confirmed as available. Open a minimal issue asking the maintainer to arrange a confidential reporting channel, without disclosing vulnerability details. Wait for a private channel before sharing them. If the repository is inaccessible, no public issue channel is available; no fallback security email or confidential contact is currently published here.

Coordinate disclosure with the maintainer after a fix is reviewed and users can obtain it. If an exposed credential is discovered, report its location privately; do not copy the credential into the report or try using it. Maintainers should revoke/rotate affected credentials and assess history/deployments before publication.

## Maintainer setup

Private vulnerability reporting is **not verified as enabled**. GitHub documents it for public repositories. When the repository is public and the feature is available: open **Settings → Security and quality → Advanced Security → Private vulnerability reporting → Enable**, then verify that Security → Advisories shows the reporting button. Subscribe to security-alert notifications. This file does not enable the feature or change repository visibility.

See [manual GitHub configuration and CI boundaries](docs/github-security-maintenance.md). [GitHub's reporting configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) describe current eligibility and UI steps.
