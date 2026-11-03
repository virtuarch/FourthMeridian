# 04 — Test Evidence

## 1. Baseline gate (before any change)

`npm run ci` (scripts/ci-local.ts: clean depth-1 copy of committed HEAD, throwaway `postgres:16`, Node 24.21.0) on `cde8fa0e25d2c744933109b41611d1dd65a1f9a8`, run 2026-10-22 from `/Users/chrstn/dev/FourthMeridian-remediation/base`. Log: `/Users/chrstn/dev/FourthMeridian-remediation/baseline-ci.log`.

| Job | Step | Result |
|---|---|---|
| test | npm ci · prisma generate · `npm run test:unit` · typecheck · lint | ✓ all (test:unit 95.7 s) |
| architecture | migrate deploy · seed · `audit:ci` (REQUIRED tier) · `rls:accept` · `rls:accept:app` · `rls:accept:ai` · `rls:accept:plaid` · `rls:accept:foreground` · `rls:accept:allowance` (15/15) | ✓ all |
| site | npm ci · `npm run verify` (incl. static build) | ✓ |

Verdict: `[ci] PASSED — every CI job green on a clean copy of HEAD.` Exit 0.

## 2. Per-agent evidence

Filled at integration from `agent-reports/*.md` and re-run by the orchestrator on the integration branch.

## 3. Integration gates (full `npm run ci`, clean depth-1 copy of committed HEAD, throwaway postgres:16, Node 24.21.0)

| HEAD | Result | Failing step → root cause → fix |
|---|---|---|
| `46a31cd` (all 7 wave-1 branches) | FAILED | unit 792/795 + REQUIRED `audit-route-guards`, `audit-db-authority` → merge seams (cron helper unrecognised; health reader on migration principal; 2 unregistered incident stages; text order vs admission) → `10010fd`, `714f543` |
| `714f543` | FAILED | `rls:accept` 36/37 → TEST-003 census correctly noticed RateLimit gained a policy (DB-004) → `0a94578` |
| `0a94578` | FAILED | `rls:accept:foreground` 66/67, case 50 → asserted the role had NO settings; DB-006 adds a role statement_timeout → narrowed to the idle setting it guards, `a7078db` |
| `a7078db` | FAILED | `rls:accept:allowance` 14/15, source case 8 → `deadline.dispose()` precedes the release in the same `finally` → `4834697` |
| **`4834697`** | **PASSED — every job green** | — |
| `bad2cde` (queue-I orchestrator work + new `audit-schema-drift`) | FAILED | unit 809/811: palette ratchet (raw colours) and db-safety (drift audit's own client) → `2744c8d`, `5ea1f94` |
| **`5ea1f94`** | **PASSED** | unit 811/811 |
| **`06212e6`** (H merged, CQ-011) | **PASSED** | unit 812/812 |
| **`01098bd`** (J merged + J-D1/2/3/5/6 fixed) | **PASSED — every job green** | unit **828/828**; RLS 37/98/72/20/67; allowance 15/15; REQUIRED audits incl. `audit-schema-drift` (0 statements) |

App production build: `npm run build` (prisma generate + `next build`, Next 16.3.8 Turbopack) on `01098bd` — **compiled successfully, 0 warnings**; 185 API routes; `/dashboard/credit` and `/api/plaid/sync` absent (log `…-remediation/build.log`).

Green run at `4834697` (log `/Users/chrstn/dev/FourthMeridian-remediation/integration1e-ci.log`):

| Job | Step | Result |
|---|---|---|
| test | `npm audit --omit=dev --audit-level=high` (new gate) | ✓ |
| test | `npm run test:unit` | ✓ 796/796 files (baseline 743 + 53 new) |
| test | typecheck · lint | ✓ · ✓ (0 errors) |
| architecture | `migrate deploy` from empty (134 migrations, 8 new) · seed | ✓ · ✓ |
| architecture | `audit:ci` REQUIRED tier (incl. new `audit-route-guards`, `audit-migration-names`) | ✓ all |
| architecture | `rls:accept` | ✓ 37/37 (baseline 34; +3 GRANT↔POLICY census) |
| architecture | `rls:accept:app` · `:ai` · `:plaid` · `:foreground` | ✓ 98/98 · 72/72 · 20/20 · 67/67 |
| architecture | `rls:accept:allowance` | ✓ 15/15 (reserve now $0.3675, admits 4 of 8) |
| site | `npm run verify` | ✓ |

Not covered by this gate: an app `next build` (CI has none; run separately — passed at `01098bd`, see below), PostgreSQL 17.6 / Supabase (the gate is PG16 — **not** evidence of PG17.6 equivalence), any browser behaviour.

## 4. Runtime-confirmed findings → regression tests (queue C)

Each runtime reproduction from `../runtime/` is now encoded as a test in the suite that passed at `4834697` (and 803/803 at `57de6aa`).

| Runtime finding (original evidence) | Regression test(s) | What the test reproduces |
|---|---|---|
| SEC-001 (`POST /api/auth/session {requireTotpSetup:false}` → `/admin` 200) | `lib/auth/token-update.test.ts`, `lib/auth/page-gate.test.ts` | the exact csrf + session-update attack against the real NextAuth handler; session stays pending; pending admin redirected from `/admin` and `/admin/providers` |
| FIN-001 (11 paychecks, slot 5 days overdue → $15,000 → $0 under a complete label) | `lib/ai/forecast/income-completeness.test.ts` F1–F9, `stream-read.test.ts` S16–S21, `lib/ai/conversation/fin001-wiring.test.ts` | the audit fixture ⇒ RECENTLY_SILENT, INCOMPLETE, bound $15,000; late / skipped / changed / resumed / stale-feed / discontinued variants |
| FIN-002 (correction on a PFC row never moves `flowType`) | `lib/transactions/merchant-corrections.test.ts` §9, `flow-row-input.test.ts` | PFC=INCOME → Transfer/Dining/Payment change flow and totals; transfer-owned row still refuses |
| IDEMP-001 (two concurrent identical CSVs → 12 rows) | `lib/imports/claim.test.ts`, `zip-bounds.test.ts` (+ real-PG proof in C's report) | concurrent claim: one batch, loser learns winner (409); re-import after rollback allowed; caps |
| IDEMP-002 (two concurrent purges → 4 ACCOUNT_DELETED rows) | `lib/account-deletion/purge.test.ts`, `purge-census.test.ts` | two concurrent workers ⇒ exactly one destructive tail and one audit row; cancel race; table census |
| SEC-AI-003 (one 429'd turn → 18 provider calls) | `lib/ai/rate-limit-retry.test.ts`, `provider-deadline.test.ts`, `conversation/turn-deadline.test.ts`, `invocation-failures.test.ts` | client `maxRetries: 0` + timeout pinned; bounded attempts; deadline aborts with a TIMEOUT row |
| OBS-001 (30-day-stale evaluation reads "Quiet / ok") | `lib/platform/ops/overview-core.test.ts`, `app/api/health/route.test.ts` | stale evaluation ⇒ "Unknown — evaluator silent"; health exposes the scheduler block |
| OBS-002 (`dead` job silent, `overdue` fires) | `lib/alerts/alerts.test.ts` | the same job at 60 days (dead) and 10 h (overdue) both fire |
| OBS-003 (`captured` counted delivered, suppressed 20 h) | `lib/alerts/alerts.test.ts` §OBS-003, `delivery-capture.test.ts` | no RESEND key outside development ⇒ not delivered, not suppressed |
| SEC-008 (register with no invite → 201) | `lib/registration-default.test.ts` | absent/typo/blank setting ⇒ invite_only ⇒ 403 before any write |
| ARCH-003 (rotating XFF rotates the limiter bucket) | `lib/security/client-ip.test.ts`, `lib/rate-limit.test.ts` | spoofed first hop ignored; platform header wins; census of IP-header readers |
| FIN-003 / FIN-005 / IDEMP-003 / IDEMP-009 / SEC-004 / SEC-005 (P2s) | `cash-flow.test.ts`; `cash-history.test.ts`, `backfill-core.test.ts`; `lib/jobs/run.test.ts`; `invocation-await.test.ts`; `lib/export/csv.test.ts`; `users/search/search-term.test.ts` | the runtime fixtures (+5000/−500 ⇒ 4500; HSA 5,000 split; two concurrent runJob ⇒ one body; failing ledger surfaces; `=RTVINJECT()` neutralised; single-character search refused) |

Preserved controls re-proven on the integrated branch: allowance reservation and fail-closed (`rls:accept:allowance` 15/15), kill switch (`cost-controls.test.ts`, allowance case 6), cross-user AI isolation (`rls:accept:ai` 72/72), tenant isolation (`rls:accept` 37/37, `:app` 98/98, `:foreground` 67/67), net-worth and flow invariants (REQUIRED audits).
