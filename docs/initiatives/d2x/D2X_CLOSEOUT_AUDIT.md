# D2.x — First-Run Sync Experience — Closeout Audit

**Status:** Audit only. No code changes.
**Branch:** `feature/v2.5-spaces-completion`.
**Scope boundary (from STATUS.md / charter):** D2.x delivers the **orchestration / progressive-reveal contract** — the fast-path connect, background history, sync-status/Connections surface, and historical backfill — plus the data-integrity foundation. The *downstream surfaces* (Daily Brief generation → v2.6b; richer AI → AI-x) ship on their own tracks; D2.x's exit does **not** require them lit up.

---

## 1. Completed D2.x slices

| Slice | Deliverable | State |
|---|---|---|
| **Slice 1 — Fast-path split** | `exchange-token` returns after accounts/balances/holdings/today-snapshot; `deferHistorySync`; `maxDuration` set; `historyPending` flag | ✅ implemented |
| **Slice 2 — Background history** | `runDeferredHistorySync` via `after()`, reusing `syncTransactionsForItem`; cron remains fallback | ✅ implemented |
| **Slice 3 — Sync-status + Connections** | `GET /api/sync/status` (state from `PlaidItem.cursor`); permanent `/dashboard/connections` hub; canonical Liquid `ConnectionCard` (all states, provider-aware); provider action cluster (Connect institution + Add wallet) | ✅ implemented |
| **Slice 4 — 30-day historical backfill** | `backfillSpaceSnapshots`; additive `SpaceSnapshot.isEstimated` (**migration `20260704145019_d2x_slice4_snapshot_isestimated` applied**); estimated-history chart badge | ✅ implemented |
| **Slice 4B — Credit-card debt reconstruction** | liability reverse-walk (`ADD`); card-only gate; pending excluded; `isEstimated` | ✅ implemented |
| **Snapshot orchestration fix** | all-items refresh regenerates each Space **once after all institutions**, **excludes failed-item Spaces** → no partial-refresh live snapshots | ✅ implemented + verified |
| **Sync integrity hardening** | `removed[]` **soft-delete** (tombstone) + resurrection; recovery script `recover-plaid-item-transactions.ts` | ✅ implemented |
| **Data Integrity Gate M1** | `SyncIssue` table + `SyncIssueKind` (**migration `20260705122158_d2x_sync_issue_integrity_gate` applied**); durable writes for MISSING_ACCOUNT / UPSERT_ERROR / REMOVED_TOMBSTONE | ✅ implemented |
| **Data Integrity Gate M2** | balance↔transaction reconciliation (cash + card), flag-only `BALANCE_TX_MISMATCH` | ✅ implemented |

**Progressive-reveal contract:** the Connections card renders `importing → ready` from `cursor` state, and Timeline/Brief/AI appear as forward-looking "ready next" markers — i.e. the contract is in place for whatever surfaces exist, matching the charter's exit definition.

## 2. Remaining blockers (must clear before marking complete)

1. **End-to-end validation on a real dev DB (not runnable in this sandbox).** Both migrations are applied, so the client has `SyncIssue`/`isEstimated` and `tsc`/`lint` should now be green — **but that must be confirmed on the machine** (the sandbox can't reach the DB or fetch the Linux Prisma engine). This is the single gating item.
2. **July 2 payroll data recovery (validates the whole chain end-to-end).** The known bad data still exists until you run `recover-plaid-item-transactions.ts --item <Chase> --apply` and re-run the backfill. This both clears the incident and proves reconciliation/soft-delete/backfill work together. Recommended as the acceptance test, not a code task.
3. **Branch build hygiene (not D2.x-authored, but blocks a clean branch build):** pre-existing `tsc` errors in `lib/transactions/plaid-category.test.ts` and `scripts/backfill-cc-payment-categories.ts` (a `CardPaymentLegInput` mismatch — external/parallel work, untouched by D2.x). A full `tsc`/build won't be clean until these are resolved. Flagging so the branch isn't merged red.
4. **Commit hygiene:** the D2.x work is stacked as uncommitted/loosely-committed changes. Should be committed as coherent per-slice commits before closeout.

## 3. Deferred non-blockers (explicitly out of D2.x scope)

- **SyncJob model, Plaid `SYNC_UPDATES_AVAILABLE` webhook, retry hardening** — charter "optional later."
- **M2 auto-replay** (guarded cursor-reset on `BALANCE_TX_MISMATCH`) → v2.5.
- **Snapshot `quality`/provenance column** → v2.6+ (only if read-time SyncIssue joins become a perf issue).
- **AI/Brief consumption of sync-health + estimated markers** ("Chase history may be incomplete") → v2.6b Ambient Intelligence.
- **`pending_transaction_id` reconciliation** → v2.6+ (soft-delete already makes the loss recoverable, not just detectable).
- **Daily Brief generation / richer AI analysis** → their own tracks (v2.6b / AI-x).
- **Deeper-than-30-day snapshot history** → Snapshot Backfill initiative.
- **Fingerprint over-match hardening** → low, v2.6+.

None of these gate the D2.x orchestration/backfill/integrity exit.

## 4. Validation checklist (run on the dev machine)

- [ ] `npx prisma migrate status` — both D2.x migrations applied (dirs confirmed present).
- [ ] `npx prisma generate` clean; `npx tsc --noEmit` — green **except** the pre-existing plaid-category/backfill-cc-payment errors (§2.3).
- [ ] `npm run lint` — no new errors.
- [ ] Unit: `backfill-core.test.ts` (24 checks) + `sync/status.test.ts` (15 checks) pass.
- [ ] First-run: sandbox connect → fast return (`historyPending`) → lands on `/dashboard/connections` importing card → background history completes → 30-day estimated backfill; chart shows estimated badge.
- [ ] Multi-institution refresh: exactly **one** snapshot per Space, no intermediate partial write; a failed item's Space is **not** snapshotted.
- [ ] Integrity M1: force a missing-account/upsert-error/removed batch → matching `SyncIssue` rows; sync counts unchanged.
- [ ] Integrity M2: a cash account whose balance moved with no matching transactions → one `BALANCE_TX_MISMATCH`; a reconciled account and an investment account → none.
- [ ] **Acceptance:** recover the July 2 payroll (script) → re-run backfill → Christian's assets curve corrects (no month-long inflation, no July 2 cliff), and reconciliation reports no open gap.
- [ ] `git` history: D2.x work committed coherently.

## 5. Recommendation

**Do NOT mark D2.x complete yet — one final required task remains: run the dev-machine validation + July 2 acceptance test (§4).** All D2.x code is implemented and both migrations are applied; the orchestration/progressive-reveal contract, 30-day historical backfill, debt reconstruction, and the integrity gate (soft-delete + SyncIssue + reconciliation + recovery script) are in place and match the charter's scope. What is missing is **proof on real data** — the sandbox cannot run Prisma/DB, so `tsc`/`lint` green post-migration, the integration smoke tests, and the July 2 recovery→reconstruction acceptance test have not been executed here.

**Concretely, to close D2.x:**
1. On the dev machine: confirm `tsc`/`lint` green (post-migration) and run the §4 unit + integration checks.
2. Run the July 2 recovery + backfill and confirm the assets curve is correct (the end-to-end acceptance test).
3. Resolve or quarantine the pre-existing plaid-category/backfill-cc-payment build errors so the branch compiles clean (branch hygiene, not D2.x-authored).
4. Commit the D2.x work; update the STATUS.md D2.x block (currently "Phase 1 — split the fast path") to mark Phases 1–4 + the integrity gate **complete**, and relocate the §3 deferrals to v2.5 / v2.6b / MC1 tracks.

**Once §4 passes and STATUS.md is updated, D2.x First-Run Sync Experience is complete for its defined scope.** The single blocker is validation-on-real-data, not remaining implementation.
