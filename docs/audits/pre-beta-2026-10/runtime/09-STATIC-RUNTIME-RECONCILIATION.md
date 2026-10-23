# 09 — Static / Runtime Reconciliation

Runtime verification of the static pre-beta audit (`docs/audits/pre-beta-2026-10/`). HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` (v2.6), verified. All testing was on an isolated throwaway stack: a Next dev server from a clean detached worktree, a disposable `postgres:16` container (migrated + seeded, RLS strict with the three role clients bound and verified via `/api/platform/platform-ops/db-authority`: 70 public tables, 62 ENABLE+FORCE, 246 policies), OpenAI fully mocked in-process (non-loopback egress blocked), every seeded Plaid Item set to REVOKED, synthetic accounts only. No Preview or Production access, no real customer data, no code change, nothing committed or deployed.

Classification per the brief: **CONFIRMED** (reproduced at runtime) · **SUPPORTED** (strong static evidence, not reproduced here) · **REFUTED** (runtime contradicts the finding) · **PARTIAL** (some behaviour reproduced) · **UNVERIFIED** (safe verification unavailable). A finding is never downgraded merely because one test could not reproduce it; the environment limitation is recorded instead.

## 1. Coverage

| Static area | Runtime method | Outcome |
|---|---|---|
| Security (SEC-001/004/005/006/008/010/013, ARCH-003, TEST-002/003/004) | live HTTP against the server with the three synthetic roles; code reads | mostly CONFIRMED; coordinator independently reproduced SEC-001 |
| Financial (FIN-001/002/003/004/005/013) | real engine modules exercised deterministically off-server with injected DB readers | FIN-001/002/003/005/013 CONFIRMED; FIN-004 SUPPORTED |
| Idempotency (IDEMP-001/002/003/006/009) | bounded concurrent requests + tsx probes on the throwaway DB | 001/002/003/009 CONFIRMED; 006 PARTIAL |
| AI reliability (SEC-AI-001/002/003 + allowance/kill-switch/isolation, IDEMP-009) | mocked provider with scripted failure modes; fixtures on the throwaway DB | controls CONFIRMED working; SEC-AI-003 CONFIRMED defect; IDEMP-009 SUPPORTED |
| Spaces (UI-001/003/006/007, permission enforcement) | HTTP with three roles; code reads (no browser) | permission enforcement CONFIRMED; UI-001 reclassified; UI-006/007 CONFIRMED in code |
| Observability (OBS-001/002/003) | fixtures + the live alert evaluator on the throwaway DB | all three CONFIRMED |
| Database (RLS census, tenant isolation, constraints; DB-004/009/013, TEST-003) | live catalog census + the six acceptance suites on their own clones | 306/306 suites pass; census CONFIRMED; TEST-003 REFUTED for tenant data |
| Production-only (OPS-013/015, DB-003/007, SEC-002 exploitability) | not reachable from an isolated box | UNVERIFIED (cutover gates) |

Runtime coverage: of the 34 static P1 findings, **11 were runtime-testable and all 11 reproduced** (one, IDEMP-009, partially); the rest are either Production-environment gates (untestable here) or configuration/testing/documentation items whose truth is established by inspection. No finding was contradicted except as noted in §4.

## 2. Confirmed findings (reproduced at runtime)

| ID | Static sev | Runtime evidence (sanitised) | Class |
|---|---|---|---|
| **SEC-001** | P1 | Pending `sysadmin` session: `/api/admin/users` 403, `/admin` 307. After `POST /api/auth/session` with `data.requireTotpSetup=false` (the `useSession().update` equivalent): `/admin` 200 with all four users' e-mails server-rendered, `/admin/providers` 200, API still 403. Coordinator reproduced the identical sequence independently. | CONFIRMED |
| **FIN-001** | P1 | 11 on-time biweekly paychecks + one slot 5 days overdue ⇒ stream SILENT/UNKNOWN ⇒ completeness LAPSED ⇒ `project_cash` returns `EVIDENCE_BASED_ESTIMATE` with all remaining payroll dropped. Measured delta vs on-time control: **$15,000 → $0** at identical opening cash. | CONFIRMED |
| **FIN-002** | P1 | `recomputeFlowFields` on a PFC-bearing row keeps `flowType=INCOME` for every user category (Transfer/Dining/Payment); PFC-null control flips correctly. | CONFIRMED |
| **IDEMP-001** | P1 | Two concurrent identical imports of a 6-row reference-less CSV ⇒ account 0 → **12** transactions (exact 2×), two batches; a `PROCESSING` batch returns 409 "cannot be rolled back". | CONFIRMED |
| **IDEMP-002** | P1 | Two concurrent `process-deletions` runs both executed the destructive tail: **4 `ACCOUNT_DELETED` audit rows for 2 users**; the loser failed only at the final `user.delete` (P2025) after deleting everything else. | CONFIRMED |
| **SEC-AI-003** | P1 | One chat turn under mocked `429` drove **18 provider calls** (6 app attempts × 3 SDK retries); the OpenAI client is built with no `timeout`/`maxRetries`. | CONFIRMED |
| **OBS-001** | P1 | A 30-day-stale quiet evaluation still yields posture `word:"Quiet", tone:"ok"`; the live `/overview` alerts chip carries no age/staleness field. | CONFIRMED |
| **OBS-002** | P1 | A seeded `dead` job ⇒ `scheduler-silent firing:false`; the same job backdated to merely `overdue` ⇒ `firing:true, critical`. The stronger failure state is the silent one. | CONFIRMED |
| **OBS-003** | P1 | With no Resend key, live `JobRun.summary` shows `deliveryStatus:captured, delivered:1`, a breach in `fired[]`, then `suppressed` (20 h). | CONFIRMED |
| **SEC-008** | P1 (config) | `POST /api/auth/register` with no invite ⇒ 201, account created (default mode open). | CONFIRMED |
| **ARCH-003** | P1 | Register limiter keyed purely on `x-forwarded-for`; same XFF ⇒ 429, fresh XFF ⇒ not limited; `cf-connecting-ip` never consulted. Production edge topology still UNVERIFIED. | CONFIRMED (mechanism) |
| FIN-003 | P2 | A −$500 clawback adds $500 to income (`income += Math.abs`). | CONFIRMED |
| FIN-005 | P2 | Hero `totalLiquid` $12,000 vs snapshot `netLiquid` basis $17,000; the $5,000 difference is restricted HSA cash. | CONFIRMED |
| IDEMP-003 | P2 | Two concurrent dispatch wakes ran all 11 due jobs twice (no row-level claim). | CONFIRMED |
| IDEMP-009 | P2 | `recordAiInvocation`/`…Failure` resolve despite a throwing write client; call sites are `void`. Happy-path rows were present at response time. | CONFIRMED (swallow) / SUPPORTED (under-count magnitude) |
| SEC-004 | P2 | `POST /api/user/export` zip contained `=RTVINJECT()+1` as a bare unescaped formula cell. | CONFIRMED |
| SEC-005 | P2 | `alex` (no grants) walked the whole user directory with single-character queries, 0/10 throttled. | CONFIRMED |
| DB-004 | P3 | Live catalog: 62/62 `fm_system` policies are `USING(true)`; 8 tables (reference + `RateLimit`) have no RLS; `RateLimit` granted full CRUD to `fm_app` with no policy. | CONFIRMED |
| DB-009 | P3 | `PlaidItem.syncIncompleteAt` and `SpaceGoal.deletedAt` indexes confirmed missing. | CONFIRMED |
| FIN-013 | P3 | 64 Float money columns, 0 Decimal; a real fold yields `0.1+0.2=0.30000000000000004`. Display-safe. | CONFIRMED |
| TEST-002 / TEST-004 | P1/P2 | 187 routes / 6 route tests; `auth/**`, `user/totp/**`, `user/sessions/**` have 0 handler tests. | CONFIRMED (counts) |

Positive confirmations (controls that work at runtime): the AI daily-allowance reservation reserves and releases correctly (in-flight bucket 0→1→0; exhaustion returns 429 with no provider call); the reservation **fails closed** (503 `RESERVATION_UNAVAILABLE`) when its lock is made unavailable; the emergency kill switch stops a turn before the provider with no cache; cross-user AI isolation holds (403 on a mismatched Space); the write-origin CSRF boundary refuses a mismatched `Origin`; every platform mutation and cross-area GET returns 403 for READ-only and no-grant operators; all six RLS acceptance suites pass (306/306); tenant isolation holds at the DB layer (no identity ⇒ 0 rows; cross-tenant SELECT/UPDATE/DELETE ⇒ 0 rows); unique, partial-unique and foreign-key constraints are present and enforced.

## 3. Supported (strong static evidence, not reproduced here)

| ID | Why not reproduced |
|---|---|
| SEC-006 (admin 2FA reset no step-up) | The only admin fixture must stay TOTP-pending for SEC-001; `adminTotpCode` is read but never verified (code-confirmed). |
| SEC-010 (no idle/absolute session lifetime) | A 30-day window is not time-testable; `UserSession` has no `expiresAt` (schema-confirmed). |
| FIN-004 (Cash Flow pending/local-clock vs AI settled/UTC) | Divergence confirmed in code; no straddling-pending fixture run through both renderers for a numeric split. |
| IDEMP-006 (valid-signature webhook replay) | Cannot forge a valid Plaid signature; the unsigned replay is correctly rejected (401, 0 rows). |
| SEC-002 (framework advisories exploitability) | Upgrade exposure is a policy matter; no exploit attempted. |
| TEST-003 (missing CI census gate) | The gate's absence is confirmed by inspection; see §4 for the hole it was feared to hide. |

## 4. Refuted or reclassified (runtime lowers the risk)

| ID | Static framing | Runtime finding | Disposition |
|---|---|---|---|
| **TEST-003** | A table could be granted to `fm_app` without an RLS policy and be cross-tenant readable; no CI gate proves otherwise | Live catalog census: the only grant-without-policy tables are the 8 reference/`RateLimit` tables (by design = DB-004). **No user, Space or account table is cross-tenant readable.** | The feared live hole is **REFUTED**; the missing CI census gate remains real but is a testing-debt item, not a latent exposure. Net risk lower. |
| **UI-001** | Five operator widgets render WRITE controls to READ holders | Every sampled mutation returns 403 server-side for READ-only (`john`) and no-grant (`alex`) operators; `jane` (CONTROL/WRITE) is accepted. | The server enforces correctly; UI-001 is a **UX clarity defect (P3)**, not a security gap. Reclassified P2→P3. |
| DB-009 (UserSession) | "no reaper index at all" | A usable revocation-related index exists; only `PlaidItem.syncIncompleteAt` and `SpaceGoal.deletedAt` are genuinely missing. | Partially REFUTED; scope narrowed. |

No P0 or P1 finding was contradicted. SEC-001, FIN-001, FIN-002, IDEMP-001 and IDEMP-002 — the findings most consequential for customer trust — were reproduced with concrete destructive or financial evidence.

## 5. Unverified (safe verification unavailable on an isolated box)

OPS-015 (Production is still v2.5), OPS-013 (no job has run in a deployed v2.6 environment), DB-007 (backup/PITR and restore drill), DB-003 (Supabase table-owner RLS bypass on PG17.6 — the disposable stack is PG16), SEC-002 exploitability against the real edge, ARCH-003 exploitability (depends on whether Cloudflare/Vercel overwrites `x-forwarded-for`), the Preview/Production presence of `RESEND_API_KEY` and any external `/api/health` monitor, and FIN-004's numeric split. These are the cutover gates and the Production-edge questions; the static audit already marked them UNVERIFIED and runtime cannot close them without Production access.

## 6. Environment differences from Production (apply to every finding)

Dev server (webpack) in a single Node process; in-memory rate limiter (`NODE_ENV=development`); http session cookie (`next-auth.session-token`, not `__Host-`); OpenAI mocked in-process (SDK network timeout/retry inferred from code plus the mock honouring `retry-after`); no Vercel lambda kill (a real `maxDuration=300` would cut a hung call the dev server does not); disposable `postgres:16` with RLS strict and the three roles bound (Production has none yet); dummy provider credentials; no Sentry. The single process means cross-instance and Vercel-cron-overlap races were reproduced by in-process `await` interleaving — sufficient to prove the TOCTOU, and only easier at Production scale. The database layer is PG16, not Supabase PG17.6.
