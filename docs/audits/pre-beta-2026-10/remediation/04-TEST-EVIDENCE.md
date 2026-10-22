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

## 3. Integration gates

(pending)
