# 11 — Remediation Priorities (runtime-informed)

This refines `../12-BETA-RELEASE-PLAN.md` with what runtime verification established. Nothing is fixed here — this phase only decides which problems are real, which are theoretical, and which still need Production-only evidence. Fixes remain unauthorised.

## Tier 1 — confirmed at runtime, fix before inviting users

All reproduced on the isolated stack; each is a small, well-understood change.

1. **SEC-001 — admin/dashboard TOTP page-gate bypass** (reproduced by the workstream and the coordinator). Stop honouring the client-supplied `requireTotpSetup` in the `jwt` callback; re-check `session.requireTotpSetup` in `app/admin/layout.tsx` and `app/(shell)/dashboard/layout.tsx`; add a test that a pending session cannot render `app/admin/page.tsx`. Pair with **SEC-006** (verify the actor's live TOTP on admin 2FA reset) — the two compose into a password-only admin path.
2. **FIN-001 — late paycheck zeroes projected payroll under a "complete" label** ($15,000 → $0 measured). Make a recently-silent current-eligible stream a blocking `INCOMPLETE_ESTIMATE` with the omitted bound; split `LAPSED` from feed-stale `UNKNOWN`; derive `observedThroughISO` from the account sync clock, not the newest income row.
3. **FIN-002 — user category correction cannot change `flowType` on PFC rows**. Suppress PFC when `categorySource ∈ {USER_RULE, USER_OVERRIDE}`, or add a USER flow authority; pin with a PFC-bearing fixture.
4. **IDEMP-002 — non-transactional, double-runnable purge** (reproduced: 4 deletion-audit rows for 2 users). Claim-first (`updateMany … purgeStartedAt IS NULL`, assert count 1), re-check due-ness before the destructive tail, wrap the tail in one transaction. Highest-consequence idempotency defect because the duplicated side effects are irreversible.
5. **IDEMP-001 — CSV import duplicates on concurrent submit** (0 → 12 rows). Add an `ImportBatch` idempotency key (file hash) claimed before parsing; declare `maxDuration`; allow rollback of stale `PROCESSING` batches. Or disable manual import for the beta cohort (owner decision).
6. **SEC-AI-003 — compounding provider retries** (18 calls for one 429'd turn). Build the OpenAI client with an explicit `timeout` (~90 s) and `maxRetries: 0`; add a per-hop abort deadline to the chat tool loop.
7. **OBS-002 / OBS-003 / OBS-001 — alerting blind to its own failures** (all reproduced). Alert the `dead` job state (one line in `evaluateSchedulerSilent`); treat `captured` e-mail as not delivered outside development; age-gate the posture chip; add an external `/api/health` monitor that reads `lastEvaluatedAt`. Pairs with OPS-002.
8. **SEC-008 — open registration default** (201 with no invite). Seed `registration_mode=invite_only` in the cutover runbook; set Turnstile keys.
9. **ARCH-003 — single client-IP extractor** (limiter bypassable by rotating `x-forwarded-for`). One `getClientIp` used by rate limiting, audit and auth.

## Tier 2 — confirmed, fix during the five-user beta

10. **FIN-003** negative income adds to income · **FIN-005** restricted-cash liquid divergence · **IDEMP-003** dispatch double-execution (advisory lock / partial unique running row) · **IDEMP-009** await the `AiInvocation` insert · **SEC-004** CSV formula escaping on export · **SEC-005** throttle and narrow `/api/users/search` · **DB-009** add the two confirmed-missing indexes · **DB-004** a user-keyed RLS policy on `RateLimit`.

## Tier 3 — reclassified downward by runtime (lower urgency than the static pass implied)

11. **TEST-003** — the feared cross-tenant grant-without-policy hole is **refuted**; what remains is a missing CI census gate (add `grants ⊆ tables-with-policy` to `rls-acceptance.ts`). Testing debt, not exposure.
12. **UI-001** — operator widgets show WRITE controls to READ holders, but the server refuses every such call. **P3 UX**: hide or disable the controls with the explanatory line the connection-health widget already uses.
13. **UI-003 / UI-006 / UI-007** — confirm dialogs on destructive customer actions; surface failed reads instead of empty states; add segment `error.tsx`/`loading.tsx`. UI-006/007 confirmed in code; the user-visible effect is UNVERIFIED without a browser.

## Tier 4 — still UNVERIFIED; the Production cutover gates (unchanged, dominant)

These could not be tested from an isolated box and remain the master conditions; they gate GO regardless of the Tier 1 fixes.

14. **OPS-015 / OPS-013** — Production still serves v2.5; no job has run in a deployed v2.6 environment. Execute the cutover plan's §6 gates and §8 issues 1-6.
15. **DB-007** — backup/PITR confirmation and a rehearsed restore with recorded RPO/RTO.
16. **DB-003** — re-run the six acceptance suites against a **PG17.6 Supabase clone** (the disposable proof here is PG16; the Supabase table-owner RLS-bypass question is only answerable there). This is the single most valuable additional test before cutover.
17. **SEC-002** — upgrade `next`/`next-auth`; add the CI dependency audit (exploitability against the real edge UNVERIFIED).
18. **Preview checks** — confirm `RESEND_API_KEY` presence on Preview (else OBS-003 means "delivery" there was `captured`), and that an external monitor polls `/api/health`.

## Recommended remediation sequence

1. Land the Tier 1 code fixes (items 1-9) on `v2.6` with their named tests; run the exact-SHA CI and read the run.
2. Governance in parallel: branch-protection rulesets, the CI dependency-audit and RLS-census gates, the repository-visibility decision (SEC-018), STATUS.md re-baseline.
3. The Production cutover (Tier 4) with the PG17.6 acceptance-suite rehearsal (item 16) added to its gate list; this is where DB-003/007 and OPS-013/015 are closed.
4. Invite five users, owner-operated, with the external health monitor live (item 7 / OPS-002).
5. Tier 2 during the beta; Tier 3 and the remaining P2/P3 backlog from `../12-BETA-RELEASE-PLAN.md` as scheduled; expand past five only after OBS-004, OPS-001, DB-005 measured, and route-level Space-mutation tests.
