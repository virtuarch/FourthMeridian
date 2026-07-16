# Fourth Meridian — SD-4 Canonical-Data Audit (Investments Workspace)

**Date:** 2026-07-16
**Trigger:** The richer Investments Workspace (SD-4 / SD-4D+) surfaced several underlying canonical-data issues. Per the audit mandate: *investigate first; fix only what belongs to the Investments Workspace / `lib/investments` presentation boundary; for anything whose root cause is elsewhere, stop at the canonical owner, document it, and produce a scoped follow-up — never a presentation-layer workaround.*

**Headline:** All three concrete bugs (A hardware-wallet refresh, B transfer semantics, C crypto currency allocation) have their canonical owner **outside** the SD-4D boundary. None were patched in presentation. Each becomes a scoped follow-up below. D (reconciliation) confirmed the three widgets already read one canonical stream — no duplicated semantics.

---

## E. Ownership classification (required report)

| # | Issue | Root-cause layer | Canonical owner (file:line) | Fixed in SD-4D+? |
|---|---|---|---|---|
| **A** | Hardware/crypto wallet never updates on "Refresh Data" | **Connection / refresh orchestration** | `refreshAllActiveItemsForUser` — `lib/plaid/refresh.ts:625`; route `app/api/plaid/refresh/route.ts:109-142`; button `components/plaid/useManualRefresh.ts:89` | **No** → follow-up FU-A |
| **B** | Period Activity shows internal transfer legs gross ($1050/-$50) vs Net Contributions $1000 | **Investment flow ontology** | `lib/investments/investment-flows-core.ts:60-95,219` (no internal-vs-external transfer notion) | **No** → follow-up FU-B |
| **C** | Allocation → By Currency excludes crypto (BTC folded into USD) | **Crypto instrument ontology / schema** | `lib/investments/crypto-instrument.ts:57,132-138` (BTC `currency:"USD"` conflates denomination with quote currency) | **No** → follow-up FU-C |
| **D** | Do Activity / Net Contributions / What-Changed reconcile? | — (audit) | All read one `PeriodFlows.netExternalFlows` — no second computation | **N/A** (verified consistent; gross/net display difference is downstream of B) |

Plus the **valuation-chart** feasibility (mission §12): investigated **GO** — follow-up FU-CHART below.

---

## A — Hardware-wallet refresh (owner: refresh orchestration, NOT Investments)

**Finding.** The wallet balance re-read (`syncBtcWallet`, `lib/crypto/btc-sync.ts:467`) is correct and fully idempotent — it re-reads the confirmed on-chain balance and writes a fresh `PositionObservation` on **every** invocation (`wallet-position-capture.ts:105-137`). The bug is that the general **"Refresh Data"** affordance never calls it: `useManualRefresh` → `POST /api/plaid/refresh` → `refreshAllActiveItemsForUser`, which enumerates **only `PlaidItem` rows** (`lib/plaid/refresh.ts:625-636`). Self-custody wallets have **no `PlaidItem`** (`app/api/accounts/wallet/route.ts:260-268`), so they are silently skipped. Wallets only refresh via the 6-hourly `sync-crypto` cron (`jobs/sync-crypto.ts:47`) and the per-account `SyncWalletButton` (`app/api/accounts/[id]/sync/route.ts:58`).

**Classification:** Connection / provider-sync orchestration. **Not** InvestmentsSpaceData, not presentation. The wallet adapter and `PositionObservation` writer are correct.

**FU-A (scoped follow-up — Connections/refresh slice):** In the bulk manual-refresh path (`refreshAllActiveItemsForUser` + `/api/plaid/refresh`), fan out to self-custody wallets alongside Plaid items — enumerate the space/user's wallet `AccountConnection`s (no `plaidItemDbId`) and invoke `syncBtcWallet` / `syncAllBtcWallets` for them, so "Refresh Data" updates wallets the same way the cron already does. No Investments-layer change. Add a test asserting the manual refresh path reaches wallet sync.

---

## B — Period Activity transfer semantics (owner: investment flow ontology, NOT presentation)

**Finding.** `PeriodFlows.netExternalFlows` is a signed sum over four boundary categories including `transfer_in`/`transfer_out` **unconditionally** (`investment-flows-core.ts:60-65,219`). Net Contributions is correct **only by arithmetic cancellation** ($50 in + −$50 out = 0), not because the ontology recognizes an internal transfer. Classification is per-event by type with **no pairing/counterparty detection** (`:68-95`) — unlike banking's `lib/transactions/transfer-evidence.ts`. `buildActivityGroups` (`components/…/investments-activity.ts:84-100`) and the Bridge (`investments-bridge.ts:70-90`) then surface `transfersIn`/`transfersOut` **gross** (money-in +$1050 / money-out −$50). The Bridge's identity still closes because the legs re-sum to $1000.

**Why it is NOT presentational.** Two different realities collapse to an identical `PeriodFlows`: (A) one internal $50 transfer (should net to zero), and (B) a genuine +$50 external in and an unrelated −$50 external out (legitimately gross). The DTO cannot distinguish them, so **no change confined to `investments-activity.ts` can fix it without corrupting case B**. The missing information (that two legs are counterparties of one intra-portfolio transfer) must be established where events are classified. *(Worse case: if the two legs straddle the period window, even `netExternalFlows`/Net Contributions is wrong.)*

**Classification:** Canonical investment flow ontology (`lib/investments/investment-flows-core.ts` + event classification). **Not** the Period Activity presentation model.

**FU-B (scoped follow-up — investment transfer ontology):** Add an internal-transfer / transfer-pairing notion to the investment flow layer (analogous to `transfer-evidence.ts`): detect intra-portfolio transfers (a TRANSFER_OUT on one in-scope account matched to a TRANSFER_IN on another in-scope account) and classify them as INTERNAL — excluded from `EXTERNAL_BOUNDARY_CATEGORIES`, so they never enter `transfersIn`/`transfersOut` or `netExternalFlows`. Once `PeriodFlows` carries the distinction, both Activity and the Bridge become correct automatically with no presentation change. This is a real ontology slice (pairing + visibility scoping); do not special-case Schwab.

---

## C — Currency allocation excludes crypto (owner: crypto instrument ontology, NOT allocation-core)

**Finding (premise corrected).** Crypto is **not filtered out** — there is no fiat whitelist, no `isFiat` check anywhere. `byCurrency` grouping is already fully generic: it buckets by `row.currency` (`investments-allocation-core.ts:119-123`), and a valued crypto row **is** included. The real cause: a BTC holding carries `currency = "USD"`, so it lands in the USD bucket. The crypto instrument model sets the asset's **quote** currency to USD and stores its **denomination** ("BTC") only in `tickerSymbol` — `BTC_ASSET = { symbol:"BTC", …, currency:"USD" }` (`crypto-instrument.ts:57`), instrument created `currency: asset.currency` = "USD" (`:132-138`), propagated to `ValuedHoldingRow.currency` (`valuation-core.ts:123`; `investments-time-machine-core.ts:145`). `currency` throughout the model means "priced/quoted in," not "denominated as."

**Why it is NOT an allocation-core fix.** Generalizing the grouping cannot invent a denomination the row does not carry — `investments-allocation-core.ts` is already correct and general, and would surface a BTC slice the moment a crypto row carried a crypto denomination.

**Classification:** Crypto instrument ontology / schema. **Not** `investments-allocation-core.ts`, not presentation.

**FU-C (scoped follow-up — instrument ontology):** Represent a crypto asset's own denomination distinctly from its quote currency (e.g. a crypto row's currency/denomination = "BTC", kept separate from the "USD" it is priced in for valuation/FX). After that, the existing generic `byCurrency` grouping surfaces BTC/ETH/SOL automatically — no crypto special-casing in the allocation core. Display-currency conversion is unaffected (it still values everything in the reporting/display currency; "currency exposure" is a grouping key, not a valuation). Coordinate with the DEC-0 precision work if crypto units/denomination touch the same fields.

---

## D — Contributions vs Activity reconciliation (audit result: consistent)

Period Activity, Net Contributions, and the What-Changed Bridge **all read the same** `PeriodFlows.netExternalFlows` (Bridge: `investments-time-machine-core.ts:207-208`, no second computation). There is **no duplicated financial semantics** across the widgets. The only discrepancy is the **gross-vs-net display** of the same (B-flawed) transfer subtotals — resolved once FU-B lands. The full reconciliation identity (`opening + netExternalFlows + residual = closing`) holds by construction in the reconciliation core; `residualChange` bundles market move + FX + income + fees and is honestly labeled (never an asserted market gain). No follow-up beyond FU-B.

---

## FU-CHART — Portfolio Value Over Time (mission §12-14: investigated GO, deferred for scope)

**Feasibility: GO, no fourth authority, no N×date.** The canonical `getInvestmentValueAsOf` (`lib/investments/valuation.ts:145`) can value at arbitrary dates but is DB-heavy (~5-6 queries/date, no batching) — sampling it for a series is the forbidden N×date path. Instead, the per-date investment value is **already persisted** in `SpaceSnapshot` (`stocks` = investments ex-crypto, `crypto` = digital assets; `lib/data/snapshots.ts` reads the whole window in **one** query), the same series Wealth uses.

**Bucket rule (avoids the BTC double-count):** the Investments Workspace portfolio is brokerage **+** crypto, so the chart line = `totalInvestments + totalCrypto` per snapshot (each asset once — `stocks` excludes crypto, `crypto` is the separate column). Do **not** plot `stocks` alone (drops crypto) and do **not** sum `stocks` with a flag-off `getInvestmentValueAsOf` value (double-counts). This respects the doctrine *"shared PositionObservation spine ≠ shared net-worth bucket."*

**Caveat (disclose):** `SpaceSnapshot.crypto` is valued via a different path (A9 regeneration) than the live `getCurrentPositions` crypto (spine RAW_CLOSE), so the chart's "today" point may differ slightly from the KPI headline for crypto holders — a pre-existing cross-mechanism divergence, not introduced here.

**Deferred for scope** (this slice already lands data-ownership + FX + KPI + allocation + holdings). FU-CHART is a small, low-risk follow-up: extend the `/investments/space-data` route to also return `series: {date,value,estimated}[]` from `getRecentSnapshots` (map `totalInvestments+totalCrypto`, drop `fxMiss`), FX-convert the series in the workspace, and render it with a compact area chart clipped to the shell window. No new authority; one extra query.

---

## Summary — what SD-4D+ fixed vs. deferred

- **Fixed in-boundary (SD-4D+):** data ownership move, display-currency transform, KPI semantics, allocation dropdown+donut, holdings top-5+modal+native cost basis. (None of these are canonical-data fixes — they are presentation/architecture.)
- **Canonical follow-ups (out-of-boundary, NOT patched in presentation):** FU-A (wallet refresh · Connections), FU-B (internal-transfer ontology · investments flows), FU-C (crypto denomination · instrument ontology), FU-CHART (valuation series · additive, GO).
