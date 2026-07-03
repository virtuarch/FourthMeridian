# D2.x — Initial Sync Experience & Historical Pipeline — Initiative Charter

**Status:** APPROVED (planning; no implementation yet) · ⭐ **v2.5 flagship UX initiative**
**Approved:** 2026-07-03
**Track/ID:** `D2.x` — derivative-of-D2 orchestration initiative. Deliberately *not* a new frozen matrix integer (D1–D14 are frozen per `PHASE_2_DECISION_MATRIX.md`) and *not* an `AI-x`/`UI-x`/`L-x` slot; the `D2.x` label signals "orchestration/UX layer built on the D2 sync engine." Folder allocated here so the ID cannot be squatted (STATUS.md §4 namespace rule).
**Queue position:** after the current D2 import/sync work, before AI indexing and later analytics (v2.5.5) work.
**Evidence / source:** `docs/investigations/INITIAL_SYNC_UX_PIPELINE_INVESTIGATION.md`, `docs/investigations/INITIAL_DAILYSNAPSHOT_BACKFILL_INVESTIGATION.md`, `docs/investigations/PLAID_TRANSACTION_HISTORY_DEPTH_INVESTIGATION.md`.

---

## Purpose

Eliminate the current "connect → wait → manual refresh" onboarding workflow while **preserving the existing synchronization engine**. This initiative is **orchestration and UX only** — it is **NOT** a replacement of the Plaid sync engine.

Treated as the **flagship UX initiative for the v2.5 window**: a new user's first five minutes shapes perceived quality more than any single visual pass, and the underlying architecture already exists — this initiative exposes it as one seamless, automatic moment.

## Scope boundary — what "done" means

D2.x delivers the **orchestration / progressive-reveal contract**: the pipeline and status surface that let each downstream capability light up automatically the moment its data dependency is ready. The **individual surfaces themselves ship on their own tracks** — Daily Brief generation on v2.6b (Ambient Intelligence), richer AI analysis on the AI-x tracks. D2.x's exit is that the reveal is seamless and automatic **for whatever surfaces exist at the time**, not that every insight is present on day one; otherwise its exit would be gated on v2.6b work and could not close in the v2.5 window.

## Current understanding (locked)

- `transactions.days_requested = 730` is already implemented (`app/api/plaid/link-token/route.ts`).
- The remaining UX issue is **availability latency**, not transaction depth.
- `syncTransactionsForItem` (`lib/plaid/syncTransactions.ts`) remains the canonical transaction engine.
- Current balances should become available immediately.
- Historical transactions should continue importing automatically in the background.
- Manual Refresh should become unnecessary for normal first-time onboarding.
- Snapshot backfill depends on historical transaction completion.

## Architectural rules

- Reuse the existing sync engine. No duplicate transaction pipeline.
- No manual-refresh requirement after completion.
- No schema unless genuinely needed. Prefer additive orchestration.
- Preserve the daily cron as the fallback.
- Every phase independently shippable and independently revertible.
- Best-effort / non-fatal: nothing here may break Link success.

## Approved implementation order

| Phase | Scope | Schema |
|---|---|---|
| **0** | Investigation (complete — see investigation doc). | — |
| **1** | **Split the fast path.** Return as soon as accounts, balances, the initial ready transaction slice, and today's `SpaceSnapshot` are finished. Do **not** wait for full historical history. | None |
| **2** | **Background historical continuation.** Use Next.js `after()` / `waitUntil` (or equivalent supported background continuation). Reuse `syncTransactionsForItem`. Do **NOT** introduce a queue or `SyncJob` yet. | None |
| **3** | **Lightweight sync-status endpoint + UI polling** (replaces reliance on manual Refresh). Progressive states: Accounts connected → Current balances ready → Importing history → Categorizing transactions → Building 30-day chart → Historical insights ready. Infer state from existing `PlaidItem` fields. Do **NOT** add `SyncJob` yet. | None |
| **4** | **Trigger 30-day `SpaceSnapshot` backfill** — runs only after historical transactions have completed; depends on the approved Snapshot Backfill initiative. Must not block the user while it runs. | None (backfill's own additive fields tracked under that initiative) |
| **5** | **Optional future `SyncJob` model** for richer progress/error tracking — only if a real need emerges. Keep additive. Defer until then. | Additive, if built |
| **6** | **Plaid webhook (`SYNC_UPDATES_AVAILABLE`)** — event-driven continuation. Daily cron remains the safety net. | None |
| **7** | **Retry hardening** — cooldown-aware retry/backoff; operational improvements only. | None |

## Dependencies

- **Snapshot Backfill initiative** — Phase 4 cannot run until historical transactions complete *and* the backfill's additive `SpaceSnapshot.source`/`isEstimated` provenance exists (see `INITIAL_DAILYSNAPSHOT_BACKFILL_INVESTIGATION.md`).
- **D5 (scheduler/cron)** — the daily `sync-banks` cron is the standing fallback and must remain functional.

## Working style

Per standing project rule: each phase gets its own short implementation checklist, submitted for approval, before any code/schema/migration work. Phase 0 completion does not pre-approve Phases 1–7. Validation each phase: `npx prisma generate` (+ `migrate dev` only if a phase is additive-schema), `npx tsc --noEmit`, `npm run lint`, targeted Link-flow run in dev.
