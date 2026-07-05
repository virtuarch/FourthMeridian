# D2.x — Snapshot Orchestration Fix — Pre-Commit Verification

**Status:** Verification only. No implementation (no correctness issue found).
**Subject:** `lib/plaid/refresh.ts` — `refreshAllActiveItemsForUser` + `regenerateCompletedSpaces` + `refreshPlaidItem(opts)`.

The gating logic under test (`regenerateCompletedSpaces`, lines 390–424):
```
if (succeededAccountIds.length === 0) return [];
candidateSpaceIds = { spaceId : ACTIVE SpaceAccountLink.financialAccountId ∈ succeededAccountIds }   // 397-401
if (failedItemIds.length > 0 && candidateSpaceIds.size > 0):
    failedFaIds   = AccountConnection.financialAccountId where plaidItemDbId ∈ failedItemIds, deletedAt null   // 406-410
    tarnished     = { spaceId : ACTIVE SpaceAccountLink.financialAccountId ∈ failedFaIds }                     // 412-416
    candidateSpaceIds = candidateSpaceIds − tarnished                                                          // 417
regenerate each candidateSpaceId once                                                                          // 421-422
```

---

## Q1 — Space with A (success) + B (fail): fully prevented? **Yes. Proof, not inference.**

- The Space **is** a candidate: A's accounts ∈ `succeededAccountIds`, and the Space links them → included by lines 397–401.
- The Space **is** tarnished: B ∈ `failedItemIds` → B's accounts ∈ `failedFaIds` (406–410) → the Space links them → ∈ `tarnished` (412–416).
- Line **417** removes every tarnished space from the candidate set → the Space is dropped → **not regenerated**. The successful A accounts cannot "rescue" it, because the exclusion is applied to the *Space*, after candidacy, not to accounts.

## Q2 — Space X = {Chase ✓, Amex ✗, Schwab ✓}: step-through

Loop (`refreshAllActiveItemsForUser`, deferSnapshot=true so no per-item write):
- Chase → ok → `succeededAccountIds += chaseAccts`.
- Amex → throws → `failedItemIds += [amexItemId]` (and health-updated).
- Schwab → ok → `succeededAccountIds += schwabAccts`.

Post-loop `regenerateCompletedSpaces([chase+schwab accts], [amexItemId])`:
- `candidateSpaceIds` = spaces of Chase+Schwab accounts = **{X}** (both live in X).
- `failedItemIds` non-empty → `failedFaIds` = Amex's accounts → `tarnished` = spaces of Amex accounts = **{X}**.
- `candidateSpaceIds − tarnished` = **{}**.
- `Promise.all([])` → **Space X does NOT regenerate.** ✓ (No partial write with a stale Amex balance.)

## Q3 — A={Chase}, B={Amex}, C={Chase+Amex}; Chase ✓, Amex ✗

- `succeededAccountIds` = Chase accounts; `failedItemIds` = [Amex].
- `candidateSpaceIds` = spaces of Chase accounts = **{A, C}** (B is *not* a candidate — nothing succeeded touches it).
- `tarnished` = spaces of Amex accounts = **{B, C}**.
- `{A, C} − {B, C}` = **{A}**.
- **A → regenerated ✓ · B → not (never a candidate) ✓ · C → excluded (tarnished) ✓.** Matches the expected answer exactly.

## Q4 — Single-item refresh still regenerates exactly once. **Confirmed — call graph:**

```
POST /api/plaid/refresh (single item)  app/api/plaid/refresh/route.ts:62
  → refreshPlaidItem(item.id)                       // NO opts
      → opts?.deferSnapshot === undefined (falsy)
      → step 4: regenerateSnapshotsForAccounts(updatedAccountIds)   // refresh.ts (not deferred)
          → regenerateSpaceSnapshot(spaceId) per affected space     // once
```
`deferSnapshot` is only ever `true` when `refreshAllActiveItemsForUser` sets it. Every other caller (the single-item route; any direct call) passes no opts → regenerates once, unchanged.

## Q5 — Connect flow: unaffected, and should stay so.

`exchangeToken.ts:521` calls `regenerateSnapshotsForAccounts(importedIds)` **directly** — it does **not** go through `refreshPlaidItem`, so this change does not touch it. **It should remain unchanged:** a connect imports exactly **one** institution, so there is no multi-institution in-flight set to be partial about. Its full-Space read includes other, already-connected institutions at their **last-known current** balances (legitimate state, not mid-refresh). The race this fix addresses is specific to refreshing **several items in one operation**; connect has no such loop. (If connect ever batch-imported multiple institutions at once, the same once-after-all principle would apply — but it does not today.)

## Q6 — Historical note: future-only; does NOT touch the July 2 row.

This change only alters `refreshAllActiveItemsForUser`'s *future* writes. It reads/writes nothing retroactively, and Slice 4B backfill never overwrites live rows — so the **existing July 2 live snapshot is untouched**. To repair that one historical row:

1. `regenerateSpaceSnapshot` can only write **today's** date (`todayUTC()`), so it cannot rewrite July 2. And July 2's *true* balances are not stored anywhere (only today's), so a faithful live recompute is impossible.
2. Realistic repair: **DELETE the July 2 `SpaceSnapshot` row** for the Space, then re-run the historical backfill — which, finding July 2 now missing, reconstructs it as an **estimated** row (cash walked back from today's complete balance). This converts the wrong partial-**live** row into a reconstructed **estimated** row.
   - Note: the backfill `--rollback` only deletes `isEstimated=true` rows; the July 2 row is **live** (`isEstimated=false`), so it must be deleted explicitly (one targeted `DELETE`), then reseeded (`--dev-seed-target-spaces-30d --apply`, which now finds July 2 missing and fills it).
3. This is defensible on historical-integrity grounds: the July 2 live row was **not** a legitimate capture (it was written from a partial/incomplete set), so replacing it with an honest reconstruction is a correction, not a falsification. It should be a deliberate one-off, and it changes that row from live → estimated (labeled).

---

## Verdict

The implementation is **correct** for all four gating scenarios (Q1–Q3), preserves single-item behavior (Q4), leaves connect untouched by design (Q5), and is future-only (Q6). **No correctness issue found — safe to commit** as the D2 snapshot orchestration fix. The one follow-up is the deliberate July 2 historical repair in Q6, which is separate from this commit.

**Stop — verification only.**
