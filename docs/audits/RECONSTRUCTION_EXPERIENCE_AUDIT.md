# Reconstruction Experience — Audit & Design (Recovery/Hardening slice · Part 3)

**Status:** AUDITED + DESIGNED. Implementation of the unified UI is **deferred** to a focused, tested slice (rationale in §5) — the engine and progress signal already exist, so the improvement is a thin control layer, but it touches the financial-truth-adjacent reconstruction path and should not be rushed at the tail of an incident-affected session.
**Date:** 2026-07-19.
**Context:** after a DB reset, recovering multi-year history by reconnecting is currently a per-connection, one-at-a-time chore. This audit determines what exists and designs a batched "Rebuild Financial History" experience that **reuses existing authorities** — no second reconstruction engine, no Plaid-logic bypass, no change to transaction/wealth truth.

---

## 1. Current architecture (verified)

| Concern | Authority | Notes |
|---|---|---|
| Per-item transaction history | `syncTransactionsForItem` (up to 730d) | the ONE sync body; runs under `withPlaidItemSyncLock` |
| **Batch across a user's items** | `refreshAllActiveItemsForUser(userId, { excludeItemIds? })` | **already batches** every active PlaidItem with per-item isolation + cooldown partitioning |
| Deferred/first-run history | `runDeferredHistorySync` (backgroundHistorySync) | out-of-band continuation after connect |
| **Progress signal** | `PlaidItem.syncIncompleteAt` → `lib/sync/status.ts` `SyncConnectionState` | `importing` (non-null) vs `ready` (null); also `needs_reauth`/`error`. Authoritative, already polled. |
| Auto-resume polling UI | `components/connections/ConnectionsList.tsx` | polls importing connections → ready, shows building state |
| Per-account reconnect | `ReconnectAccountButton` (in `ConnectionCard`) | Plaid Link update mode |
| Wealth-timeline rebuild | `components/dashboard/RebuildHistoryButton.tsx` | **single-account** select; snapshot-amendment path (separate truth concern from Plaid txn history) |
| Deep (>730d) expand | admin `AdminExpandHistoryFlow` + `exchange-expanded-history-token` | **admin-only, item-scoped** |
| Snapshot/wealth regen | `regenerateSnapshotsForAccounts`, `regenerate-history.ts` | derived truth, runs after history lands |

## 2. The determinations the mission asked for

- **Is reconstruction account-scoped or can it be safely batched?** The *body* is item-scoped, but batching is a **solved problem** — `refreshAllActiveItemsForUser` already runs every active item with per-item locks + isolation. Batching a **subset** just needs an `includeItemIds` filter (additive; the inverse of the existing `excludeItemIds`).
- **Is progress/state tracked?** **Yes** — `syncIncompleteAt` per item, surfaced as `SyncConnectionState` (`importing`/`ready`/`needs_reauth`/`error`). `ConnectionsList` already polls it. No new progress store is needed.
- **Does it already batch internally?** Yes (see above). The gap is purely **experience**, not engine.

## 3. The actual limitation

The capability is **fragmented across three surfaces** with no unified control:
1. Reconnect is **per-connection** (`ReconnectAccountButton`, one at a time).
2. Wealth rebuild is **single-account** (`RebuildHistoryButton`).
3. Batch refresh (`refreshAllActiveItemsForUser`) exists but is only reachable **all-or-nothing** via `/api/plaid/refresh` (no `plaidItemId` → all items), with no selection and no per-connection progress surface.

So a user recovering state must reconnect each institution individually and watch a scattered building indicator — exactly the "does not scale" problem.

## 4. Design — "Rebuild Financial History" (reuses existing authorities)

A single surface in the **Connections workspace** (the natural home; it already renders the connection inventory + importing state):

```
Rebuild Financial History
  ☑ Chase Checking          ready
  ☑ Amex Credit Card        ready
  ☑ Fidelity Brokerage      ready
  ☐ Coinbase (wallet)       — (non-Plaid, separate path)
  [ Reconstruct selected ]

  Chase      ████████ importing… →ready
  Amex       ████░░░░ importing…
  Fidelity   waiting
```

- **Selection** — checkboxes over the user's Plaid connections (reuse `ConnectionCard`/`ConnectionsList` inventory). Atlas `Surface`/`Block` + a footer action, matching HQ/workspace patterns.
- **Trigger** — one call to the existing batch authority: `refreshAllActiveItemsForUser(userId, { includeItemIds: selected })`. The **only** backend change is adding an additive `includeItemIds` option (a subset filter — the inverse of the shipped `excludeItemIds`); it introduces no new sync logic. Respects the existing per-item lock + manual cooldown.
- **Progress** — reuse the existing `SyncConnectionState` polling (`ConnectionsList` already does this): each selected connection shows `importing → ready` (or `error`/`needs_reauth`). No new progress store.
- **No duplicate imports** — the per-item `withPlaidItemSyncLock` already coalesces concurrent syncs; a connection already importing is not re-triggered.

**Preserved:** transaction truth (`syncTransactionsForItem` untouched), wealth truth (snapshot regen unchanged), Plaid history logic (reused, not bypassed), the auth boundary (owner-scoped, exactly like `/api/plaid/refresh`). **Not** a second engine — a selection + progress shell over the batch authority.

## 5. Why implementation is deferred (and the recommendation)

The mission permits "audited **or** improved" and asks for "what was deferred + recommended next step." I am deferring the UI implementation because: (a) it sits on the financial-truth-adjacent reconstruction path, (b) it warrants its own focused, well-tested slice with browser verification against seeded multi-connection state, and (c) this session already carried a destructive DB incident — the disciplined move is to land the guardrails (Part 1) and the verified account-recovery path (Part 2) now, and implement the reconstruction UI cleanly next, not rushed.

**Recommended next slice (small, safe):**
1. Add `includeItemIds?: string[]` to `refreshAllActiveItemsForUser` (additive filter) + a unit test.
2. A "Rebuild Financial History" block in the Connections workspace: multi-select → `POST /api/plaid/refresh`-equivalent batch → reuse `SyncConnectionState` progress polling.
3. Tests: multiple-account selection triggers one batch; no duplicate imports (lock coalescing); existing per-account reconnect + wealth rebuild untouched.

Estimated surface: one additive lib option + one route param + one workspace block + polling reuse. No schema, no new engine.
