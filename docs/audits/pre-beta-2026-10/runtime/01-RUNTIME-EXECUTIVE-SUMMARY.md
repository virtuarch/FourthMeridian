# 01 — Runtime Verification Executive Summary

**Fourth Meridian — runtime verification of the static pre-beta audit.** HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` (v2.6), verified. Date 2026-10-21. This was a verification phase, not a fixing phase: nothing was fixed, committed, pushed, deployed, or changed in either source tree, and no Preview or Production system was touched.

## 1. What was built and how isolation was proven

An isolated, disposable stack with synthetic data only:
- A `postgres:16` container on a random loopback port, migrated and seeded from the repo (4 synthetic users, 8 Spaces, 376 transactions, 5 Platform Spaces), with the three RLS role clients (`fm_app`/`fm_auth`/`fm_system`) provisioned and bound.
- A Next dev server run from a **clean detached git worktree** of `cde8fa0` (no `.env` files) with a minimal, fully explicit environment: every provider key a dummy, the database pointed only at the throwaway container, `FM_RLS_STRICT=true`. `/api/platform/platform-ops/db-authority` confirmed at runtime: strict mode on, all three roles bound (none a superuser, none BYPASSRLS, none owning tables), tenant identity set inside the transaction, 70 public tables, 62 ENABLE+FORCE, 246 policies.
- OpenAI **mocked in-process** (a `NODE_OPTIONS` preload answers every `api.openai.com` fetch locally and blocks all other non-loopback egress); every seeded Plaid Item set to **REVOKED** so no job could reach Plaid; no Resend/Turnstile/Sentry keys.

Safety checks that passed before any test: the server process holds only dummy keys and the throwaway database URL (verified against the process environment); `localhost:5432` (the persistent dev database) was unreachable and never used; `.env.local`, `.env.preview`, and the Preview/Production credential files were never read; the database-target guard (`FM_DB_GUARD=clone-only`) was armed; the egress block logged and refused every attempt to reach npm, Next telemetry, or any provider. No Production credential or connection was accessible to the harness.

Six parallel workstreams ran against this stack (security, financial, idempotency, AI, Spaces + observability, database). The coordinator independently reproduced the headline finding (SEC-001) and cross-checked every promoted claim.

## 2. Verdict

**CONDITIONAL GO — unchanged. Overall beta readiness 5.9 / 10.** Runtime verification did not surface a new P0, did not refute any release blocker, and reproduced the findings that matter most for customer trust with concrete evidence. It also *lowered* aggregate risk in two places: the one theoretical cross-tenant hole the static pass could not rule out is refuted, and the operator-widget access finding is confirmed to be cosmetic rather than a security gap. The decision is still governed by the Production cutover gates, which an isolated box cannot exercise.

## 3. Runtime coverage

Of the 34 static P1 findings, **11 were runtime-testable and all 11 reproduced** (one partially). The remainder are Production-environment gates (untestable here) or configuration/testing/documentation items established by inspection. The six database acceptance suites — the authoritative RLS proof the static pass lacked because its database was down — ran on fresh clones and passed **306 of 306** checks.

## 4. Confirmed findings

**P0: 0.**

**P1 confirmed at runtime (11):** SEC-001 (admin TOTP page-gate bypass — reproduced twice, independently), FIN-001 (one late paycheck drops $15,000 of projected payroll to $0 under a "complete" label), FIN-002 (user category correction cannot change the economics of a PFC-bearing row), IDEMP-001 (concurrent CSV import: 6 rows → 12), IDEMP-002 (non-transactional purge runs the destructive tail twice: 4 deletion-audit rows for 2 users), SEC-AI-003 (one 429'd turn drives 18 provider calls), OBS-001/OBS-002/OBS-003 (the alerting path is blind to a dead evaluator, a dead job, and an undeliverable e-mail), SEC-008 (open registration default), ARCH-003 (rate-limit IP key bypassable).

**P2/P3 confirmed (8):** FIN-003, FIN-005, FIN-013, IDEMP-003, IDEMP-009, SEC-004, SEC-005, DB-004/DB-009.

**Controls confirmed working (positive):** the AI daily-allowance reservation reserves and releases correctly and **fails closed** when its lock is unavailable; the emergency kill switch stops a turn before the provider with no cache; cross-user AI isolation holds; the write-origin CSRF boundary refuses a mismatched Origin; every platform mutation and cross-area read returns 403 for READ-only and no-grant operators; tenant isolation holds at the database layer; unique, partial-unique and foreign-key constraints are enforced.

## 5. Refuted / reclassified (lower risk)

- **TEST-003** — the feared "a table granted to the app role without an RLS policy could be cross-tenant readable" is **REFUTED for tenant data**: the live census shows the only grant-without-policy tables are the eight reference/`RateLimit` tables, by design. The missing CI census gate remains a testing-debt item, not a latent exposure.
- **UI-001** — operator widgets do show WRITE controls to READ holders, but the server refuses every such call (403). Reclassified from P2 to a **P3 UX** defect.
- **DB-009 (UserSession)** — a usable revocation index exists; only two indexes are genuinely missing.

No P0 or P1 was contradicted.

## 6. Unverified (Production-only; the cutover gates)

OPS-015 (Production still serves v2.5), OPS-013 (no job has ever run in a deployed v2.6 environment), DB-007 (backup/PITR and restore drill), DB-003 (the Supabase PG17.6 table-owner RLS bypass — the disposable stack is PG16), SEC-002 exploitability and ARCH-003 exploitability against the real edge, and the Preview presence of `RESEND_API_KEY` and an external health monitor. The single most valuable additional test before cutover is to re-run the six acceptance suites against a PG17.6 Supabase clone.

## 7. Top 10 confirmed runtime risks (ranked)

1. SEC-001 — password-only admin can read the server-rendered admin inventory (reproduced).
2. FIN-001 — a late paycheck silently zeroes projected payroll under a complete-estimate label ($15,000 → $0).
3. IDEMP-002 — the account purge is non-transactional and double-runnable, duplicating irreversible deletions.
4. OBS-001/002/003 — the alerting path cannot report a dead evaluator, a dead job, or an undeliverable alert.
5. FIN-002 — the only customer-facing correction lever cannot change a transaction's economics.
6. IDEMP-001 — concurrent CSV import duplicates every row and leaves un-rollbackable batches.
7. SEC-AI-003 — compounding retries turn one failed turn into 18 provider calls (cost and latency).
8. SEC-008 + ARCH-003 — open registration default plus a bypassable rate-limit key (sign-up abuse surface).
9. IDEMP-009 — the AI spend ledger is fire-and-forget, so the allowance can under-count.
10. Production reality (OPS-015/013, DB-003/007) — the candidate has never run in a deployed environment and the Supabase RLS bypass is unproven; untestable here, and the dominant gate.

## 8. Revised decision and sequence

**CONDITIONAL GO**, 5.9/10, unchanged. Invite the first five users only after: the nine Tier-1 runtime-confirmed fixes land with tests and a green exact-SHA CI; governance (branch protection, dependency-audit and RLS-census CI gates, repository-visibility decision, STATUS re-baseline); and the Production cutover with the PG17.6 acceptance-suite rehearsal added to its gate list and an external `/api/health` monitor live. Full ordering in `11-REMEDIATION-PRIORITIES.md`; per-finding evidence in `02`–`08`; reconciliation in `09`; scores in `10`; artifacts in `12-EVIDENCE-INDEX.md`.

## 9. Final numbers

| Question | Answer |
|---|---|
| Runtime verification coverage | 11/11 runtime-testable P1s reproduced; 306/306 DB acceptance checks; AI, Spaces, observability exercised live |
| Confirmed P0 | 0 |
| Confirmed P1 | 11 (plus 8 P2/P3) |
| Refuted / reclassified | TEST-003 (hole refuted), UI-001 (→ P3), DB-009 UserSession (narrowed) |
| Unverified | OPS-015/013, DB-003/007, SEC-002/ARCH-003 edge exploitability, Preview env presence |
| Beta readiness | 5.9 |
| Security | 6.6 |
| Financial integrity | 6.1 |
| Idempotency | 6.2 |
| Reliability | 5.6 |
| Customer Spaces | 6.1 |
| Operator Spaces | 6.5 |
| Observability | 5.2 |
| Decision | CONDITIONAL GO |
