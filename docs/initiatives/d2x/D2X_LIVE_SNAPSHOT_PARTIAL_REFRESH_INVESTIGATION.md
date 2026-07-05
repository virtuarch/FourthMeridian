# D2.x — Live Snapshot Generated From a Partial Refresh — Investigation

**Status:** Investigation only. No code.
**Given:** the July 2 anomaly is a **cash** movement, on an **estimated→live** boundary, with **no** Jul 1–4 payroll transaction and debt reconstruction ruled out. That points at the **live** July 2 snapshot having been written from an **incomplete/stale cash set**, not at the estimated reconstruction.

---

## The live-snapshot write path (code-proven)

`refreshPlaidItem(itemId)` (`lib/plaid/refresh.ts`) does: balances → holdings → transactions → **step 4, line 321**: `regenerateSnapshotsForAccounts(updatedAccountIds)`. That helper (`regenerate.ts:103`) resolves the **spaces** those accounts belong to and calls `regenerateSpaceSnapshot(spaceId)` for each — which reads the **full** space account set via `getAccounts({spaceId})` + `classifyAccounts`, then **upserts** the `[spaceId, today]` row (`isEstimated=false`).

`refreshAllActiveItemsForUser` (`refresh.ts:452`) **loops the items** and calls `refreshPlaidItem(item.id)` per item, inside a per-item `try/catch`; on failure it records item health and does **not** regenerate. The manual `POST /api/plaid/refresh` route calls `refreshPlaidItem` (single item) or `refreshAllActiveItemsForUser` (all items). `exchangeToken.ts:521` (connect) regenerates the same way, per just-imported item.

**Consequence:** `regenerateSpaceSnapshot` is invoked **once per institution**, each time reading the *whole* space but with only the *just-refreshed* institution guaranteed fresh; the day's row is an **upsert (last-write-wins)**.

---

## Answers

### Q1 — Which FinancialAccounts contributed to `totalCash` for that live snapshot?
`regenerateSpaceSnapshot` → `getAccounts({spaceId})` returns **every ACTIVE `SpaceAccountLink` whose `FinancialAccount.deletedAt IS NULL`**, and `classifyAccounts` sums `type='checking'` (+ `savings`) balances. So the contributors were *all* active-linked cash accounts **at the instant that upsert ran** — using **whatever balance each held at that instant** (fresh for the just-refreshed institution, **stale** for the others).
**Data limitation:** `SpaceSnapshot` stores only the aggregate (`cash`, `savings`, …), **not a per-account breakdown**, so the exact set that produced the July 2 `cash` value **is not recoverable from the row**. It can only be inferred from the connect/refresh timeline (the diagnostic's Section 3 / AuditLog).

### Q2 — Did every ACTIVE SpaceAccountLink participate?
**Set-membership: yes** — `getAccounts` includes all ACTIVE, non-deleted links regardless of refresh state. **Balance freshness: no** — links belonging to institutions not yet refreshed (or that failed) contributed **stale** balances. So "participation" is complete but the *values* can be a mix of fresh and stale. (An account is genuinely *excluded* only if, at that instant, its link was non-ACTIVE or its `FinancialAccount.deletedAt` was set — e.g. a mid-reconnect window.)

### Q3 — Was Chase Checking included?
Included **iff** at the upsert instant it had an ACTIVE link and `deletedAt IS NULL`. If Chase was connected but its **balance had not yet been refreshed** when an *earlier* institution's regenerate ran (or Chase's own refresh **failed**), the row would carry Chase's **stale/low** balance — or, if Chase was mid-reconnect (`deletedAt` set transiently), it would be **excluded** entirely, dropping `totalCash`. Not provable from the stored row; the AuditLog/PlaidItem timeline (diagnostic §3) is the evidence.

### Q4 — Can `regenerateSpaceSnapshot` execute before all PlaidItems finish? **Yes.**
It runs *inside* `refreshPlaidItem` (step 4). In `refreshAllActiveItemsForUser`, item 1 completing triggers a regenerate while items 2..N are still pending/stale. So a snapshot is written **before** the later institutions refresh.

### Q5 — During "Refresh Data", is it called once per institution or once after all finish? **Once per institution.**
`refreshPlaidItem` calls it per item (line 321); `refreshAllActiveItemsForUser` loops items, so it fires **N times** (once per institution), each an upsert of the same `[spaceId, today]` row. There is **no** single post-loop regeneration.

### Q6 — Is there a race where a partially-refreshed set becomes the persisted snapshot? **Yes.**
Because the row is upserted per-institution (last-write-wins) from a full-set read:
- **Intermediate writes** reflect partial freshness (just-refreshed item fresh, others stale).
- **Mid-run failure:** if a later institution **throws**, its regenerate (step 4) never runs, so the **last successful** regenerate — which read the failed institution's **stale** balance — remains persisted (`refreshAllActiveItemsForUser`'s `catch` records health but does **not** re-snapshot).
- **Ordering:** the final value depends on which institution's regenerate ran last and the state of the others at that moment.
- **Concurrency:** overlapping writers on the same `[spaceId, today]` key (manual Refresh + the 06:00 cron, or connect + refresh) can interleave upserts with different partial views — last writer wins, possibly the partial one.
- **Connect day:** `exchangeToken` step 9b regenerates right after importing *one* institution, before others are connected/settled.
Any of these can persist a **low-cash** live row. Because Slice 4B backfill **never overwrites live rows**, that bad row survives — and shows as the est→live cash jump.

### Q7 — Smallest architectural fix
**Regenerate each affected space exactly once, AFTER all institutions in the operation complete — not per institution.** Concretely: have `refreshAllActiveItemsForUser` (and the manual all-items route) **collect the union of affected `spaceId`s** across every item, then call `regenerateSpaceSnapshot(spaceId)` **once per space after the loop finishes**, and drop (or make conditional) the per-item regenerate inside `refreshPlaidItem`. This guarantees the persisted snapshot reflects the **fully-refreshed** set, eliminating the intermediate/partial writes and the last-write-wins race.
- **Optional hardening:** skip a space's post-loop regeneration if **any** of its items failed this run (never persist a knowingly-partial set — leave the prior row intact), and treat single-item refresh as "all items for that space are done" (still one regenerate). Single-item refresh already regenerates once, so it's unaffected.
- **Out of scope but related:** a genuinely stale row from an item that *stayed* failed is a data-freshness issue, not a race — the once-after-all change still prevents a **transient** partial write from being persisted.

This is a **call-site hoist** (where and how often `regenerateSpaceSnapshot` is invoked), not a change to the snapshot math, the schema, or the reconstruction. Smallest surface that closes the race.

---

## Note on confirming it for July 2

The stored July 2 row cannot tell you which accounts/balances produced its `cash` (aggregate-only). The confirming evidence is the **timeline** (diagnostic §3): if the AuditLog shows a July 2 `PLAID_REFRESH`/`ACCOUNT_ADD` where one institution refreshed/failed around the time the live row was written — and today's full-set cash (which the estimated neighbor reconstructs from) is materially higher — that is the partial-refresh signature. The fix above prevents recurrence regardless of which institution was implicated.

**Stop — investigation only. No code.**
