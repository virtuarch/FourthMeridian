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
✅ CONN-2 — Financial Intelligence Reconstruction      (LANDED 7f521de → 3412fb8)
⬇️
✅ CONN-3 — Financial Freshness Pipeline               (LANDED 25ef845)
⬇️
✅ CONN-4 — Connection Removal Doctrine + CONN-4A      (LANDED da679b0, 9c9b4c0)
⬇️
⏸️ PO-4B — Provider Authorization Lifecycle            (separate track — paused, operator not customer)
⬇️
✅ PO-5 — QA / Beta Hardening                          (audit f1a0901; PO-5A gate hardening 630a84e)
```

**Sequence status (reconciled V25-CLOSE-1):** the customer-facing CONN arc is complete. CONN-4A resolved the disconnect-lifecycle boundary decision that CONN-2 item 10 left open. PO-4B remains deliberately paused. What remains on the beta gate is not connection work — it is the LLM disclosure copy and the production ops/config floor tracked in [../audits/production-readiness.md](../audits/production-readiness.md).

### ✅ CONN-1 — Connection Lifecycle Experience *(complete — 26c0a54)*
Investigation + presentation-only foundation. Established the single persisted source of truth per provider (`PlaidItem.syncIncompleteAt` / `Connection.lastSyncedAt`), the pure `ConnectionLifecycleStatus` projection (`lib/sync/lifecycle.ts`), truthful card copy, and the registration "check your inbox" screen. Documented the Phase-6 (Layer-3) balance-freshness root cause without touching financial authorities. See `docs/audits/CONN1_CONNECTION_LIFECYCLE_AUDIT.md`.

### ✅ CONN-2 — Financial Intelligence Reconstruction Experience *(complete — `7f521de` roadmap correction + spinner fix → `d1d3d97` CONN-2A/C/G/H → `3412fb8` CONN-2B multi-account rebuild)*
Make Layer 2 visible and controllable. Per-connection intelligence-readiness surface ("Transactions: complete · Intelligence: ready/incomplete · ~N available"), and a multi-account **"Rebuild selected intelligence"** control that reuses the existing batch authority (`refreshAllActiveItemsForUser`, with an additive `includeItemIds[]` filter — **never** a new `refreshMultipleAccounts()`). Progress is stage-based (Importing → Reconstructing → Finalizing → Ready), data-backed only, no fabricated percentages. See `docs/audits/CONN2_FINANCIAL_RECONSTRUCTION_AUDIT.md` + the implementation audit `docs/audits/CONN2_RECONSTRUCTION_IMPLEMENTATION_AUDIT.md`. **Constraints:** no new sync engine, no DayFacts/FlowType/valuation changes, no duplicate authorities.

**Principle (amended):** a connection can have *complete transaction data* while *derived intelligence* (charts, trends, snapshots, insights) is still rebuilding. The experience must never imply "your transactions are missing" or "we're re-downloading your history" when the real operation is `Provider Data → Transaction Truth → Intelligence Reconstruction → Charts/Trends/Insights/Snapshots`.

**Amendments (CONN-2A…H), executed in priority order:**
1. ✅ **Frozen second-account spinner** — fixed (7f521de).
2. **CONN-2A — Reconstruction readiness projection** (`ConnectionIntelligenceStatus`): derived-only view — `transactionHistory: READY|IMPORTING|UNKNOWN`, `intelligence: READY|REBUILDING|NOT_READY`, `availableHistory {years,months,days}`, `lastReconstructedAt`. Derives from transaction availability + `PLAID_HISTORY_SYNCED` anchor + reconstruction outputs. No persisted fake completion.
3. **CONN-2C — Reconstruction lifecycle UI**: the existing stepper language, no percentages ("Rebuilding timeline / Updating charts / Refreshing insights"). Survives navigation; no client-only fake progress.
4. **CONN-2B (engine) — `includeItemIds[]`** additive filter on `refreshAllActiveItemsForUser`.
5. **CONN-2B (UI) — multi-account "Rebuild Financial History"**: per-account available history + last-rebuilt, select-all, min 2 selection, honest scope estimate ("~4y 8m across 3 accounts"), no fake ETA.
6. **CONN-2D — Connection Truth Timeline** (customer-facing diagnostics): Authorization → Data acquisition → Intelligence reconstruction → Current freshness, each with a timestamp — so a "my net worth is wrong" report identifies *which layer* failed.
7. **CONN-2F — operator diagnostics** in Platform Ops / Customer Success: per-connection provider sync, tx count, latest tx, last reconstruction, latest snapshot, health.
8. **CONN-2G — completion semantics**: "Provider: Sync complete" ≠ "Fourth Meridian: Financial profile ready." The card says "You're ready" ONLY when acquisition + reconstruction complete.
9. **CONN-2H — empty state**: explain the transformation ("Import transactions · Build your financial timeline · Generate cash-flow insights · Create your wealth picture").
10. ✅ **Disconnect lifecycle** — resolved in **CONN-4** (doctrine audit `da679b0`) and **CONN-4A** (`9c9b4c0`): Disconnect vs consent-gated Delete-data, soft-delete only, history preserved (Model A).

**CONN-2E — architecture amendment (binding):** provider truth stays boring — `PlaidItemStatus`/`ConnectionStatus` remain `ACTIVE | NEEDS_REAUTH | ERROR | REVOKED`, NOT expanded into a workflow engine. A derived **`ConnectionLifecycleProjection`** (pure, no DB authority) computes the richer UI phases `IMPORTING | RECONSTRUCTING | READY | ACTION_REQUIRED | RETRYING | REMOVING`. Canonical facts, derived intelligence — the UI is smart without a second database authority.

**Boundary (binding):** CONN-2 answers *"Is Fourth Meridian's intelligence built?"* CONN-3 answers *"Is today's financial state current?"* Do NOT touch freshness (balance/snapshot refresh authority, `FinancialAccount.balance` writes, current-value pipelines) in CONN-2 even though the bugs are related.

### ✅ CONN-3 — Financial Freshness Pipeline *(complete — `25ef845`)*
Resolve the Layer-3 root cause: route the routine sync paths (webhook / cron) through a balance-refresh + today's-snapshot regeneration step the way `refreshPlaidItem` already does — reusing existing authorities, adding none. Surface the three freshness timestamps separately. **This is the slice that is permitted to touch the balance/snapshot refresh path** (behind its own tested, revertible change) — CONN-1/CONN-2 deliberately do not.

### ⏸️ PO-4B — Provider Authorization Lifecycle *(separate track — paused; class C)*
Operator-facing provider auth-age visibility + prompt-to-reauth (never auto-revoke). Distinct axis from CONN (customer intelligence): PO-4B is *platform operating the platform*. Remains paused until explicitly resumed. See `docs/audits/PO4_PLATFORM_OPERATIONS_CONTROL_INVESTIGATION.md` §4.

### ✅ PO-5 — QA / Beta Hardening *(audit `f1a0901`; PO-5A gate hardening `630a84e`)*
The gate before opening beta: end-to-end verification of the connection → reconstruction → freshness experience across multi-account state, plus the OPS-1 operational floor. No new product surface. **The audit and the code half are done** (consent capture, lazy Plaid client with honest 503, operator email/job/provider health widgets). What is still open is the *operational* half — Sentry, uptime monitor, restore drill, and the production config flips — tracked in [../audits/production-readiness.md](../audits/production-readiness.md), not here.

---

## Why this order

Layer 1 already works, so CONN-2 can make Layer-2 reconstruction honest and controllable **without** touching any financial authority (it reads derived-truth markers and reuses the batch refresh). CONN-3 then fixes the one place derived truth genuinely goes stale (Layer 3) — the only slice that edits the refresh pipeline, isolated so it can be verified and reverted on its own. PO-4B is an orthogonal operator concern and does not block either. PO-5 hardens the whole chain before beta.
