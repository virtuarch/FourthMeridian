# CONN-2 — Financial Intelligence Reconstruction: Investigation & Architecture Audit

**Status:** INVESTIGATION COMPLETE. Gated deliverable — implementation beyond the smallest safe slice (§6) follows only after this architecture is confirmed.
**Date:** 2026-07-19.
**Frame:** the reconstruction problem is **Layer 2** (rebuild *derived* intelligence from transactions that already exist), NOT Layer 1 (re-download transactions — that works). See `docs/plans/connection-lifecycle-roadmap.md` for the three-layer model. **Naming rule:** "history rebuild" = the technical operation only; the user experience is about **restoring intelligence**, never re-downloading data.

---

## 0. Executive summary

1. **Transaction truth already exists and is separate from derived truth.** Transactions (`Transaction` rows, cursor, `syncIncompleteAt`) are Layer-1 authority. Everything the reconstruction experience is *about* — wealth snapshots, net-worth timeline, cash-flow history — is **derived truth** rebuilt by existing authorities. CONN-2 surfaces and re-triggers that rebuild; it does not compute any of it.

2. **The rebuild engines already exist. The *experience* does not.** `regenerateWealthHistory[ForAccounts]`, `regenerateSpaceSnapshot[/ForAccounts]`, and `backfillHistoryForItem` already reconstruct derived intelligence. The per-item completion anchor is the `PLAID_HISTORY_SYNCED` AuditLog row. What is missing is a surface that says *"your transactions are here; Fourth Meridian is rebuilding your intelligence from them"* and lets the user see/re-trigger it per account.

3. **Per-account intelligence readiness is derivable now** from persisted records — no new store, no financial-authority change (§4).

4. **The reported "spinner never finishes after adding a 2nd bank" is a client polling bug, root-caused and fixed in this slice** (§5). Completion was always persisted correctly; the poller simply never started for the newly-added connection.

5. **Multi-account rebuild reuses the one batch authority** (`refreshAllActiveItemsForUser`) via an additive `includeItemIds[]` filter — never a new `refreshMultipleAccounts()` (§4.3).

---

## 1. Transaction truth vs derived truth (the boundary)

| | Layer 1 — transaction truth | Layer 2 — derived truth (reconstruction) |
|---|---|---|
| Records | `Transaction`, `PlaidItem.transactionCursor`, `syncIncompleteAt` | `SpaceSnapshot` (today + historical), wealth timeline, cash-flow history, coverage/trust projections |
| Authority | `syncTransactionsForItem` (never touched by CONN-2) | `regenerate*` family + `backfillHistoryForItem` |
| Completion marker | `syncIncompleteAt === null` | `PLAID_HISTORY_SYNCED` AuditLog row (per item) |
| CONN-2 stance | **read-only** — never re-imports | **surface + re-trigger via existing authority** — never recompute inline |

---

## 2. What already rebuilds derived intelligence (verified)

- **`lib/snapshots/regenerate.ts`** — `regenerateSpaceSnapshot(spaceId)` writes **today's** `SpaceSnapshot` from current balances; `regenerateSnapshotsForAccounts(faIds)` fans out to every ACTIVE-linking Space.
- **`lib/snapshots/regenerate-history.ts`** — `regenerateWealthHistory` / `regenerateWealthHistoryForAccounts(faIds, window)` rewrite **historical** rows (`toDate ≤ yesterday`; `recentWealthWindow()` = 30 days). Today's live row is deliberately out of scope.
- **`lib/plaid/backgroundHistorySync.ts`** — `runDeferredHistorySync(itemId)`: `syncTransactionsForItem` → `backfillHistoryForItem` (first-run historical backfill, new-Space-gated) → **`recordSyncComplete`**, which writes the single `PLAID_HISTORY_SYNCED` AuditLog row (metadata `{ institutionName, plaidItemId }`) and fans out the `SYNC_COMPLETED` bell. This row is the authoritative "full deferred pipeline complete" = **intelligence reconstructed** marker.
- **`components/dashboard/RebuildHistoryButton.tsx` → `/api/spaces/[id]/wealth/amend`** — existing **space-wide** wealth recompute (single-account select only records *which* account motivated it; the recompute uses the Space's current active-account set). `SpaceSnapshot` is a space-level aggregate — a single account's slice cannot be subtracted.

**Progress tracking that already exists:** `PlaidItem.syncIncompleteAt` → `SyncConnectionState` (`importing`/`ready`), polled by `ConnectionsList`; the `ConnectionLifecycleStatus` projection (`lib/sync/lifecycle.ts`, CONN-1). No percentage progress store exists, and none should be invented.

---

## 3. What is missing (the Layer-2 experience)

1. **A per-connection intelligence-readiness surface.** Today the card shows transaction state (`importing`/`ready`) but never distinguishes *"transactions imported"* from *"intelligence reconstructed."* The target:
   ```
   Chase Checking     Transactions: complete   Intelligence: ready       ~2 years available
   Amex               Transactions: complete   Intelligence: incomplete  ~18 months available
   ```
2. **A multi-account "Rebuild selected intelligence" control** in the Connections workspace (multi-select → one batch call).
3. **Stage language for reconstruction** — Importing → Reconstructing → Finalizing → Ready — data-backed only, no fabricated %.

---

## 4. Design for the missing pieces (additive, no authority change)

### 4.1 Per-account "intelligence readiness" — derivable now
Per connection, from existing records:
- **Transactions complete** = `SyncConnection.state === "ready"` (`syncIncompleteAt === null`).
- **Intelligence ready** = a `PLAID_HISTORY_SYNCED` AuditLog row exists with `metadata.plaidItemId === item.id`. Absent ⇒ **incomplete** (transactions landed but the derived-intelligence pipeline has not completed for this item).
- **~N available** = `today − earliestTxDate`, where `earliestTxDate = MIN(non-deleted Transaction.date)` per account (`app/api/spaces/[id]/accounts/route.ts:84-110`). NOT the `730`/`365` literals (Plaid request window / chart caps).

This is a **pure read** over `PlaidItem` + `AuditLog` + a `Transaction` min-date `groupBy` — no balances, no valuation, no financial-authority mutation. It extends the CONN-1 `ConnectionLifecycleStatus` projection (where `intelligenceReady` was an alias) into a real, data-backed marker.

### 4.2 Reconstruction stages (data-backed)
| Stage | Backed by |
|---|---|
| Importing | `syncIncompleteAt !== null` |
| Reconstructing | `syncIncompleteAt === null` AND no `PLAID_HISTORY_SYNCED` row yet |
| Finalizing | (optional) backfill/regeneration in flight — only if a persisted signal exists; else fold into Reconstructing |
| Ready | `PLAID_HISTORY_SYNCED` row present |

No percentage. Stages map cleanly onto the existing `deriveConnectionLifecycle` projection.

### 4.3 Multi-account rebuild — one additive filter
`refreshAllActiveItemsForUser(userId, { excludeItemIds? })` (`lib/plaid/refresh.ts:437`) already batches every active item with per-item locks + `regenerateCompletedSpaces` fan-out. Add **`includeItemIds?: string[]`** — one line in the same `where` clause (inverse of the existing exclude):
```ts
...(options?.includeItemIds?.length && { id: { in: options.includeItemIds } }),
```
`include` + `exclude` compose (`id: { in, notIn }` is valid). **No `refreshMultipleAccounts()`, no duplicate path.** A subset rebuild is just `refreshAllActiveItemsForUser(userId, { includeItemIds })`. (This is unused until the UI consumes it, so it lands *with* the reconstruction block, not before.)

---

## 5. The reported "spinner never finishes after adding a 2nd bank" — ROOT CAUSE + FIX (this slice)

**Symptom:** after adding a second bank, the background sync completes server-side (`syncIncompleteAt` cleared, `PLAID_HISTORY_SYNCED` written), but the UI spinner keeps spinning until a manual hard refresh.

**Root cause (confirmed by trace):** `components/connections/ConnectionsList.tsx` — the polling-start `useEffect` gated on `status.building` but with an **empty dependency array**, so it evaluated `building` only at mount. The Plaid Link success handler (`context/PlaidContext.tsx:162`) does `router.push("/dashboard/connections")` — but the user is **already on** that route, so it re-renders `ConnectionsList` **in place** (no remount, no `key` on the component). The re-seed effect (`setStatus(initialStatus)`) flips `status.building` false→true so the importing card appears, but the mount-only polling effect never re-runs → **the poller never starts** for the new connection. Since the 4s poll + `router.refresh()` is the *only* mechanism that moves a card importing→ready (no push/SSE channel exists), the card spins until a hard refresh remounts the component. The *first* connection works because the user navigates in from another route → a real mount with `building: true`.

**Not the cause:** completion, notification, or persisted state. Completion is correctly persisted (`syncIncompleteAt = null`) and `/api/sync/status` would report it — the poller just wasn't running to read it. This satisfies the invariant *"completion must always come from persisted state."*

**Fix (landed here):** key the effect on `status.building` (instead of `[]`) so it re-arms whenever building flips false→true, and on entry reset the poll budget + `slow`, and seed `prevBuildingRef = true` so the building→false transition still fires the single `router.refresh()`. Pure client polling — no financial authority, no new engine, no push channel. Secondary contributor noted (`prevBuildingRef` staleness) is addressed by the same seeding.

---

## 6. Safest implementation order

| # | Work | Risk | Slice |
|---|---|---|---|
| **1** | **Spinner-completion fix** (§5) — poller re-arms on building false→true | none (client polling) | **THIS SLICE (smallest safe)** |
| 2 | Extend `ConnectionLifecycleStatus` with the data-backed `intelligenceReady` marker (`PLAID_HISTORY_SYNCED` presence) + per-account `available` window (§4.1); surface "Transactions: complete · Intelligence: ready/incomplete · ~N available" | low (read-only projection + presentation) | CONN-2 body (next) |
| 3 | `includeItemIds[]` additive filter + "Rebuild selected intelligence" multi-select block in Connections workspace, reusing `SyncConnectionState` polling for stage progress (§4.2–4.3) | low-med (financial-adjacent path; additive only) | CONN-2 body (next) |
| 4 | Reconstruction stage language (Importing → Reconstructing → Finalizing → Ready) on the card | none (presentation) | CONN-2 body (next) |
| — | Layer-3 balance/snapshot freshness fix | **high (financial authority)** | **CONN-3 (separate)** |

**This slice implements only #1** — the reported bug, presentation/polling-only — plus the roadmap + this audit. Steps 2–4 are the reconstruction UX proper and land next as a focused, tested slice with browser verification against multi-connection state. Step "—" is CONN-3.

**Constraints honored:** no new sync engine · no DayFacts / FlowType / investment-valuation changes · no duplicate authorities · completion derives from persisted state · derived truth reconstructed only by existing `regenerate*` authorities.
