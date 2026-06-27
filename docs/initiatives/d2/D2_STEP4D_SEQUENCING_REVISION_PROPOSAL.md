# D2 Step 4D Sequencing Revision — Mapping Before QuickBooks (Proposal)

Architecture review only. No code, schema, or migration changes. **`D2_ROADMAP.md` itself has not been edited** — this is a proposal to react to, not yet applied. If approved, the actual roadmap-doc edit is a separate, trivial follow-up.

## Verdict

Agree with the resequencing. Building `ImportMappingProfile` before QuickBooks is architecturally cleaner than the original 4D-1→4D-4 order, for reasons stronger than "QuickBooks can reuse it" — the two features sit on different pipeline stages, and the original order simply predates the mapping-layer idea (the 4D pipeline investigation's four-way split was written before column-mapping existed as a concept; QuickBooks was slotted last by default, not by a reasoned dependency).

## 1. Is there a technical reason QuickBooks should come before Import Mapping Profiles?

No. They sit on different pipeline stages. Per the original 4D pipeline investigation (`D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §6), QuickBooks's real differentiator isn't column shape — it's the **Match/Classify stage**: a durable `TxnID`/API `Id` (genuinely stable across re-exports, unlike Plaid's `transaction_id`), and **update-on-match** behavior (QuickBooks transactions get edited/voided/reclassified in place, so a re-import of the same period should update existing rows — the one source where that's correct, vs. CSV/Excel's no-op-on-match). That fork lives entirely downstream of header resolution and doesn't depend on how columns got mapped. Nothing about implementing it requires the mapping layer to exist first, and nothing about the mapping layer requires QuickBooks's match-stage fork to exist first. They're parallel, not sequential — so ordering between them should be decided on simplicity grounds (§2), not a technical dependency, and simplicity favors mapping first.

## 2. Would QuickBooks become simpler if it targeted the finished mapping contract instead of today's fixed aliases?

Yes, meaningfully. "QuickBooks file export" isn't one column shape — QuickBooks Desktop and QuickBooks Online produce different export layouts, and even within Online, different report types ("Banking > Download Transactions" vs. a Transaction List report) name columns differently. Building QuickBooks against `detectColumns()`'s fixed-alias pattern the way Excel did would mean hardcoding not one new alias list but several, with no guarantee the next QuickBooks report type a user tries won't need a fourth. That's exactly the shape of problem the mapping layer exists to solve once instead of every time a new header variant shows up. With the mapping layer in place, QuickBooks's implementation only has to handle the two things that are actually specific to it — the structural parse (see §3) and the update-on-match fork (§1) — and can lean on the generic fallback for header resolution rather than growing `HEADER_ALIASES` indefinitely.

## 3. Should the mapping layer become the canonical entry point for every file import (CSV, Excel, QuickBooks, future OFX/QIF)?

**For tabular, ambiguous-header formats, yes. For self-describing structured formats, no — with a QuickBooks-specific wrinkle worth flagging now.**

CSV, Excel, and QuickBooks's flat CSV/Excel-style exports all share the same problem: a human-readable header row whose exact wording varies by source, which is what column mapping resolves. OFX and QIF are a different kind of format entirely — OFX is tagged/structured (`<DTPOSTED>`, `<TRNAMT>`, `<NAME>`, `<FITID>` are unambiguous by spec, no header-guessing involved), and QIF is line-prefix-tagged (`D`/`T`/`P`/`M` per line) rather than columnar at all. Neither has an "ambiguous header" problem to map — they need their own structural parsers that emit directly into the same `NormalizedRow` contract, bypassing column mapping entirely because there's nothing to resolve.

The QuickBooks-specific wrinkle: QuickBooks's *native* interchange format, IIF, is also structured/record-based (`!TRNS`/`TRNS`/`!SPL`/`SPL`/`ENDTRNS` lines), not a flat header-and-rows file. If "QuickBooks file import" is ever asked to cover IIF as well as a CSV-style export, that's two structurally different parsers under one feature name, only one of which the mapping layer helps with. Recommend confirming, before 4D-4's own checklist is written, that 4D-4 targets QuickBooks's flat/CSV-shaped export only (which the existing pipeline investigation already leaned toward by scoping QuickBooks to file-export rather than live API sync) — IIF, if ever wanted, is its own structural-parser slice, unrelated to the mapping layer.

So: the `NormalizedRow` contract is canonical for every format. The mapping layer specifically is canonical only for the subset with ambiguous, human-authored headers — CSV, Excel, QuickBooks's tabular exports, and presumably most future bank-style sources. Structured formats target the same contract through their own parser, not through the mapping layer.

## 4. Should `detectColumns()` remain only the fast-path auto-detector, with the mapping layer as fallback?

Yes — unchanged from the Part B recommendation, and QuickBooks reinforces it rather than complicating it. `detectColumns()`'s curated alias list stays exactly as-is (no widening), stays fast, and stays the zero-friction path for the formats it already recognizes. If a QuickBooks export shape turns out to be extremely common, promoting it into `HEADER_ALIASES` later is a fine, cheap optimization — but it's optional, not a precondition, because the mapping-layer fallback already covers it on day one. This is also lower-risk: it means 4D-4 never needs to touch `lib/imports/csv.ts`'s alias table at all, keeping that file's blast radius exactly where it's been kept through every prior 4D slice.

## 5. Is `NormalizedRow` already sufficient, or should it evolve before 4D-5?

Its **required** shape is sufficient and already proven across two source formats (CSV, Excel share it unmodified). Its **optional** surface should evolve, and 4D-5 is the right slice to do it in — once, rather than twice. Concretely, add (all additive, all optional, no existing field touched): `transactionType` (distinct from amount sign — useful for sources, including QuickBooks's "Type" column, that label DEBIT/CREDIT/CHECK/etc. explicitly), `balanceAfter` (some exports carry a running balance; capture rather than discard it), `currency` (captured, never converted), and a `rawMetadata`/memo bucket for mapped-but-unclassified columns. Note `externalTransactionId` already exists and is exactly the right field for QuickBooks's `TxnID` — no change needed there. QuickBooks's bank-reconciliation status has no analog in this schema and was already flagged in the original pipeline investigation as a known, deliberately-ignored gap, not something this evolution needs to address.

## 6. Is Space-scoped + header-signature still right, with QuickBooks as the next consumer?

Yes — and QuickBooks makes the case stronger, not weaker. Institution-scoping (one of the options considered and rejected in Part B) would be actively incoherent for QuickBooks: QuickBooks is accounting software, not a financial institution, so a profile keyed on `institutionId`/`institution` has no sensible value to key on for a QuickBooks-sourced file. Header-signature doesn't care what kind of source produced the file — "QuickBooks Online banking export" and "QuickBooks Desktop transaction list" just become two different signatures, handled identically to two different banks' CSV shapes, with no special-casing. One refinement worth adding now that QuickBooks is concretely in view: store `source: ImportSource` on the profile as informational/display metadata (same non-key role as the optional institution label from Part B) so a profile list can show "QuickBooks" as a friendly tag — without making source part of the actual lookup key.

## 7. Does this change Step 5, or shrink it?

**Shrinks it.** Step 5's own roadmap text already commits to "a shared normalized transaction format that every adapter maps into." If 4D-5 designs and proves that contract first — across three file-based sources (CSV, Excel, QuickBooks) before Step 5 even starts — then Step 5's import-adapter half is largely already done by the time Step 5 begins. Step 5's remaining work becomes: formalize an interface boundary around a pattern that's already working in production, and extend the same normalized-row idea to sync adapters (Plaid-shaped, pull/cursor-based) and wallet adapters — a different mechanical problem (polling vs. file upload) but targeting a contract that's already been validated three times over rather than a contract Step 5 has to invent and prove from zero. This is a genuine scope reduction for Step 5, not just a relabeling.

## Tradeoffs

The one real cost: QuickBooks support ships later in wall-clock time than it would if 4D-4 were done next using the "hardcode one more alias list" shortcut Excel used. That shortcut was reasonable for Excel because Excel needed exactly one shared `detectColumns()` reuse, no format proliferation. It's weaker for QuickBooks specifically, because QuickBooks's export-shape heterogeneity (§2) means "hardcode the aliases" is unlikely to be a one-shot fix the way it was for Excel — making the "ship fast now, refactor later" case weaker here than it was for the precedent it would be copying. If there's external pressure to ship QuickBooks import on a specific date, that pressure is the only thing that should reopen this sequencing call — not architecture.

## Proposed roadmap (not yet applied to `D2_ROADMAP.md`)

| Sub-step | What | Status |
|---|---|---|
| 4D-1 | CSV Import MVP | ✅ |
| 4D-2 | Excel Import | ✅ |
| 4D-R | `deletedAt` read-path audit + fix | ✅ |
| 4D-3 | Rollback | ✅ |
| **4D-5** | **Import Mapping Profiles** — `ImportMappingProfile` (Space-scoped, header-signature-keyed, additive), `NormalizedRow` contract extension (§5), `detectColumns()` kept as unmodified fast path with the profile as fallback, sequenced in small approved sub-slices (caller-supplied mapping → schema → persistence/reuse → fuzzy-detect/preview, per the Part B recommendation). | ⏳ Proposed next |
| 4D-4 | QuickBooks file import (flat/CSV-shaped exports only — IIF explicitly out of scope per §3) — targets the finished mapping contract; implementation-specific work narrows to the update-on-match fork (§1) and the structural parse. | ⏳ After 4D-5 |
| Step 5 | Adapter Interface — formalizes the now-proven normalized contract into a real interface boundary; extends it to sync/wallet adapters. Smaller than originally scoped (§7). | ⏳ Unchanged position, smaller scope |

**Note (not part of this proposal, flagged for whenever the roadmap doc is next touched):** the live `D2_ROADMAP.md` currently bundles Excel, rollback, and the read-path audit under a single "4D (remainder) — ⏳ Not started" row, even though all three have since shipped (4D-2, 4D-R, 4D-3 are each their own completed, individually-validated slices). That row is stale independent of this sequencing question and will need correcting whenever the roadmap doc itself is next edited.

---

**Stopping here per your instruction — no code, schema, or roadmap-doc changes made. This is a proposal awaiting your approval before either the resequencing or the roadmap-doc correction noted above is applied.**
