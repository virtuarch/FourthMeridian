# 02 — Architecture

Pre-beta audit of Fourth Meridian · branch `v2.6` · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · audit date 2026-10-21 · read-only.
Evidence labels: **IMPLEMENTED / PARTIALLY IMPLEMENTED / STUBBED / PLANNED / UNVERIFIED / NOT APPLICABLE**. Finding IDs `ARCH-nnn` are cross-referenced from `01-EXECUTIVE-SUMMARY.md`, `12-BETA-RELEASE-PLAN.md` and `13-EVIDENCE-INDEX.md`.

## 1. Verdict

The architecture that exists is the one the doctrine describes, and its strongest property is defence-in-depth tenant isolation: an application predicate on every route plus Postgres Row-Level Security on the paths that go through the tenant client. The weaknesses are accretion, not design: each program added a new authority beside the old one and retired the old one in a header comment rather than by deletion. The result is four Space-membership authorities (one off-RLS), three client-IP extractors with two header orders, four AuditLog write idioms, two operator consoles for two roles, four refresh entry points, one 4,768-line AI tool file, one 50-file import cycle, and 163 runtime files still reaching Postgres through the migration principal. None of this is a P0. Weighted architecture score: **6.7 / 10**.

Scope measured: 1,407 non-test source files, 275,955 lines (`lib/` ≈ 270k incl. subdirectories, `app/` 31k, `components/` 86k, `jobs/` 2k); 187 `route.ts` handlers; 70 Prisma models; 126 migrations; 744 test files.

## 2. Current architecture (reconstructed from code)

### 2.1 Layers — IMPLEMENTED, with leaks

```
Browser ──► proxy.ts (Edge middleware)
             ├─ /api/*            : browser-write Origin boundary ONLY (lib/security/write-origin.ts); no token read
             ├─ /dashboard,/admin : getToken JWT gate, role redirect, TOTP-enrolment surface pick
             └─ public paths      : redirect to the separate public site when NEXT_PUBLIC_SITE_URL is set
                 │
                 ▼
   app/api/**/route.ts (187)                     app/(shell) | app/admin | app/merchant-ops (Server Components)
     guards: lib/session.ts (requireUser,          guards: getServerSession + lib/space.ts getSpaceContext
             requireFreshUser, requireSystemAdmin,          lib/platform/authorize.ts | inline grant check
             requireFreshSystemAdmin, requireSpaceRole)
             lib/spaces/authorize.ts (requireSpaceAction)
             lib/platform/authorize.ts (requirePlatformAccess)
             CRON_SECRET bearer (6 job routes); Plaid webhook JWT (1)
                 │                                              │
                 ▼                                              ▼
   lib/** domain authorities  ◄────────────── components/** (311/312 files "use client"; 128 client fetch() sites)
     pure *.core.ts (49) + DB bindings that take a `client` parameter
                 │
                 ▼
   lib/db.ts → db (migration principal, BYPASSRLS) | withTenantDb → fm_app | authDb → fm_auth | systemDb → fm_system
                 │
                 ▼
   PostgreSQL (Supabase; RLS policies keyed on app.user_id set via set_config(..., true) inside a transaction)
```

Evidence: `proxy.ts:63-193` (matcher 180-193; the `/api` branch 78-95 only evaluates write origin); `lib/session.ts:195-330`, `:360-395`; `lib/spaces/authorize.ts:111`; `lib/platform/authorize.ts:116-136`; `lib/db.ts:30-37, 76-115`; `lib/db/tenant-context.ts:109-129`.

Layer leaks verified by import graph (2,214 files, 7,384 edges):
- `lib/` imports `components/` in 5 places (2 type-only; 3 runtime: `lib/space/use-active-envelope.ts:27`, `lib/space/use-space-navigation.ts:34`, `lib/space/use-platform-workspace-navigation.ts:37`). Ten `lib/` files import React; seven carry `"use client"`.
- `lib/` imports `jobs/`: `lib/jobs/registry.ts:131-166` (dynamic, by design) and `lib/money/server-context.ts` → `jobs/fetch-fx-rates.ts` (runtime).
- `components/` imports `app/api/**/route.ts` in 44 files, all `import type` — route files are the DTO authority, inverting dependency direction.
- Components never import `@/lib/db`, Prisma values or `server-only` (0/0/3, the 3 being test-support).

### 2.2 Server/client split — PARTIALLY IMPLEMENTED
Pages under `app/` are Server Components (26 of 67 `.tsx` are client) loading data through `getSpaceContext` + `withTenantDb` (`app/(shell)/dashboard/page.tsx:26-115`). Inside `components/`, 311 of 312 `.tsx` files are client; data arrives as serialised props or by client `fetch()`. Platform Spaces self-fetch by decision (`lib/platform/workspaces.ts` header): 97 widgets against 66 `app/api/platform/**` routes. No Server Actions exist (the single `"use server"` string is in a test).

### 2.3 Service boundaries and business-logic placement — IMPLEMENTED (house rule), PARTIALLY enforced
House pattern: pure authority in `*.core.ts` or a pure module, with the DB binding beside it taking a `client`/`tx` as first argument (`lib/db/tenant-context.ts:66-106`). Routes are mostly thin (41 use `withApiHandler`). Logic leaks into the large routes (`app/api/accounts/[id]/import/route.ts` 763 lines; `app/api/spaces/[id]/activity/route.ts` 588; `app/api/plaid/refresh/route.ts` 202; `app/api/plaid/sync/route.ts` 201) and into large client components (`components/dashboard/DebtClient.tsx` 1,251 lines / 29 `useState`; `SpacesClient.tsx` 1,129; `SpaceDashboard.tsx` 1,024).

### 2.4 API organisation — IMPLEMENTED
| Area | Routes | Guard pattern |
|---|---|---|
| `platform/platform-ops/*` | 41 | `requirePlatformAccess("PLATFORM_OPS", READ/WRITE/CONTROL)`; writes `requireFreshPlatformAccess` + `recordOperatorAction` |
| `platform/growth-revenue/*` | 15 | `requirePlatformAccess("GROWTH_REVENUE", …)` |
| `platform/customer-success/*` | 7 | `requirePlatformAccess("CUSTOMER_SUCCESS", …)` |
| `platform/security-ops/*` | 5 | `requirePlatformAccess("SECURITY_OPS", READ)` |
| `spaces/*` | 27 | `requireSpaceRole` / `requireSpaceAction` / inline membership (5) |
| `user/*` | 16 | `requireUser` / `requireFreshUser`; `email/confirm` is token-as-credential |
| `accounts/*` | 16 | `requireUser` + owner predicate inside `withTenantDb` |
| `admin/*` | 15 | `requireSystemAdmin` / `requireFreshSystemAdmin` |
| `plaid/*` | 7 | `requireUser`; webhook JWT; `resume-sync` poller |
| `auth/*` | 7 | NextAuth handler; token-as-credential; `limitByIp` |
| `jobs/*` | 6 | `CRON_SECRET` bearer (2 live crons + 4 fallback routes) |
| `notifications/*`, `connections/*`, `ai/*` | 4 / 4 / 3 | `requireUser` (+ entitlements, limits, allowance on `ai/chat`) |
| singletons | 15 | mixed; `health` public and rate-limited |

81 routes declare `runtime = "nodejs"`; 13 set `maxDuration` (300 s ×8, 120 s ×1, 60 s ×4).

### 2.5 Domain model — IMPLEMENTED
Identity: `User, UserSession, RecoveryCode, PlatformGrant, PlatformSetting, RateLimit, AuditLog`. Tenancy: `Space` (five platform Spaces marked by `platformArea @unique`, `prisma/schema.prisma:513`), `SpaceMember, SpaceInvite, SpaceAccountLink, SpaceDashboardSection, SpaceMemory, DailyBrief, AiAgent`. Providers: `PlaidItem, Connection, AccountConnection, ProviderAccountIdentity, ProviderCapabilityObservation, PlaidWebhookEvent`. Money: `FinancialAccount, DebtProfile, ManualAssetProfile, AssetValuation, Transaction, TransactionEvent, TransactionObservation, Merchant*, ImportBatch, ImportMappingProfile, SpaceSnapshot, SnapshotAmendment(+Day), CreditScore, FxRate`. Investments: `Instrument, InstrumentAlias, Holding, PositionObservation, InvestmentEvent, PositionCoverage, PositionReconstruction, CorporateActionTerms, PriceObservation, InvestmentEventCoverage`. Operations: `JobRun, RefreshExecution, RefreshEndpointAccountCoverage, RefreshEndpointResult, ProviderCall, SyncIssue(+Occurrence), AiInvocation, ApiUsageCounter, Notification(+Delivery, +Preference), BetaAccessRequest(+Event), CustomerPolicyAssignment, CustomerCohort`.

Dead or retired schema still present: `SpaceGoal, GoalCheckIn, GoalContribution` (0 call sites), `AiAdvice` (2 readers, 0 writers), `Holding` (still written by `lib/investments/sync-current-holdings.ts:188-226` although readers are forbidden by `lib/data/accounts.ts:16-22`). Money columns are **`Float` in 63 fields, `Decimal` in 0** (ADR-005; see `04-FINANCIAL-INTEGRITY.md`).

Authorities by aggregate: balances `lib/balances/account-balances.ts`; snapshots `lib/snapshots/regenerate.ts` + `regenerate-history.ts`; history `lib/history/account-series.ts`, `net-worth-node.ts`; wealth read model `lib/wealth/wealth-time-machine.ts`; forecast `lib/forecast/engine.ts` (`forecastCash`) + `projection.ts` (`projectCash`); scenarios `lib/ai/conversation/scenario-ledger.ts` (pure, 1,561 lines); debt payoff `lib/debt/payoff.ts`; cash-flow fold `lib/transactions/cash-flow.ts`; classification `flow-classifier.ts`; transfer maturation `transfer-maturation.ts` (1,606 lines).

### 2.6 Shared libraries — IMPLEMENTED
Highest fan-in (non-test importers): `lib/db.ts` 212, `lib/db/tenant-context.ts` 140, `lib/session.ts` 98, `lib/audit-actions.ts` 93, `lib/platform/authorize.ts` 69, `lib/currency.ts` 67, `types/index.ts` 65 (671 lines, 27 exports), `lib/money/types.ts` 60, `components/platform/widget-kit.tsx` 57, `lib/format.ts` 56, `lib/api.ts` 55.

### 2.7 Middleware — IMPLEMENTED, deliberately minimal
`proxy.ts` is Edge and zero-DB; it is explicitly not the API authorisation boundary (its own header, lines 28-39). It refuses cross-origin state-changing `/api` requests, redirects unauthenticated page navigations, separates SYSTEM_ADMIN (`/admin`) from USER (`/dashboard`), picks the TOTP-enrolment surface, and expires legacy pre-`__Host-` cookies. Path lists are hand-duplicated from `lib/marketing/public-site.ts` and `lib/admin-totp-enrollment.ts`, pinned by tests.

### 2.8 Authentication — IMPLEMENTED
NextAuth v4, Credentials provider only, JWT strategy, bcrypt(12), TOTP + recovery codes, mandatory MFA for SYSTEM_ADMIN. Session-row proof on every request (`lib/auth/session-proof.ts`) via `authDb`, with a 30-second in-process revocation cache (`lib/session-cache.ts:121-127`) bypassed by `requireFresh*`. Degraded DB returns 503, not 401 (`lib/session.ts:109-120`). See `03-SECURITY.md` for SEC-001 (the page-level TOTP gate defect).

### 2.9 Authorisation — IMPLEMENTED on three axes, with four implementations of one of them
Axes: role (USER/SYSTEM_ADMIN); Space membership (VIEWER < MEMBER < ADMIN < OWNER, action table `lib/spaces/policy.ts:169 can()`); platform grants READ < WRITE < CONTROL per area (`lib/platform/policy.ts`, adapter `lib/platform/authorize.ts` with SYSTEM_ADMIN break-glass `:67-74, :92-96`). Every one of the 187 routes carries a recognised guard (verified file by file).

The membership axis has four implementations: `requireSpaceRole` (`lib/session.ts:360`, tenant phase), `requireSpaceAction` (`lib/spaces/authorize.ts:111`, tenant phase), `resolveSpaceContext` (`lib/space.ts:168-240`, on the migration-principal `db`: `spaceMember.findUnique/findFirst` at `:182, :213, :235, :239`), and inline `spaceMember.*` lookups in 5 routes and 4 lib files. The platform page re-implements the platform guard inline (`app/(shell)/dashboard/platform/[area]/page.tsx:73-143`).

### 2.10 Database access — IMPLEMENTED (RLS programme), PARTIALLY adopted
Four clients in `lib/db.ts`: `db` (migration principal, `:30-37`), `tenantDb` via `withTenantDb`, `authDb`, `systemDb`; each role client **falls back to `db` when its URL is unset** (`:52-60`), with `FM_RLS_STRICT` refusing boot in that state (`lib/db/strict-mode.ts`). Tenant phases are interactive transactions with `set_config('app.user_id', $1, true)` and a 15-second idle timeout (`tenant-context.ts:118-128`). Routes: 78 use `withTenantDb`, 12 `systemDb`, 2 `authDb`, **60 still call `db.<model>` on the migration principal**, 18 of them customer-facing (`users/search`, `access-request`, `spaces/[id]`, `plaid/webhook`, `plaid/sync`, `spaces/[id]/snapshots`, `spaces/[id]/activity`, `spaces/[id]/invite`, `spaces/[id]/permanent`, `spaces/[id]/invites`, `plaid/investments/enable`, `accounts/manual/[id]`, `accounts/[id]/restore`, `spaces/[id]/accounts/detail`, `spaces/[id]/members/[userId]`, `spaces/[id]/invites/[inviteId]`, `accounts/[id]/import/preview`, `user/email/confirm`). The repo's own ratchet (`scripts/lib/db-authority-baseline.json`, 2026-10-04) records 163 runtime files, 31 default sites and 64 implicit owner calls on the migration principal.

### 2.11 Background jobs and scheduling — IMPLEMENTED
`vercel.json`: region `sin1`; crons `/api/jobs/dispatch` every 15 minutes and `/api/jobs/resume-stale-imports` every 5 minutes. The dispatcher (`lib/jobs/dispatch.ts`) selects due jobs from the `JobRun` ledger plus a cadence policy (`lib/jobs/cadence-policy.core.ts`) and runs each through `runJob()` (`lib/jobs/run.ts`, the only `JobRun` writer). The registry binds 13 job names to dynamic imports of 12 bodies in `jobs/` plus `lib/notifications/cleanup.ts`; `jobs/resume-stale-imports.ts` sits outside the registry on its own cron. Five per-job fallback routes remain deployed behind `CRON_SECRET`. There is no slot-level overlap lock in the dispatcher; overlap protection is per item (`PlaidItem.syncLockedAt`, `lib/plaid/sync-lock.ts`; `lib/refresh/wallet-lock.ts`). The dispatch route's header comment (`app/api/jobs/dispatch/route.ts:3-9`) still describes the retired multi-slot schedule.

### 2.12 AI orchestration — IMPLEMENTED
`POST /api/ai/chat` (`app/api/ai/chat/route.ts`, 343 lines, `maxDuration 300`): `requireUser` → entitlement `refuseIfDisabled` → per-minute and per-hour `limitByUser` from entitlements → kill switch `readPaidRequestsAdmission` (no cache, fail-closed on read error) → daily allowance reservation `dailyAiAllowanceFor` → `resolveSpaceContext` → `runStatelessTurn`. `lib/ai/provider.ts` is the only `openai` importer; it pins base URL and organisation, writes `AiInvocation` success and failure rows, and retries 429 only. The tool surface is 18 registered tools plus 2 memory tools (prose in three places says 13, 16 and 20). Daily Brief lifecycle in `lib/ai/brief/*`. The memory routes use full dependency injection (`app/api/ai/memory/handlers.ts`, `deps.ts`), the pattern the rest of the API lacks. See `03-SECURITY.md` §6 for the allowance and kill-switch analysis.

### 2.13 External providers — IMPLEMENTED, one seam each
Plaid `lib/plaid/client.ts` (throws at import without `PLAID_CLIENT_ID`, `:24-29`, which forces dynamic imports across the job registry) with a `ProviderCall` ledger; OpenAI `lib/ai/provider.ts`; Resend `lib/email/providers/resend.ts` behind `lib/email/send.ts`; Sentry via `instrumentation.ts` and `lib/monitoring/sentry-options.ts`; FX `lib/fx/registry.ts` (Open Exchange Rates → Frankfurter failover); prices `lib/prices/registry.ts` (Tiingo, CoinGecko); crypto `lib/crypto/{btc-explorer, eth-rpc, sol-rpc, alchemy, evm-native}.ts`; Turnstile `lib/captcha.ts` (fail-open, no-op without a key). Provider timeout and retry posture is in `06-DATABASE-RELIABILITY.md`.

### 2.14 Configuration — PARTIALLY IMPLEMENTED by design
`lib/env.ts` validates at boot and reports; flags are deliberately not centralised (`:28-44`). Consequence: 56 non-test files read `process.env` directly; 69 distinct variables are read, 61 documented in `.env.example`; `ALLOW_DESTRUCTIVE_DB`, `ETH_SYNC_TIMEOUT_MS`, `EVM_SYNC_TIMEOUT_MS`, `SOL_SYNC_TIMEOUT_MS` are read but undocumented. `PROD_REQUIRED_KEYS` includes `PLATFORM_ALERTS_EMAIL` (the candidate refuses to boot on Production without it).

### 2.15 Deployment — IMPLEMENTED
`next.config.ts`: security headers on every route (HSTS production-only, `X-Frame-Options: DENY`, CSP **Report-Only** with `unsafe-inline`/`unsafe-eval`). `instrumentation.ts`: Sentry init then `validateEnv()`; `onRequestError = Sentry.captureRequestError`. Build is `prisma generate && next build`; migrations are not run on deploy. CI runs no `next build` for the app.

### 2.16 Environment isolation — PARTIALLY IMPLEMENTED, documented honestly
Per `docs/operations/environment-separation.md`: `ENCRYPTION_KEY` and `PLAID_CLIENT_ID` are single Vercel records shared by Preview and Production; the OpenAI key is owner-stated identical; RLS role URLs and strict mode exist on Preview only; Production runs the July release with no RLS roles. Code side: `deploymentEnvironment()` keys on `VERCEL_ENV`; the OpenAI client refuses to build on an `OPENAI_EXPECTED_ENVIRONMENT` mismatch. Live values are UNVERIFIED by rule.

### 2.17 Prototype pages — NOT SHIPPED (verified)
`app/prototype/` and `prototype/` exist on disk (1,486 files) but are gitignored, untracked (`git ls-files` = 0), excluded by `tsconfig.json` and ESLint, and pinned by `lib/prototype-containment.test.ts`. They cannot reach a Vercel build. Residual hazard: `next build` from the main checkout fails because of them, so production builds must come from a clean worktree.

## 3. Dependency map

Top module-to-module edges (file-import counts): `platform→db` 47, `ai→forecast` 27, `ai→transactions` 26, `platform→jobs` 23, `investments→db` 22, `ai→data` 21, `crypto→investments` 19, `ai→db` 17, `plaid→transactions` 17, `investments→perspective-engine` 16, `platform→alerts` 16. Module fan-out: `lib/ai` 31 modules, `lib/platform` 22, `lib/space` 20, `lib/plaid` 18. `lib/db` is imported by 43 distinct top-level modules.

Strongly connected components (file level, non-test): 10. The one that matters is a **50-file cycle** spanning `lib/jobs/{registry,health}`, seven `jobs/*` bodies, `lib/alerts/*`, `lib/plaid/{refresh,refresh-execution,refresh-ledger,syncTransactions,client,…}`, `lib/crypto/*`, `lib/snapshots/*`, `lib/email/*`, `lib/notifications/*`, `lib/events/*`, `lib/account-deletion/purge.ts`. Witnessed cycles: `lib/jobs/registry.ts → jobs/evaluate-alerts.ts → lib/alerts/run.ts:25 → lib/jobs/health.ts:76 → lib/jobs/registry.ts` (4 hops); a 9-hop cycle through `lib/email/send.ts → templates/platform-alert → lib/alerts/evaluate → … → lib/account-deletion/purge → lib/email/send`; mutual dynamic imports `lib/plaid/refresh.ts:571 ⇄ lib/plaid/refresh-execution.ts:461`. The remaining nine are two- or three-file cycles, several type-only and benign.

## 4. Findings

Severity: P0 critical (none issued in this report) · P1 should fix before beta · P2 schedule · P3 cleanup. Coordinator severities below supersede the workstream's where they differ.

| ID | Finding | Sev | Status | Evidence | Beta blocker |
|---|---|---|---|---|---|
| **ARCH-001** | Four Space-membership authorities; `resolveSpaceContext` (used by 18 routes and every shell page) runs on the migration-principal `db`, bypassing RLS and the pure `can()` policy | P2 | PARTIALLY IMPLEMENTED | `lib/session.ts:360-395`; `lib/spaces/authorize.ts:111`; `lib/space.ts:168-240`; inline checks in `app/api/spaces/[id]/route.ts`, `space/switch`, `accounts/manual`, `spaces/[id]/invite`, `spaces/[id]/members/[userId]`, `lib/imports/authorize.ts`, `lib/accounts/space-account-link.ts`, `lib/ai/absence.ts`, `lib/spaces/default-space.ts` | No (correct today; on the RLS cutover path) |
| **ARCH-002** | 60/187 routes query through the migration principal; 18 customer-facing. Application predicates are the only boundary there | P2 | PARTIALLY IMPLEMENTED | §2.10 list; `scripts/lib/db-authority-baseline.json` (163 files) | No, but SEC-003 caps the tenant-isolation score |
| **ARCH-003** | Three client-IP extractors with two header orders; `lib/rate-limit.ts` keys on `x-forwarded-for` and never reads `cf-connecting-ip`, while audit/auth prefer `cf-connecting-ip` | P1 | IMPLEMENTED inconsistently | `lib/rate-limit.ts:247-254`; `lib/api.ts:66-84`; `lib/auth.ts:172-175`; 37 routes use `limitByIp/limitByUser` | Yes (cheap). Exploitability depends on whether Cloudflare fronts Vercel in Production: UNVERIFIED |
| **ARCH-004** | `withApiHandler` catches unexpected errors and only `console.error`s them; Sentry's `onRequestError` never sees them (41 routes) | P2 | IMPLEMENTED | `lib/api.ts:119-133`; `instrumentation.ts:66` | No (trivial fix, high observability value) |
| **ARCH-005** | 50-file strongly connected component ties jobs, alerts, platform readers, Plaid, crypto, snapshots, email and notifications; any platform reader of job health compiles the Plaid SDK | P2 | IMPLEMENTED | §3 witnesses; `lib/jobs/health.ts:76`; `lib/alerts/run.ts:25`; `lib/jobs/registry.ts:76-86` admits it | No |
| **ARCH-006** | Two operator consoles for two mutually exclusive roles: `/admin` (8 pages, 15 routes, SYSTEM_ADMIN) and Platform Spaces (66 routes, 97 widgets, grants); three user-list endpoints, two audit feeds, two session views | P2 | IMPLEMENTED (both) | `proxy.ts:141-148`; `app/api/platform/security-ops/audit/route.ts:7-11`; `admin/users`, `admin/security/users`, `growth-revenue/users` | No |
| **ARCH-007** | Four refresh/sync entry points with overlapping semantics; `POST /api/plaid/sync` has no UI consumer; `lib/plaid/refresh.ts` and `refresh-execution.ts` depend on each other through dynamic imports | P2 | PARTIALLY IMPLEMENTED (one envelope, not one API) | `app/api/plaid/{refresh,sync}`, `app/api/refresh/all`, `app/api/accounts/[id]/sync`; `lib/plaid/refresh.ts:571`, `refresh-execution.ts:461` | No |
| **ARCH-008** | `lib/` contains client hooks and context providers that import `components/` | P3 | IMPLEMENTED | `lib/space/use-active-envelope.ts:27`; `lib/space/use-space-navigation.ts:34`; `lib/currency-context.tsx` | No |
| **ARCH-009** | Flags and provider secrets read in 56 files; four variables undocumented; Plaid client throws at import | P3 | IMPLEMENTED by design | `lib/env.ts:28-44`; `lib/plaid/client.ts:24-29`; `.env.example` | No |
| **ARCH-010** | In-process caches and side-effect registries on a serverless platform (30 s revocation cache per instance; registries populated by import side effects) | P3 | IMPLEMENTED (documented trade-off) | `lib/session-cache.ts:121-127`; `lib/perspective-engine/registry.ts:28`; `lib/ai/assembler-registry.ts:72` | No |
| **ARCH-011** | Every tenant read is an interactive transaction; 21 routes `findMany` without `take` (`admin/users`, `spaces/[id]/snapshots`, `admin/platform-grants`, … ) | P3 | IMPLEMENTED | `tenant-context.ts:109-129`; route list in workstream draft | No at beta scale |
| **ARCH-012** | Source comments and READMEs contradict the deployed shape (cron schedule, model name, tool count, "no platform routes yet") | P3 | — | `app/api/jobs/dispatch/route.ts:3-9`; `lib/ai/provider.ts:13`; `lib/ai/conversation/tools.ts:3`; `app/api/platform/README.md:3-4` | No |

Cross-references: SEC-003 (RLS bypass on `db`) in `03-SECURITY.md`; CQ-004/CQ-007 (IP extractors, membership duplication) in `07-CODE-QUALITY-REDUNDANCY.md`; OPS findings on job overlap in `06-DATABASE-RELIABILITY.md`.

## 5. Scores (Part 1 items)

Scale: 1-2 critical · 3-4 major weaknesses · 5-6 functional with significant gaps · 7 generally sound · 8 strong, minor gaps · 9 very strong, verified · 10 exceptional.

| # | Item | Score | Weight | Evidence | Strengths | Weaknesses | Confidence | Beta impact | Improvement |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Overall layering | 7 | 5 | §2.1 | thin edge, thin routes, pure cores | lib→components/jobs edges, 4 fat routes | high | low | ARCH-008 moves |
| 2 | Frontend/backend separation | 5 | 3 | §2.2 | RSC pages with tenant phases | 311/312 client components; 128 client fetches | high | low | RSC data for workspaces post-beta |
| 3 | Service boundaries | 6 | 4 | §2.3, ARCH-006/007 | documented authorities | parallel consoles, four refresh doors, three health derivations | high | low | ARCH-006/007 |
| 4 | API organisation | 7 | 3 | §2.4 | area-grouped, uniform guard idiom and `{error}` body | 4 unconsumed routes, duplicate reads | high | low | CQ-009, CQ-005 |
| 5 | Business-logic placement | 7 | 4 | §2.3 | pure authorities with injected clients | `tools.ts` god file; `DebtClient.tsx`; import route | high | low | split `tools.ts` |
| 6 | Domain modelling | 7 | 4 | §2.5 | provenance/ledger tables; platform Spaces as rows | Float money; dead Goal tables; `Holding` dual-write | high | low | schema train |
| 7 | Module cohesion | 6 | 3 | §3, ARCH-005 | `ai/platform/data` mostly acyclic | 50-file SCC | high | none | ARCH-005 |
| 8 | Dependency coupling | 5 | 3 | §3 | one db, one session, one audit vocabulary | lib↔jobs, hooks in lib, route types as DTO authority | high | none | ARCH-005/008 |
| 9 | Shared libraries | 7 | 2 | §2.6 | consistent primitives | `types/index.ts` catch-all; 1,301 unreferenced exports | medium | none | CQ-003 |
| 10 | Middleware | 8 | 3 | §2.7 | zero-DB edge, origin boundary, legacy-cookie purge | hand-duplicated path lists | high | none | — |
| 11 | Authentication architecture | 7 | 5 | §2.8, SEC-001 | session-row proof, fm_auth, 503-not-401, admin MFA | client-updatable token hint trusted by pages (SEC-001); CAPTCHA no-op on Production | high | medium | SEC-001 fix, Turnstile keys |
| 12 | Authorisation architecture | 7 | 5 | §2.9 | three orthogonal axes, pure policies, every route guarded | four membership implementations, one off-RLS | high | low | ARCH-001 |
| 13 | Database access patterns | 6 | 5 | §2.10 | SET LOCAL identity, strict mode, single factory | 163-file migration-principal residue; silent fallback design | high | medium (cutover) | continue ratchet; make `db` throw in strict mode |
| 14 | Background jobs | 7 | 3 | §2.11 | ledgered, cadence policy, per-item locks | 50-file cycle, stale comments, no slot lock | high | low | see OPS findings |
| 15 | Scheduling | 6 | 2 | §2.11 | two crons, cadence-driven dispatch | crons never exercised on Preview; fallback routes kept | high | medium | exercise on Preview before cutover |
| 16 | AI orchestration | 8 | 4 | §2.12 | single chokepoint, allowance, kill switch, failure rows | 4,768-line tools file; prose counts disagree | high | low | CQ-011 |
| 17 | External provider integrations | 8 | 3 | §2.13 | one seam each, ledgers, env-pinned OpenAI | Plaid client throws at import; CAPTCHA fail-open | high | low | lazy Plaid client |
| 18 | Configuration management | 6 | 3 | §2.14 | boot validation, value-free report | 56 direct readers; 4 undocumented vars | high | low | document flags |
| 19 | Deployment architecture | 7 | 3 | §2.15 | headers, instrumentation, env gate | CSP report-only; no app `next build` in CI; dirty main checkout | high | low | add build job |
| 20 | Environment isolation | 5 | 4 | §2.16 | honest matrix; env-pinned OpenAI | shared `ENCRYPTION_KEY`/`PLAID_CLIENT_ID` records; Production on the July build | high (docs) / UNVERIFIED (live) | high (cutover) | per cutover plan §4 |

Weighted mean: **6.7 / 10**. Confidence: high (the graph and route census were computed, not sampled); evidence coverage: all 187 routes, all top-level `lib` modules, the core authority files read in full.

## 6. Structural weaknesses (ranked)

1. **Accretion without deletion.** Old authorities survive beside new ones (membership ×4, IP ×3, audit ×4, refresh ×4, consoles ×2). Each is a place a future fix must be made twice.
2. **Migration-principal residue.** 163 files and 60 routes reach Postgres as the table owner; RLS is defence-in-depth only on the tenant-client paths.
3. **One 50-file cycle** making jobs, alerts, Plaid and email a single compilation unit.
4. **`lib/ai/conversation/tools.ts`** at 4,768 lines and 64 commits since August is the hottest and least modular artefact in the system.
5. **Error observability gap** in the 41 `withApiHandler` routes.
6. **Shared secrets across environments** and a Production that is two releases and 38 migrations behind the candidate.
