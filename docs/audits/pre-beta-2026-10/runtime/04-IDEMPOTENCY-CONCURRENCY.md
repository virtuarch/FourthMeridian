> Runtime verification deliverable · HEAD cde8fa0 (v2.6) · 2026-10-21 · isolated throwaway stack (synthetic data, OpenAI mocked, Plaid Items set REVOKED, no Preview/Production access). Classifications: CONFIRMED / SUPPORTED / REFUTED / PARTIAL / UNVERIFIED. This is the verifying workstream's report; the coordinator independently reproduced SEC-001 and cross-checked every promoted claim (see 09-STATIC-RUNTIME-RECONCILIATION.md).

# Workstream IDEMP (N=3) — Idempotency & Concurrency runtime verification

HEAD under test: `cde8fa0` (v2.6). Server: http://127.0.0.1:3100 (Next dev, webpack, single Node process).
RLS strict (fm_app/fm_auth/fm_system). Owner DB: `fintracker_rtv` (throwaway). All requests sent with
`X-Forwarded-For: 10.3.0.x` (bucket isolation) and, for write routes, `Origin: http://127.0.0.1:3100` + jane's cookie.
Scripts/fixtures: `$S/rtv/idemp/`. Date 2026-10-21.

## Environment differences from Production (apply to every finding)
- **Single Node process, single instance.** Cross-instance races (two Vercel lambdas, Vercel cron overlap/retry,
  draining of `void` promises after the HTTP response) cannot be reproduced here. Where I reproduced a race it was by
  in-process interleaving at `await` points (DB round-trips) — which is *sufficient* to prove the TOCTOU, and strictly
  easier to trigger across instances in Production.
- In-memory rate limiter (`RATE_LIMIT_ENABLED=true`, NODE_ENV=development); http cookies (`next-auth.session-token`,
  not `__Host-`); OpenAI mocked in-process; Plaid creds dummy + every PlaidItem REVOKED; Resend absent (emails → in-memory
  capture adapter, not externally readable); Sentry DSN empty.
- **Rate-limit buckets key on `X-Forwarded-For`** — confirmed as a runtime observation: every test used a distinct
  `10.3.0.x` and never tripped a limiter, including two concurrent login-free cron calls.
- **Route-method note:** the brief specified `POST` for `/api/jobs/process-deletions` and `/api/jobs/dispatch`.
  Both routes export **`GET` only** (`withApiHandler(GET)`); a `POST` would 405. I used `GET` + `Authorization: Bearer rtv-cron-secret`.

---

## IDEMP-001 — CSV import: concurrent double-submit duplicates transactions; crash-shaped PROCESSING batch is un-rollbackable

- **Finding ID:** IDEMP-001 (P1, audit §4; matrix score 4/10)
- **Initial state:** jane's `Example CU Checking` (`cmviisb9j0038sem7jec2n2su`, USER-owned, HOME-linked to her PERSONAL
  Space `cmviisb7p001hsem70jj8mm37`). Transactions = **0**, ImportBatch = **0**.
- **Exact method:**
  - Fixture `$S/rtv/idemp/import.csv`: 6 rows, headers `Date,Description,Amount`, **no reference/id column** → dedupe
    falls to the fingerprint *read* (`resolveFingerprintOutcome`), never a DB constraint.
  - Replayed the UI multipart exactly: `curl -F "file=@import.csv;type=text/csv"` to
    `POST /api/accounts/{id}/import`, cookie jar = jane + `fintracker_space` cookie, `Origin` + XFF `10.3.0.11`.
  - Fired **two identical submits concurrently** (`$S/rtv/idemp/run_concurrent_import.sh`, 2 background curls, `wait`).
- **Expected (per finding):** duplicate transaction rows.
- **Actual:** both requests → **HTTP 201**, each body `importedCount:6, matchedCount:0`. Resulting rows = **12**
  (exactly 2× each of the 6 `(date,merchant,amount)` tuples; grouping shows count=2 for every tuple). Two distinct
  `ImportBatch` ids, each `COMPLETED` with `importedCount=6`.
- **Evidence:** before=0 → after=12; `distinct importBatchId` = {batchA:6, batchB:6}; per-tuple dup count uniformly 2.
- **Crash-shaped sub-case (rollback eligibility):** I did **not** crash the server. I simulated the stuck state by
  setting one batch to `status=PROCESSING, completedAt=null` in the throwaway DB (its 6 rows stay live), then
  `POST /api/imports/{batch}/rollback` as jane → **HTTP 409** `"Import batch is PROCESSING and cannot be rolled back.
  Only COMPLETED, COMPLETED_WITH_ERRORS, or FAILED batches are eligible."`; the 6 live rows **survived**. Static root:
  `ROLLBACK_ELIGIBLE_STATUSES = [COMPLETED, COMPLETED_WITH_ERRORS, FAILED]` (rollback route) — `PROCESSING`/`PENDING`
  excluded, so a mid-loop crash orphans rows the user cannot undo.
- **Static corroboration:** route declares **no `maxDuration`**; schema has **no `ImportBatch` idempotency key / fileSha**
  (grep returned NONE). Within-file dup detection is sequential-by-design, but offers nothing across concurrent requests.
- **Reproducibility:** 2/2 submits duplicated (deterministic in-process); rollback-409 deterministic.
- **Classification:** **CONFIRMED** (both halves: concurrent duplication AND un-rollbackable PROCESSING batch).
- **Remediation:** `@@unique([financialAccountId, fileSha256])` or a client idempotency key claimed before parsing;
  declare `maxDuration`; allow rollback (or a janitor) for stale `PROCESSING` batches; chunked `createMany`.

---

## IDEMP-002 — Account purge is non-transactional, re-checks "due" once, double-runnable via the fallback route

- **Finding ID:** IDEMP-002 (P1, destructive; matrix score 3/10)
- **Initial state:** two synthetic users inserted into the throwaway DB, `rtvidempdel0000000000001/2`
  (`@rtv.invalid`), each with `deletionScheduledAt = now()-2 days` (due). JobRun=0, ACCOUNT_DELETED audit=0.
- **Exact method:** fired **two concurrent** `GET /api/jobs/process-deletions` (Bearer rtv-cron-secret, XFF
  10.3.0.21/22). Then inspected JobRun, AuditLog, server.log, and whether the users remained.
- **Expected (per finding):** both invocations proceed; a single top-of-function due-check does **not** guard the
  irreversible tail; non-transactional ⇒ duplicate destructive side effects.
- **Actual — all three predictions reproduced:**
  - **Both invocations proceeded.** Two `process-deletions` JobRun rows, `startedAt` 20:07:55.**724** and .**725**
    (overlapping), both `succeeded`. One run's summary `{total:2, purged:2, failed:0}`, the other `{total:2, failed:2,
    purged:0}` — i.e. **both read the same 2 due users** before either deleted them (the fallback route bypasses the
    dispatcher's in-flight guard; `runJob` takes no lock / no conditional claim).
  - **The single due-check did NOT guard the destructive tail.** The "losing" run failed **only at the very last
    statement** — `purge.ts:333` `db.user.delete(...)` → **P2025** (record not found), logged
    `[process-deletions] purge failed for user … (will retry next run)`. It had already executed steps 5–7 of the tail.
  - **Duplicate irreversible side effects (the sharp evidence):** **4** `ACCOUNT_DELETED` AuditLog rows for **2** users
    (userId SetNull after delete) — i.e. step 7 (audit write) + the deletion-complete "security-alert" email ran
    **twice per user**. Both synthetic users ended **deleted**.
- **Evidence:** 2 JobRun rows (overlapping timestamps, both succeeded); server.log two `P2025` stacks at
  `purgeUser (lib/account-deletion/purge.ts:333)`; `ACCOUNT_DELETED` count = 4 for 2 users; users gone.
- **Static corroboration:** `purge.ts` contains **0** `$transaction` and **14** separate `db.*` writes
  (sessions→plaid→SALs→conn re-elect→`financialAccount.deleteMany`→`space.delete`→audit→email→`user.delete`); the only
  due re-check is `purge.ts:77-79`, at the top, a plain read — nothing re-validates `deletionScheduledAt` before the
  `deleteMany`/`delete` tail (the cancel-at-login race window).
- **Reproducibility:** this run reproduced the double-tail cleanly; the exact split (which run wins the final delete)
  is timing-dependent, but *both running the tail* is the invariant and was observed. Cancel-vs-purge lost-update is
  **SUPPORTED** statically (same missing re-check) — not separately exercised (would need mid-purge timing injection /
  a real crash, out of scope here).
- **Classification:** **CONFIRMED** (non-transactional + double-run + tail unguarded, with observed duplicate
  destructive side effects). Cancel-race sub-claim: **SUPPORTED**.
- **Remediation:** conditional claim `updateMany … where deletionScheduledAt ≤ now AND purgeStartedAt IS NULL` (assert
  count 1); re-check due immediately before `financialAccount.deleteMany`; wrap the DB tail in one transaction;
  make itemRemove/email side effects idempotent.

---

## IDEMP-003 — Job dispatch: concurrent wakes double-execute every due job (TOCTOU, no row-level claim)

- **Finding ID:** IDEMP-003 (P2; matrix score 5/10)
- **Initial state:** JobRun table held only the 2 process-deletions rows from IDEMP-002; all other registered jobs had
  never run (⇒ all due on wake).
- **Exact method:** recorded a DB `now()` cutoff, then fired **two concurrent** `GET /api/jobs/dispatch`
  (Bearer, XFF 10.3.0.31/32), then counted JobRun rows created after the cutoff, grouped by job.
- **Expected:** the dispatcher's in-flight guard (`selectDueJobs` reading ledger facts) is check-then-run with no
  row-level claim, so two overlapping wakes each select and run the same due set.
- **Actual:** both calls → **HTTP 200**. **Every one of 11 due jobs ran exactly twice** — `evaluate-alerts`,
  `fetch-fx-rates`, `fetch-security-prices`, `notification-cleanup`, `notification-retry`, `plaid-removal-retry`,
  `product-event-retention`, `purge-trash`, `rate-limit-sweep`, `sync-banks`, `sync-crypto` each produced 2 JobRun
  rows. No job was skipped by the overlap guard. Both wakes read the ledger facts before either inserted a `running`
  row, so each saw the other as "not running".
- **Evidence:** JobRun grouped after cutoff = 11 jobs × 2 runs = 22 rows; the `having count(*)>=2` query returned all
  11 job names. `evaluate-alerts` running twice is the live IDEMP-015 double-mail path.
- **Static corroboration:** `runJob` (`lib/jobs/run.ts`) inserts a `status:"running"` JobRun with a fresh
  `executionId` and **no advisory lock / no conditional claim**; `JobRun` has only `executionId @unique`. The fallback
  per-job routes call `runJob` directly, bypassing `selectDueJobs` entirely (demonstrated independently by the two
  concurrent process-deletions runs in IDEMP-002).
- **Reproducibility:** 11/11 jobs doubled on a single concurrent pair (deterministic here).
- **Classification:** **CONFIRMED** (in-process double-execution of every due job on concurrent dispatch). Note most
  downstream bodies are individually idempotent; the materially harmful doubles are the non-idempotent ones
  (process-deletions → IDEMP-002; evaluate-alerts → IDEMP-015).
- **Remediation:** `pg_try_advisory_xact_lock(hashtext(jobName))` or a partial-unique `running` row per job; abort the
  wake if the start-ledger write fails; add a stale-run reaper; align fallback `maxDuration` with the dispatcher.

---

## IDEMP-009 — AiInvocation ledger writes are fire-and-forget and swallow errors

- **Finding ID:** IDEMP-009 (P2; matrix score 6/10)
- **Initial state:** n/a (did not touch the AI workstream's mock; sent **no** chat/brief requests).
- **Exact method (statically-at-runtime, as instructed):**
  - Static: `lib/ai/provider.ts` calls `void recordAiInvocation(...)` (`:147`) and `void recordAiInvocationFailure(...)`
    (`:175`, `:237`, `:278`) — the returned promise is **never awaited**. Inside `lib/ai/invocation.ts` both recorders
    wrap the single `await client.aiInvocation.create(...)` in `try/catch` and only `console.warn('… (non-fatal)')`.
  - Runtime: `$S/rtv/idemp/idemp009-swallow.ts` imports the real recorders and calls each with a **deliberately
    failing write client** (`create: async () => { throw … }`), then checks whether the returned promise rejects.
    Ran via `tsx --require ./scripts/lib/server-only-preload.cjs` with `FM_DB_GUARD=clone-only` (no real DB write).
- **Expected:** the recorder resolves (does not reject) despite the insert throwing; the error is logged non-fatal and lost.
- **Actual:** both `recordAiInvocation` and `recordAiInvocationFailure` **resolved to `undefined`** (threw/rejected =
  `false`); each emitted `[ai/invocation] … failed (non-fatal): Error: LEDGER DB DOWN (synthetic)…`. Verdict printed:
  *"ERROR SWALLOWED — both recorders resolved despite the write throwing."*
- **Evidence:** script stdout (probe lines + the two non-fatal warnings with stacks at `invocation.ts:144` / `:178`).
- **Reproducibility:** deterministic.
- **Classification:** **CONFIRMED** (I exercised the recorder with a failing client and observed the swallow). The
  downstream consequence — the daily allowance under-counting a turn whose ledger insert failed — follows from the
  fire-and-forget shape but was not separately measured (would require the AI workstream's chat path); that consequence
  is **SUPPORTED**.
- **Remediation:** `await` the single insert before responding, or route it through a durable outbox.

---

## IDEMP-006 — Plaid webhook duplicate delivery (sampled: unsigned replay)

- **Finding ID:** IDEMP-006 (P2; matrix score 6/10)
- **Initial state:** `PlaidWebhookEvent` = 0.
- **Exact method:** sent the **same** crafted `TRANSACTIONS/SYNC_UPDATES_AVAILABLE` body **twice** to
  `POST /api/plaid/webhook` with an **invalid** `plaid-verification` header, then once with the header absent (XFF
  10.3.0.41). I did **not** forge a valid ES256 signature.
- **Expected:** rejected at verification; nothing recorded.
- **Actual:** all three → **HTTP 401** `{"error":"invalid webhook signature"}`; `PlaidWebhookEvent` stayed **0**.
  Confirms the route's contract (verify first; an invalid signature records nothing) and that unsigned replays never
  reach the dedup-less pipeline.
- **Evidence:** 401×3; row count 0→0.
- **Static corroboration:** `PlaidWebhookEvent` has only `@@index(...)` — **no `@@unique` and no body-hash column**
  (schema `:4353-4405`); `webhook-receiver.ts` appends one row per verified trigger and schedules a full pipeline.
- **Reproducibility:** deterministic.
- **Classification:** **PARTIAL** — the *verification gate* is **CONFIRMED** to reject unsigned replays (defense-in-depth
  holds); the core claim (a *validly-signed* duplicate/replay inside the 5-min `iat` window is not deduped and re-runs the
  pipeline) is **SUPPORTED** by schema/code but **UNVERIFIED at runtime** (cannot forge a valid signature without the
  Plaid signing key — correctly out of scope).
- **Remediation:** short-TTL unique on `sha256(rawBody)` + code + item; skip when present.

---

## Scores (Part-4 items touched) — static (audit) vs runtime-adjusted

| Item (finding) | Audit score | Runtime classification | Runtime-adjusted severity | Confidence | Key uncertainty |
|---|---|---|---|---|---|
| IDEMP-001 CSV import duplication + un-rollbackable PROCESSING | 4/10 · P1 | **CONFIRMED** (12 rows from 2× submit; 409 on PROCESSING rollback) | **P1 — hold** (duplicates every total/baseline; orphaned half-imports) | High | None for the duplication/rollback halves; a true mid-loop crash (vs simulated PROCESSING) not induced |
| IDEMP-002 Purge non-transactional / double-run / tail unguarded | 3/10 · P1 (destructive) | **CONFIRMED** (both ran tail; 4 ACCOUNT_DELETED for 2 users; P2025 at `user.delete`) | **P1 — hold** (duplicated irreversible side effects incl. duplicate deletion email/itemRemove) | High | Cancel-vs-purge lost-update SUPPORTED only; cross-instance makes it easier, not harder |
| IDEMP-003 Job dispatch double-execution (TOCTOU) | 5/10 · P2 | **CONFIRMED** (11/11 due jobs ran twice on one concurrent pair) | **P2** (most bodies idempotent; harmful via IDEMP-002 & evaluate-alerts) | High | Vercel cron overlap/retry semantics UNVERIFIED (single process here) |
| IDEMP-009 AiInvocation fire-and-forget swallow | 6/10 · P2 | **CONFIRMED** (recorders resolve despite throwing insert) | **P2** (allowance under-counts failed/frozen ledger writes) | High | Allowance under-count magnitude SUPPORTED, not measured (no chat requests sent) |
| IDEMP-006 Webhook duplicate dedup | 6/10 · P2 | **PARTIAL** (unsigned replay rejected 401, 0 rows; verified-dup dedup gap not runnable) | **P2 low-med** | Med-High | Valid-signature replay UNVERIFIED (cannot forge signature) |

Overall: every Part-4 item I could exercise at runtime **confirmed** the audit's static claims; IDEMP-001/002 in
particular reproduced with concrete destructive evidence (duplicate transactions; duplicate irreversible purge tails).
No claim was refuted. The only residual uncertainties are the inherently cross-instance / signed-payload cases, which
this single-process, dummy-credential stack cannot reach.

## Artifacts (all under `$S/rtv/idemp/`)
- `import.csv`, `run_concurrent_import.sh`, `resp_A.json`/`resp_B.json` (IDEMP-001)
- `rollback_resp.json` (IDEMP-001 PROCESSING 409)
- `pd_A.json`, `pd_code_*` + server.log P2025 excerpts (IDEMP-002)
- `disp_A.json`/`disp_B.json` (IDEMP-003)
- `idemp009-swallow.ts` (IDEMP-009)
- `wh_1.json`/`wh_2.json`/`wh_noheader.json` (IDEMP-006)
- Throwaway-DB residue (acceptable per RTV rules): 12 synthetic transactions + one PROCESSING ImportBatch on
  `Example CU Checking`; synthetic purge users already deleted; extra JobRun rows from the dispatch pair.
