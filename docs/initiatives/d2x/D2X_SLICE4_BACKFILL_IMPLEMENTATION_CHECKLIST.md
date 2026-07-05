# D2.x — Slice 4: Historical Snapshot Backfill — Implementation Checklist

**Status:** Checklist only. No implementation until approved.
**Source:** `D2X_SLICE4_HISTORICAL_SNAPSHOT_BACKFILL_INVESTIGATION.md`.
**Decision:** additive `SpaceSnapshot.isEstimated` flag; 30-day backfill; triggered from `runDeferredHistorySync` after tx sync; best-effort; badge ships with the wiring; no Connections change, no SyncJob, no queue.

Four independently-shippable, independently-revertible phases.

---

## Phase 1 — Additive schema flag

**Files:**
- `prisma/schema.prisma` — add to `model SpaceSnapshot`:
  ```prisma
  isEstimated Boolean @default(false) // D2.x Slice 4 — true for reconstructed/backfilled rows
  ```
  (No `source` enum — approved single boolean. No other field change.)
- Migration via `npx prisma migrate dev --name d2x_slice4_snapshot_isestimated`
  → produces `prisma/migrations/<timestamp>_d2x_slice4_snapshot_isestimated/migration.sql` (an `ALTER TABLE "WorkspaceSnapshot" ADD COLUMN "isEstimated" BOOLEAN NOT NULL DEFAULT false`).

**Behavior:** none changes — every existing row and current writer (`regenerateSpaceSnapshot`) reads `isEstimated=false`. Ship alone.

**Validation:** `npx prisma generate`; `npx prisma migrate dev`; `npx tsc --noEmit`; `npm run lint`.

---

## Phase 2 — Dark backfill function + tests (unwired)

**Files (new):**
- `lib/snapshots/backfill-core.ts` — **pure**, no DB/imports of Prisma client, so it unit-tests without `prisma generate`.
- `lib/snapshots/backfill.ts` — DB orchestration (gate, queries, `createMany`).
- `lib/snapshots/backfill-core.test.ts` — standalone (`node`/`tsx`) test of the math.

### 2a. Pure core (`backfill-core.ts`)

Types + pure functions (no I/O):
```ts
interface BackfillAccount { id: string; type: string; balance: number; floorDate: Date; }
interface CashDelta { financialAccountId: string; date: Date; sum: number; } // Σ signed amount that day

// Walk cash balances backward from today's current balance.
// eod(d) = current − Σ amount(txns dated > d). Returns Map<accountId, Map<isoDate, balance>>.
reconstructDailyCash(cashAccounts, deltas, today, earliestDate): ...

// For each day in [earliestDate, today-1], build a per-day account array
// (cash = reconstructed balance, non-cash = current flat), EXCLUDING accounts
// whose floorDate > day, and return classify-ready arrays.
buildDailyAccountSets(accounts, reconstructedCash, today, earliestDate): Array<{ date, accounts: BackfillAccount[] }>
```
Aggregation is done by the **caller** via the existing `classifyAccounts()` on each day's account array (reuse — do not duplicate the totals logic), then the same derived formula as `regenerate.ts` (`totalAssets = stocks+crypto+cash+savings+realAssets`, `netWorth = totalAssets − debt`, `netLiquid = cash+savings−debt`, `cashOnHand = max(cash,0)`, `total = stocks+crypto`). Keeping aggregation in `classifyAccounts` guarantees the backfilled series matches live totals.

**Sign convention:** FM `amount` is `+in / −out`. `eod(d) = eod(d+1) − Σ amount(txns dated d+1)`. Cash-type accounts only (`checking`, `savings`). No FlowType — raw `amount`.

### 2b. Orchestration (`backfill.ts`)

`export async function backfillSpaceSnapshots(spaceId: string): Promise<number>` (returns rows written):

1. **New-Space gate:** `const n = await db.spaceSnapshot.count({ where: { spaceId } }); if (n > 1) return 0;` (only today's LIVE row may exist).
2. **Account set (parity with live snapshot):** `const accounts = await getAccounts({ spaceId });` — same visibility-respecting set/types/current balances `regenerateSpaceSnapshot` uses.
3. **Floors:** query `FinancialAccount.createdAt` for those ids and the ACTIVE `SpaceAccountLink.createdAt` for `(spaceId, financialAccountId)`; `floorDate(account) = max(link.createdAt, financialAccount.createdAt)` (truncated to date).
4. **Window:** `today = todayUTC()`; `windowStart = today − 30d`; `effectiveStart = max(windowStart, min(floorDate over accounts))`.
5. **Cash deltas query (window-bounded, indexed):**
   ```ts
   const cashIds = accounts.filter(a => a.type === "checking" || a.type === "savings").map(a => a.id);
   const txns = await db.transaction.groupBy({
     by: ["financialAccountId", "date"],
     where: { financialAccountId: { in: cashIds }, deletedAt: null,
              date: { gt: effectiveStart, lte: today } },
     _sum: { amount: true },
   });
   ```
   (Also compute each cash account's earliest txn date to stop cash reconstruction below it — before that, hold that account flat at its earliest reconstructed balance; never fabricate.)
6. **Reconstruct + build rows** via the pure core; **exclude `today`**; each row `isEstimated: true`.
7. **Write create-if-absent, never overwrite:**
   ```ts
   await db.spaceSnapshot.createMany({ data: rows, skipDuplicates: true }); // @@unique([spaceId,date])
   ```
8. Wrap the whole function so it is safe to call anywhere; return count for logging.

**Preserved invariants:** never touches today's row; never `upsert`/overwrite; `regenerate.ts` unchanged.

### 2c. Unit tests (`backfill-core.test.ts`)

Pure, standalone (run via `node --experimental-strip-types` after a cjs transpile, mirroring `lib/sync/status.test.ts`):
- **Cash delta walk:** balance 1000; txns `today:-50`, `today-1:+200` ⇒ eod(today)=1000, eod(today-1)=1050, eod(today-2)=850. Assert.
- **Non-cash flat:** investment/crypto/other/loan balances identical across all days.
- **Floor:** no day < `effectiveStart`; an account with `floorDate` mid-window is excluded from earlier days' arrays.
- **Earliest-txn stop:** cash not reconstructed below its earliest txn date.
- **Today excluded:** no row for `today`.
- **Derived parity:** feed a day's array through `classifyAccounts` + the derived formula; assert `netWorth/netLiquid/totalAssets/cashOnHand` match hand-computed values and the `regenerate.ts` formula.

---

## Phase 3 — Wire into background history sync (ship WITH Phase 4)

**File:** `lib/plaid/backgroundHistorySync.ts` — in `runDeferredHistorySync`, **after** `syncTransactionsForItem(plaidItemId)` succeeds (inside the same `try`, before/after the success log), resolve affected Spaces and backfill each, best-effort:

```ts
// Resolve the item's FinancialAccounts → their ACTIVE SpaceAccountLink spaces.
const conns = await db.accountConnection.findMany({
  where: { plaidItemDbId: plaidItemId, deletedAt: null },
  select: { financialAccountId: true },
});
const faIds = conns.map(c => c.financialAccountId);
const links = await db.spaceAccountLink.findMany({
  where: { financialAccountId: { in: faIds }, status: ShareStatus.ACTIVE },
  select: { spaceId: true },
});
const spaceIds = [...new Set(links.map(l => l.spaceId))];
for (const spaceId of spaceIds) {
  try {
    const written = await backfillSpaceSnapshots(spaceId);
    if (written) console.log(`[plaid][D2x-slice4] backfilled ${written} snapshot(s) for space ${spaceId}`);
  } catch (e) {
    console.error(`[plaid][D2x-slice4] backfill failed for space ${spaceId} (non-fatal):`, e);
  }
}
```

- The `backfillSpaceSnapshots` new-Space gate ensures only genuinely new Spaces are touched (existing Spaces short-circuit at count > 1).
- Entire block wrapped so backfill can **never** fail the sync or the (already-sent) Link response. No change to sync-status derivation → **no Connections UI change**.
- `regenerateSnapshotsForAccounts` (today's row) still runs as today — unaffected.

**Validation:** `npx tsc --noEmit`; `npm run lint`; dev Link run (below).

---

## Phase 4 — Minimal estimated-history badge (ship WITH Phase 3)

**Files:**
- `types/index.ts` — add `isEstimated?: boolean` to `interface Snapshot`.
- `lib/data/snapshots.ts` — in `getRecentSnapshots` / `getPortfolioHistory`, select `isEstimated` and map it onto each returned `Snapshot`. (Additive; no query redesign.)
- `components/charts/EstimatedHistoryBadge.tsx` — **new** tiny presentational badge (reuse existing badge/token styling; no new material) with tooltip copy: *"Estimated history — cash reconstructed from transactions; investments held flat."*
- `components/charts/NetWorthChart.tsx` (primary) — render `<EstimatedHistoryBadge />` in the chart header when `series.some(p => p.isEstimated)`. (Optionally `CashChart.tsx` too; keep to NetWorth for minimal.)

**Preserved:** `ChartFirstDayPlaceholder` unchanged — still the honest single-point day-one state. No AI change (the AI assembler already reads whatever history exists; badging is UI-only).

**Honesty gate (risk R1):** Phase 3 writes flagged rows that readers otherwise render unlabeled — so Phase 4 must land **in the same release** as Phase 3.

**Validation:** `npx tsc --noEmit`; `npm run lint`; visual: a backfilled Space shows the net-worth trend with the estimated badge; a Space with only real data shows no badge.

---

## Cross-phase validation plan

- Phase 1: `prisma generate` + `migrate dev` + `tsc` + `lint`; confirm existing rows read `isEstimated=false`.
- Phase 2: run `backfill-core.test.ts` (all math assertions pass); `tsc`/`lint`.
- Phase 3+4: dev Plaid sandbox first-run →
  - after background sync, assert **N ≤ 30** backfilled rows exist for the new Space, all `isEstimated=true`;
  - **today's row remains `isEstimated=false` (LIVE)** and is unchanged;
  - net-worth series is **continuous** into today (cash varies, non-cash flat);
  - re-running the flow inserts **no duplicates** (`@@unique[spaceId,date]` + `skipDuplicates`);
  - a Space with >1 prior snapshot is **not** backfilled (gate);
  - no rows before `effectiveStart` / account floors;
  - charts render the trend + estimated badge; Daily Brief trend populates; AI assembler returns multi-day history;
  - Plaid Link + background sync still succeed if backfill throws (temporarily force an error).
- `git diff` limited to each phase's scoped files.

## Rollback plan

- **Data:** `DELETE FROM "WorkspaceSnapshot" WHERE "isEstimated" = true;` removes all backfilled rows; LIVE rows untouched.
- **Phase 3:** remove the backfill block from `backgroundHistorySync.ts` → sync reverts to Slice 2 behavior.
- **Phase 2:** delete `backfill*.ts` — nothing else imports them.
- **Phase 1:** drop the column (defaulted, so safe); all rows already read LIVE.
- Each phase reverts independently; no engine/Connections/AI/snapshot redesign to unwind.

**Stop — await approval before implementation.**
