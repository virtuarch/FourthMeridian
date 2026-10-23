# 01 — Executive Summary

**Fourth Meridian pre-beta audit** · branch `v2.6` · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` (verified; the last approved commit named in the brief) · audit date 2026-10-21 · strictly read-only (no code, schema, data, config, credentials, deploys or pushes were changed; nothing was committed).

## 1. Decision

**CONDITIONAL GO — not ready today.** Fourth Meridian may invite its first five external beta users once the conditions in §5 are met. No P0 finding was confirmed: no cross-customer data exposure, no authentication bypass that yields a session, no privilege escalation, no double charging, no unbounded AI spend path, no secret disclosure, no destructive data-loss path reachable by a normal user. The code that exists is more carefully built than most pre-beta products: defence-in-depth tenant isolation (application predicates plus Postgres Row-Level Security), session rows proved on every request, a fail-closed AI allowance reservation, insert-only financial archives with database uniqueness, and a CI job that runs 306 adversarial checks against real database roles.

What stops a GO today is not a single defect but the combination of (a) a Production that still serves the July v2.5 release with no RLS and a shared session secret, 872 commits and 38 migrations behind the candidate, whose own cutover plan is NO-GO on its own gates; (b) a small set of P1 defects that are each cheap but touch the things a financial beta cannot get wrong (MFA enforcement on admin pages, a forecast that silently drops all payroll after one late paycheck, a category correction that cannot change the economics, deletion that leaves shared financial data behind); (c) delivery governance that would let a red commit auto-deploy to Production from a public repository with no branch protection and no dependency gate; and (d) an alerting path that cannot detect its own death.

**Overall beta-readiness score: 5.9 / 10** (functional with significant gaps). Confidence: high on code (every API route, every Prisma model, every alert rule, every widget read); evidence coverage: static only. The local database was down, no running app or browser was available, and Preview/Production were not touched, so every live measurement is UNVERIFIED and no performance figure in this audit is measured.

## 2. Weighted scorecard

| Group | Score | Weight | Basis | Confidence |
|---|---|---|---|---|
| A. Architecture & engineering | 6.7 | 10 | `02-ARCHITECTURE.md` | high |
| B. Security & privacy | 6.4 | 20 | security 6.6 (×0.7) + privacy 5.8 (×0.3); `03`, `11` | high / UNVERIFIED live RLS catalog |
| C. Financial integrity | 6.1 | 20 | financial integrity 6.1, idempotency 6.2; `04`, `05` | high (code), nothing executed |
| D. Reliability & operations | 5.6 | 15 | reliability 5.3 (×0.6) + database 6.0 (×0.4); `06` | high (structure), all scaling PREDICTED |
| E. Code quality & maintainability | 6.1 | 3 | `07` | high |
| F. Testing & delivery | 4.6 | 10 | `08` | high |
| G. Customer-facing Spaces | 6.1 | 7 | `09` | medium (no runtime) |
| H. Operator-facing Spaces | 6.4 | 5 | `09` | medium (no runtime) |
| I. Internal observability | 5.2 | 10 | `10` | high (code) / low (live) |
| **J. Overall beta readiness** | **5.9** | 100 | weighted mean of A–I | — |

Weights reflect what can hurt a consumer-finance beta most: security/privacy and financial correctness carry 40%; reliability, testing and observability (the ability to notice and recover) 35%; the Spaces and code quality the remaining 25%. Calculation: Σ(score × weight) / 100 = 593 / 100 = 5.9. A P0 would have overridden the average regardless; none was confirmed.

Findings counted once each across the thirteen reports (coordinator severities): **P0: 0 · P1: 34 · P2: 77 · P3: 73.** The P1 set is large because the audit was asked to be unsparing, not because the system is fundamentally unsafe: 23 of the 34 are code changes of a day or less, five are owner configuration or decision acts, and the rest are testing or documentation debt.

## 3. Top 10 risks (ranked by actual risk to real customers)

1. **Production is not the candidate** (OPS-015, DB-007, OPS-013). Production serves `87e4df7` (v2.5) with 0 of 55 tables under RLS and the pre-P1 shared `NEXTAUTH_SECRET`; the candidate has never booted there; no scheduled job has ever run in any deployed v2.6 environment; no database restore has ever been rehearsed; PITR is "No record". The cutover plan's own gates 1-11 and issues 1-6 are open.
2. **Forced-MFA bypass on server-rendered pages, including `/admin`** (SEC-001, with SEC-006). The browser can clear `requireTotpSetup` through NextAuth's `update` trigger; the proxy trusts it; the admin and dashboard layouts never re-check the database-derived flag. Password-only access to the admin inventory. Latent today (both Production admins are enrolled), opened by the next admin onboarding or 2FA reset.
3. **The alerting path cannot report its own death** (OBS-001/002/003, OPS-002). Alert evaluation runs inside the cron it watches; a dead cron leaves "Alerts: Quiet" green forever; the `dead` job state is never alerted; an e-mail captured in memory counts as delivered for 20 hours; there is no external monitor.
4. **Delivery governance** (TEST-001, TEST-005, SEC-002, SEC-018). No branch protection or rulesets on `main` or `v2.6`; Production auto-deploys from `main`; a red run has landed on `main` before; `next@16.2.7` and `next-auth@4.24.14` carry 17 and 3 published advisories with no `npm audit` in CI; the repository is public with the Production project ref, deployment ids and the full cutover runbook in it.
5. **Customer-visible financial wrongness with a clean label** (FIN-001, FIN-002). One paycheck four days late drops every remaining paycheck from `project_cash` while the answer is still "evidence-based"; a user's category correction cannot change the economic classification of any Plaid row, so the only correction lever does not reach money.
6. **Deletion is not deletion** (PRIV-001, PRIV-002, IDEMP-002). Sole-member shared Spaces survive "permanent" deletion with accounts and transactions; raw e-mails persist in audit metadata; the purge is non-transactional, checks "due" once, and can run twice.
7. **More customer data reaches OpenAI than the product says, with no point-of-use notice** (SEC-AI-005, PRIV-010/011/012). Raw Plaid descriptors (which carry partial card and reference numbers), masks, institutions and member first names are sent; the legal page lists "merchant, amount, date and category"; the waitlist form has no privacy notice and its rows are never purged.
8. **AI spend is bounded by estimates over an unreliable ledger** (SEC-AI-003, IDEMP-009/OBS-005, SEC-AI-002). The OpenAI client runs on SDK defaults (10-minute timeout, two invisible retries); the invocation ledger that the allowance reads is fire-and-forget; worst-case overshoot is ~3× the reserve. No fleet-wide gate (alert only).
9. **Idempotency gaps in the two customer write paths that are not provider-keyed** (IDEMP-001, OPS-001). CSV import duplicates rows on a double submit and leaves stuck batches; the bank sweep has no time budget and starves its tail once ~40-100 Items are connected.
10. **CI would not catch regressions in exactly the areas above** (TEST-002/003/004). 187 API routes, 6 route tests, 1 real handler test; no handler tests for login, reset, TOTP, email verification or session revocation; no gate asserts every table granted to the app role has an RLS policy; the owner-client ratchet is per-file. Customer-side, outages render as empty states with no error boundary anywhere under `app/` (UI-006/007).

## 4. What is genuinely strong (verified)

Route authorisation (all 187 routes guarded; 45 object-level checks hand-verified correct); session proof and cookie hygiene; parameterised SQL everywhere; Plaid webhook verification; the Markdown output sink; AES-256-GCM with HKDF sub-keys; the RLS programme (62/70 models, transaction-local identity, strict-mode boot refusal, six acceptance suites in CI); the AI allowance reservation and kill switch (fail-closed, no cache, CONTROL-gated with reason); the Daily Brief claim; the Plaid per-Item lease and cursor-safety gate; net worth computed by one function and agreeing across five surfaces; FX that never substitutes 1.0; the Policies and AI Cost Controls editors (reason, version token, armed confirm, in-transaction audit); and an incident-born culture of regression pins.

## 5. Conditions for a GO (all required)

| # | Condition | Closes | Owner | Effort |
|---|---|---|---|---|
| G0 | Execute the Production cutover plan with every §6 gate and §8 issue 1-6 green: clone rehearsal of all pending migrations, every job body exercised once on Preview under the role topology, a rehearsed restore with recorded RPO/RTO and PITR confirmed, `registration_mode` seeded `invite_only`, Turnstile keys and `PLATFORM_ALERTS_EMAIL` set, `FM_RLS_STRICT` + role URLs, secret rotation | OPS-015, OPS-013, DB-007, SEC-008 | owner | 3-5 days owner/ops |
| G1 | Fix the page-level TOTP gate (drop the client-updatable claim; re-check `session.requireTotpSetup` in both layouts) with a regression test; require the actor's live TOTP on admin 2FA reset | SEC-001, SEC-006 | engineering | 0.5-1 day |
| G2 | Upgrade `next` ≥ 16.3.8 and `next-auth` to the fixed 4.24.x; add `npm audit --omit=dev --audit-level=high` and Dependabot to CI | SEC-002, TEST-005 | engineering | 1 day |
| G3 | Rulesets on `main` and `v2.6` requiring the three CI jobs, no force-push, no deletion; an explicit owner decision on repository visibility (make private, or scrub operational docs from the public tree) | TEST-001, SEC-018 | owner | 0.5 day |
| G4 | Alert the `dead` job state; treat `captured` e-mail as not delivered outside development; age-gate the alerts posture chip; register an external monitor on `/api/health` that exposes `lastEvaluatedAt` | OBS-001/002/003, OPS-002 | engineering + owner | 1 day |
| G5 | OpenAI client with explicit `timeout` (~90 s) and `maxRetries: 0`; `await` the invocation ledger write; confirm and record the OpenAI project spend limit per environment | SEC-AI-003, IDEMP-009, SEC-AI-001 | engineering + owner | 1 day |
| G6 | Scrub `merchant`/`description` on every AI tool row as the Brief already does; align the AI legal page with the real payload; one point-of-use sentence that inputs are processed by OpenAI; privacy notice and consent on the waitlist form | SEC-AI-005, PRIV-010/011/012 | engineering + counsel | 1-2 days |
| G7 | Delete sole-member shared Spaces on purge; hash e-mails in audit metadata; make the purge claim-first and transactional with a re-check before the destructive tail; table-census deletion test | PRIV-001/002, IDEMP-002, TEST-009 | engineering | 1-2 days |
| G8 | Make a recently-silent payroll stream a blocking `INCOMPLETE_ESTIMATE` and split LAPSED from UNKNOWN; let a user correction change `flowType` on PFC-bearing rows | FIN-001, FIN-002 | engineering | 3-4 days |
| G9 | Either an `ImportBatch` idempotency key (file hash) with `maxDuration` and stale-batch rollback, or manual CSV/XLSX import disabled for the beta cohort | IDEMP-001 | engineering or owner | 1 day / decision |
| G10 | Confirmation dialogs on member removal, role change, archive and account revoke; surface failed reads in the Space host instead of empty states; a segment `error.tsx` under the dashboard and platform routes | UI-003, UI-006, UI-007 | engineering | 1-2 days |
| G11 | One client-IP extractor used by rate limiting, audit and auth | ARCH-003 | engineering | 0.5 day |
| G12 | A scripted Preview smoke of register → verify → login (+TOTP) → logout → reset, or handler-seam tests for those routes; a CI census that every route carries a recognised guard and every fm_app-granted table has a policy | TEST-004, TEST-002, TEST-003 | engineering | 2-3 days |
| G13 | STATUS.md re-baselined to the merged HEAD per the owner's own maintenance rule (it does not record the UI hardening merge, the fail-closed reservation, or any gate on `cde8fa0`) | SEC-AI-011 | owner | 0.5 day |

Estimated work: **approximately 15-20 engineering days plus 3-5 days of owner/operations acts and one external legal review of the privacy/AI wording**; four to six calendar weeks for a solo maintainer. Everything else in `12-BETA-RELEASE-PLAN.md` is P2/P3 and can run during the beta.

## 6. Recommended beta scope

- At most five invited users, US-based, USD reporting currency (the FX paths are sound but non-USD disclosure gaps exist).
- Owner-operated: the owner checks the Platform Operations console daily until OBS-001 and OBS-004 land; no unattended operation.
- Plaid Transactions (Investments only with explicit consent); wallets and manual assets allowed; manual CSV/XLSX import off or supervised until G9.
- AI conversations and Daily Brief on, at the $5/day allowance with the kill switch verified on Production; harness scripts never pointed at the Production key.
- Shared Spaces allowed among the five; public-Space join stays off (it is already "coming soon"); Markets hidden or marked coming-soon.
- Expand beyond five only after: OBS-004 (incident rule), OPS-001 (bank-sweep budget), DB-005 measured (pool sizing), route-level tests for Space mutations, and the retention jobs (DB-001).

## 7. Where to read next

`SCORECARD.md` (every grade on one page) · `12-BETA-RELEASE-PLAN.md` (the full P0-P3 backlog with owners, effort and verification) · `13-EVIDENCE-INDEX.md` (commands, files, tests, limitations, unverified claims) · the eleven subject reports `02`-`11`.
