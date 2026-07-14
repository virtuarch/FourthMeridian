# Fourth Meridian — Transactions Tab Redesign: Investigation

**Date:** 2026-07-12
**Scope:** Ground the "canonical financial explorer" vision (pivoting views over one ledger, not a Location table; Flow Type/Confidence/Source/Relationship filters; Group By; Saved Views; Natural Language Search; per-row Explain; Compare; Coverage; Bulk Actions; Perspective toggle) against real code.
**Prompted by:** a product vision explicitly rejecting a separate Transactions data model in favor of pivoting the existing ledger, matching this codebase's own "single source, many lenses" doctrine already used by Wealth/Cash Flow/Liquidity/Investments/Debt.

---

## 1. Executive assessment

**This is the best-instrumented tab of the four redesigned this week, by a wide margin.** `Transaction` is not a thin record — it already carries a `FlowType` ontology (`SPENDING/INCOME/REFUND/DEBT_PAYMENT/TRANSFER/INVESTMENT/FEE/INTEREST/ADJUSTMENT/UNKNOWN`), merchant intelligence, transfer-pairing evidence, payment-channel/settlement facts, and a full Transaction Intelligence (TI) subsystem (`lib/transactions/*`, ~45 files) that already resolves relationships, classification-confidence disclosure, and provenance **at read time**. Almost none of this reaches the list view today — it's built, tested, and sitting in the per-row detail drawer.

**One correction to my own assumption, found mid-investigation:** I initially believed transfer-pair and duplicate detection didn't exist. They do — `RelationshipResolver.ts` (TI4/TI5-2) is a pure, tested resolver, wired live in `lib/data/transactions.ts:430` on every detail read. It resolves `pendingPosted`, `duplicate`, and — as of TI4 Slice 1 — a **deterministic cross-account `transferCandidate`** (exact amount/currency/date-window match against the account owner's other owned accounts, KD-15 visibility-gated). Only `refundCandidate` is genuinely unbuilt (reserved `null`, deliberately deferred pending a ratified fuzzy-matching heuristic — the one piece of "relationship" work that's honestly not safe to fake). `detail-sections.ts`'s doc comment ("`refundCandidate` / `transferCandidate` are reserved-null and never rendered") is now **stale** — it was accurate when `transferCandidate` didn't resolve; TI4 Slice 1 shipped since. That's a live, already-computed signal not yet rendered anywhere, in the drawer or the list.

**On Confidence specifically: the codebase already has a better answer than a raw tier badge.** The vision proposes `Observed / Imported / Reconstructed / Needs review` as a filterable tier. This codebase's actual doctrine (TE-2B, `detail-sections.ts:71–85`) is a single honest boolean, `needsClassification`, silent when the system is confident and a specific plain-English sentence when it isn't ("Fourth Meridian can see that money came in, but it can't yet identify the source.") — with an explicit, documented refusal to ever show raw confidence numbers, reason codes, provider strings, or ontology terms to users. A raw four-tier badge would be a step backward from the honesty bar this app already holds itself to. The right move is to expose the *existing* boolean as a "Needs review" filter, not invent a tier system.

**The vision splits into four buckets, same shape as Accounts/Activity:**
1. **Real and cheap** — Flow Type filter, Group By, Source filter, Merchant filter, Needs-review filter, Duplicate flag, transfer-pair surfacing. All backed by fields/resolvers that already compute correctly; the gap is UI-only.
2. **Real but genuinely bigger** — per-row Explain (needs new honest-language sentence generation beyond the one `needsClassification` case), Coverage (a new read-time aggregation, same shape as the Accounts-tab Coverage finding), Compare (diffing two periods' transaction sets).
3. **Should not build yet** — Natural Language Search (a real NLU/parsing subsystem, not a filter wiring task — meaningfully different engineering, no existing scaffold), Saved Views (needs new persistence — no `SavedView`-shaped model exists), Bulk Actions beyond what already exists.
4. **Genuinely missing** — refundCandidate resolution (deliberately deferred, needs a ratified heuristic — do not build ad hoc), recurring/subscription detection (grep-verified: no recurrence concept anywhere in `lib/transactions/`), a Location dimension (correctly, the vision does not ask for this — confirmed no location fields exist on `Transaction` at all, so "Location" can only ever be a text-search/merchant heuristic, never a real filter — worth stating explicitly since the vision's "pivoting views, not a Location table" instinct is validated by the schema).

---

## 2. Current state (verified)

- **Component:** `components/dashboard/widgets/SpaceTransactionsPanel.tsx` (449 lines) — real filters today: text search, category, account, date range (`all/90d/30d/7d`), pending/cleared. Uses `isCostFlow`/`isRefund`/`isIncome` from `lib/transactions/flow-predicates.ts` **internally** for summary totals (Spend/Refund/Income chips) — FlowType membership logic already centralized, just never exposed as a user-facing filter axis.
- **Detail drawer:** `components/transactions/TransactionDetailContent.tsx` renders `buildTransactionDetailSections()` (`lib/transactions/detail-sections.ts`) — a pure, tested, ordered-section builder. Confirmed sections, in render order: `Summary`, `Needs classification` (TE-2B, conditional), `Account`, `Transaction Intelligence` (payment channel/method, settlement, authorized/posted, counterparty, FX), `Relationship Intelligence` (pendingPosted + duplicate notes — see correction above), `Provenance` (source: Plaid/Import/Manual, plus import batch/filename/date when relevant), `Reporting` (currency conversion, when applicable).
- **`TransactionDetail` DTO** (`types/index.ts:274–305`) — extends `Transaction` with `account`, `provenance`, `counterparty`, `reporting`, `relationships: TransactionRelationships`. Computed server-side in `getTransactionDetail()` (`lib/data/transactions.ts`), one row at a time, on drawer open — **not** currently computed for the list (i.e., relationship/provenance facts exist per-transaction only when a user opens that specific row).
- **`FlowType` enum** (`prisma/schema.prisma`) — `SPENDING, INCOME, REFUND, DEBT_PAYMENT, TRANSFER, INVESTMENT, FEE, INTEREST, ADJUSTMENT, UNKNOWN`. Already populated on every classified `Transaction` row (`flowType`, `flowDirection`, `classificationConfidence`, `classificationReason`, `classifierVersion` — the confidence/reason fields exist in the schema but are deliberately never surfaced raw, per TE-2B).
- **Merchant intelligence:** `lib/transactions/merchant-merge.ts`, `merchant-corrections.ts`, `merchant-rules.ts`, `merchant-backfill.ts` — a real subsystem (`merchantId`, `merchantDisplayName`, `categorySource` fields exist on `Transaction`/`TransactionDetail`). `SpaceTransactionsPanel.tsx` today only reaches merchant via free-text search, not a dedicated filter/group axis.
- **No location fields exist anywhere on `Transaction`** (schema-verified) — confirms the vision's own instinct that "Location" can only be a grouping/search concept layered on merchant text, never a stored dimension.
- **No recurring/subscription detection** (grep-verified across `lib/transactions/`) — genuinely absent, not hidden.
- **No `SavedView`-shaped persistence model** (schema-verified) — Saved Views would be new schema, not a read-time feature.

---

## 3. Bucket 1 — real and cheap (verified data, no new schema, UI-only or thin-route work)

| Vision item | Real source | Note |
|---|---|---|
| Flow Type filter | `Transaction.flowType` + `lib/transactions/flow-predicates.ts` (`COST_FLOWS`, `isIncome`, `isRefund`, `isTransfer`, `isDebtPayment`, `isInvestmentFlow`) | Already the single authority used internally for totals; just needs a filter control + a `FLOW_TYPE_LABEL` humanized-label map (none exists yet — small, new, pure). |
| Group By (Flow Type / Merchant / Account / Category) | Same fields, client-side grouping over the already-fetched list | No new query — a pure client-side reduce, same shape as the existing category grouping in Cash Flow. |
| Source filter (Plaid / Import / Manual) | `provenance.source` — **already fully computed** in `getTransactionDetail()`, just per-row/drawer-only today | Needs to move from a per-row detail computation to a list-level field (see §4 — the one real "new work" item in this bucket). |
| Needs-review filter | `Transaction.classificationConfidence`/`classificationReason` are already reduced server-side into a boolean-ready shape (TE-2B's `needsClassification`/`needsClassificationReason`) | Reuse the existing derivation, do not invent a new tier system. |
| Duplicate flag | `RelationshipResolver.resolveDuplicate()` — real, deterministic, already wired at the detail layer | Same "move from per-row to list-level" work as Source. |
| Transfer disposition filter/badge (list level) | `transferDisposition` — already computed for every list row via `getTransactions()` → `contextFields()` (CF-1), batched, no N+1 | Free — already on the data the panel already fetches. |
| Transfer-pair detail (drawer level) | `RelationshipResolver`'s `transferCandidate` — real, resolved, KD-15 visibility-gated, **computed today and simply not rendered anywhere** (stale doc comment in `detail-sections.ts`) | Cheapest single-file win in the investigation: render what's already being computed in the drawer. |
| Merchant filter | `merchantId`/`merchantDisplayName` already on `Transaction` | A dropdown/typeahead over distinct merchants already in the fetched set — no new backend. |
| Perspective toggle (List / By Category / By Merchant) | Pure client-side view-mode switch over one fetched list | Matches the vision's own "pivot, don't refetch" framing exactly. |

---

## 4. Correction found mid-investigation: most of this is already batched at list level

I initially assumed `needsClassification`/transfer facts were only computed per-row in `getTransactionDetail()` and would need new batching work to reach the list. **That's wrong for two of the three signals — verified directly in `lib/data/transactions.ts`'s actual list source, `getTransactions()`:**

- **`needsClassification` is already on every list row today.** `getTransactions()` calls `contextFields()` (`:150–176`) → `deriveTransactionContext()` (`lib/transactions/transaction-context.ts`, CF-1) for every row in the result set — already flowing into `SpaceTransactionsPanel.tsx`'s `transactions` prop right now, just not exposed as a filter.
- **Transfer disposition is already batched at list level too, and it's richer than the detail drawer's `transferCandidate`.** `getTransactions()` calls `resolveOwnedTransferCounterparties(rows, {spaceId})` (`:135`) **once for the whole list**, then derives a canonical `transferDisposition` (internal-vs-external, owned-counterparty-aware) per row from already-persisted transfer-evidence columns — no N+1, no per-row candidate query. This is a different, already-batched, already-shipped mechanism from the single-row `RelationshipResolver.transferCandidate` used in the detail drawer (CF-1 vs. TI4/TI5-2 — two real, distinct, both-already-built mechanisms for the same underlying idea, one list-scoped, one row-scoped).
- **`provenance.source`** (Plaid/Import/Manual): cheap — `importBatchId`/`plaidTransactionId`/`externalTransactionId` are flat columns already present on the base `Transaction` row `getTransactions()` returns; deriving `source` from them is a pure function, no new query.
- **`duplicate` is the one signal genuinely still per-row-only.** `RelationshipResolver.resolveDuplicate()` runs inside `getTransactionDetail()`'s bounded ±7-day same-account candidate query (`lib/data/transactions.ts:404–429`), not inside `getTransactions()`. Naively repeating that per row for a 200-row list is 200 queries. Recommend deferring a list-level duplicate flag to Phase 2 (batch one candidate query per account/window, resolve all rows against the shared set) rather than rushing it — this is the only piece of Bucket 1 that isn't already free.

---

## 5. Bucket 2 — real but genuinely bigger

- **Explain (per-row).** The existing `needsClassification` disclosure (TE-2B) is the right pattern to extend, but it currently only covers the *unclassified* case. Extending "Explain" to classified rows means generating an honest, non-technical sentence from `classificationReason`/`categorySource` for the common case too (e.g., "Categorized as Spending because it matched merchant rule X") — new sentence-generation logic following the established doctrine (no raw reason codes, no ontology terms), not a data problem. Real, valuable, deserves its own slice and its own copy review — the same bar TE-2B was clearly held to.
- **Coverage.** Same finding as the Accounts Tab investigation's Bucket 2/§7: a real, computable read-time aggregation (min/max transaction date per account, `MIN(date)`/`MAX(date)` over `Transaction`), not a relocation. Should be scoped once, shared between Accounts and Transactions rather than built twice — worth flagging as a candidate for a single shared `lib/data/coverage.ts` rather than two bespoke aggregations.
- **Compare (period vs. period).** Diffing two transaction sets (e.g., this month vs. last) — real and buildable from the existing FlowType/category grouping, but is its own read shape (two queries + a diff), not a filter. Worth a dedicated slice.

---

## 6. Bucket 3 — should not build yet

- **Natural Language Search.** A genuinely different kind of engineering — parsing free text into structured filters ("coffee over $20 last month") needs either a real NLU layer or a constrained grammar parser; no scaffold for this exists anywhere in the codebase today (confirmed: no NLU/parsing library, no existing query-parsing precedent in `lib/transactions/`). Not a UI wiring task — do not scope this alongside Phase 1.
- **Saved Views.** Needs new persistence (no `SavedView`-shaped model exists in `prisma/schema.prisma`) — a real, additive migration, categorically different work from a presentation redesign, same reasoning as the Accounts Tab's "Space participation" schema bucket. Defer until there's a concrete need driving the shape (per-user? per-Space? shared?) rather than guessing at a schema.
- **Bulk Actions beyond what exists.** No investigation was done into what (if any) bulk action infrastructure exists elsewhere in the dashboard to reuse — flagging as unscoped rather than claiming buildability either way. Should not ride along with Phase 1.

---

## 7. Bucket 4 — genuinely missing

- **refundCandidate resolution.** Deliberately unbuilt in `RelationshipResolver.ts` today, reserved `null`, with an explicit comment that it needs a "ratified fuzzy heuristic" before it's safe to ship — correctly conservative given this app's honesty doctrine (guessing wrong here is worse than staying silent). Not a Phase 1 or Phase 2 item; a future decision, not an oversight.
- **Recurring/subscription detection.** Confirmed absent by grep across `lib/transactions/` — no concept of recurrence anywhere. A real, separate feature (pattern detection over historical rows), not something any existing module partially covers.
- **Location as a real dimension.** Confirmed no location fields exist on `Transaction` — validates the vision's own explicit choice not to ask for a Location table. If "Location" ever becomes real, it would need new schema (new columns from a richer Plaid location payload, currently not persisted) — out of scope here and correctly so.

---

## 8. Recommended sequencing

1. **Phase 1 — pivot the existing ledger, zero new batched-query design work.** Flow Type filter + Group By + Perspective toggle + Merchant filter + Source filter + Needs-review filter + transfer-disposition filter/badge, all backed by data `getTransactions()` **already computes for every row today** (`needsClassification`, `transferDisposition`) or a cheap pure derivation (`source` from existing flat columns). Also: fix the stale `detail-sections.ts` comment and render `transferCandidate` in the drawer (separately-computed, single-row-scoped, also already real — the cheapest single-file win here). List-level duplicate badge deferred to Phase 2 (the one signal that's genuinely still per-row-only).
2. **Phase 2 — Explain (extended), Coverage, batched duplicate at list level.** Each is real but needs its own design pass — sentence-generation copy review for Explain, a shared aggregation for Coverage (ideally shared with the Accounts Tab), and a batched-candidate-query variant of `RelationshipResolver.resolveDuplicate()` for a list-level duplicate flag.
3. **Phase 3 / defer — Compare.** Real, buildable, but a distinct read shape; sequence after Phase 1 ships and it's clear which comparison shape (period-over-period? category-over-category?) members actually want.
4. **Not now — Natural Language Search, Saved Views, refundCandidate, recurring detection, Location.** Each named explicitly rather than silently dropped, with the specific reason it's out of scope (new engineering discipline, new schema, deliberately deferred heuristic, confirmed absent, confirmed not a real dimension, respectively).

---

## 9. Open questions for a product decision before an implementation plan is written

1. Phase 1 defers only the list-level *duplicate* badge to Phase 2 (§4) — transfer disposition ships in Phase 1 since it's already computed for the whole list today. Confirm that split is acceptable, or if duplicate is important enough to pull forward despite the added batched-query design work.
2. Group By — confirm the exact initial axis set (Flow Type / Merchant / Account / Category proposed) before implementation, so the client-side reduce logic is scoped once, not iterated.
3. Coverage (§5) is flagged as shareable with the Accounts Tab's own Coverage bucket (still Phase 2/deferred there too) — worth deciding whether these ship together as one shared aggregation, or independently whenever each tab's Phase 2 lands.
