# OPS-4 — Background Jobs & Platform Reliability · Investigation

**Status:** INVESTIGATION ONLY — no code, no schema, no STATUS.md changes, no roadmap edits
**Date:** 2026-07-07 · investigated against the working tree at `2486b5f` (OPS-3 complete)
**Position in the OPS chain:** OPS-1 (email floor, S0–S3 landed) → OPS-2 (account lifecycle, landed) → OPS-3 (notifications & preferences, landed) → **OPS-4 (this document)** → OPS-5 (platform operations read layer)
**Relationship to PO1:** `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md` Phase 2 ("Job substrate") describes the same territory. OPS-4 is the implementation vehicle for PO1 Phase 2 plus the reliability items other initiatives have parked under the OPS-4 name (notification retries — OPS-3 F16; quiet hours — OPS-3 F11; key-rotation runbook — SECURITY_CHECKLIST / INCIDENT_RESPONSE_RUNBOOK §7.6). This document does not fork PO1's architecture; it slices it.
**Doctrine (inherited, binding):** investigation first · smallest additive slices · one seam per capability · extend existing patterns, never invent parallel ones · Product vs Platform Operations boundary preserved · facts first, infrastructure second, AI third.

---

## 1. Current background architecture

Three execution models exist today, all deliberate, none duplicated in function:

**(a) Vercel Cron → API route → job body.** The production scheduling substrate. `vercel.json` declares the schedule; each `app/api/jobs/<name>/route.ts` authenticates `Authorization: Bearer ${CRON_SECRET}` (exact match, no fallback auth, 401 otherwise), sets `maxDuration = 60`, and calls a plain exported async function in `jobs/<name>.ts`. The route is transport; the job body is logic; the body is independently callable from scripts. This is the house pattern ("fetch-fx-rates is the template job" — PLATOPS §1.3) and it is consistent across all three live jobs.

**(b) Request-tail async via Next.js `after()`.** Post-response work that must not block a request: D2.x background history sync (`lib/plaid/backgroundHistorySync.ts`, invoked from the exchange-token route) and OPS-3 notification email delivery (`lib/notifications/create.ts` — delivery runs post-response when a request scope exists, inline otherwise). Best-effort, never rethrows, classified failure updates state for the daily cron to pick up. Not a queue and not pretending to be one.

**(c) Cron-tail piggybacking.** OPS-3 S6 notification cleanup (`lib/notifications/cleanup.ts`) rides the tail of the process-deletions cron handler because frozen ruling F7 forbids new cron slots while no dispatcher exists. The route header and the cleanup module header both state the exit plan verbatim: *"When the PF1 dispatcher lands, cleanupNotifications() moves there and this tail call is deleted."* This is scheduled work wearing another job's clothes — tolerated, documented, and explicitly temporary.

**Dormant fourth model (to be retired).** `jobs/scheduler.ts` — a setInterval-based in-process scheduler whose `startScheduler()` is invoked nowhere (no `instrumentation.ts` exists; the file's own header says so). It registers `purgeTrash` (daily 01:00) and `syncBanks` (4-hourly), encoding scheduling *intent* that production doesn't honor. Its header already concedes the replacement path ("Replace with node-cron or BullMQ for production resilience" — neither is the right answer; the dispatcher is).

**Stubs presenting as files:** `jobs/run-ai-advice.ts`, `jobs/sync-crypto.ts`, `jobs/take-snapshot.ts` are each literally `export {}` (KD-14).

## 2. Existing cron inventory

| Schedule (UTC) | Route | Body | Behavior |
|---|---|---|---|
| `0 6 * * *` | `GET /api/jobs/sync-banks` | `jobs/sync-banks.ts` | Incremental Plaid `/transactions/sync` for every ACTIVE PlaidItem of non-deactivated users (OPS-2 S4 billing-honesty filter). Per-item isolation; failure classifies via `classifyPlaidErrorForHealth` → `PlaidItem.status`/`errorCode` + `notifyItemSyncFailed` (OPS-3 Wave 3, suppress-deduped). No retry beyond `withPlaidRetry` inside the engine — the next daily run is the retry. |
| `30 6 * * *` | `GET /api/jobs/fetch-fx-rates` | `jobs/fetch-fx-rates.ts` | Fetches only the missing quotes for the previous closed UTC day through the provider failover chain; append-only `fxArchive.writeBatch` (skipDuplicates). Re-run is a network-free no-op. A fully-failed day self-heals via tomorrow's run or `scripts/backfill-fx-rates.ts`. |
| `0 7 * * *` | `GET /api/jobs/process-deletions` | `jobs/process-deletions.ts` | Purges every account past its deletion grace window via `purgeUser` (OPS-2 S7c); idempotent/resumable — "no retry framework, the cron IS the retry" (`lib/account-deletion/purge.ts`). **Tail:** OPS-3 notification cleanup (best-effort, non-fatal). |

**Registered but never running:** `purgeTrash` (7-day trashed-goal purge — the soft-delete promise for goals is currently false in production), 4-hourly bank sync, daily `take-snapshot`.

**Cron-budget note (verify before implementation):** PLATOPS §1.4 (2026-07-06) called the Vercel Hobby cron budget "effectively exhausted" at 2 slots; `vercel.json` now carries **3** crons (process-deletions added by OPS-2). Either the project moved off Hobby or the documented ceiling was wrong. Either way the dispatcher (§6 S2) makes the question permanently moot — but the actual plan tier and per-invocation duration ceiling should be confirmed at S2 entry, since the dispatcher concentrates all job runtime into one 60s-bounded invocation.

## 3. Existing reliability mechanisms

These are real, tested, and better than the "no infrastructure" framing suggests:

- **Bounded retry/backoff exists in exactly one place, correctly scoped:** `lib/plaid/retry.ts` (`withPlaidRetry` — 2 total attempts, 1s fixed delay) with retryability decided solely by `lib/plaid/errors.ts` `isRetryablePlaidError()`. Deliberately per-call, not per-pipeline, because the pipelines are idempotent/resumable by design.
- **Idempotency is the pervasive house discipline, not an add-on:** transaction upserts on unique `plaidTransactionId`; snapshot upserts on `@@unique([spaceId, date])`; FxRate insert-only with `skipDuplicates`; SAL idempotent upserts with a compute-retry-once race recovery (`lib/accounts/space-account-link.ts`); notification dedupe race-safe on `@@unique([userId, dedupeKey])`; cleanup as WHERE-guarded `updateMany`/`deleteMany` against absolute cutoffs; purge resumable mid-failure. Every cron body is safe to re-run and safe to overlap with its user-triggered twin.
- **Per-item failure isolation:** sync-banks and process-deletions both loop with per-item try/catch; one institution's `ITEM_LOGIN_REQUIRED` never blocks the fleet.
- **Non-throwing side-effect contracts:** `EmailResult` (OPS-1), `CreateNotificationResult` (OPS-3), EV-1 handlers each individually try/caught — a notification/email/handler failure structurally cannot fail the originating request or job.
- **An outbox-shaped retry substrate already exists, unconsumed:** `NotificationDelivery` rows carry `status` ("sent"/"captured"/"skipped"/"error"), `error`, `provider`, `providerMessageId`, and `attempts` (default 1, "recorded, never incremented here — retries are OPS-4" — `lib/notifications/create.ts` header, frozen F16). OPS-3's architecture review states it plainly: error rows + attempts *are* the outbox OPS-4 needs.
- **Failure-recovery by self-healing cadence:** FX (append-only + next-day top-up + backfill script), deletions (row survives partial purge, reselected next run), Plaid history (transient errors left "for the daily sync-banks cron to retry" — `backgroundHistorySync.ts`).
- **Encryption lifecycle machinery:** AES-256-GCM, HKDF per-purpose subkeys (D14), dual-format v1/v2 reads, v1→v2 re-encryption code-complete with zero v1 rows (SEC-1); `detectCiphertextVersion` audit support exists. What remains is the v1 read-branch removal gate and the rotation *runbook* — both OPS-4-owned by name (SECURITY_CHECKLIST "Key rotation" — Owner: OPS-4; INCIDENT_RESPONSE_RUNBOOK §7.6 and its OPS-4 forward-reference).
- **Rate limiting:** implemented (KD-3, DB-backed fixed-window in prod, race-safe upsert), flag-gated off by default, fails open. Not a background concern except for one gap (§4).
- **Secrets:** env-var based; `CRON_SECRET` pattern uniform across the three routes (non-timing-safe compare is L1, owned by PO1, not OPS-4).

## 4. Existing operational gaps

Ordered by how directly the repository itself names them:

1. **No job-run ledger of any kind.** A cron that silently stops firing leaves no corpse; "did last night's sync run?" is unanswerable. Named by PLATOPS (§1.1 Jobs row, Part 10 gap #2) and implied by KD-14. This is capture-class debt: every day without it is execution history destroyed.
2. **No dispatcher.** N crons for N jobs, a budget ceiling of uncertain height, and F7 already forcing cleanup to hide in another job's tail. Digests (OPS-3 S6) are **blocked on this by frozen ruling** — the first concrete feature waiting on OPS-4.
3. **Dead scheduled work.** `purgeTrash` never runs (goal-trash retention promise false); daily snapshot cadence doesn't exist — `jobs/take-snapshot.ts` is a stub and `jobs/sync-banks.ts` syncs transactions only (no snapshot regeneration in `syncTransactionsForItem`), so `SpaceSnapshot` continuity depends on users logging in or mutating state. Chart history gets holes for inactive users.
4. **Notification retry unimplemented.** Delivery failures are recorded (`status: "error"`, attempts=1) and then nothing ever retries them. The substrate was built to be consumed by OPS-4 (F16).
5. **Cron route boilerplate triplicated.** The CRON_SECRET check + maxDuration + result-JSON shape is copy-pasted across all three routes. Harmless at 3; the wrapper seam (§6 S1) is where the run ledger wants to live anyway.
6. **`RateLimit` rows are never swept.** No `deleteMany` exists in `lib/rate-limit.ts` or any job — one row per (key, window) accumulates forever once `RATE_LIMIT_ENABLED=true`. Small today, unbounded by construction.
7. **`jobs/scheduler.ts` limbo.** Dormant scheduling intent contradicting production reality; PLATOPS 2.3 already recommends retire-as-decision.
8. **Key-rotation runbook absent.** `ENCRYPTION_KEY` is a single point of total loss; the incident runbook currently says "do NOT casually rotate" and points at OPS-4 for the process. Preview/prod key separation unverified.
9. **No dead-job detection / no alerting on background failure.** Even with a ledger, nobody is told. (Alerting thresholds are PO1 Phase 5; a minimal expected-vs-absent check can ride the dispatcher — see §6 S5.)
10. **No telemetry/metrics** (v2.4.5 counters, open since 2026-07-02). Real, but **PO1 Phase 1's**, not OPS-4's — noted here only because the job wrapper must not grow ad-hoc metrics that PO1 then has to unify.

**Duplication findings:** none of substance in job logic itself — the three job bodies share shape but not copy-pasted logic. The true duplications are the route boilerplate (gap 5) and the *two scheduling systems* (vercel.json vs dormant scheduler.ts — gap 7).

## 5. Candidate evaluation

| Candidate | Exists today | Fit / complexity / value | Classification |
|---|---|---|---|
| **Job abstraction** (`runJob(name, fn)` wrapper) | No — three hand-rolled routes | Perfect fit (chokepoint idiom); trivial complexity; enables everything below | **Required** (S1) |
| **Job-run ledger** | No | Append-only dated fact table — the house's strongest idiom (AuditLog/FxRate/SyncIssue); one narrow model + wrapper writes; highest value-per-line in the initiative; capture-class urgency | **Required** (S1) |
| **Dispatcher** | No — F7 workaround in production | Single cron fanning out over an internal registry mirroring scheduler.ts's intent table; solves the budget once; unblocks digests, purge-trash, sweeps; per-job isolation | **Required** (S2) |
| **Scheduler (`jobs/scheduler.ts`)** | Yes, dormant | Retire formally; the dispatcher registry inherits its intent table; closing the "entrypoint never invoked" limbo is a decision, not code | **Required as a retirement decision** (S2) |
| **Idempotency** | Yes, pervasive (§3) | Already the house discipline; codify as a registry requirement ("every registered job must be idempotent — one sentence in the registry type's doc") | **Do not implement** (already exists; document only) |
| **Retry framework** (generalized) | `withPlaidRetry` only, correctly scoped | No repo-visible problem needs a generic retry framework; the cadence-is-the-retry pattern is load-bearing and correct at this scale | **Do not implement** |
| **Backoff** (exponential, jitter) | Fixed 1s in withPlaidRetry | No evidence of thundering-herd or rate-limit pressure requiring it; revisit if telemetry (PO1) shows retry storms | **Future** |
| **Notification retry** | Substrate yes (attempts/error rows), consumer no | Bounded dispatcher job over `NotificationDelivery` error rows; increments `attempts`, caps at N, re-uses the existing channel adapter; F16 names OPS-4 as owner | **Required** (S4) |
| **Dead-letter handling** | No queue exists to have a DLQ | `NotificationDelivery` rows that exhaust attempts *are* the dead letters — query-visible, no new table. A queue-class DLQ would be invented infrastructure | **Do not implement** (as infrastructure); exhausted-attempts state = Recommended documentation in S4 |
| **Distributed locking** | No | Daily cadence + serverless cron = no concurrent-run problem today; every job is overlap-safe by idempotency anyway. A lock would be "large systems have one" | **Do not implement** (revisit only if sub-daily schedules or multi-region arrive) |
| **Concurrency** (parallel fan-out inside dispatcher) | Sequential loops today | Sequential-by-default inside the 60s window is fine at current fleet size; parallelize per-job only when a ledger-measured duration approaches the ceiling | **Future** (ledger provides the trigger data) |
| **Failure recovery** | Yes — self-healing cadence per job (§3) | Preserve; the ledger makes it *observable*; dead-job detection makes it *alertable* | **Required** (observability leg, S1/S5) |
| **Secret rotation (runbook)** | No; explicitly OPS-4-owned in three documents | Doc + drill, near-zero code; preview/prod key separation check; high security value | **Required** (S6) |
| **Encryption key lifecycle** (v1 read-branch removal) | SEC-1 code-complete, zero v1 rows; removal gate open | Small, gated on backup-window confidence; natural rider on S6 | **Recommended** (S6 rider) |
| **Digest scheduling** | Designed (OPS-3 S6), blocked on dispatcher by F7 | One registered job assembling unread digestable LOW items; delivery through the existing chokepoint (digest observability requirement from the OPS-3 review) | **Recommended** (S3b — scope is OPS-3's, vehicle is OPS-4's) |
| **Quiet hours** (delay-not-drop) | Deferred to OPS-4 by F11 | Needs held-delivery semantics (a deliverAfter concept) + the retry pass to honor it; real but not visible as a user complaint yet | **Future** (design note in S4 so the retry pass doesn't preclude it) |
| **AI scheduling** (`run-ai-advice`) | Stub | **Belongs to v2.6b by two standing rules:** D5/KD-14 close at v2.6b entry, and the v2.6b entry criterion ("may not speak unprompted until…") is an explicit product gate. OPS-4 provides the dispatcher it will register with; nothing more | **Do not implement** (belongs elsewhere: v2.6b) |
| **Plaid scheduling** (frequency, webhook) | Daily cron; `SYNC_UPDATES_AVAILABLE` webhook deferred by D2.x closeout to v2.5 residuals | Webhook is provider-integration work, not job infrastructure; sub-daily sync frequency is a product decision gated on plan tier. Dispatcher makes either trivial to schedule later | **Do not implement in OPS-4** (belongs elsewhere: D2.x residual track) |
| **Crypto sync** (`sync-crypto`) | Stub | Own track; no OPS-4 claim | **Do not implement** (belongs elsewhere) |
| **Operational telemetry** | None (v2.4.5 debt) | PO1 Phase 1's seam (`lib/ops/telemetry.ts` shape). OPS-4 must not fork it — the run ledger is a *fact table*, not a metrics system | **Do not implement in OPS-4** (belongs to PO1 Phase 1) |
| **Background metrics / rollups** | None | PO1 Phase 3 (rollups over the ledger + telemetry). The ledger is designed to be their raw source | **Do not implement in OPS-4** (belongs to PO1 Phase 3) |
| **Snapshot cadence** (`take-snapshot`) | Stub; snapshots only on user activity | Real data-continuity gap (§4.3) with an existing idempotent upsert engine (`lib/snapshots/regenerate.ts`); a registered daily job is small. Verify at slice entry what a snapshot without a fresh balance read should mean (stale-balance snapshot vs skip) | **Recommended** (S3c, with an entry-gate design question) |
| **RateLimit sweep** | No | One WHERE-guarded deleteMany registered on the dispatcher; the cleanup.ts idiom exactly | **Recommended** (S3a rider) |
| **Purge-trash revival** | Body exists, never scheduled | Register on dispatcher; makes an existing product promise true | **Required** (S3a) |
| **Dead-job detection** | No | Dispatcher-tail check: expected runs (registry) vs ledger rows for yesterday → security-alert email via OPS-1 seam. Minimal now; PO1 Phase 5 replaces it with real alerting | **Recommended** (S5) |

## 6. Proposed OPS-4 slices

Every slice independently shippable and revertible; no slice requires unshipped work from any other initiative.

- **S0 — Allocation (doc-only).** OPS-4 ledger row in STATUS §3, `docs/initiatives/ops4/` (this document). No behavior change.
- **S1 — Job wrapper + run ledger.** One narrow append-only `JobRun` model (job name, trigger source, startedAt/finishedAt, outcome, error summary, result counts as Json — no user content, no monetary values, per the PO1 telemetry doctrine). One `runJob(name, fn)` wrapper that also owns the CRON_SECRET check (de-triplicating the routes). Wrap the three existing cron bodies mechanically. *Gate:* all three crons produce ledger rows; a forced failure produces a failure row; routes byte-equivalent in behavior; "did last night's sync run?" is a query.
- **S2 — Dispatcher.** One cron endpoint + typed internal registry (name, schedule expression, job fn) that fans out to due jobs with per-job try/catch isolation, each run individually ledgered. Migrate the three existing jobs into it; `vercel.json` shrinks to one entry (each job individually revertible to its own cron). Formally retire `jobs/scheduler.ts` (delete; the registry is its successor — record the decision in the slice closeout, closing the KD-14 "entrypoint" limbo without touching the v2.6b-owned stubs). *Gate:* week-long ledger comparison shows the same execution pattern pre/post; a deliberately failing registered job provably cannot block siblings; F7 is dissolved rather than worked around.
- **S3 — Revive/relocate scheduled work.** (a) Register `purgeTrash` + a `RateLimit` window sweep; move `cleanupNotifications()` off the process-deletions tail into its own registration (deleting the tail call, exactly as both file headers promise). (b) Digest job per OPS-3 S6's frozen design, delivery through `createNotification`/`sendEmail` so digest observability lands in `NotificationDelivery`. (c) Daily snapshot job over `lib/snapshots/regenerate.ts` — entry-gated on the stale-balance semantics decision (§5). *Gate:* trash purge and cleanup provably run on schedule; the process-deletions route returns to single-purpose; a digest email arrives for an opted-in user with unread digestable items.
- **S4 — Notification retry pass.** One registered job: select `NotificationDelivery` rows with `status = "error"` and `attempts < MAX` (recommend 3), re-deliver through the existing EMAIL adapter, increment `attempts`, write outcome. Exhausted rows stay as the queryable dead-letter state. Design note recorded (not built): a future `deliverAfter` honors quiet hours through this same pass. *Gate:* an injected failed delivery is retried and either succeeds or exhausts; attempts never exceeds MAX; no double-send for rows that succeeded (idempotent selection).
- **S5 — Dead-job detection.** Dispatcher-tail (or first-registered-job) check of registry expectations vs yesterday's ledger; absence → email via the OPS-1 seam to the operator. Watches the dispatcher's own execution by construction (any ledger row proves the dispatcher ran; total absence is caught by the external uptime monitor on the dispatcher endpoint — note the dependency on OPS-1 Slice 6, see §12). *Gate:* deregistering a job's schedule (test) produces exactly one alert; a healthy week produces zero.
- **S6 — Key-rotation runbook + lifecycle closeout.** Documented, exercised rotation procedure for `ENCRYPTION_KEY` (rotate root, re-encrypt via the SEC-1 machinery, verify with `detectCiphertextVersion`, retire); verify preview/prod key separation; execute the v1 read-branch removal behind its stated gate (0 v1 rows + backup window — confirm both). Mostly documentation + one drill; the smallest slice with the largest incident-response payoff. *Gate:* the runbook has been executed once against a non-production database; INCIDENT_RESPONSE_RUNBOOK §7.6's forward reference resolves.

## 7. Recommended implementation order

S0 → S1 → S2 → S3 → S4 → S5, with S6 parallel-safe any time after S0 (it touches no job code). S1 before S2 so the dispatcher is born ledgered; S3 before S4 so the retry pass has dispatcher registration to ride; S5 last because it consumes the registry+ledger pair. Stopping after any slice leaves the system strictly better: after S1 alone, background work is observable for the first time.

## 8. Risks

- **The dispatcher becomes a single point of failure.** One cron running everything means one silent failure kills all jobs. Mitigations: S5 dead-job detection watches from inside; an external uptime check on the dispatcher endpoint (OPS-1 Slice 6 territory) watches from outside; each job remains individually revertible to its own cron entry.
- **The 60s duration ceiling concentrates.** Today's three jobs individually finish well under 60s, but the dispatcher sums them. Mitigations: the S1 ledger measures per-job duration *before* S2 migrates anything (data-driven, not speculative); schedule staggering within the registry; verify the actual plan tier's ceiling at S2 entry (§2 note).
- **Retry double-send.** A retry pass that selects wrongly re-emails users. Mitigation: selection keyed on the delivery row's own status/attempts (row-atomic update-then-send or send-then-update decided at slice entry with the failure mode written down); dedupe semantics already prevent duplicate *notifications*, but not duplicate *emails* for one delivery row — this is S4's one hard design point.
- **Ledger growth.** KD-12 is the in-repo precedent for write amplification. A daily dispatcher writing ~5–10 rows/day is trivial, but the retention policy should ship *in S1* (a WHERE-guarded sweep, itself registered in S3) so the ledger never becomes the thing it exists to prevent.
- **Scope gravity toward PO1.** The wrapper is one telemetry-shaped seam away from becoming a metrics system. The boundary must hold: OPS-4 writes execution *facts*; PO1 Phase 1/3 owns counters and rollups. A metric field creeping into `JobRun` is the drift signal.
- **STATUS drift.** STATUS.md's "Current focus" still says OPS-1 is the active initiative while OPS-2/OPS-3 are merged. Not OPS-4's to fix (and this document must not), but the release-checklist step ("STATUS.md updated") should catch it before OPS-4 opens.

## 9. Explicit non-goals

No queue/broker (BullMQ, Redis, SQS — nothing in the repo needs one and EV-1's header rules out the event-bus direction by prior decision). No generalized retry/backoff framework. No distributed locks. No DLQ infrastructure beyond the exhausted-attempts state. No telemetry emission seam, counters, or rollups (PO1 Phases 1/3). No AI scheduling — `run-ai-advice`/`AiAdvice` write path is v2.6b's entry criterion, untouched. No crypto sync. No Plaid webhook or sync-frequency change (D2.x residual track). No quiet hours implementation (design-compatible only). No new notification channels. No admin UI over the ledger (OPS-5/PO1 Phase 4 consumes it later). No `instrumentation.ts`/Sentry/health endpoint (OPS-1 Slice 6 — see §12).

## 10. Estimated complexity

| Slice | Schema | Code | Est. effort | Risk |
|---|---|---|---|---|
| S0 | — | doc only | trivial | none |
| S1 | 1 narrow model | 1 wrapper + 3 mechanical wraps | small | low |
| S2 | — | 1 route + registry + vercel.json + delete scheduler.ts | medium | medium (SPOF, duration ceiling) |
| S3 | — | 3–4 job registrations, 1 tail-call deletion | small (a: small · b: medium · c: small + design decision) | low |
| S4 | — (existing columns) | 1 registered job | medium (the double-send design point) | medium |
| S5 | — | 1 check + 1 email template use | small | low |
| S6 | — | runbook doc + 1 drill + gated branch removal | small–medium (mostly ops time) | low code / high care |

Total: comfortably a single-initiative window; S1+S2 are the structural core and together are smaller than any one OPS-3 wave.

## 11. Exit criteria for OPS-4

- Every scheduled unit of work leaves a ledger row; "did job X run last night, and how did it go?" is a query, demonstrated for one full week in production.
- `vercel.json` contains exactly one cron entry; adding a scheduled job is a registry entry, not a platform-config change; F7 is retired.
- `jobs/scheduler.ts` no longer exists; no dormant scheduling intent contradicts production.
- `purgeTrash` and notification cleanup run on their own schedules; the process-deletions route does deletions only; goal-trash retention is true.
- A failed notification delivery is retried up to the cap and its terminal state is queryable; no delivery row can produce a duplicate email.
- A registered job that stops running produces an operator email within one day.
- The `ENCRYPTION_KEY` rotation runbook exists and has been exercised once; preview and prod keys are confirmed distinct; the v1 ciphertext read branch is removed (or its remaining gate is explicitly re-dated in the ledger row).
- Grep-provable boundaries: no `JobRun` field can carry user content or monetary values; the CRON_SECRET check exists in exactly one module.

## 12. Is OPS-4 the correct next initiative?

**Mostly yes — but the repository says one thing should come first: finish OPS-1.**

OPS-1's ledger entry and commit history show Slices 0–3 landed (email substrate, password reset, verification). Verified absent from the working tree today: **Slice 4** (rate limiting is still opt-in — `RATE_LIMIT_ENABLED === "true"` in `lib/rate-limit.ts`; a missing env var still means unprotected), **Slice 5** (zero security headers in `next.config.ts`), **Slice 6** (no `instrumentation.ts` — so `validateEnv()` has *never run in any environment* — no Sentry, no `/api/health`, no uptime monitoring), **Slice 9** (no `/terms`, `/privacy`, `/legal/ai` routes), **Slice 10** (no beta gate). These are the named beta blockers (B1–B10) of the initiative STATUS still lists as current.

Two of those unshipped slices materially degrade OPS-4 if it runs first: S5's dead-job alert and any failure visibility assume error reporting and an external monitor exist (Slice 6), and a dispatcher endpoint without a health/uptime check reproduces the exact silent-failure mode OPS-4 exists to kill — one level up. Meanwhile nothing in OPS-4 blocks OPS-1's residuals, and nothing in OPS-1's residuals is large (Slices 4–6 are each smaller than OPS-4 S2).

The counterweight is real: the job-run ledger (S1) is **capture-class** — execution history not recorded now is unreconstructible later, the same argument PLATOPS Part 8 uses to require the ledger *before* private beta. And digests plus notification retries are already queued behind the dispatcher by frozen rulings.

**Recommendation:** close OPS-1 Slices 4–6 first (days, not weeks; Slice 6's `instrumentation.ts` is the single highest-leverage file absent from the repo — it is simultaneously the env-validation hook, the Sentry init point, and the thing OPS-4's alerting quietly depends on). Then run OPS-4 as sliced here. If parallelism is acceptable, OPS-4 S0+S1 are safe to land during OPS-1's tail — they depend on nothing unshipped and start the irreplaceable capture immediately. OPS-1 Slices 9–10 (legal, beta gate) gate the *beta*, not OPS-4, and can trail.

What should *not* jump the queue: PO1 Phase 1 telemetry (valuable, but OPS-4's ledger + OPS-1's Sentry cover the acute "flying blind on background work" risk with far less surface), and any v2.6b ambient/AI scheduling work (its own entry criteria say so).

---

*Sources (all verified in-tree at `2486b5f`): `vercel.json` · `jobs/*` · `app/api/jobs/*/route.ts` · `lib/plaid/{retry,errors,syncTransactions,backgroundHistorySync,refresh,encryption,sync-notifications}.ts` · `lib/account-deletion/purge.ts` · `lib/notifications/{create,cleanup,channels/email}.ts` · `lib/email/send.ts` · `lib/events/emit.ts` · `lib/rate-limit.ts` · `lib/snapshots/{regenerate,backfill}.ts` · `lib/fx/archive.ts` · `prisma/schema.prisma` (NotificationDelivery, RateLimit, SyncIssue, PlatformSetting) · `next.config.ts` · STATUS.md §§1–7 (D5, KD-3, KD-12, KD-14, v2.4.5 debt, OPS-1 row, current-focus) · `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md` · `docs/initiatives/ops3/{OPS3_IMPLEMENTATION_PLAN,OPS3_ARCHITECTURE_REVIEW}.md` (F7, F11, F16) · `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md` · `docs/investigations/UX1_SETTINGS_INFORMATION_ARCHITECTURE.md` (OPS chain naming) · SECURITY_CHECKLIST.md · INCIDENT_RESPONSE_RUNBOOK.md · RELEASE_CHECKLIST.md · `git log` 2026-07-06→07.*
