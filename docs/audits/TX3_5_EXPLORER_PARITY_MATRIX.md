# TX-3.5 — Transaction Explorer Parity Matrix

**Type:** Parity inventory + UX verification for the TX-3.3 cutover. No new authority, no new aggregation, no Cash Flow semantics, no canonical time.
**Date:** 2026-07-20.
**Baseline:** the pre-cutover panel at `b1c9550`. **Current:** `cd28478` (TX-3.3) + `5761892` (TX-3.4).

The mission's rule: functionality may only be removed if it is **intentionally replaced**, **belongs elsewhere**, or is **not semantically valid** under the new architecture. Every removal below is classified against exactly that test.

---

## 1. Parity matrix — old behavior → new equivalent

### 1.1 FIND — preserved, now server-answered

| Old affordance | Old mechanism | New equivalent | Status |
|---|---|---|---|
| Search box | `filter()` over `merchant`/`merchantDisplayName`/`description` | `text` param → ILIKE over `merchant`/`description`/`resolvedMerchant.displayName` | ✅ **PARITY** — the three fields match exactly; now debounced (300 ms) and complete rather than limited to the loaded 5,000 |
| Date presets (All/90d/30d/7d) | client date compare | `dateFrom`/`dateTo` params | ✅ PARITY |
| Custom [from, to] window | client date compare | `dateFrom`/`dateTo` params | ✅ PARITY |
| Category filter | `tx.category !== catFilter` | `categories` param | ✅ PARITY |
| Flow type filter + Quick Flow pills | `tx.flowType !== flowFilter` | `flowTypes` param | ✅ PARITY — same pills, same state |
| Account filter | `tx.accountId !== accountFilter` | `accountIds` param (server intersects with the KD-15 visible set) | ✅ **IMPROVED** — options now come from the Space's account list, not from whichever accounts happened to appear in the loaded rows |
| Pending / cleared | `tx.pending` compare | `pending` param (tri-state) | ✅ PARITY |
| Source (Plaid/import/manual) | `tx.source !== sourceFilter` | `sources` param via `sourceWhere`, mirroring `deriveSource` precedence | ✅ PARITY |
| Sort: Newest / Oldest | `arr.sort()` | server `sort` (keyset-ordered) | ✅ PARITY |
| Active filter chips | — | unchanged component | ✅ PARITY |
| Deep-link account pre-filter | `initialAccountFilter` | unchanged | ✅ PARITY |
| KD-15 scope note | — | unchanged | ✅ PARITY |

### 1.2 INSPECT — preserved

| Old affordance | New equivalent | Status |
|---|---|---|
| Day-grouped editorial ledger with sticky headers | unchanged (`groupByDay` is presentation over the server's already-ordered rows — it never reorders or filters) | ✅ PARITY — browser-verified (`SUNDAY, JUL 19 …`) |
| Row → detail drawer, `?transaction=<id>` | unchanged | ✅ PARITY |
| Keyboard-accessible rows (role/button + Enter/Space) | unchanged | ✅ PARITY |
| Transfer glyph, native-currency amounts, category/disposition chips | unchanged | ✅ PARITY |

### 1.3 ACT — new in TX-3.4

| Capability | Status |
|---|---|
| Correct category — this transaction only (`override`) | 🆕 **ADDED** (endpoint existed since MI1 M5 with no UI) |
| Correct category — always for this merchant (`category` → USER MerchantRule) | 🆕 ADDED |
| Merchant pivot ("More from this merchant" → `merchantId` filter) | 🆕 ADDED — the inspect→query loop |
| List invalidation after a correction | 🆕 ADDED (mutation signal) |

### 1.4 REPLACED — same need, different mechanism

| Old affordance | Replacement | Justification |
|---|---|---|
| Numbered pagination + page-size select (25/50/100) | Cursor infinite scroll + explicit **Load more** button | **Intentionally replaced.** Keyset pages forward; "page 7 of 154" is not expressible without offset, and offset degrades with depth and double-counts under concurrent sync. Load more preserves keyboard/a11y access. Mobile-first, desktop-usable. |
| Merchant filter dropdown (by display **name**) | Merchant **pivot** by resolved `Merchant.id` from a row | **Intentionally replaced.** The old dropdown was built from *the rows already loaded*, so it silently offered only the merchants in the fetched window — a partial list presented as complete. The pivot filters on the persisted, indexed Merchant authority. *Partial regression acknowledged:* you can no longer pick a merchant you cannot currently see. A distinct-merchant facet endpoint would restore full parity — deferred, no consumer demand yet. |
| Per-flow-type KPI money cards | Server **count** only ("3,983 transactions · showing 100") | **Belongs elsewhere** — see §2. |

### 1.5 REMOVED — with classification

| Removed | Classification | Reason |
|---|---|---|
| **Group By pivot** (flow / merchant / account / category) | *Belongs elsewhere* | A pivot with per-bucket money totals is analytics over the whole set. A 100-row page cannot produce it honestly, and its conversion/classification doctrine is the Cash Flow projection layer's, not the explorer's. |
| **Calendar heat-map view** | *Belongs elsewhere* | Same: a per-day money fold over the entire filtered set. See TX-4 §3 for its proper home. |
| **KPI summary cards** (spend/income/transfers/debt/investments/refunds) | *Belongs elsewhere* | Client-derived `Math.abs(FX-converted)` sums. Moving them server-side would have meant a converted-totals authority the explorer must not own. |
| **Sort: Largest / Smallest** | *Not semantically valid* | The product's "largest" is `Math.abs(FX-converted)`; SQL can only order the **signed native** column, and those disagree **by sign** even in a single-currency Space. Prisma has no expression ordering (`ORDER BY abs(amount)` unreachable) and there is no index on `amount`. Documented in `TX3_1B_CONTRACT_HARDENING.md` §2. |
| **Sort: Merchant A–Z** | *Not semantically valid (as a server sort)* | Would need a keyset on `(merchant, id)` with no index on `merchant`. Not in the query contract; the mission scopes sorting to "supported by query contract". |
| **transferDisposition filter** | *Not semantically valid* | Derived at read time, **never persisted** — `schema.prisma:1710,1881`. Cannot be a server predicate without a second derivation authority. |
| **needsClassification ("Needs review") filter** | *Not semantically valid* | Same, and additionally depends on a read-time counterparty-resolution query. **This is the most genuinely useful loss** — "show me what needs review" is a real investigation question. Deferred as a future intelligence projection (persist both at classification time, then they become ordinary indexed filters and drop into `buildFilterWhere` unchanged). |

**Nothing was removed for convenience.** Every entry is *replaced*, *belongs elsewhere*, or *not semantically valid*.

---

## 2. Why the explorer owns a count and not a total

The explorer's set-level fact is **how many rows answer this question** — exact, currency-free, no doctrine. `countTransactions` shares `bankingTransactionWhere` and `buildFilterWhere` verbatim with `queryTransactions`, so the figure cannot drift from the list.

Money figures are a different kind of claim. They require conversion doctrine (which date's rate), classification doctrine (what counts as spend), and sign doctrine (magnitude vs net) — all owned by the Cash Flow projection layer. An earlier TX-3.1b draft did build a converted per-flow-type aggregate; it was removed in TX-3.3 because it had **no consumer** and claimed authority Cash Flow already holds. Transactions does not own financial totals.

---

## 3. UX verification (browser, `localhost:3000`)

| Gate | Result |
|---|---|
| Explorer loads, server count | ✅ `3,983 transactions · showing 50` — matches the DB-level count exactly |
| Cursor loading (button) | ✅ 50 → 100, count line updates |
| Cursor loading (**auto** infinite scroll) | ✅ scroll to bottom → 50 → 100 with no click |
| No numbered pager / Grouping / Calendar | ✅ all absent |
| Day headers | ✅ `SUNDAY, JUL 19`, `SATURDAY, JUL 18`, `FRIDAY, JUL 17` |
| Merchant pivot renders on rows | ✅ |
| Detail drawer opens, sets `?transaction=<id>` | ✅ |
| Drawer sections | ✅ `SUMMARY / ACCOUNT / TRANSACTION INTELLIGENCE / PROVENANCE / CORRECT CATEGORY / ASK AI` |
| Correction control | ✅ category select populated, Save disabled until changed, scope defaults to "This transaction only" |
| Mobile (500 px) | ✅ no horizontal overflow, **0** elements wider than viewport, row reflows to 460 px, toolbar + Filters intact |
| Duplicate-row check | ✅ one repeated row text investigated → a genuine duplicate **purchase** (two identical Talabat orders); DB walk proved uniqueness by id |

**Not verified:** the correction **write** end-to-end (drawer refresh + list consistency after a real mutation). Executing it mutates real personal financial data in the local dev DB, and category provenance is not cleanly reversible, so it was not done unprompted.

---

## 4. Architecture gates

| Gate | Status |
|---|---|
| Transactions does not own financial totals | ✅ count only (§2) |
| Transactions does not own canonical time | ✅ no `preset`/`asOf`/`compareTo` anywhere in the contract or panel — tripwired |
| Transactions does not bypass `bankingTransactionWhere` | ✅ both `queryTransactions` and `countTransactions` compose it; source-scanned |
| No unbounded transaction loading returns | ✅ every page `clampLimit`-bounded (≤100); the explorer no longer holds a full array |
| No client-side filtering / sorting / grouping / analytics | ✅ tripwired (`rows.filter`/`rows.sort`/`rows.slice` banned in the panel; `.filter`/`.sort` banned in the hook) |
| Cash Flow / Liquidity / Calendar consumers untouched | ✅ they still read the existing `/transactions` route and shared array |
| TimelineLens / canonical time untouched | ✅ not referenced by any file in this arc |

---

## 5. Outcome

**No TX-3.5 UI work was required beyond TX-3.3 + TX-3.4.** The redesign the mission describes — search, contract-supported sorting, account/source/category filters, cursor loading, mobile-first, no in-memory array, no client filtering/grouping/analytics — was delivered by the cutover and is verified above. This slice is the inventory that proves it, plus the honest record of the four capabilities that did not survive and why.
