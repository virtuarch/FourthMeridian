# 02 — Agent Ownership Matrix

Wave 1 · seven agents · disjoint file ownership. A path listed under one agent is **exclusively** that agent's for the wave. Anything not listed is read-only for everyone; a needed change outside the owned set is reported to the orchestrator.

## Shared-resource owners (one owner each)

| Resource | Owner | Why |
|---|---|---|
| `prisma/schema.prisma`, `prisma/migrations/**`, `prisma/seed.ts` | **C** | centralised migration ownership |
| `package.json`, `package-lock.json`, `.github/**`, `scripts/ci-local.ts`, `scripts/lib/ci-contract.ts`, `scripts/ci-local.test.ts`, `tsconfig.json`, `eslint.config.mjs`, `.nvmrc` | **F** | one dependency/CI authority |
| `lib/ai/**` (incl. `lib/ai/conversation/tools.ts`), `app/api/ai/**` | **D** (wave 1) → **H** (wave 2) | security + reliability fixes precede extraction |
| `lib/api.ts` (`getClientIp`, `withApiHandler`) | **A** | ARCH-003 + ARCH-004 |
| `lib/audit.ts` | **A** | email hashing helper |
| `lib/jobs/**`, `jobs/**` | **C** | dispatch lock, finaliser, budgets |
| `lib/alerts/**`, `lib/email/**`, `lib/platform/ops/**`, `lib/platform/email-health.ts`, `app/api/health/**` | **E** | observability |
| `lib/platform-settings.ts` | **A** | registration default |
| `STATUS.md`, `docs/audits/pre-beta-2026-10/remediation/0*.md`–`12-*.md` | **Orchestrator** | single authority |
| `docs/audits/pre-beta-2026-10/remediation/agent-reports/<letter>-*.md` | each agent | per-agent report |

## Wave 1

### A — Security & privacy (`remediation/a-security`, worktree `…-remediation/a`)
Findings: SEC-001, SEC-006, SEC-008, ARCH-003/CQ-004, ARCH-004/OPS-003, SEC-004, SEC-005, SEC-009, SEC-010, SEC-013, PRIV-002, UI-013, PRIV-011, PRIV-012 (notice + consent only), PRIV-010 (copy draft), PRIV-015, UI-004, UI-005, UI-022.
Owned paths: `lib/auth.ts`, `lib/auth/**`, `lib/session.ts`, `lib/session-cache.ts`, `lib/sessions.ts`, `proxy.ts`, `app/admin/**`, `app/(shell)/dashboard/layout.tsx`, `app/api/admin/**`, `app/api/auth/**`, `app/api/users/**`, `app/api/user/**`, `app/api/access-request/**`, `app/api/registration-policy/**`, `app/api/platform/growth-revenue/requests/**`, `app/api/platform/growth-revenue/invitations/**`, `app/api/spaces/[id]/permanent/**`, `app/api/spaces/[id]/invite/**`, `app/api/transactions/[id]/correct/**`, `lib/api.ts`, `lib/audit.ts`, `lib/rate-limit.ts`, `lib/platform-settings.ts`, `lib/registration-policy.ts`, `lib/export/**`, `lib/captcha.ts`, `lib/totp.ts`, `lib/monitoring/**`, `components/ai/AiDisclosure.tsx`, `components/marketing/**`, `content/marketing/legal-*.md`, `lib/security/**`.

### B — Financial integrity (`remediation/b-financial`, `…/b`)
Findings: FIN-001, FIN-002, FIN-003, FIN-005, FIN-009, FIN-011, FIN-013 (partial), FIN-015, FIN-004 (document + UTC boundaries if cheap).
Owned paths: `lib/forecast/**`, `lib/ai/forecast/**` (exception to D's `lib/ai/**` — B owns exactly `lib/ai/forecast/streams.ts` and `income-completeness.ts`; D does not touch them), `lib/transactions/**`, `lib/account-classifier.ts`, `lib/snapshots/backfill-core.ts`, `lib/liquidity/**`, `lib/money/**`, `lib/plaid/refresh.ts` (FIN-011 only), `lib/plaid/syncTransactions.ts` (FIN-009 only), `lib/ai/measures/baseline.ts` (FIN-001 CADENCE→MEASURED fall only, if needed; otherwise untouched).
Not owned: `lib/ai/conversation/tools.ts` — if FIN-001 needs a change there, report it.

### C — Idempotency, data reliability, jobs, schema (`remediation/c-idempotency`, `…/c`)
Findings: IDEMP-001, IDEMP-002, PRIV-001, DB-002/DB-011, SEC-007/OPS-007, IDEMP-003/OPS-005/OPS-006, IDEMP-004, IDEMP-005 (fence), IDEMP-006, IDEMP-007, IDEMP-008 (per-account catch), IDEMP-010, IDEMP-011, IDEMP-013, OPS-001/OPS-010, FIN-007, PRIV-003/DB-001 (retention jobs), PRIV-004 (null token), PRIV-012 (retention job + purge on deletion), DB-004, DB-006, DB-009, SEC-014, TEST-009.
Owned paths: `prisma/**`, `lib/account-deletion/**`, `jobs/**`, `lib/jobs/**`, `app/api/jobs/**`, `app/api/accounts/[id]/import/**`, `app/api/imports/**`, `lib/imports/**`, `lib/plaid/sync-lock.ts`, `lib/plaid/webhook-receiver.ts`, `lib/plaid/disconnect.ts`, `lib/plaid/exchangeToken.ts`, `lib/plaid/backgroundHistorySync.ts`, `lib/crypto/wallet-refresh.ts`, `lib/refresh/**`, `app/api/accounts/[id]/sync/**`, `app/api/spaces/[id]/members/**`, `app/api/spaces/[id]/invites/**`, `lib/notifications/cleanup.ts`, `lib/platform/customer/assign.ts`, `scripts/rls-*acceptance*.ts` fixtures only if a schema change requires it (coordinate with F — F owns `scripts/rls-acceptance.ts` logic additions).

### D — AI reliability & cost control (`remediation/d-ai-reliability`, `…/d`)
Findings: SEC-AI-003, IDEMP-009/OBS-005, SEC-AI-005, SEC-AI-002/SEC-AI-008 (reserve guidance), SEC-AI-004, SEC-AI-001 (if cheap), OBS-006 (the `lib/platform/ai/failures.ts` half).
Owned paths: `lib/ai/**` except `lib/ai/forecast/**` (B), `app/api/ai/**`, `app/api/brief/**`, `lib/platform/ai/**`.
Constraints: minimal, surgical edits to `lib/ai/conversation/tools.ts` (scrub only); no restructuring (H does that in wave 2). Preserve reservation/kill-switch semantics; the CI suite `rls:accept:allowance` must stay 15/15.

### E — Observability & operations (`remediation/e-observability`, `…/e`)
Findings: OBS-001, OBS-002, OBS-003, OPS-002, OBS-004, OBS-008, OBS-009, OBS-010, OBS-011, OBS-012, OBS-015, OPS-004, OPS-012, OPS-014, UI-010, UI-011, UI-021.
Owned paths: `lib/alerts/**`, `lib/email/**`, `lib/platform/ops/**`, `lib/platform/email-health.ts`, `lib/platform/scheduler/**`, `lib/platform/authorize.ts` (OBS-009 audit row only), `app/api/health/**`, `app/api/platform/platform-ops/**` (route-level only), `components/platform/widgets/Ops*Widget.tsx`, `components/platform/widgets/SecurityPostureWidget.tsx`, `lib/plaid/client.ts`, `lib/prices/**`, `lib/fx/**`, `docs/operations/background-jobs.md`, `docs/operations/monitoring*.md`.

### F — Release engineering & testing (`remediation/f-release-eng`, `…/f`)
Findings: SEC-002, TEST-005, TEST-001 (docs + ruleset JSON), TEST-003, TEST-002 (guard census), TEST-006 (smoke workflow + drift doc), TEST-007, TEST-008 (doc), TEST-012, TEST-013, TEST-014, DB-008 (name check), SEC-016, CQ-001 (uninstall after G's verification), branch strategy (owner decision 7), production cutover checklist, backup/restore procedure docs.
Owned paths: `package.json`, `package-lock.json`, `.github/**`, `scripts/ci-local.ts`, `scripts/lib/ci-contract.ts`, `scripts/ci-local.test.ts`, `scripts/run-tests.ts`, `scripts/rls-acceptance.ts`, `scripts/audit-registry.ts` + new `scripts/audit-*.ts` census scripts, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, `.claude/settings.local.json`, `docs/operations/branching*.md`, `docs/operations/production-cutover-*.md` (additive section only), `docs/operations/backup-restore*.md`, `docs/operations/release-checklist.md`.

### G — Product retirement & code hygiene (`remediation/g-hygiene`, `…/g`)
Findings: Credit retirement (UI-015), Growth product retirement (investigate first), Markets coming-soon (UI-014), CQ-002 orphans, dead lib modules, CQ-001 verification (report to F), ARCH-007/CQ-009 (after consumer verification), CQ-008, ARCH-012, PRIV-014 comments, ARCH-001/CQ-007 assessment + safe inline-check consolidation, CQ-006 assessment, schema-model assessment (doc only; no table drops).
Owned paths: `app/(shell)/dashboard/credit/**`, `app/api/credit/**`, `components/dashboard/FicoCard.tsx`, `components/dashboard/DebtClient.tsx` (credit removal only), `components/space/widgets/debt/CreditHealthInputs.tsx`, `components/space/workspaces/**`, `components/brief/{BriefModal,HeroRegionProvider,BriefLogo}.tsx`, `components/plaid/AccountRefreshButton.tsx`, `components/atlas/**`, `components/space/widgets/{TimelineWidget,AssetValueWidget,ProgressWidget}.tsx`, `components/ui/UserButton.tsx`, `components/dashboard/widgets/GlassModal.tsx`, `lib/ai/domain-manifest.ts`, `lib/ai/domain-relevance.ts`, `lib/ai/conversation/compaction.ts` (deletion only — coordinate: D must not import them), `lib/forecast/spending-baseline.ts` (deletion only; B does not touch it), `lib/hero-region.ts`, `lib/platform/capability-classification.ts`, `lib/forecast/obligation.ts`, `lib/debt.ts`, `lib/debt/interest-cost.ts`, `lib/debt-space-data.ts`, `app/api/plaid/sync/**`, `app/api/spaces/[id]/{investments,snapshots,transactions}/**` (after verification), `lib/space-nav.ts`, `lib/space/workspace-resources.ts`, `lib/platform/growth/**` (assessment; preserve), `components/platform/widgets/Growth*.tsx` (assessment; preserve unless product-only), `lib/plaid/investmentsConsent.ts` (comments), `app/api/plaid/link-token/**` (comments), `README.md`, `app/api/platform/README.md`, `app/api/jobs/dispatch/route.ts` (header comment only — C owns the code; G may not change code there), `lib/ai/provider.ts` header comment (no: D owns — report instead).

## Wave 2 (after integration 1)

| Agent | Scope | Owned paths |
|---|---|---|
| H — AI modularisation | CQ-011: characterisation tests, split `tools.ts` by domain, thin registry | `lib/ai/conversation/tools.ts` → `lib/ai/conversation/tools/**`, `scripts/ai-baseline/**` imports, `scripts/rls-ai-acceptance.ts` import path |
| I — UI hardening | UI-003, UI-006, UI-007, UI-001, UI-009, UI-012 (partial), UI-018 | `components/space/**`, `lib/space/use-space-data.ts`, `app/(shell)/dashboard/error.tsx`, `app/(shell)/dashboard/loading.tsx`, `app/(shell)/dashboard/platform/**/error.tsx`, `components/platform/widgets/**` (non-Ops) |
| J — Route/auth handler tests | TEST-004, TEST-002 seam tests | `app/api/auth/**` (handler extraction + tests), `app/api/user/totp/**`, `app/api/user/sessions/**`, `app/api/spaces/[id]/**/*.test.ts` |

## Collision log

No textual merge conflict occurred in any of the 10 merges. Cross-workstream SEMANTIC collisions were all caught by the integrated gate and fixed by the orchestrator (`04` §3, register NEW-001…005): incident-stage registry (B, C), AI evidence registry (B), RLS census vs RateLimit policy (F vs C), foreground case 50 vs role statement timeout (C), allowance pin vs turn deadline (D), cron-auth duplication (A vs C), health reader authority (E), palette/db-safety pins (orchestrator). Ownership exceptions taken by agents (flagged in their reports): A edited `site/` legal copy and `lib/marketing/request-access.ts`; G edited a few unowned test pins; I made a one-line guard in an Ops widget.
