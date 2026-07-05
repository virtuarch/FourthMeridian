# D2.x — Slice 4: Historical Snapshot Backfill — Investigation

**Status:** Investigation only. No implementation.
**Goal:** Smallest safe backfill that reconstructs ~30 days of `SpaceSnapshot` history after first-run transaction history completes, so net-worth charts, Daily Brief, and the AI snapshot assembler stop being shallow.
**Governing prior art:** `docs/investigations/INITIAL_DAILYSNAPSHOT_BACKFILL_INVESTIGATION.md` (approved design). This doc integrates that design with D2.x Slices 1–3 and updates the one dependency that has since changed.

**Dependency update (material):** the prior doc's main sequencing blocker — no `transactions.days_requested`, giving only ~24–99 days — is **resolved**. `app/api/plaid/link-token/route.ts` now sets `transactions: { days_requested: 730 }` (D4). Newly-linked Items therefore have ≥30 days for honest reconstruction. (Items linked before that change keep their immutable shallower cap — backfill floors at whatever exists, so this degrades gracefully, never fabricates.)

---

## 1. Current snapshot model (Q1)

`model SpaceSnapshot` (`@@map("WorkspaceSnapshot")`), `prisma/schema.prisma`:
- `date DateTime @db.Date`; **`@@unique([spaceId, date])`**; `@@index([spaceId, date])`.
- Stored: `stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, cashOnHand, netLiquid`, `createdAt`.
- **No `source` / `isEstimated` / provenance field exists.**
- **Writers:** `regenerateSpaceSnapshot()` (today only, from current balances) and `regenerateSnapshotsForAccounts()` (fans out to ACTIVE `SpaceAccountLink` spaces) — `lib/snapshots/regenerate.ts`; plus `prisma/seed.ts` (synthetic demo history — not production).
- **Readers:** `lib/data/snapshots.ts` (`getRecentSnapshots`, `getPortfolioHistory`, `getSpaceNetWorthSummaries`), `lib/ai/assemblers/snapshot.ts`, `GET /api/spaces/[id]/snapshots`, dashboard charts, `lib/space-hero.ts`. Day-one is handled honestly by `ChartFirstDayPlaceholder` ("Started tracking today… check back tomorrow") — the codebase's "never fabricate a trend" contract.

## 2. Current generation — balance-derived only (Q2)

`regenerateSpaceSnapshot(spaceId, date=today)` = `getAccounts({spaceId})` → `classifyAccounts()` → upsert `[spaceId, date]`. It is **purely balance-derived** and only ever writes **today**. There is no historical writer. So a fresh Space has exactly one row after first sync → every trend chart shows the placeholder. What historical reconstruction needs that we don't store: **historical daily balances** (Plaid `/transactions/sync` doesn't return them; Holdings are current-only, wiped each sync).

## 3. Reconstruction approach (Q3) — what is honest

**Anchor on today's real (LIVE) row and walk balances backward using signed transaction sums** (FM convention: `+`=money in, `−`=money out):
```
balance(day n-1) = balance(day n) − Σ amount(transactions dated day n)
```

| Component | Reconstructable? | Handling |
|---|---|---|
| **Cash — checking + savings** | ✅ transactions fully explain deltas | Reconstruct per prior day (delta walk) |
| **Credit-card debt** | ⚠️ partial (interest/fees post without a txn) | v1: recommend **hold flat** (avoid drift); optional later |
| **Investments / crypto** | ❌ value moves with market price, no price history stored | **Hold flat** at today's value → estimated |
| **Manual/real assets (`other`)** | ❌ no transactions | Hold flat, floored at `createdAt` → estimated |
| **Loans (non-card debt)** | ❌ amortization not txn-driven | Hold flat → estimated |

Recompute derived fields (`netWorth/totalAssets/netLiquid/cashOnHand`) each backfilled day with the **same `classifyAccounts()` arithmetic** so the series stays internally consistent with live totals. **Account-level reconstruction → aggregate per Space** (never Space-level deltas). **Do NOT use FlowType** (not finalized) — reconstruction uses raw signed `amount` only. **Hard floor:** stop before each account's earliest transaction date and before `FinancialAccount.createdAt` / `SpaceAccountLink.createdAt` — never imply an account existed earlier than it did.

**Cannot be reconstructed honestly:** any prior-day value for investments/crypto/manual/loans. Because a coherent net-worth series must still include those, they are carried **flat and flagged estimated** — which is why a provenance flag is required (§8).

## 4. First-run integration (Q4)

- **Where Slice 2 history completes:** `runDeferredHistorySync(plaidItemId)` (`lib/plaid/backgroundHistorySync.ts`), inside the `after()` task, calls `syncTransactionsForItem` — on success `cursor`/`lastSyncedAt` are set and full history exists.
- **Trigger point:** call the backfill **from `runDeferredHistorySync`, after `syncTransactionsForItem` succeeds** (history must exist before reconstruction). This supersedes the prior doc's "wire into `exchangeToken.ts` step 9" — under Slice 1 the inline history is deferred, so the correct seam is the Slice 2 background task.
- **Best-effort:** wrap in its own `try/catch`; a backfill failure must never affect the sync result or the (already-sent) Link response. Mirrors the existing non-fatal snapshot step.
- **Sync status:** should **not** change. `state` is `cursor`-derived; backfill runs in the same background task moments after the cursor is set, and reconstructing ≤30 rows/space is sub-second. Adding a "building history" sub-state would need a new signal (scope creep) for a sub-second window the chart placeholder already covers. **Recommend no Connections UI change** (honors the rule).

## 5. Scope (Q5)

- **Window:** **30 days first** (smallest). `days_requested:730` allows going deeper later; start at 30, floored at available depth.
- **Which Spaces:** **per-Space**, only Spaces that (a) are impacted by the just-synced `FinancialAccount`s (via ACTIVE `SpaceAccountLink`, same fan-out as `regenerateSnapshotsForAccounts`) **and** (b) are **genuinely new** (`≤ 1` existing snapshot) — so there is no real history to corrupt and today's membership isn't an anachronism (§6). Personal and shared Spaces evaluated independently.

## 6. Correctness (Q6)

- **No double-counting shared accounts:** reconstruct **per Space** from that Space's visible account set; an account in multiple new Spaces is reconstructed independently in each (same model as the current fan-out).
- **Respect `SpaceAccountLink` visibility:** reconstruct from the same visibility-respecting set `getAccounts({spaceId})` uses. **Subtle risk:** link/visibility is **not versioned over time**, so using today's membership for prior days is an anachronism — **mitigated by the new-Space gate** (≤1 snapshot ⇒ membership is fresh).
- **Preserve current balance correctness:** **never overwrite** any existing row; **exclude today** (authoritative LIVE). Create-if-absent only.
- **Transfers / debt payments:** handled naturally by per-account delta walks — a transfer debits one account and credits another; if both are in the Space they net at aggregate, if only one is, that account's real movement is reflected. No special-casing, and **no FlowType dependency**.
- **Avoid FlowType:** confirmed — raw `amount` only (FlowType write/read path is not finalized).

## 7. Performance (Q7)

- **Row counts:** ≤ window (30) rows per new Space; typically 1–2 new Spaces per first connect. Transaction reads are indexed (`@@index([financialAccountId, date])`) and bounded to the window.
- **Batching:** one `createMany({ data, skipDuplicates: true })` per Space (unique `[spaceId,date]` makes it idempotent).
- **`maxDuration` with `after()`:** runs inside the Slice 2 `after()` task (route `maxDuration = 60`); reconstruction is in-memory + a bounded query + one small insert → sub-second, well within budget.
- **Cron fallback:** the daily `sync-banks` cron syncs transactions and regenerates **today's** snapshot but does **not** backfill history. So if the `after()` task is cut off before backfill, history stays shallow (chart shows the honest placeholder) — **no data loss**, just the nicety missed. A re-run path (e.g. on next manual refresh) is **deferred** (keep minimal). Flagged as a risk.

## 8. Provenance / schema (Q8) — the one necessary deviation

**Existing schema is not enough for honesty, and this slice cannot be honest without a flag.** A coherent net-worth series mixes **real cash** with **flat-estimated** investments/loans/manual assets; without a provenance flag, every reader (charts, Daily Brief, AI assembler) would present estimates as fact — breaking the codebase's "never fabricate" contract.

**Recommended minimal additive schema** (aligned with additive-before-subtractive; the prior investigation's approved §8):
- `SpaceSnapshot.isEstimated Boolean @default(false)` (and/or `source SnapshotSource @default(LIVE)` enum `LIVE | BACKFILL`).
- Defaulted → **all existing rows and every current writer read as LIVE/not-estimated with zero migration risk**. No new tables, no renames, no removal, no price-history store, no `SyncJob`, no queue.

This is the smallest change that satisfies "no schema unless absolutely necessary": it **is** necessary for honest mixed real/estimate rows. *If schema is refused:* the only schema-free alternative is a cash/netLiquid-only backfill that omits investments from historical days — which makes the net-worth series discontinuous vs today and is **not recommended** (incoherent trend). Recommendation: accept the single additive boolean.

## 9. Product surface unlocked (Q9)

- **Net-worth / cash-history charts:** a real 30-day trend curve instead of the day-one placeholder (`getRecentSnapshots`/`getPortfolioHistory`).
- **Daily Brief:** `netWorthTrend`/`netWorthTrendPct` in the snapshot domain become non-trivial → the "Since Last Visit" and trend insights populate.
- **AI historical context:** `lib/ai/assemblers/snapshot.ts` reads multi-day history → trend/window reasoning becomes possible (no AI redesign — it already reads whatever exists).
- **Connections ready state:** already correct at `cursor`-set; **no "Building history" state needed** (backfill completes with the sync; sub-second). Recommend **no Connections UI change**.
- **Honesty:** charts/AI should distinguish estimated history via `isEstimated` (badge) — see Phase 4.

## 10. Files affected (Q10)

| File | Change | Phase |
|------|--------|-------|
| `prisma/schema.prisma` (+ migration) | Additive `isEstimated` (+ optional `source` enum) on `SpaceSnapshot`, defaulted. | 1 |
| `lib/snapshots/backfill.ts` | **New** `backfillSpaceSnapshots(spaceId)`: new-Space gate, cash delta-walk from today's LIVE row, non-cash flat, floors, `createMany skipDuplicates`, `isEstimated=true`, excludes today. Dark (unwired). | 2 |
| `lib/snapshots/backfill.test.ts` | **New** unit tests for the reconstruction math (standalone `tsx`/node, no DB). | 2 |
| `lib/plaid/backgroundHistorySync.ts` | After `syncTransactionsForItem` succeeds, resolve affected new Spaces (via ACTIVE `SpaceAccountLink`) and call the backfill, best-effort/non-fatal. | 3 |
| `components/charts/*` (+ possibly `lib/ai/assemblers/snapshot.ts` read) | Minimal "estimated history" badge honoring `isEstimated`. | 4 (with 3) |
| `lib/snapshots/regenerate.ts` | **No change** (preserve current behavior; backfill anchors on its LIVE output). | — |

## 11. Smallest implementation slices (Q11)

Four independently-shippable, independently-revertible phases (this doc is Phase 0):
- **Phase 1 — additive schema.** `isEstimated` (+ optional `source`), defaulted. `prisma generate` + `migrate dev` + `tsc` + `lint`. No behavior change. Ship alone.
- **Phase 2 — backfill function, dark.** `backfillSpaceSnapshots(spaceId)` + unit tests. Pure addition, unwired.
- **Phase 3 — wire into Slice 2.** Call from `runDeferredHistorySync` after the tx sync, per affected new Space, best-effort. **Ship Phase 4 with it** (see risk R1).
- **Phase 4 — UI honesty.** Badge `isEstimated` series; keep `ChartFirstDayPlaceholder` for true day-one. Should land **with** Phase 3 so estimated data is never shown unlabeled.

## 12. Risks

- **R1 — unlabeled estimates (honesty).** Readers don't filter by `isEstimated` today, so Phase 3 alone would render backfilled estimates unlabeled. **Mitigation:** ship Phase 4 with Phase 3 (or have readers ignore `isEstimated` rows until Phase 4).
- **R2 — investment/loan flat lines.** The largest asset class is estimated-flat historically; the badge + tooltip ("cash reconstructed; investments held flat") is the honesty guard.
- **R3 — visibility anachronism.** Today's membership applied to prior days — mitigated by the new-Space (≤1 snapshot) gate.
- **R4 — `after()` timeout skips backfill; cron doesn't backfill.** Degrades to the day-one placeholder; no data loss. Re-run path deferred.
- **R5 — shallow depth on pre-`days_requested` Items.** Floors at available data; fewer than 30 days for legacy Items. Honest, just shorter.
- **R6 — credit-card drift** if reconstructed. Mitigated by holding card debt flat in v1.

## 13. Validation plan

- `npx prisma generate`; `npx prisma migrate dev` (Phase 1); `npx tsc --noEmit`; `npm run lint`.
- **Unit** (`backfill.test.ts`): known account balance + transaction set → assert reconstructed daily cash matches hand-computed deltas; assert non-cash held flat; assert floor at earliest tx date / `createdAt`; assert today excluded and never overwritten.
- **Dev Link run:** fresh Space connect → after background sync, assert N backfilled rows (`isEstimated=true`), today's row remains `LIVE`, net-worth series is continuous into today, `@@unique` prevents dupes on re-run.
- **Gating:** a Space with >1 existing snapshot is not backfilled; a shared Space is evaluated independently.
- **Reader check:** charts render the trend with the estimated badge; Daily Brief trend populates; AI assembler returns multi-day history.
- `git diff` limited to the phase's scoped files.

## 14. Rollback plan

- Additive flag defaults keep all pre-existing rows `LIVE`/not-estimated → zero migration risk.
- Full data reversal: `DELETE FROM "WorkspaceSnapshot" WHERE isEstimated = true` (or `source='BACKFILL'`).
- Each phase reverts independently: unwire the call in `backgroundHistorySync.ts` (Phase 3), delete `backfill.ts` (Phase 2), drop the column (Phase 1). No engine/Connections/AI redesign to unwind.

**Stop — investigation/checklist only. Await approval (incl. §8 schema decision and the Phase 3+4 bundling) before implementation.**
