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

Not covered by this gate: an app `next build` (CI has none; run separately, §4), PostgreSQL 17.6 / Supabase (the gate is PG16 — **not** evidence of PG17.6 equivalence), any browser behaviour.
