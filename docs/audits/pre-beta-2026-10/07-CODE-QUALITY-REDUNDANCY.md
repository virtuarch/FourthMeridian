# 07 — Code Quality and Redundancy

Pre-beta audit of Fourth Meridian · `v2.6` · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · 2026-10-21 · read-only. Nothing was deleted or modified. Finding IDs `CQ-nnn`; architecture-level duplicates are `ARCH-nnn` in `02-ARCHITECTURE.md`.

## 1. Verdict

Type safety is strong (`strict: true`, 0 `@ts-ignore`, 13 `as any` in 276k lines, 0 TODO/FIXME markers). The debt is of a different kind: dead code the previous audit already named is still on disk, four production dependencies are unused, 1,301 `lib/` exports have no production reference, one file holds the system's hottest logic at 4,768 lines, and several security-relevant utilities exist in two or three copies with diverging behaviour. One redundancy is a beta blocker (CQ-004, client-IP extraction). Weighted code-quality score: **6.1 / 10**.

Static checks run by the coordinator on HEAD with Node 24.21: `tsc --noEmit` 0 errors in tracked code; ESLint 0 errors in tracked code (CI reports 19 warnings). Both are polluted locally by the gitignored `tmp/` directory (23 TypeScript errors, 578 lint errors there) because `tsconfig.json:35` excludes only `node_modules, prototype, app/prototype, site`.

## 2. Redundancy register

"Overlap verified" records whether the two implementations were read and found to do the same thing (yes), part of the same thing (partial), or different things that merely share a name (no).

| ID | Files | Related modules | Why it looks redundant | Overlap verified | Risk of removal | Recommended consolidation | Effort | Priority |
|---|---|---|---|---|---|---|---|---|
| **CQ-004** | `lib/api.ts:66-84`, `lib/rate-limit.ts:247-254`, `lib/auth.ts:172-175` | rate limiting, audit, login | three client-IP extractors; `rate-limit.ts` reads `x-forwarded-for` first and never `cf-connecting-ip`; the other two prefer `cf-connecting-ip` | **yes, divergent** | low | `limitByIp` → `getClientIp` from `lib/api.ts`; inline copy in `auth.ts` → `getRequestMeta` | S | **P1** (= ARCH-003) |
| **CQ-007** | `lib/session.ts:360`, `lib/spaces/authorize.ts:111`, `lib/space.ts:168`, 5 routes, 4 lib files | authorisation, RLS | four Space-membership checks, one on the migration principal | **yes** | medium (page-context fallback semantics) | `resolveSpaceContext` over `requireSpaceAction`; delete inline checks | M | P2 (= ARCH-001) |
| **CQ-006** | 80 direct `auditLog.create(` sites; `lib/audit.ts:99,161,320`; `lib/events/emit.ts` | audit, events, fm_auth `RETURNING` restriction | four AuditLog write idioms; only `auditInsert` handles the fm_auth restriction, so a direct `create` on an fm_auth path fails | **yes** | low | lint rule forbidding `auditLog.create` outside `lib/audit.ts`; migrate callers | M | P2 |
| **CQ-005** | `app/api/admin/{users,security/users,audit,spaces}`, `app/admin/*` vs `app/api/platform/**` + `components/platform/widgets/*` | operator consoles | three user lists (same `db.user.findMany` substring search, different select/guard), two audit feeds (same filter), two session views | **partial** | medium (SYSTEM_ADMIN break-glass must survive) | keep `/admin` for grants and security settings only; retire `admin/users`, `admin/spaces`, `admin/audit`, `admin/providers` once widgets exist | M | P2 (= ARCH-006) |
| **ARCH-007** | `app/api/plaid/{refresh,sync}`, `app/api/refresh/all`, `app/api/accounts/[id]/sync`; `lib/plaid/refresh.ts`, `lib/refresh/refresh-all.ts` | provider orchestration | four refresh APIs | **partial** (all route through `runFullRefresh`; `/api/plaid/sync` has no UI consumer) | low for `/plaid/sync` | delete `/api/plaid/sync`; single-item only on `/plaid/refresh` | S | P2 |
| **CQ-001** | `package.json` | dependencies | `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `recharts`: 0 imports anywhere | **yes** | none | uninstall | S | P2 |
| **CQ-002** | 11 orphan components, 6 lib modules (§3) | dead code | imported by no non-test file | **yes** | none | delete; keep the two documented scaffolds only if a dated plan names them | S | P3 |
| **CQ-008** | `lib/debt.ts:21-26`, `lib/debt/interest-cost.ts:26-29`, `lib/debt-space-data.ts` | debt | the same monthly-interest formula in two places; three homes under one name | **partial** | low | fold into `lib/debt/`; `estimateMinimumPayment` calls `estimatedMonthlyInterest` | S | P3 |
| **CQ-010** | `lib/perspectives.ts` / `lib/perspectives/` / `lib/perspective-engine/`; `lib/session.ts` / `sessions.ts` / `session-cache.ts`; `lib/space.ts` / `spaces/` / `space/`; `lib/platform-settings.ts` / `lib/platform/settings/` / `lib/settings/` | naming | name collisions | **no** (distinct concerns, verified by headers) | none | rename in one post-beta commit | S | P3 |
| — | `lib/currency.ts` vs `lib/money/*` vs `lib/format.ts` vs `lib/ai/format.ts` | money presentation | brief asked | **no** for currency/money/format (presentation vs conversion vs dates); **yes** for `lib/ai/format.ts:31-36 fmtMoney` ≡ `formatCurrency` | low | `fmtMoney` → `formatCurrency`; delete unused `fmtMonthYear` | S | P3 |
| — | `lib/audit.ts` vs `lib/audit-actions.ts` vs `lib/platform/security/operator-actions-core.ts` | audit | brief asked | **no** (constants / shape helpers / feed projection) | — | none | — | — |
| — | `lib/balances` / `lib/snapshots` / `lib/history` / `lib/wealth` / `lib/data/snapshots.ts` | net-worth path | brief asked | **no** (layered: authority → writer → series → read model → DB read) | — | none | — | — |
| — | `lib/sync/status.ts`, `lib/connections/health.ts:285-306`, `lib/connections/space-data-health.ts`, `lib/freshness/*` | connection health | brief asked | **partial**: three derivations of connection health (customer `SyncStatus`, platform `deriveConnectionHealthState`, Space sources); freshness is per-account and distinct | medium | one `deriveConnectionHealthState` consumed by both surfaces | M | P3 |
| — | `lib/rate-limit.ts`, `lib/login-limits.ts`, `lib/ai/rate-limit-retry.ts`, `lib/plaid/provider-call.ts:84` | rate limiting | brief asked | **no** (one limiter; constants; provider-429 retry; provider classification) | — | none beyond CQ-004 | — | — |
| — | `lib/db.ts` | Prisma factories | brief asked | **no** (single factory; seven `scripts/` instantiate their own, guarded by `lib/db-safety.test.ts`) | — | none | — | — |
| — | `app/api/jobs/{sync-banks,fetch-fx-rates,fetch-security-prices,process-deletions}` vs the dispatcher | jobs | per-job fallback routes | **yes** (documented as intentional) | low | keep until the cadence policy is proven on Production, then delete | S | P3 |
| **CQ-009** | `GET /api/spaces/[id]/{investments,snapshots,transactions}`, `POST /api/plaid/sync` | API | no consumer found by path grep | grep-only (UNVERIFIED at runtime) | low | delete or document as public API | S | P3 |
| **CQ-017** | `lib/forecast/engine.ts`, `lib/forecast/projection.ts`, `lib/ai/conversation/scenario-ledger.ts`, `lib/debt/payoff.ts` | finance engines | three projection engines with separate interest conventions (ACT/365 on spine dates vs monthly) | UNVERIFIED (needs execution; see `04-FINANCIAL-INTEGRITY.md`) | high | document divergence; numeric parity test | L | P2 |
| **CQ-018** | spending-named exports in `lib/forecast/{spending-baseline,spending-change,observed-spending}.ts`, `lib/transactions/canonical-spending.ts`, `flow-classifier.ts:542-553`, `lib/ai/intelligence/annotations/metrics.ts`, `lib/ai/measures/baseline.ts`, `lib/ai/brief/contract.ts`, `lib/ai/conversation/scenario-rules.ts` | spending aggregation | prior audit counted nine | `deriveSpendingBaseline` dead (verified); live-set agreement UNVERIFIED | — | numeric parity harness | M | P3 |

## 3. Dead code

Method: import graph over 2,214 files (`scratchpad/ws1/depgraph.js`); "orphan" = imported by no non-test, non-entry file. Name-based heuristics are stated where used.

- **Orphan components (11):** `components/brief/{BriefModal,HeroRegionProvider,BriefLogo}.tsx`, `components/plaid/AccountRefreshButton.tsx`, `components/atlas/{InlineFilter.tsx,tones.ts}`, `components/space/widgets/{TimelineWidget,AssetValueWidget,ProgressWidget}.tsx`, `components/ui/UserButton.tsx`, `components/dashboard/widgets/GlassModal.tsx`.
- **Orphan or test-only lib modules:** `lib/ai/domain-manifest.ts` (0 importers), `lib/ai/domain-relevance.ts` (test-only), `lib/forecast/spending-baseline.ts` (0 importers; the prior audit's "DEAD, must not be revived" item, still on disk), `lib/ai/conversation/compaction.ts` (0), `lib/hero-region.ts` (only by the orphan `HeroRegionProvider`), `lib/platform/capability-classification.ts` and `lib/forecast/obligation.ts` (test-only, documented scaffolds).
- **Prior-audit dead-code list (2026-09-21, 20 items):** 4 deleted, 12 still on disk, no closure census run (STATUS §10 agrees).
- **Dead schema:** `SpaceGoal`, `GoalCheckIn`, `GoalContribution` (0 call sites); `AiAdvice` (2 readers, 0 writers); `Holding` still dual-written by `lib/investments/sync-current-holdings.ts:188-226` while readers are forbidden. The `audit-goals-tombstone` and `audit-crypto-holding-tombstone` CI audits guard that nothing *revives* them; nothing schedules their removal.
- **Unreferenced exports (CQ-003):** 1,301 `lib/` exports with no production reference (165 consts, 112 functions; 1,024 types/interfaces, largely DTO contracts consumed by tests); a further 835 referenced only by tests. Hot spots: `lib/platform/growth/product-analytics-core.ts` (14 values), `lib/alerts/evaluate.ts` (9), `lib/hero-region.ts` (8), `lib/crypto/eth-history.ts` (7). Heuristic; medium confidence.
- **Unused dependencies (CQ-001):** four, listed above. Every other dependency has at least one importer; all devDependencies are used.
- **Untracked artefacts on disk (CQ-016):** `backups/` (81 SQL dumps, 317 MB), `tmp/` (632 files incl. real-balance transcripts), `_v26pre_bundle/`, `prototype/` (140 MB). All gitignored. Not a repository problem; a laptop-hygiene one (customer-grade data at rest outside the DB).

## 4. Duplicate gateways and services

See the register rows CQ-004, CQ-005, CQ-006, CQ-007, ARCH-007. The pattern in every case is "new authority added beside the old one; old one documented as retired in a header". The two that carry security weight are the IP extractors (rate-limit buckets can be rotated independently of the audited IP) and the membership check that runs off-RLS.

## 5. Other quality observations

| Topic | Finding | Evidence |
|---|---|---|
| Oversized files (CQ-011, P2) | 25 files over 800 lines. `lib/ai/conversation/tools.ts` 4,768 lines, 46 imports, 26 non-null assertions, 6 `as unknown as`, **64 commits since 2026-08-01** (highest churn in the repo), 13 self-contained numbered sections and a `TOOLS` registry at `:4747` that already is the index. Others: `lib/ai/assemblers/transactions.ts` 2,165; `lib/ai/types.ts` 1,608; `lib/transactions/transfer-maturation.ts` 1,606; `lib/ai/conversation/scenario-ledger.ts` 1,561; `lib/snapshots/regenerate-history.ts` 1,490; `lib/plaid/syncTransactions.ts` 1,279; `components/dashboard/DebtClient.tsx` 1,251 (29 `useState`) | `wc -l`, `git log --since` |
| Prisma queries in loops (CQ-012, P3) | 37 heuristic sites (loop header followed within 8 lines by `await <client>.<model>.<op>`); notable: `lib/platform-settings.ts:388-394` (one `findUnique` per key), `lib/snapshots/regenerate-history.ts:521-527` (per-day `transaction.findMany`), `lib/platform/connection-diagnostics.ts:115-174`, `app/api/admin/security/settings/route.ts:74-80`. Most are bounded by small N or inside one transaction | `scratchpad/ws1/loopq.js` |
| Type safety (CQ-013, positive) | `as any` 13, `as unknown as` 89, `@ts-ignore` 0, `@ts-expect-error` 0, `: any` 67 (regex incl. comments), non-null `!` ≈271, `eslint-disable` 40, `console.log` 94 (incl. per-request timing logs in `lib/space.ts`). `strict: true` | grep |
| Error handling (CQ-014, P3) | Sample of 31 routes: 11 `withApiHandler`, 10 bare `try`, 10 neither (rely on Next default → Sentry `onRequestError`). Body shape uniformly `{ error: string }` (432 sites). Raw `Error.message` reaches the client in `app/api/spaces/[id]/wealth/amend/route.ts:104-106` and `app/api/merchant-ops/decide/route.ts:70` (= SEC-013). No validation library; 66 routes call `.json()` with inline `typeof` checks; two local `readBody` helpers | route sample |
| Legacy layers (CQ-015, P3) | 429 "legacy" mentions in source prose; fallback clients `lib/db.ts:52-60`; legacy cookie expiry `proxy.ts:58-67`; cookie name `fintracker_space` (`lib/space.ts:31`) from the pre-rename product; `context/PlaidContext.tsx` imported by 7 components | grep |
| Naming (CQ-010) | 19 files named `types.ts`, 8 `registry.ts`, 4 `policy.ts`, 3 `authorize.ts`; 8 camelCase file names in a kebab-case tree (`lib/plaid/{syncTransactions,exchangeToken,backgroundHistorySync,refreshCooldown,syncIssues,investmentsConsent}.ts`, `lib/transactions/RelationshipResolver.ts`, `lib/fx/providers/openExchangeRates.ts`) | `find` |
| Stale prose (ARCH-012) | cron schedule, model name (`gpt-4o-mini` vs `gpt-5.1`), tool count (13/16/18/20), "no platform routes yet" | see `02-ARCHITECTURE.md` |

## 6. Consolidation recommendations (ordered)

1. **Before beta (P1):** CQ-004 — one `getClientIp`; make `limitByIp` use it.
2. **First post-beta cleanup (P2, ~1 week):** CQ-001 uninstall four packages; CQ-002 delete orphans; CQ-006 lint-ban direct `auditLog.create`; CQ-007/ARCH-001 single membership authority; ARCH-007 delete `/api/plaid/sync`; CQ-011 split `tools.ts` along its own section markers into `tools/<n>-<name>.ts` with `tools/index.ts` as the registry; ARCH-004 capture in `withApiHandler`.
3. **Schema train (P2/P3):** drop `SpaceGoal/GoalCheckIn/GoalContribution`, `AiAdvice`, and either stop writing `Holding` or stop forbidding its readers.
4. **Later (P3):** CQ-010 renames; CQ-003 export pruning; CQ-005/ARCH-006 console consolidation; tsconfig/ESLint excludes for `tmp/` and `backups/`.

## 7. Scores

| Category | Score | Weight | Evidence | Strengths | Weaknesses | Confidence | Beta impact | Improvement |
|---|---|---|---|---|---|---|---|---|
| Dead code | 5 | 2 | §3 | CI tombstone audits stop revival | prior-audit items not actioned; 11 orphan components; 4 dead routes; 3 dead models | high | none | delete list in §3 |
| Duplication | 5 | 3 | §2 | each new authority is better than the old | old authorities kept; one security-relevant divergence (CQ-004) | high | medium (CQ-004) | §6 |
| Unused dependencies | 6 | 1 | CQ-001 | all else used | four unused packages | high | low | uninstall |
| Type safety | 8 | 2 | CQ-013 | strict, no ignores | 271 non-null assertions concentrated in `tools.ts` and fixtures | high | none | — |
| Error-handling consistency | 6 | 2 | CQ-014, ARCH-004 | one body shape | three handler styles; Sentry gap; two `e.message` leaks | high | low | one `readJsonBody`; capture in wrapper |
| Module boundaries | 6 | 2 | `02-ARCHITECTURE.md` §3 | components never import DB | lib leaks into components/jobs; 50-file cycle | high | none | ARCH-005/008 |
| Query efficiency / N+1 | 7 | 2 | CQ-012, ARCH-011 | keyset where it matters; bounded loops | `platform-settings` per-key reads; 21 uncapped lists | medium | none at beta scale | batch settings read |
| Naming / orientation | 6 | 1 | CQ-010 | expressive names | collisions; camelCase outliers | high | none | rename |
| Complexity (largest units) | 5 | 2 | CQ-011 | sections are internally delimited | 4,768-line hottest file; 1,251-line client component | high | low | split |
| Legacy layers | 6 | 1 | CQ-015 | each layer documented | dual-written dead table; pre-rename cookie | high | none | schema train |

Weighted mean: **6.1 / 10**. Confidence high; evidence coverage: whole-repo graph and greps, 31-route handler sample, all candidate pairs named in the brief read.
