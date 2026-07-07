> **INVESTIGATION ONLY — no code, no schema, no migrations, no roadmap-doc changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Transaction Intelligence — Durable Fact Layer Investigation

**Date:** 2026-07-07
**Status:** Investigation complete — architecture and sequencing recommendation only, no implementation.
**Scope of "Transaction Intelligence" in this document:** the **write-side durable-fact layer** that answers *"what actually happened"* for each transaction — the economic-event analogue of Merchant Intelligence's *"who handled it."* This is **not** the read/presentation initiative of the same name in `TRANSACTION_INTELLIGENCE_DETAIL_VIEW_INVESTIGATION_2026-07-06.md`; that initiative renders facts, this one computes them. §0.1 reconciles the name collision.
**Baseline:** FlowType P5 complete (`classifyFlow` is the single flow authority, persisted and read everywhere). Merchant Intelligence M0–M6 complete (persisted `Merchant`/`MerchantAlias`/`MerchantRule`, `categorySource` provenance, read cutover). MC1 multi-currency complete (`Transaction.currency` stamped).
**Sources:** `lib/transactions/{flow-classifier,plaid-flow-input,plaid-category,fingerprint,merchant-corrections}.ts`; `lib/imports/csv.ts`; `lib/plaid/syncTransactions.ts`; `lib/ai/assemblers/transactions.ts`; `lib/ai/intelligence/annotations.ts`; `lib/debt.ts`; `app/api/ai/chat/route.ts`; `app/api/accounts/[id]/import/route.ts`; `components/dashboard/{BankingClient,widgets/SpaceTransactionsPanel}.tsx`; `prisma/schema.prisma` (Transaction model); `docs/investigations/{MERCHANT_INTELLIGENCE_PERSISTED_TIER_PLAN,FLOWTYPE_FOUNDATION,TRANSACTION_METADATA_DEPTH,TRANSACTION_INTELLIGENCE_DETAIL_VIEW,NEXT_INITIATIVE_TI_VS_MI,CREDIT_CARD_PAYMENT_CLASSIFICATION,DEBT_PAYMENT_ATTRIBUTION}*.md`.

---

## 0. Executive summary

**Transaction Intelligence is not a greenfield initiative — its kernel already shipped as FlowType.** `classifyFlow` (`lib/transactions/flow-classifier.ts`) already computes, persists, and versions a durable transaction fact: the economic **kind** (`flowType`) and **direction** (`flowDirection`) of every movement, with a confidence score, a stable machine reason, and a `classifierVersion` for selective re-runs. Every production writer stamps it; Banking, Spaces, Debt, the AI assembler, the opportunity engine, and the chat route all read it. This is exactly the "compute once, reuse everywhere" durable-fact pattern the request asks for — already built, for one facet.

**The gap is that FlowType is one facet of "what happened," and the rest of that question is answered by scattered, duplicated, mostly read-time heuristics.** Payment method (ACH/wire/check/card/ATM/cash) is captured from Plaid at sync and then *discarded*. The pending→posted lifecycle is a boolean with no link between the two rows. Transfer-leg pairing, refund→purchase linkage, and duplicate-event grouping are either unbuilt or half-built (the `counterpartyAccountId` column exists but is always written `null`; `fingerprint.ts` matches duplicates but persists no group). Recurring detection is a throwaway per-request heuristic. And the membership predicate "which flows count as spend" is triplicated across two React components and the AI assembler.

**The smallest architecture that satisfies the long-term vision is to generalize FlowType into a small family of orthogonal, additive facets — not to build a new engine.** TI extends the primitive that already exists: same purity contract, same `classifierVersion` gating, same "never fabricate → UNKNOWN" honesty valve, same additive-nullable-column discipline MC1 and MI established. `classifyFlow` stays the single authority for `flowType`; TI adds sibling facets around it and **never forks it**. The one genuinely new architectural piece is a **reconciliation pass** for the *relational* facts (transfer groups, duplicate groups, refund links) that depend on other rows — computed once at settle-time or in backfill, never re-derived per request (the KD-10/KD-11 anti-pattern MI spent M6 removing).

**Recommendation (detail in §7):** adopt TI as a reusable platform capability sequenced as six additive slices TI0–TI5 mirroring MI's M0–M6. Front-load the zero-schema debt paydown (collapse the triplicated spend-membership sets into one TI predicate); then capture-at-write the two facets whose inputs Plaid already sends but sync throws away (`paymentMethod`, `settlementState`); then a reconciliation pass for the three relational facets reusing the `counterpartyAccountId` and `fingerprint` seams already half-built; then read cutover. Receipt Intelligence consumes TI facts (settlement state + payment method + merchant identity) rather than duplicating them.

### 0.1 Name reconciliation (required before anything else)

Two initiatives carry the name "Transaction Intelligence":

| | This document (the **fact layer**) | `..._DETAIL_VIEW_...2026-07-06` (the **surface**) |
|---|---|---|
| Question | *What happened?* (write-side) | *Show me one transaction* (read-side) |
| Output | Durable facts on the row (kind, method, lifecycle, groupings) | Canonical DTO, single-row endpoint, detail overlay |
| Schema | Additive nullable columns | Zero, until an annotations sidecar |
| Analogue | Merchant Intelligence persisted tier | The rendering host for MI/FlowType/TI facts |

They are complementary halves and both are real, but conflating them will produce a muddled roadmap. This document proposes the fact layer be tracked as **TI-fact / `docs/initiatives/ti-fact/`** (or a name ratified at TI0) and that the detail-view work keep its existing designation as the **surface that renders these facts**. Where this document says "TI" it means the fact layer.

---

## 1. Existing architecture — every place transaction semantics are inferred

Transaction meaning is computed in **eleven** distinct sites. Only the first two are a shared, single-authority primitive; the rest are consumers or independent re-derivations.

**1. `lib/transactions/flow-classifier.ts` — `classifyFlow` (the authority).** Pure, deterministic, Prisma-free. Produces `{flowType, flowDirection, confidence, reason}` from category + sign + account-type context + Plaid PFC hints (when in memory). Precedence: PFC → flow-value category → account-type context → sign default → honest `UNKNOWN`. Carries `FLOW_CLASSIFIER_VERSION` for selective re-runs. **This is Transaction Intelligence, phase zero, already in production.**

**2. `lib/transactions/plaid-flow-input.ts` — the write adapter.** `buildFlowInputFromRow` / `buildFlowWriteFields` marshal a Plaid payload (or a stored row) into classifier input and out to the persisted flow columns. Critically, `CapturedPlaidMetadata` already extracts `pfcConfidenceLevel`, `merchantEntityId`, and `counterparties[]` — but of these only `merchantEntityId`, `pfcPrimary/Detailed/ConfidenceLevel` reach the database. **`payment_channel`, `authorized_date`, `pending_transaction_id`, and the counterparty detail are captured in memory and dropped** (`TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` deferred their persistence as a separate PII-reviewed decision).

**3. `lib/transactions/plaid-category.ts` — `mapPlaidCategory`.** Plaid PFC → the 16-value `TransactionCategory` enum (MI's domain, not flow's, but it *feeds* flow). Semantic inference path #1.

**4. `lib/imports/csv.ts` — `mapCategory` + `CATEGORY_ALIASES`.** A **second, independent** keyword→category inference: `income|payroll|deposit|salary → Income`, `transfer → Transfer`, `payment|loan → Payment`, `interest → Interest`, etc. This is a parallel "what happened" heuristic for the CSV dialect that does not share code or semantics with the Plaid path — the two can and do disagree on identical economic events.

**5. `lib/plaid/syncTransactions.ts` — the sync writer.** Calls `classifyFlow` + `buildFlowWriteFields` on create and on the fingerprint-update path; applies a category override *before* classifying (so flow follows the corrected category). Consumer of #1, not a re-derivation — the correct pattern.

**6. `app/api/accounts/[id]/import/route.ts` — the import writer.** Same `classifyFlow` + `buildFlowWriteFields` call. Also correct.

**7. `lib/transactions/merchant-corrections.ts` — the correction writer (MI M5).** Re-runs `classifyFlow → buildFlowWriteFields` whenever a user correction changes category, so category and flow never desync. This is the **category-rewrite invalidation contract** in action — the single most important structural precedent for TI (§4).

**8. `lib/ai/assemblers/transactions.ts` — the AI aggregator.** Re-derives several "what happened" facts at read time: `EXPENSE_FLOWS` membership set, `refundTotal` / `debtPaymentTotal` / `transferTotal` accumulation, `netCashFlow`, and a **recurring-candidate heuristic** (group by lowercased merchant, ≥2 occurrences in-window, flow-exclude TRANSFER/DEBT_PAYMENT). None persisted.

**9. `app/api/ai/chat/route.ts` — the chat context builder.** A keyword→category map (line ~410), `SERIALIZED_SPENDING_FLOWS` / `NON_SPENDING_CATEGORY_NAMES` derived at request time via `classifyFlow(category, -1)`, per-liability debt-payment rollup (`fetchPerLiabilityDebtPayments` → `rollupDebtPaymentsByAccount`), and hand-written prose distinguishing refunds/transfers/debt-payments from spending.

**10. `lib/ai/intelligence/annotations.ts` — the opportunity engine.** The spending-opportunity eligibility gate *is* `isExcludedFromSpending(classifyFlow({category, amount:-1}))` computed at read time. Consumer of #1, but re-invokes the classifier per category per request rather than reading a stored fact.

**11. `components/dashboard/BankingClient.tsx` + `widgets/SpaceTransactionsPanel.tsx` — the UI.** Each defines its own `FLOW_COST = {SPENDING, FEE, INTEREST}` set and computes spend = cost − refund locally. Two copies, plus the assembler's `EXPENSE_FLOWS` and `SERIALIZED_SPENDING_FLOWS` — the same "what counts as spend" definition in **four** places.

Adjacent, related primitives: `lib/debt.ts` (`rollupDebtPaymentsByAccount`, `estimateMinimumPayment` — debt-payment attribution math), and `lib/transactions/fingerprint.ts` (`normalizeMerchantKey` + fingerprint matching — duplicate detection, shared by sync and CSV import, but persisting no group id).

### 1.1 Duplicated heuristics (the debt TI would retire)

| Duplicated heuristic | Where it lives (independent copies) | Consequence |
|---|---|---|
| "Which flows count as spend" | `BankingClient.FLOW_COST`, `SpaceTransactionsPanel.FLOW_COST`, assembler `EXPENSE_FLOWS`, chat `SERIALIZED_SPENDING_FLOWS` | 4-way drift risk; any new flow kind must be added in four files |
| Category→economic-kind inference | `plaid-category.mapPlaidCategory` (Plaid dialect) vs `csv.mapCategory` (file dialect) | Two providers, two semantics for the same event class (`payment/loan`→Payment vs PFC `LOAN_PAYMENTS`→DEBT_PAYMENT) |
| Non-spending category-name set | derived per-request in chat route **and** annotations **and** assembler | Same `classifyFlow` re-invoked at three read sites (KD-10/KD-11 re-derivation class) |
| Recurring / subscription detection | assembler read-time heuristic; `SUBSCRIPTION_MERCHANTS` allowlist in `plaid-category` | Throwaway, per-request, unpersisted; overlaps MI's deferred cadence track |
| Debt-payment attribution | `rollupDebtPaymentsByAccount` (destination-side rollup) because `counterpartyAccountId` is written `null` | Attribution is heuristic, not deterministic leg-pairing (KD-18) |
| Duplicate-event identity | `fingerprint.ts` matching, but no persisted `duplicateGroupId` | Every consumer re-runs matching or ignores duplicates |
| Pending→posted lifecycle | `pending` boolean only; `pending_transaction_id` discarded at sync | No link between a pending row and its posted successor |

---

## 2. Existing computed knowledge — what facts already exist, and which belong in TI

**Persisted transaction facts today** (on the `Transaction` row):

| Fact | Column(s) | Owner | TI verdict |
|---|---|---|---|
| Economic kind | `flowType` | FlowType | **Already TI** — the kernel |
| Direction | `flowDirection` | FlowType | **Already TI** |
| Classifier confidence / reason / version | `classificationConfidence`, `classificationReason`, `classifierVersion` | FlowType | **Already TI** — the provenance model TI reuses |
| Provider taxonomy hint | `pfcPrimary/Detailed/ConfidenceLevel` | Plaid capture | TI **input**, not a TI fact (provider-owned) |
| Currency of `amount` | `currency` | MC1 | TI **input** for the FX facet |
| Counterparty account | `counterpartyAccountId` | FlowType (seam) | **TI**, but written `null` today — the transfer-group substrate |
| Merchant identity | `merchantId`, `merchantEntityId` | MI | **MI**, not TI — the "who" |
| Category + provenance | `category`, `categorySource`, `categoryRuleId` | MI | **MI** — but flow *derives* from it (shared contract, §4) |
| Pending flag | `pending` | core | TI **input** for `settlementState` |

**Read-time / unpersisted facts** (recomputed every request): refund/debt-payment/transfer totals and net cash flow (assembler); spend-membership; opportunity eligibility; recurring candidates; per-liability debt rollup; duplicate matches.

**Which belong inside TI.** The kind/direction/confidence/version block already *is* TI — the initiative should formally adopt it as its first tier rather than re-implement it. The **new** durable facts TI should own are the ones currently discarded or re-derived: `paymentMethod`, `settlementState` (+ pending↔posted link), `transferGroupId`/refined transfer direction, `refundLinkId`, `duplicateGroupId`, and (coordinated with MI's cadence track) `recurringCandidate`. The read-time *aggregates* (spend totals, refund totals) stay aggregates — but they should read TI's stored membership fact instead of each re-deriving the `FLOW_COST` set. Merchant identity and category stay MI's; TI never writes them.

---

## 3. Proposed Transaction Intelligence architecture

TI is the **generalization of FlowType from one facet to a small family of orthogonal facets**, under the identical contracts that made FlowType, MC1, and MI safe:

- **`classifyFlow` remains the single authority for `flowType`.** TI adds sibling computers for the new facets; none re-derive kind. (Mirrors MI's "category is the only output; flow is derived" rule.)
- **Single-row facts are pure and computed at write.** Anything derivable from one row + its provider payload (`flowType`, `paymentMethod`, initial `settlementState`, the FX facet) is computed once at write time by a pure function, exactly like `buildFlowWriteFields`.
- **Relational facts are computed by a reconciliation pass, never lazily per request.** Transfer-leg pairing, refund→purchase linkage, and duplicate grouping depend on *other* rows and change as rows arrive. These are computed once at settle-time (or in backfill) and persisted as group ids — not re-derived in every assembler call. This is the one new structural component; it is the direct answer to KD-10/KD-11.
- **Versioned honesty.** Every facet carries the `classifierVersion` discipline (re-run only stale rows via `WHERE version < N`) and the "insufficient signal → UNKNOWN, never fabricate" valve already in `classifyFlow`.
- **Additive, nullable, no default.** Every new column is nullable-no-default; `null` means "pre-TI / not yet computed," never a manufactured claim (MC1 Phase 0 doctrine, restated by MI §3.5).
- **One shared predicate module replaces the four spend-membership copies** — the immediate, zero-schema win.

Layering, top to bottom:

```
 raw Plaid/CSV payload (immutable)
        │  capture (extend plaid-flow-input: payment_channel, pending_transaction_id, authorized_date)
        ▼
 ┌───────────────────────────────────────────────┐   write-time, pure, per row
 │ TI single-row facts                            │
 │   flowType/flowDirection   ← classifyFlow (unchanged authority)
 │   paymentMethod            ← payment_channel + PFC detailed
 │   settlementState (initial)← pending flag
 │   fxConverted              ← currency ≠ account currency / Plaid FX
 └───────────────────────────────────────────────┘
        │
        ▼
 ┌───────────────────────────────────────────────┐   settle-time reconciliation pass (batch, not per-request)
 │ TI relational facts                            │
 │   transferGroupId    ← pair legs via counterpartyAccountId (finally written)
 │   settlementState    ← pending→posted transition via pending_transaction_id
 │   duplicateGroupId   ← persist fingerprint.ts result
 │   refundLinkId       ← match refund to prior purchase (same merchant/amount window)
 └───────────────────────────────────────────────┘
        │
        ▼
 one shared TI read predicate (isSpend / isExcluded / isTransferLeg …) ← consumed by UI, assembler, brief, opportunity, debt, search, export
```

The **category-rewrite contract** (`merchant-corrections.ts` today) extends naturally: any write that changes category re-runs `classifyFlow`; TI adds that the same rewrite re-stamps any single-row TI facet that depends on category, through one shared helper — so category, flow, and TI facts can never desync (the seam MI already closed for flow).

---

## 4. Candidate durable facts

Investigation only — these are candidates to ratify at TI0, not a schema. Each is mapped to the request's example vocabulary and to the existing seam it reuses.

| Candidate fact | Tier | Reuses / derives from | Maps to request examples |
|---|---|---|---|
| `flowType` (economic kind) | single-row (**exists**) | `classifyFlow` | transactionKind; fee; interest; payroll; dividend; refund; reversal |
| `flowDirection` | single-row (**exists**) | `classifyFlow` | transferDirection (coarse) |
| `paymentMethod` | single-row (**new**) | Plaid `payment_channel` + PFC detailed (captured, discarded today) | ACH; wire; check; card purchase; ATM withdrawal; cash deposit |
| `settlementState` | single-row init + relational transition | `pending` flag (init); `pending_transaction_id` (transition) | pending → posted lifecycle |
| `fxConverted` / `fxRateApplied` | single-row (**new**) | `currency` (MC1) vs account currency; Plaid FX fields | foreign exchange |
| `transferGroupId` | relational (**new**) | `counterpartyAccountId` seam (written `null` today) | transfer between own accounts; internal transfer; credit-card payment (both legs) |
| `refundLinkId` / `refundReason` | relational (**new**) | merchant + amount + window match | refund; reversal; adjustment |
| `duplicateGroupId` | relational (**new**) | `fingerprint.ts` (matches, persists nothing) | duplicate financial event |
| `debtPaymentRole` (principal/interest/fee leg) | single-row (**new**) | account `debtSubtype` + PFC + sign | debt payment; interest; fee |
| `recurringCandidate` / cadence | relational (**deferred, coordinate w/ MI**) | time-series over ledger | subscription renewal; recurring |
| `transactionIntent` | single-row (**candidate — flag overlap**) | largely a projection of `flowType` | — |

Two vocabulary cautions to settle at TI0. First, **`transactionIntent` overlaps `flowType` heavily** ("reduce a liability" ≈ DEBT_PAYMENT, "move own money" ≈ TRANSFER); it should only be admitted if it captures something `flowType` genuinely cannot, otherwise it is a synonym that invites drift. Second, **`recurringCandidate` is already claimed by MI's deferred cadence track** (`MERCHANT_INTELLIGENCE_PERSISTED_TIER_PLAN §8 "Deferred with intent"`) — TI0 must decide ownership: cadence is a *time-series over the merchant-resolved ledger*, so it arguably belongs to MI's identity spine with TI contributing only the per-row `recurringCandidate` boolean. Resolve the boundary before either side builds it.

---

## 5. Read/write boundaries

Applying the project philosophy (raw immutable · intelligence additive · computed once · reused everywhere):

| Computation timing | Facts | Rationale |
|---|---|---|
| **Once at write** | `flowType`, `flowDirection`, `paymentMethod`, `settlementState` (initial), `fxConverted`, `debtPaymentRole` | Pure functions of one row + its payload; the `buildFlowWriteFields` precedent. All inputs are present at sync/import time (some already captured, then discarded). |
| **Once at settle-time / reconciliation** | `transferGroupId`, `settlementState` (pending→posted transition), `duplicateGroupId`, `refundLinkId` | Depend on *other* rows; correct answer only exists once the counterpart row has landed. A batch reconciler (or the sync tail) computes them once and persists group ids. |
| **Once at backfill** | all of the above, historical rows | Reuse the `classifierVersion` gating pattern — re-run only rows below the current version; dry-run → apply → idempotence proof (MI M3 pattern). |
| **Lazily at read, never persisted** | spend/refund/transfer **totals**, net cash flow, opportunity eligibility | Pure aggregations over stored facts. They stay computed — but read TI's stored membership fact instead of each re-deriving `FLOW_COST`. |
| **Never** | anything requiring an LLM to *infer* kind | The deterministic fact is stored; any AI explanation *phrases* the stored fact, never re-infers it (FlowType/MI doctrine, both prior docs agree). |

The load-bearing decision is the **middle two rows**: relational facts are computed by a reconciliation pass, *not* lazily. Lazily re-deriving transfer pairing or dedup in every assembler/chat call would recreate exactly the re-derivation-site defect class MI's M6 read-cutover existed to remove. Persist the group id once; readers filter on it.

---

## 6. Reuse opportunities

Everywhere a "what happened" heuristic is currently inlined becomes a read of a stored TI fact:

- **UI (Banking, Spaces, Debt).** The four `FLOW_COST`/`EXPENSE_FLOWS` copies collapse to one imported TI predicate. Debt's `rollupDebtPaymentsByAccount` becomes deterministic once `transferGroupId` pairs the payment legs (retires the KD-18 attribution heuristic).
- **AI assembler + chat route.** `EXPENSE_FLOWS`, `refundTotal`/`transferTotal`/`debtPaymentTotal` accumulation, and the recurring heuristic read stored TI facts; the per-request `classifyFlow(category,-1)` derivations disappear (the KD-10/KD-11 discipline applied to TI).
- **Opportunity engine (`annotations.ts`).** The eligibility gate reads a stored `isSpend` fact rather than re-invoking the classifier per category per request.
- **Daily Brief.** "Since last visit" and cash-flow lines read settled TI facts, including a clean pending-vs-posted distinction it cannot currently make.
- **Search.** `paymentMethod`, `settlementState`, `transferGroupId`, and `duplicateGroupId` become first-class filter/facet dimensions.
- **Exports.** Deterministic, documented columns instead of values re-derived by whatever code path built the export.
- **Transaction detail view (the surface-side TI).** Renders TI facts directly — payment method, settlement lifecycle, "this is one leg of a transfer between your accounts," "duplicate of…," "refund of…" — which are exactly the human-legible statements that surface is designed to show.
- **Future Receipt Intelligence.** Receipts match to transactions on `settlementState` + `paymentMethod` + amount + merchant identity (MI). TI supplies three of the four matching dimensions; Receipt Intelligence should *consume* them, not re-derive its own transfer/duplicate/settlement logic. Building TI first is what prevents Receipt Intelligence from duplicating this layer.

---

## 7. Suggested implementation slices

Mirroring MI's M0–M6: strictly ordered, each additive, independently shippable, each a safe stopping point.

**TI0 — Decision gate (doc-only).** Ratify: the name reconciliation (§0.1) and track allocation (`docs/initiatives/ti-fact/`); the facet vocabulary and the two open questions in §4 (`transactionIntent` overlap; `recurring` ownership vs MI cadence); the single-row-vs-relational boundary (§5); confirmation that `classifyFlow` stays the sole `flowType` authority and TI never forks it. Output: decision record, no code.

**TI1 — Consolidate the flow authority as the TI kernel (zero schema).** Collapse the four `FLOW_COST`/`EXPENSE_FLOWS`/`SERIALIZED_SPENDING_FLOWS` copies into one shared TI predicate module re-exported from the flow-classifier home; re-point the two React components, the assembler, and the chat/opportunity read sites at it. Behavior-neutral (byte-identical aggregates proven). This is the immediate debt paydown and the analogue of MI's desync/M0 hygiene gate — it makes every later slice land in one place instead of four.

**TI2 — Capture-at-write foundation (schema additive + write path).** Persist the provider metadata already captured-then-discarded in `plaid-flow-input.ts` and compute the single-row new facets: `paymentMethod`, `settlementState` (initial), `fxConverted`. Additive nullable columns; sync + import + correction writers stamp via a pure `buildTransactionFacts` sibling to `buildFlowWriteFields`; **no reader**. Gate: clear the deferred PII/visibility review that `TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` parked on `payment_channel`/counterparty capture. (MI M1+M2 pattern.)

**TI3 — Single-row backfill.** Compute the TI2 facets over historical rows; `classifierVersion`-style gating; dry-run → apply → idempotence proof; rollback logs (MI M3 pattern).

**TI4 — Relational reconciliation pass (the one new component).** Finally write `counterpartyAccountId` non-null and derive `transferGroupId`; link pending→posted via `pending_transaction_id` to complete `settlementState`; persist `fingerprint.ts` results as `duplicateGroupId`; derive `refundLinkId`. A settle-time/batch reconciler, not per-request. Handles dual-FK legacy rows and null-`merchantEntityId` rows.

**TI5 — Read cutover.** AI assembler/chat, Banking/Spaces, Daily Brief, opportunity engine, and Debt read stored TI facts; remove the read-time re-derivations. Byte-comparison harness on a fixed fixture set before/after (MI M6 pattern).

**Deferred with intent:** `recurringCandidate`/cadence (own track, boundary with MI to be set at TI0); `transactionIntent` (only if §4 shows it is non-redundant); receipt-matching fields (belong to Receipt Intelligence, consuming TI). Recorded so deferral is a decision, not an omission.

Sequencing against the live roadmap: TI1 is safe immediately (zero schema, pure cleanup). TI2's migrations queue behind any open MI/annotation migration train (the repo's serialized-migration doctrine). The surface-side detail-view TI can proceed in parallel — it renders whatever facts exist and gains richer content as TI2/TI4 land.

---

## 8. Risks

**Ownership drift between TI and MI.** The clean split is *TI owns "what happened," MI owns "who."* `flowType`/method/lifecycle/groupings are TI; merchant/category are MI. The danger zones are the shared row and the shared rewrite contract: TI must never write `category` or `merchantId`, and MI must never write `flowType`. The existing `merchant-corrections.ts` contract (category change → `classifyFlow` re-run) is the model — TI extends it to "category change → re-stamp category-dependent TI facts too," through one helper, so the three can never desync.

**Name collision (§0.1).** Unresolved, it produces two roadmaps both called TI and a muddled STATUS ledger. Resolving it is TI0's first output.

**Relational facts are the hard, wrong-able part.** Transfer pairing, refund matching, and dedup can be wrong and can change as rows arrive. Mitigations: version them like `classifyFlow`; make them fully recomputable from raw; never fabricate a link below a confidence threshold (the honesty valve); and never expose a low-confidence group as fact in the UI without the same disclosure layering FlowType uses.

**Discarded provider metadata is a gated dependency.** `paymentMethod`/`settlementState` need `payment_channel`/`pending_transaction_id`, whose capture `TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` deferred behind a PII/visibility review. TI2 cannot skip that review; it is an explicit entry gate, not an implementation detail.

**Two category-inference dialects (Plaid vs CSV).** `mapPlaidCategory` and `csv.mapCategory` already disagree by construction. TI does not fix this (it is MI/category's problem) but *surfaces* it — once payment method and kind are shown per row, a CSV `payment/loan`→Payment row sitting next to a Plaid `LOAN_PAYMENTS`→DEBT_PAYMENT row becomes visibly inconsistent. Coordinate the vocabulary so TI display does not expose the divergence as a bug.

**Migration train + legacy dual-FK.** TI columns queue behind the serialized migration doctrine. `counterpartyAccountId` turning non-null in TI4 must handle `accountId` (legacy) vs `financialAccountId` (canonical) rows and rows with null `merchantEntityId`.

**`classifierVersion` semantics.** Bumping re-runs stale rows — safe for flow (no user override on flow; flow derives from category). TI must preserve that: no TI facet should acquire a user-override tier without the same rank-gated clobber protection MI built for category, or a version bump will silently overwrite a user correction.

**AI context budget.** New per-row facts entering AI context risk the D6.3D budget. TI facts should reach AI as *aggregates and stored labels the LLM phrases*, not as raw per-row dumps; the single-row AI domain stays bounded and opt-in (the detail-view TI's discipline).

---

## 9. Recommendation

**Build Transaction Intelligence as a durable-fact platform capability — but build it as the generalization of a primitive that already exists, not as a new engine.** FlowType already proved the pattern in production: a pure, versioned, honestly-UNKNOWN, write-once, read-everywhere fact. The smallest architecture that satisfies the long-term vision is to (1) reconcile the name, (2) collapse the four duplicated spend-membership sets into one TI predicate (zero schema, immediate), (3) capture-at-write the two facets whose inputs Plaid already sends and sync discards (`paymentMethod`, `settlementState`), plus the cheap `fxConverted` facet, (4) add the single genuinely new component — a settle-time reconciliation pass for the three relational facts (`transferGroupId`, `duplicateGroupId`, `refundLinkId`) reusing the `counterpartyAccountId` and `fingerprint` seams already half-built, and (5) cut reads over to stored facts with a byte-comparison harness.

Keep `classifyFlow` the single authority and extend the category-rewrite contract to cover TI facts, so category, flow, and TI never desync. Treat TI as the write-side "what happened" layer, MI as the write-side "who," sharing the row and the rewrite helper; the transaction detail view and Receipt Intelligence are downstream consumers that render and match against TI facts rather than duplicating them. Defer `transactionIntent` (pending an overlap check with `flowType`) and `recurring`/cadence (pending a boundary decision with MI's deferred track) to explicit later slices, so each deferral is a recorded decision.

Sequenced as TI0–TI5, no slice ships into a void, every slice is additive and independently reversible, and the first slice (TI1) pays down real duplication debt with zero schema — the same shape that made Merchant Intelligence safe.

---

**End of investigation. No implementation performed. Recommendation: adopt TI as the write-side durable-fact layer, sequenced TI0–TI5, generalizing FlowType rather than replacing it, with the §5 write/reconcile/read boundary and the §8 TI↔MI ownership split as binding constraints.**
