# GitHub CI and security maintenance

These files are prepared locally. They have not been committed/pushed, and no repository settings, visibility or deployment settings were changed. Workflows and Dependabot will only become active after an owner intentionally publishes the configuration to GitHub. Existing deployed revisions are not verified as containing Tasks 1–4.

## CI

`.github/workflows/ci.yml` runs pushes to `main` and pull requests targeting `main` on a disposable GitHub-hosted Ubuntu runner. The stable required check name is **Quality and production audit**. Node.js 22, lockfile-based npm caching, `npm ci`, all existing test/lint/typecheck/build scripts and a production audit run in one job. Superseded runs are cancelled; timeout is 15 minutes.

`npm audit --omit=dev --audit-level=high` fails on high/critical production findings. Low/moderate findings remain visible but do not fail this gate. Audit-service/network errors also fail CI; there is no silent bypass or automated fix. The audit uses npm's production dependency classification, including transitive dependencies. It does not certify runtime safety, detect leaked credentials or block development-only advisories. Monitor development dependencies too, since their code runs during install/build/CI. No forced upgrades or lockfile changes are introduced by this task.

Only official `actions/checkout` and `actions/setup-node` are used, pinned to verified full commit hashes with release comments. Their action runtime may use a different Node version internally; project commands use Node 22. Dependabot can propose updated pins. Review release provenance and minimum runner requirements when updating actions; GitHub-hosted runners are used, not self-hosted production machines.

Workflow token permissions are `contents: read`; checkout credential persistence is disabled. There are no deployment environments, custom tokens, application secrets, artifact uploads or deploy steps. npm caching stores the package-manager cache, not `node_modules`, environment files or build output. Do not add private credentials to cached paths. `pull_request_target` is deliberately absent.

PR source, npm lifecycle scripts and test/build commands execute untrusted code. Read-only tokens and absent deployment secrets limit exposure but do not sandbox a malicious PR beyond the hosted runner. Fork approval policies and review remain necessary. Never approve a changed workflow or dependency install blindly, enable write tokens/secrets for fork PRs, or reuse these jobs on privileged self-hosted runners. Review repository/global Actions secrets separately without copying their values; the workflow needs none.

## Dependabot

npm and GitHub Actions version checks run weekly on Monday at 08:00 Europe/Warsaw, with at most five open version-update PRs per ecosystem. Next.js and `eslint-config-next` minor/patch updates are grouped together; other npm minor/patch updates form a separate group. Action minor/patch updates are grouped. Major upgrades remain separate review items; grouping is not a guarantee of compatibility. No auto-merge is configured. Security alerts and security-update enablement are separate repository settings; version-update scheduling alone does not enable them or impose a weekly delay on enabled security fixes.

Known development-tool advisories from Task 1 still require compatibility-aware review. Do not apply overrides or `npm audit fix --force` just to obtain a green report.

## Manual repository configuration

An administrator must apply these steps; this task does not verify or change the current settings. Availability depends on visibility, plan and organization policies. UI labels can vary.

1. **Actions:** Settings → Actions → General. Ensure GitHub Actions is enabled. Under Actions permissions, allow the official `actions/checkout` and `actions/setup-node` actions (or the required GitHub-created actions). Under Workflow permissions select **Read repository contents and packages permissions**; leave **Allow GitHub Actions to create and approve pull requests** unchecked. For fork/outside-collaborator workflows choose approval for all outside collaborators where available. In fork PR settings, leave sending write tokens or secrets disabled. Keep this CI on GitHub-hosted runners. Inspect existing secrets without exposing values; do not add OpenAI, Redis or deployment Basic credentials for CI.
2. **First run:** After an owner intentionally commits/pushes the configuration, confirm Actions → CI succeeds on `main` and on a PR. GitHub requires a recent check run before it can be selected for branch protection. Verify workflow permissions and the log's Node major version.
3. **Protect main:** Settings → Branches → Add branch protection rule → branch pattern `main`. Enable **Require a pull request before merging** (one independent approval if another reviewer is available), **Require status checks to pass before merging**, select **Quality and production audit**, and enable **Require branches to be up to date before merging**. Enable conversation resolution and prevent bypasses where supported. Keep force pushes and branch deletion disabled. If private-repository protection is unavailable on the current plan, record that limitation; do not change visibility to work around it during this task. Requiring an independent approval in a single-maintainer repository can block all merges, so arrange a reviewer first.
4. **Dependency protection:** Settings → Security and quality → Advanced Security (older UI: Code security and analysis). Enable the dependency graph, Dependabot alerts and Dependabot security updates where available. Confirm entries under Security → Dependabot. Review PRs and CI; leave auto-merge disabled. Subscribe to security notifications.
5. **Secret protection:** On the same security settings page, enable secret scanning and push protection where the repository/plan supports them. Confirm the state under Security → Secret scanning. If unavailable while private, record this and review eligibility before a later public launch. Scanning does not cover every secret format, screenshots or every historic leak; it does not replace the existing manual audit or credential rotation.
6. **Private reports:** Follow SECURITY.md to enable Private vulnerability reporting when eligible, then verify the reporting button and notification delivery. It is not currently confirmed as enabled; no security email is invented. Do not disclose reproduction details publicly while arranging a reporting channel.
7. **Licensing:** No LICENSE is added. The owner must choose a license explicitly before one is introduced; public visibility by itself does not grant a general open-source license.

References: [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule), [security settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-security-and-analysis-settings-for-your-repository), [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference), [npm audit](https://docs.npmjs.com/cli/npm-audit/).

## Local verification

On Node 22.14.0/macOS arm64, a fresh `npm ci` using the preserved lockfile passed, followed by 309 tests, lint, typecheck and production build. `npm audit --omit=dev --audit-level=high` reported zero production vulnerabilities. actionlint 1.7.12 accepted the workflow, and both YAML files parsed with structural/security checks. All seven screenshot references still resolve. GitHub-hosted Linux execution and repository settings remain unverified until an owner publishes and runs the workflow.

Task 5 changes only `.github/workflows/ci.yml`, `.github/dependabot.yml`, `SECURITY.md`, `docs/github-security-maintenance.md` and `README.md`. Application behavior, dependencies, credentials, author metadata and history are unchanged.
