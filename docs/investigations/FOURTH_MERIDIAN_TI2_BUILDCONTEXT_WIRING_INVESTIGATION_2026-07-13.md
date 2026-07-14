> **INVESTIGATION ONLY — no code, no schema, no migrations, no STATUS.md changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# TI2 → buildContext() Wiring — Needs-Classification and RelationshipResolver in the AI Read Path

**Date:** 2026-07-13
**Status:** Investigation complete — wiring recommendation only, no implementation.
**Prior art:** `docs/investigations/INTELLIGENCE_BOUNDARY_DEFINITION_INVESTIGATION_2026-07-08.md` (classifies both facets as Transaction Intelligence and lists "TI2 wiring and remaining slices" as the open TI work, §10 registry table, line 280) and `docs/investigations/TRANSACTION_INTELLIGENCE_FACT_LAYER_INVESTIGATION_2026-07-07.md` (the TI0–TI5 slice plan; §6 already names the Daily Brief as a TI read-cutover beneficiary, line 189). This document builds on both; §7 states point-by-point where it agrees, extends, or corrects them.
**Question:** Should `buildContext()` (and therefore the Daily Brief, chat, and every AI-driven consumer) consume the two Transaction Intelligence facets that today stop at the transactions read path — the TE-2B needs-classification predicate and the TI5-2/TI4 read-time RelationshipResolver — and if so, through which seam, at what cost, in what order?
**Out of scope (already settled, not re-investigated):** the FlowType predicate convergence. `lib/transactions/flow-predicates.ts` is the ratified single membership authority, consumed identically by the Cash Flow Perspective (`lib/transactions/cash-flow.ts:8` doctrine comment, import at line 20) and the AI transactions assembler (`lib/ai/assemblers/transactions.ts:77`), both over the persisted `Transaction.flowType` column. That seam is done.
**Sources:** `lib/transactions/{needs-classification,RelationshipResolver,transfer-resolution,transaction-context,cash-flow,cash-flow-context,flow-predicates,transfer-evidence}.ts` · `lib/data/transactions.ts` · `lib/ai/{context-builder,types}.ts` · `lib/ai/assemblers/transactions.ts` · `lib/ai/signals/detectors/transactions.ts` · `lib/ai/intelligence/annotations.ts` · `app/api/brief/route.ts` · `app/api/ai/chat/route.ts` · `lib/plaid/syncTransactions.ts` · `types/index.ts` · the two prior-art investigations and `docs/investigations/D6_3D_CONTEXT_BUDGET_INVESTIGATION.md`.

---

## 0. Executive summary

**Needs-classification: wire it — small, cheap, and it fixes a real honesty gap.** The assembler already selects almost every input the predicate needs; adding it is roughly three columns on the existing query, one pure O(n) pass, and four or five aggregate fields on `TransactionsSummaryData`. The payoff is concrete: the Daily Brief's savings-rate insight (`app/api/brief/route.ts:386–399`) and the assessment layer's income-confidence machinery (`lib/ai/intelligence/annotations.ts:1799–1806`) currently judge income completeness by *counting* income transactions (`INCOME_TXN_HIGH_THRESHOLD = 3`, line 579) with no notion of whether those inflows are *identified*. TE-2B's `UNKNOWN_INFLOW_SOURCE` is precisely the missing fact — "$X of the income in this window is sign-default inflow with no resolved source" — and it is exactly the income-completeness Coverage claim the boundary investigation said the AI path needs (§5.3, line 203). One new signal (`NEEDS_CLASSIFICATION`) gives the Brief an actionable "review these" item for free.

**RelationshipResolver: mostly do not wire it — the double-counting fear the question raises is already structurally handled.** The assembler's money totals are settled-only (`lib/ai/assemblers/transactions.ts:307`, pending rows never enter `incomeTotal`/`expenseTotal`), transfers are excluded from `netCashFlow` by flowType (line 413), and the pending→posted lifecycle is resolved at *write* time by Plaid's `removed[]` tombstone (`lib/plaid/syncTransactions.ts:454–471`) plus the assembler's `deletedAt: null` filter (line 264). A pending row and its posted counterpart are therefore not double-counted in any total today. What remains is disclosure-grade, not totals-grade: a live pending row whose posted successor is already in the window inflates `pendingDebitTotal`/`transactionCount` and can fire a stale `PENDING_DEBIT` signal — detectable with a pure in-memory `pendingTransactionRef` pass, no resolver query. Duplicate detection adds almost nothing (§4.2), and read-time transfer matching enters only as a *parity input* to needs-classification (§3.3), through the seam that already exists (`lib/transactions/transfer-resolution.ts:111`).

**The promotion precedent exists and should be reused, not reinvented (§5):** TI1 / FlowType P5 Slice 4 — a capability born UI-side is extracted to a pure, zero-import module under `lib/transactions/` and imported by the assembler — is exactly the pattern, and needs-classification is already at the "pure module" stage; only the import + aggregate + serialize steps remain. Recommended slices in §8: **W1** (needs-classification aggregates in the assembler, with counterparty parity via `resolveOwnedTransferCounterparties`), **W2** (signal + Brief + annotations consumption), **W3** (pending↔posted disclosure dedup, gated on a corpus audit proving unremoved pending rows actually occur). Duplicate/transfer/refund relationship wiring into buildContext: **explicitly not recommended** (§4.2, §4.3).

One correction to the framing of the request itself (§7.3): "both facets feed only the Transactions Tab UI path" is slightly out of date. Since CF-1/CF-2B, `needsClassification` and `transferDisposition` ride the list DTO into the Cash Flow surfaces (`lib/data/transactions.ts:147` → `lib/transactions/cash-flow-context.ts:100` → `components/space/widgets/CashFlowSummaryWidget.tsx:184` and `components/space/widgets/cashflow/cash-flow-insights.ts:173`). The claim that holds exactly is the grep-verified one: **zero imports of either module under `lib/ai/` or `lib/perspective-engine/`** — the AI/assessment path is the genuinely unwired consumer, and `lib/perspective-engine/` imports nothing from `lib/transactions/` at all.

---

## 1. The two facets as they exist today

### 1.1 Needs-classification (TE-2B)

`shouldSurfaceAsNeedsClassification(tx)` (`lib/transactions/needs-classification.ts:64`) is pure, total, zero-import, and provider-neutral. It flags exactly two earned clusters (lines 68–81):

- **A — `UNKNOWN_PAYMENT_APP_PURPOSE`:** `transferRail === "PAYMENT_APP"` and no resolved owned counterparty. Money moved over Venmo/Zelle/Cash App/PayPal/Apple Cash (`lib/transactions/plaid-transfer-evidence.ts:64`) and Fourth Meridian cannot say whether it was a purchase, repayment, gift, or income.
- **B — `UNKNOWN_INFLOW_SOURCE`:** `flowType === "INCOME"` ∧ `classificationReason === "SIGN_DEFAULT_INFLOW"` ∧ no resolved merchant. Money arrived, was called income *by its sign only*, and no source could be resolved.

Doctrine in the module header (lines 8–26): this is **semantic ambiguity, never low numeric confidence** — the ~1,520 sign-default grocery/fuel purchases must stay invisible — and the predicate is self-healing (owned-account matching resolves A; merchant resolution resolves B).

Inputs (`NeedsClassificationInput`, lines 38–50): `flowType`, `classificationReason`, `transferRail`, `hasResolvedMerchant` (= `merchantId != null`), `hasResolvedCounterparty` (= persisted `counterpartyAccountId` **or** a read-time transfer match — see the Tab's construction at `lib/data/transactions.ts:190` and the detail read's at line 475). All five derive from flat persisted columns plus, for the counterparty bit, the TI4 read-time matcher. This input-availability fact drives the whole wiring cost analysis in §3.

Current consumers (grep-verified, non-test): `lib/transactions/transaction-context.ts:20` (the CF-1 per-row projection), `lib/data/transactions.ts:76` (list reads via `contextFields()`, lines 169–193; detail read at lines 470–476), and the type-only import in `types/index.ts:7`. The DTO fields land on `TransactionDetail` (`types/index.ts:314–321`) and, via CF-1, on list rows. **No imports under `lib/ai/` or `lib/perspective-engine/`.**

### 1.2 RelationshipResolver (TI5-2 + TI4 Slice 1)

`resolveTransactionRelationships(transaction, candidates)` (`lib/transactions/RelationshipResolver.ts:296`) is the pure, zero-import, read-time engine for the ratified TI4 posture — relationships are **not persisted**; they are explanation context, cheap to recompute (module header, lines 5–9; the boundary investigation §1.1 leans on exactly this precedent). Three deterministic facts:

- `pendingPosted` (line 174): exact provider match, `pendingTransactionRef` ↔ `plaidTransactionId`, both directions. Deliberately does **not** filter tombstoned rows (a tombstoned pending row must still resolve — line 180).
- `duplicate` (line 197): exact fingerprint (same account/date/amount/pending state/normalized merchant) — the *same* deterministic keys as `lib/transactions/fingerprint.ts`'s write-time dedup (line 24 comment).
- `transferCandidate` (line 242, `matchTransferCandidate`): deterministic owned-account two-leg transfer matching, ambiguity refused, confidence 1-or-0. `refundCandidate` is reserved-null (line 114) — no ratified fuzzy heuristic exists.

Current consumers: the detail read (`lib/data/transactions.ts:448`, candidates gathered at lines 414–447, ≤300 rows, ±7 days, KD-15 gate on the transfer id at lines 453–464) and, for the transfer facet only, the list reads through the impure wrapper `resolveOwnedTransferCounterparties` (`lib/transactions/transfer-resolution.ts:111`, called at `lib/data/transactions.ts:136` and 218). DTO exposure is detail-only (`types/index.ts:309–312`). **No imports under `lib/ai/` or `lib/perspective-engine/`.** (`lib/investments/reconstruction-core.ts:43` cites its epsilon as precedent; comment only.)

---

## 2. The buildContext() side as it exists today

`buildContext()` (`lib/ai/context-builder.ts:100`) assembles registered domain assemblers in parallel (lines 171–194), then runs signal detectors over the assembled domains (line 216). The transactions assembler (`lib/ai/assemblers/transactions.ts:217`) is the only assembler that touches transaction rows; the other three (`accounts`, `snapshot`, `goals`, plus `holdings`) never see them, so **all wiring lands in one assembler**.

What the assembler does today, with the facts that matter for this investigation:

- **Query** (lines 245–287): dual-path Space scoping with KD-1 visibility, `deletedAt: null` (line 264), `flowType ∈ BANKING_FLOWS` (line 268), newest-first, `take: TRANSACTION_FETCH_LIMIT + 1` (5,000-row cap + KD-7 sentinel, lines 138, 286). Selected columns (lines 272–284): `date, merchant, merchantId, resolvedMerchant, category, amount, pending, currency, flowType, flowDirection`. **Not selected today:** `id`, `classificationReason`, `transferRail`, `counterpartyAccountId`, `plaidTransactionId`, `pendingTransactionRef`, `financialAccountId`.
- **Settled/pending partition** (lines 300–305): money totals accumulate over settled rows only; pending rows contribute only `pendingCredit/DebitCount/Total` (lines 417–434) and `transactionCount`.
- **Flow partition** by the shared predicates (lines 369–409); `netCashFlow` excludes transfers by construction (line 413).
- **Payload** (`TransactionsSummaryData`, `lib/ai/types.ts:544–652`) — aggregates only; raw rows never leave the assembler except under an explicit D6 drilldown (lines 689–691).

Downstream consumers of that payload:

- **Signals:** `lib/ai/signals/detectors/transactions.ts` emits `PENDING_CREDIT`/`PENDING_DEBIT` iff the pending counts are > 0 (lines 37, 58); registered signal types live in `lib/ai/signals/types.ts:22–45`.
- **Daily Brief:** `app/api/brief/route.ts:478` builds one context per eligible Space with `scopeHint: "brief"` (30-day window, `lib/ai/assemblers/transactions.ts:140`); `buildAttention()` consumes warning/critical signals (info-severity skipped, line 239); `buildInsight()` computes a savings-rate sentence directly from `incomeTotal`/`expenseTotal` (lines 386–399).
- **Chat:** `app/api/ai/chat/route.ts:2029/2098` builds full contexts; the serializer surfaces summary fields as labeled prose (the `refundTotal` one-liner at lines 1000–1002 is the pattern a new field would follow).
- **Assessment:** `computeAssessment()` (`lib/ai/intelligence/annotations.ts`) reads the summary — `dataQuality.incomeConfidence` derives from `incomeTransactionCount` and an income-plausibility ratio (lines 1799–1806, threshold at 579); LOW income confidence drives the `LOW_INCOME_SAMPLE` deficit-cause class (line 54), the `INCOMPLETE_INCOME_DATA` risk (lines 1514–1522), and `incompleteIncomeWarning` (lines 131–137).

---

## 3. Wiring needs-classification into the assembler — exact changes and why it matters

### 3.1 What would change, file by file

**1. `lib/ai/assemblers/transactions.ts`** — the only query change in the whole plan:

- Extend the `select` (lines 272–284) and `TxnRow` (lines 176–193) with `classificationReason`, `transferRail`, `counterpartyAccountId` (all flat persisted columns; `merchantId` is already selected). For the parity option in §3.3, additionally `id` and `financialAccountId`.
- In (or beside) the existing settled-row loop (lines 350–410), evaluate `shouldSurfaceAsNeedsClassification()` per row — a pure call, mirroring how the Tab's `contextFields()` builds the input (`lib/data/transactions.ts:179–191`) — and accumulate aggregates. Import from `@/lib/transactions/needs-classification`, exactly parallel to the existing `flow-predicates` import at line 77.
- Emit new payload fields (data object at lines 695–743).

**2. `lib/ai/types.ts`** — extend `TransactionsSummaryData` (lines 544–652) with an aggregate block, following the KD-7/KD-17 disclosure style:

```
needsClassification: {
  count: number;                       // rows flagged, settled + pending
  unknownInflowCount: number;          // reason = UNKNOWN_INFLOW_SOURCE
  unknownInflowTotal: number;          // Σ amount of those rows, target currency
  unknownPaymentAppCount: number;      // reason = UNKNOWN_PAYMENT_APP_PURPOSE
  unknownPaymentAppTotal: number;      // Σ|amount| of those rows
  counterpartyResolution: 'PERSISTED_AND_READ_TIME' | 'PERSISTED_ONLY';  // §3.3 parity disclosure
}
```

Aggregates only — no row ids, no merchants — per the TI fact-layer doctrine that TI facts reach AI "as aggregates and stored labels the LLM phrases, not raw per-row dumps" (`TRANSACTION_INTELLIGENCE_FACT_LAYER_INVESTIGATION_2026-07-07.md:271`) and the D6.3D token-budget posture (`D6_3D_CONTEXT_BUDGET_INVESTIGATION.md:31`, "serialize narrowly under a token budget"). Six scalars ≈ a few dozen tokens.

**3. `lib/ai/signals/types.ts` + `lib/ai/signals/detectors/transactions.ts`** — one new `NEEDS_CLASSIFICATION` signal type; detector rule `count > 0`, severity `info` (or `warning` above a share threshold of `incomeTotal`), mirroring the existing pending detectors (lines 37–76).

**4. `lib/ai/intelligence/annotations.ts`** — the substantive consumer. `dataQuality` (lines 114–119) gains `unidentifiedInflowShare` (= `unknownInflowTotal / incomeTotal`); the `incomeConfidence` derivation (lines 1799–1806) adds it as a downgrade input alongside the count threshold and plausibility ratio; the `INCOMPLETE_INCOME_DATA` evidence string (line 1519) can then say *"$X of $Y income in-window has no identified source"* instead of only counting rows. Pure-function constraint preserved — the fact arrives pre-computed in the summary.

**5. `app/api/brief/route.ts`** — `buildAttention()` renders the new signal as an actionable item (href to the Transactions Tab review surface), and `buildInsight()`'s savings-rate sentence (lines 386–399) gains the honesty caveat when `unidentifiedInflowShare` is material.

**6. `app/api/ai/chat/route.ts`** — one serializer line in the summary block, the `refundTotal` pattern (lines 1000–1002): *"N transactions need classification (…$X of income has no identified source; $Y moved via payment apps, purpose unknown)"*.

No schema changes, no writes, no new modules: the predicate stays the single authority; the assembler becomes its fourth consumer.

### 3.2 Why it matters for the Daily Brief / AI features specifically

**It changes what the Brief can honestly claim, and gives it a new actionable item.**

- *Savings-rate honesty.* Today `buildInsight()` will happily report "You kept 34% of income" (`app/api/brief/route.ts:390–399`) when a third of `incomeTotal` is sign-default inflow with no source — the exact figure TE-2B exists to flag. The assessment layer's proxy (income transaction *count* ≥ 3 ⇒ potentially HIGH confidence, `annotations.ts:579/1806`) cannot see this: three unidentified deposits pass the count test. `unknownInflowTotal` is the direct measurement.
- *Deficit-cause accuracy.* `LOW_INCOME_SAMPLE` ("deficit is a data artifact", `annotations.ts:54`) currently triggers only off the count proxy. Unidentified-inflow share is a second, sharper trigger — and conversely, a window with many *identified* income rows can stop being spuriously downgraded.
- *An insight class the Brief cannot produce today.* "3 payment-app movements totaling $412 need classification" is exactly the Brief's "Needs Attention" material — deterministic, actionable, self-healing (the predicate shrinks as the user classifies; module doctrine, `needs-classification.ts:22–26`). The Cash Flow widget already ships the UI-side twin of this insight (`cash-flow-insights.ts:15`, input (d) is needs-classification/unresolved presence via `groupCashFlowContext`), so the Brief saying it too keeps surfaces consistent rather than inventing a new claim.
- *Validator/coverage alignment.* The boundary investigation's Coverage section names "income data is complete enough to state a savings rate" as a first-class epistemic claim the AI path lacks (§5.1–5.3, lines 191–203). This aggregate is the first concrete feed for it — computed in the assembler from a TI predicate, consumed as a caveat, exactly the "coverage facts reach every derived metric's prompt block or suppress it" shape (line 203).

**Perspectives need nothing here.** The Cash Flow Perspective already consumes the predicate through CF-1 with a strict scope invariant — needs-classification is a review flag, "never subtracted" from Cash In/Out (`lib/transactions/cash-flow-context.ts:10–21`). The AI wiring must copy that invariant: the aggregates are disclosure, and **no money total in the assembler changes**. `lib/perspective-engine/` imports nothing from `lib/transactions/` (grep-verified) and its lenses operate on accounts/snapshots, not transaction rows — no change there.

### 3.3 The one real design decision: counterparty parity

The Tab computes `hasResolvedCounterparty` as *persisted `counterpartyAccountId` OR read-time TI4 transfer match* (`lib/data/transactions.ts:190`, detail at line 475). Since persisted counterparty ids are still sparse (the TI fact-layer doc, §1.1 table line 74: the column is "written null today" outside provider-confirmed links), an assembler that used **persisted-only** would count some rows as `UNKNOWN_PAYMENT_APP_PURPOSE` that the Tab displays as resolved internal transfers — a cross-surface figure divergence, the exact KD-10 defect class the boundary doc's rule 13 forbids ("one authority per claim… module, consumer, script, or prompt", line 314).

Two honest options:

- **(a) Parity (recommended):** call `resolveOwnedTransferCounterparties(rows, { spaceId })` (`lib/transactions/transfer-resolution.ts:111`) in the assembler before the aggregation loop, exactly as the list reads do (`lib/data/transactions.ts:136`). It is already KD-15-gated per Space, already bucketed to avoid O(n²) (lines 159–176), already capped (`CANDIDATE_CAP = 5000`, line 39). Cost: three bounded queries per assembly (§6). Requires selecting `id`/`financialAccountId` on `TxnRow`.
- **(b) Persisted-only, disclosed:** skip the resolver, set `counterpartyResolution: 'PERSISTED_ONLY'` in the payload, and have the serializer soften cluster-A wording. Cheaper, but ships a knowingly-inflated count and a standing divergence from the Tab.

Recommendation: (a). The divergence in (b) is small today but grows with every user who links accounts, and the seam for (a) already exists — no new code shape, one import.

---

## 4. Wiring RelationshipResolver — the double-counting question answered fact by fact

### 4.1 Pending↔posted: totals are already safe; the residue is disclosure-grade

The question posits "risk of double-counting a pending transaction and its later-posted counterpart as two separate flows." Tracing the actual lifecycle:

1. Money totals are **settled-only** — the pending partition never touches `incomeTotal`/`expenseTotal`/`netCashFlow` (`lib/ai/assemblers/transactions.ts:300–307`, doctrine restated at `lib/ai/types.ts:355–356`).
2. When a pending transaction posts, Plaid sends the pending row in `removed[]`, and sync **tombstones** it (`lib/plaid/syncTransactions.ts:454–471`); the assembler filters `deletedAt: null` (line 264). So in the normal lifecycle the pending predecessor is not even *fetched*.
3. Therefore a pending row and its posted counterpart are never both in a money total. **The prompt's hypothesized totals-level double-count does not exist in buildContext() today** — it was closed at write time (tombstone) and at aggregation time (settled-only), not by relationship resolution.

The genuine residue: if `removed[]` is missed or delayed, a **live** pending row coexists with its live posted successor. Both are fetched; the posted row is in the money totals (correct); the pending row inflates `pendingDebitTotal`/`pendingDebitCount` and `transactionCount`, and can fire a `PENDING_DEBIT` signal (`signals/detectors/transactions.ts:58`) for money that has already settled — a stale "$X outgoing" line in the Brief. This is exactly `resolvePendingPosted`'s deterministic match (`RelationshipResolver.ts:174–194`), and — because both rows are live and fetched — it is detectable **without the resolver's candidate-gathering machinery**: select `plaidTransactionId` + `pendingTransactionRef` on `TxnRow`, build one Set of referenced pending ids from posted rows, and skip (or separately disclose) matched pending rows in the pending accumulators. Pure, in-memory, O(n), zero queries. A `pendingAlreadyPostedCount`/`Total` disclosure field keeps the correction honest rather than silent.

**Gate before building it:** run a corpus audit (the `audit:flow-desync` idiom) counting live pending rows whose `plaidTransactionId` is referenced by a live posted row's `pendingTransactionRef`. If the count is ~0 — which the tombstone path predicts — record that and skip the slice. Building a dedup for a defect the write path already prevents would be speculative complexity.

### 4.2 Duplicates: read-time detection buys almost nothing buildContext can use

`resolveDuplicate` uses the **same deterministic keys** as write-time dedup: `findByFingerprint` at sync (`lib/plaid/syncTransactions.ts:409`, `lib/transactions/fingerprint.ts:55`) matches on (account, date, amount, merchant, pending) — the identical tuple `resolveDuplicate` matches on (`RelationshipResolver.ts:24–25`, 197–219). Any duplicate the read-time resolver *can* see is one the write path was built to prevent; any duplicate the write path *misses* (cross-source descriptor drift — a CSV "WM SUPERCENTER" beside a Plaid "WALMART #1842") is invisible to the read-time resolver too, because both use the raw-merchant fingerprint. So wiring duplicate detection into the assembler would mostly re-verify write-time dedup, and the duplicates that actually inflate `expenseTotal` would sail through.

Worse, *acting* on read-time duplicate facts inside the assembler (dropping a leg from totals) would make the AI's `expenseTotal` diverge from the Tab's list sums and the Perspective's `deriveCashFlowAxes` output — a second definition site for "what the window's spend is," the re-derivation defect class both prior docs exist to prevent. Verdict: **do not wire.** The cross-source duplicate problem is real but belongs to MI-keyed fingerprinting or a TI reconciliation slice at *write/backfill* time, not to buildContext.

### 4.3 transferCandidate and refundCandidate

`netCashFlow` already excludes transfers wholesale by flowType (line 413) — transfer-leg matching cannot change any buildContext total. Its AI-path value is (i) the needs-classification parity input (§3.3 — wired via `transfer-resolution.ts`, not via the resolver directly) and (ii) per-row explanation ("this $2,000 is one leg of a transfer to your savings"), which belongs to the D6 **drilldown** path (`lib/ai/assemblers/transactions.ts:1040`) or a future single-transaction AI domain — explanation-scoped, exactly the TI4 posture — not to the always-on summary. `refundCandidate` is reserved-null (`RelationshipResolver.ts:114`); nothing to wire.

---

## 5. Precedent: how Tab-only capabilities were promoted into the AI read path before

Four shipped precedents, in order of relevance; W1 should copy the first two rather than invent a seam:

1. **TI1 / FlowType P5 Slice 4 — the canonical promotion.** "Which flows count as spend" was born UI-side (`FLOW_COST` in `BankingClient.tsx` and `SpaceTransactionsPanel.tsx`, plus the assembler's private `EXPENSE_FLOWS`), then consolidated into the pure, zero-import `lib/transactions/flow-predicates.ts` (module header, lines 1–35) and imported by the assembler (`transactions.ts:77`) and the Perspective (`cash-flow.ts:20`) — behavior-neutral, golden-pinned. **Needs-classification is already past the hard step** (it *is* a pure zero-import `lib/transactions/` module, by construction — header lines 4–6: "usable by any future surface (review inbox, AI, Cash Flow) without importing UI or DB"); the remaining work is only the import + aggregate + serialize tail of the same pattern.
2. **TI4 Slice 1 — the impure-wrapper seam.** When the pure matcher needed to serve *list* reads, the codebase did not put candidate-gathering in the resolver; it built `transfer-resolution.ts` (server-only gathering + KD-15 gating around the pure core, header lines 4–23) and had both list reads call it (`lib/data/transactions.ts:136/218`). An assembler needing the same fact calls the **same wrapper** — no new gathering code.
3. **MI M6 read cutover — additive select + read-time resolution in both paths.** The resolved-Merchant join was added symmetrically to the Tab (`lib/data/transactions.ts:132`) and the assembler (`transactions.ts:277`, `merchantGroupOf` at 544–550). Precedent for "grow the assembler's select, keep raw fields for forensics."
4. **KD-1 ↔ KD-15 — one predicate, two surfaces.** `TRANSACTION_DETAIL_VISIBILITY` is defined once (`lib/ai/visibility.ts`) and imported by both the assembler (line 62) and the Tab (`lib/data/transactions.ts:55`) so "AI and UI can never disagree on what's visible" (comment at lines 27–38). Direction was AI→UI, but it is the standing rule that a fact crossing surfaces must cross as a shared import — the §3.3 parity argument in one sentence.

CF-1's `contextFields()` (`lib/data/transactions.ts:169–193`) is the fifth, smaller precedent: a per-row projection spread additively onto an existing read, "no calculation reads it" — the disclosure-not-computation posture the new aggregates must keep.

---

## 6. Performance and complexity vs. the current on-demand pattern

Current cost profile of the facets (on-demand, per user action): the detail read pays one ≤300-row candidate query + two small account queries per transaction viewed (`lib/data/transactions.ts:414–447`); the list reads pay `resolveOwnedTransferCounterparties`' three bounded queries per Tab load (`transfer-resolution.ts:127–157`); needs-classification is free everywhere (pure function over already-selected columns).

At buildContext() assembly time:

| Wiring | New queries | New CPU | New payload | Notes |
|---|---|---|---|---|
| Needs-classification, persisted-only | **0** | O(n) pure pass, n ≤ 5,000 | ~6 scalars | +3 selected columns on the existing query |
| Counterparty parity (§3.3a) | **3** (owner lookup, owned accounts, transfer legs; all indexed, capped at 5,000) | bucketed matching, no O(n²) (`transfer-resolution.ts:19`, 159–176) | 1 enum | The Tab already pays this per list load; the assembler pays it per context build |
| Pending↔posted disclosure (§4.1) | **0** | O(n) Set pass | 2 scalars | +2 selected columns (`plaidTransactionId`, `pendingTransactionRef`) |
| Full `resolveTransactionRelationships` per row | would require per-row candidate sets incl. tombstoned rows — the detail read's query shape × 5,000 | — | — | **Rejected**; this is the "lazily re-derive relational facts per request" anti-pattern both prior docs warn against (fact-layer §5, line 178) |

The multiplier to respect is the Brief: `app/api/brief/route.ts:476–480` builds a context for **every eligible Space in parallel**, so the parity option's three queries become 3 × Spaces per Brief load. Bounded (memberships are small; the brief window is 30 days so target sets are small), but it argues for keeping the parity resolver call *conditional* — skip it when the fetched window contains zero `PAYMENT_APP`-rail unresolved rows, which is the common case and costs one array scan to detect. Token cost is negligible by design (aggregates only, §3.1), consistent with the D6.3D budget doctrine and the fact-layer's explicit "AI context budget" risk entry (line 271).

Complexity cost is likewise contained: no new module, no schema, no write-path change; the assembler grows one aggregation block and the summary type one sub-object. The main ongoing obligation is test surface — the golden test (`transactions.golden.test.ts`) pins byte-identical aggregates, so new fields must be additive and the existing accumulators untouched (the MC1 Phase 2 precedent, `transactions.ts:196–203`).

---

## 7. Relationship to the prior investigations

**7.1 Agrees.** With the boundary investigation: both facets are TI, not new modules (§4 rows 29–30 — FlowType a facet, RelationshipResolver "TI's code, not a sibling", lines 176–177); the Daily Brief is a Consumer that must never mint facts (§4 row 22, §8) — hence every figure here is computed in the assembler and *consumed* by the Brief; persistence stays a per-fact engineering decision (rule 4, line 302) — nothing in this plan persists a relationship or a needs flag. With the fact-layer investigation: the Daily Brief was already named a TI read-cutover beneficiary, including "a clean pending-vs-posted distinction it cannot currently make" (§6, line 189) — §4.1 is that item, scoped down to its honest size; and TI facts reach AI as aggregates, never row dumps (§8, line 271).

**7.2 Extends / refines.** (a) The fact-layer doc (2026-07-07, §5 line 178) prescribed *persisted* relational facts via a reconciliation pass; the ratified TI4 decision (recorded as load-bearing "new evidence" in the boundary doc's header, line 9) superseded that with read-time resolution. This investigation applies the superseding posture to the buildContext question and finds it *strengthens* the case against wiring the resolver into the summary path: read-time relational facts are explanation-scoped by ratified intent, and the summary path needs totals-scoped facts, which are already safe. (b) The boundary doc's Coverage section (§5.3, line 203) called income-completeness caveats an AI-path need with no feed; §3 identifies `unknownInflowTotal` as the first shipped-predicate-backed feed for it, and names the aggregate's eventual home: if/when Coverage is built as a module, this figure migrates from "assembler-local aggregate" to a Coverage-owned claim — the field shape in §3.1 is chosen so that migration is a move, not a redefinition. (c) One adjacent observation for the KD register rather than this plan: `buildInsight()` computes a savings-rate figure inline in a Consumer (`app/api/brief/route.ts:387–389`) — the boundary doc's §8 argument predicts this is where a divergence will eventually live; the honest home for that ratio is the assessment layer.

**7.3 Corrects (the request's framing, not the docs).** "Both currently only feed the Transactions Tab UI path" is out of date by one initiative: CF-1/CF-2B route `needsClassification` + `transferDisposition` through the list DTO into the Cash Flow Perspective surfaces (`lib/data/transactions.ts:147` → `cash-flow-context.ts:100` → `CashFlowSummaryWidget.tsx:184`, `cash-flow-insights.ts:173`), under the "review flag, never subtracted" invariant. The precise gap is the one the grep states: zero imports under `lib/ai/` and `lib/perspective-engine/`. This matters because it means the AI wiring has a *second* live consumer to stay consistent with (the Cash Flow context section), not just the Tab.

---

## 8. Recommendation and slice plan

**Verdict: worth doing for needs-classification; mostly not worth doing for RelationshipResolver.** The current split is *half*-correct as-is: relationship facts are explanation context and correctly stay out of the summary path (the totals they would protect are already protected upstream), but needs-classification is an honesty fact the AI path is measurably poorer without — the Brief and assessment layer are currently confident about income figures the predicate can prove are unidentified.

Slices, each additive and independently shippable:

- **TI2-W1 — Needs-classification aggregates in the assembler.** Columns + pure pass + `TransactionsSummaryData.needsClassification` block + serializer line, with counterparty parity via `resolveOwnedTransferCounterparties` (conditional on unresolved payment-app rows being present in the window). Golden test extended additively; a parity test asserting the assembler's count equals the count derivable from the Tab's DTO over a shared fixture. Zero schema.
- **TI2-W2 — Consumption.** `NEEDS_CLASSIFICATION` signal; Brief "Needs Attention" item + savings-rate caveat; `annotations.ts` income-confidence downgrade by `unidentifiedInflowShare`. Pinned-wording tests per the MC1 serializer precedent.
- **TI2-W3 (gated) — Pending↔posted pending-disclosure dedup.** Precondition: a corpus audit shows live pending rows with live posted successors actually occur. If the audit returns ~0, close the slice as "write path already prevents it" and record that in STATUS.
- **Not planned:** duplicate detection in buildContext (§4.2); transferCandidate/refundCandidate in the summary domain (§4.3); any persistence of either facet (ratified TI4 posture stands).

Ordering: W1 before W2 trivially; both are independent of W3. Nothing here blocks, or is blocked by, the remaining TI slices in the fact-layer plan — W1/W2 are pure read-side consumers of already-persisted TE-2B inputs.

---

**End of investigation. No implementation performed. No files modified; STATUS.md untouched. Recommended next action if approved: ratify §3.3(a) parity and the §8 slice order, then implement TI2-W1.**
