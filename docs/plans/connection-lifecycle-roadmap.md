# Connection Lifecycle Roadmap — CONN-x

**Status:** ROADMAP + MODEL CORRECTION. Sequencing and doctrine only; each CONN slice carries its own audit + implementation.
**Date:** 2026-07-19.
**Doctrine (inherited, binding):** investigation first · architecture before implementation · smallest additive slices · no second sync engine · no changes to financial authorities (DayFacts / FlowType / investment valuation / aggregation) · completion always derives from persisted state · every slice independently shippable and revertible.

---

## The three-layer model (the correction)

The connection experience was previously described as one undifferentiated "syncing" state. That conflated three genuinely separate concerns. They must be modeled — and communicated — separately.

### Layer 1 — Data acquisition (EXISTS — do not rebuild)
- **Authority:** Plaid transaction sync (`syncTransactionsForItem`), wallet sync (`syncBtcWallet`), provider ingestion.
- **Purpose:** obtain raw financial *events* (transactions, holdings, balances).
- **Status:** already built and correct. **There is no second sync engine to write.** The refresh batch authority is `refreshAllActiveItemsForUser`.
- **User truth:** *"Your transactions are here."* Never imply transactions are missing once they are imported.

### Layer 2 — Financial intelligence reconstruction (THE MISSING EXPERIENCE)
- **Purpose:** rebuild *derived* intelligence from transactions that already exist — wealth snapshots, historical net-worth timeline, cash-flow history, analytical views.
- **Authorities that already do the rebuilding:** `regenerateWealthHistory` / `regenerateWealthHistoryForAccounts` (historical wealth rows, ≤ yesterday), `regenerateSpaceSnapshot` / `regenerateSnapshotsForAccounts` (today's snapshot), `backfillHistoryForItem` (first-run historical backfill). The per-item completion anchor for the full deferred pipeline is the `PLAID_HISTORY_SYNCED` AuditLog row (written by `recordSyncComplete` after transactions + backfill).
- **What's missing is the *experience*,** not the engine: the product never tells the user *"Fourth Meridian is rebuilding your financial intelligence from your transactions,"* and offers no way to see or re-trigger that reconstruction per account.
- **User truth:** *"Your transactions are here. Fourth Meridian is rebuilding your financial intelligence from them."*
- **Naming rule (binding):** the phrase **"history rebuild"** refers ONLY to the technical operation (`regenerate*`, snapshot amendment). The **user-facing** language is about **restoring intelligence**, never re-downloading data. Internal code may say `regenerate`/`reconstruct`; UI says "financial intelligence."

### Layer 3 — Current freshness (SEPARATE — do not merge into the spinner)
- **Concern:** a sync can *complete* while current balances / today's snapshot are still *stale*. Root cause (CONN-1 audit §4, confirmed): only the manual Refresh path runs `accountsGet` + regenerates today's snapshot; webhook / cron / "Sync Now" ingest transactions but never refresh `FinancialAccount.balance` or today's snapshot.
- **Track separately:** transaction-ingestion freshness ⊥ balance freshness ⊥ snapshot freshness. Do NOT combine them into one indicator.
- **User truth:** three honest timestamps, not one spinner.

---

## Sequence

```
✅ CONN-1 — Connection Lifecycle Experience            (LANDED 26c0a54)
⬇️
🔜 CONN-2 — Financial Intelligence Reconstruction Experience
⬇️
🔜 CONN-3 — Financial Freshness Pipeline
⬇️
🔜 PO-4B — Provider Authorization Lifecycle            (separate track — operator, not customer)
⬇️
🛑 PO-5 — QA / Beta Hardening                          (gate before opening beta)
```

### ✅ CONN-1 — Connection Lifecycle Experience *(complete — 26c0a54)*
Investigation + presentation-only foundation. Established the single persisted source of truth per provider (`PlaidItem.syncIncompleteAt` / `Connection.lastSyncedAt`), the pure `ConnectionLifecycleStatus` projection (`lib/sync/lifecycle.ts`), truthful card copy, and the registration "check your inbox" screen. Documented the Phase-6 (Layer-3) balance-freshness root cause without touching financial authorities. See `docs/audits/CONN1_CONNECTION_LIFECYCLE_AUDIT.md`.

### 🔜 CONN-2 — Financial Intelligence Reconstruction Experience
Make Layer 2 visible and controllable. Per-connection intelligence-readiness surface ("Transactions: complete · Intelligence: ready/incomplete · ~N available"), and a multi-account **"Rebuild selected intelligence"** control that reuses the existing batch authority (`refreshAllActiveItemsForUser`, with an additive `includeItemIds[]` filter — **never** a new `refreshMultipleAccounts()`). Progress is stage-based (Importing → Reconstructing → Finalizing → Ready), data-backed only, no fabricated percentages. See `docs/audits/CONN2_FINANCIAL_RECONSTRUCTION_AUDIT.md`. **Constraints:** no new sync engine, no DayFacts/FlowType/valuation changes, no duplicate authorities.

### 🔜 CONN-3 — Financial Freshness Pipeline
Resolve the Layer-3 root cause: route the routine sync paths (webhook / cron) through a balance-refresh + today's-snapshot regeneration step the way `refreshPlaidItem` already does — reusing existing authorities, adding none. Surface the three freshness timestamps separately. **This is the slice that is permitted to touch the balance/snapshot refresh path** (behind its own tested, revertible change) — CONN-1/CONN-2 deliberately do not.

### 🔜 PO-4B — Provider Authorization Lifecycle *(separate track)*
Operator-facing provider auth-age visibility + prompt-to-reauth (never auto-revoke). Distinct axis from CONN (customer intelligence): PO-4B is *platform operating the platform*. Remains paused until explicitly resumed. See `docs/audits/PO4_PLATFORM_OPERATIONS_CONTROL_INVESTIGATION.md` §4.

### 🛑 PO-5 — QA / Beta Hardening
The gate before opening beta: end-to-end verification of the connection → reconstruction → freshness experience across multi-account state, plus the OPS-1 operational floor. No new product surface.

---

## Why this order

Layer 1 already works, so CONN-2 can make Layer-2 reconstruction honest and controllable **without** touching any financial authority (it reads derived-truth markers and reuses the batch refresh). CONN-3 then fixes the one place derived truth genuinely goes stale (Layer 3) — the only slice that edits the refresh pipeline, isolated so it can be verified and reverted on its own. PO-4B is an orthogonal operator concern and does not block either. PO-5 hardens the whole chain before beta.
