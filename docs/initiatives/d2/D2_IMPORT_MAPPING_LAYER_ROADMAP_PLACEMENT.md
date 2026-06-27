# Import Converter / Mapping Layer — Roadmap Placement (Part B)

Analysis only. No code, schema, or migration changes. Answers the 10 questions raised alongside the Part A weird-header validation (`D2_STEP4D_WEIRD_HEADER_VALIDATION.md`). Nothing here is approved for implementation — it's a recommendation to react to.

## Grounding: what exists today

`detectColumns()` in `lib/imports/csv.ts` does exact-string-equality matching against a fixed `HEADER_ALIASES` table. `lib/imports/excel.ts` doesn't reimplement this — it imports and calls the same `detectColumns()` directly, then both formats converge on the identical `NormalizedRow` shape (`lineNumber`, `date`, `merchant`, `description`, `category`, `amount`, `externalTransactionId`, `error`). So there's already exactly one shared seam where header resolution happens, even though `csv.ts`'s own header comment says a "forced shared interface" was deliberately avoided — in practice, Excel ended up reusing `detectColumns()` anyway rather than duplicating it. That seam is where a mapping layer belongs.

## 1. New D2 Step 4D-5, or wait for D2 Step 5 Adapter Interface?

**New D2 Step 4D-5. Don't wait for Step 5.**

Step 5 ("Adapter Interface," per `D2_ROADMAP.md`) is explicitly cross-provider: sync adapters (Plaid-like), import adapters, wallet adapters, all mapping into one shared normalized format. It's `⏳ Planned, not started`, and Step 6's own text says picking a first real new provider happens "when Steps 4/5 are far enough along" — i.e., Step 5 doesn't have a concrete trigger yet and is partly gated on Step 4 maturity. Making column-mapping wait for Step 5 would block a concrete, present-day problem (real bank exports failing against fixed aliases) on an abstraction that has no start date.

This also matches precedent already set inside Step 4 itself: 4C extracted a shared fingerprint helper mid-Step-4 without waiting for Step 5's formal adapter interface. A mapping layer is the same move — solve the Step 4-scoped problem now, write its contract so Step 5 can adopt it later rather than redefine it.

## 2. Feature naming

Recommend splitting the name by what it names:

- **`ImportMappingProfile`** — the persisted thing (a schema model: one saved column mapping). Generic enough to survive Excel/QuickBooks/future sources without implying a UI.
- **"Import Column Mapper"** — the screen/UI where a user builds or edits a mapping. Describes the interaction, not the data.

Avoid **"Institution Import Profiles"** — ties the concept to `institution`, but manually-uploaded files often have no populated `institutionId` at all (see Q4). Avoid **"Source Adapter Mapper"** — "Adapter" already means something specific in this roadmap (Step 5's cross-provider interface); naming this after it invites scope confusion with a feature this explicitly is not.

## 3. Should it be schema-backed?

**Yes, but additive and optional everywhere it touches existing models.** The entire value of this feature is not re-mapping the same bank's export every month — an unpersisted, one-shot mapping defeats the purpose. Concretely: a new `ImportMappingProfile` table, plus a nullable `ImportBatch.mappingProfileId` FK. Nothing about today's fixed-alias `detectColumns()` path changes or becomes required — a profile is consulted only when the fixed aliases miss, never when they hit. This keeps `lib/imports/csv.ts`'s `HEADER_ALIASES` exactly as-is (per Part A's standing constraint) and treats the mapping layer as a fallback path alongside it, not a replacement.

## 4. Mapping scope

**Space-scoped, keyed by header signature — not by user, account, or institution alone.**

- Per-account is too narrow: the same bank produces the same export shape across every account a user holds there: re-mapping per account is pure friction.
- Per-user works for a single uploader but doesn't let a teammate in the same Space reuse a mapping someone else already built — and Space-based sharing is already the project's standing multi-tenancy model (`SpaceAccountLink`/`SpacePermissions`), so reusing it here is free.
- Per-institution is the intuitive scope but isn't reliable as a *lookup key*: `institutionId`/`institution` come from Plaid metadata and are frequently null on manually-uploaded files (cash accounts, accounts never Plaid-linked, etc.).
- The header signature (the file's normalized column headers, sorted and hashed) is available on every file regardless of provenance and is the actual thing that determines whether a saved mapping applies. It also generalizes across institutions that happen to share export tooling.

Recommend: `ImportMappingProfile` scoped to `spaceId`, with an optional `institutionLabel` field for human-readable organization in a list UI, and the real lookup key being the header-signature hash. A new upload checks "does this Space have a profile whose signature matches these headers?" before falling into manual mapping.

## 5. Minimum normalized transaction contract

The existing `NormalizedRow` (shared by both `csv.ts` and `excel.ts` today) already is most of this contract — extend it, don't replace it:

Required (already present): `date`, `amount`, `description` or `merchant` (one of the two, already enforced by `detectColumns()`).

Optional (already present): `category`, `externalTransactionId` (the "reference" alias group already feeds this).

Optional (not yet present, worth adding to the contract now even before they're populated by anything): a `transactionType` hint distinct from amount sign (useful for sources that label "DEBIT"/"CREDIT" explicitly rather than relying on sign or a debit/credit column pair — exactly the column the weird-header fixture used), `balanceAfter` (some bank exports include a running balance column — not used for anything today, but worth capturing rather than discarding), `currency` (captured, not converted — see Q10), and a `rawMetadata`/`memo` bucket for anything mapped-but-unclassified, so a mapping doesn't have to silently drop a column the user explicitly chose to map.

Recommend extending `NormalizedRow` itself (additive fields, all optional) rather than inventing a second, parallel contract — Excel already proves that one shared row type survives two source formats; a third format (QuickBooks) and a mapping layer should target the same one.

## 6. Auto-detect first, then confirm if low-confidence?

**Yes.** Order of resolution, every time:

1. Try `detectColumns()` (today's exact-alias match) — unchanged, zero friction, no aliases widened.
2. On miss, try the Space's saved `ImportMappingProfile`s by header signature — if one matches exactly, apply it silently (this Space has done this exact file shape before).
3. On miss, run a fuzzy suggestion pass (simple string-similarity against the same alias lists `detectColumns()` already uses — no ML, see Q10) to pre-fill a best-guess mapping per required field, and require the user to explicitly confirm it before anything is created. Confidence scoring should be a hint for what to pre-select in the UI, never a silent auto-apply threshold — sign and date-format mistakes here corrupt financial data, and the cost of one extra confirm click is much lower than the cost of a wrong silent guess.

## 7. Import preview screen?

**Yes, and pair it with the confirmation step above, not as a separate feature.** Render the first N rows exactly as they'd be normalized — typed date, signed amount, description — before any `ImportBatch`/`Transaction` write happens. This is the cheapest place to catch the two mistakes that matter most: a flipped sign convention, and an ambiguous date format (e.g. `01/06/2026`, which `parseDate()` must currently pick one interpretation of). Rollback (4D-3, already implemented) remains the safety net for whatever preview review misses or whenever a user skips it; preview is the cheaper first line of defense, not a replacement for rollback.

## 8. Interaction with CSV, Excel, QuickBooks, future provider adapters

- **CSV/Excel**: both already funnel through `detectColumns()` today. The mapping layer should sit at that exact seam — a new resolution function (e.g. `resolveColumns(headers, profile?)`) that `detectColumns()` becomes the first branch of, called identically from both `csv.ts`'s and `excel.ts`'s callers. No per-format duplication, matching how Excel already reuses CSV's detection rather than reimplementing it.
- **QuickBooks** (still not started, per the roadmap's "4D (remainder)" row): sequence the mapping contract (Q5) *before* QuickBooks parsing work begins, so QuickBooks is written once against the final `NormalizedRow` shape instead of being retrofitted later. QuickBooks exports are also exactly the kind of "weird headers" case this whole investigation is about, so it's a natural first real consumer of the mapping layer rather than a third bespoke parser.
- **Future provider (sync) adapters / Step 5**: Step 5's own roadmap language already promises "a shared normalized transaction format that every adapter maps into." This Step 4D-5 contract should be explicitly documented as a candidate Step 5 should adopt or generalize, not a competing definition — one normalized-transaction shape in the codebase, not two.

## 9. Smallest safe first slice

Smaller than a full 4D-5 sub-split: let one import request optionally accept a caller-supplied column mapping (no persistence, no auto-detect, no UI, no schema change) that the route uses instead of `detectColumns()`'s output when present, falling back to today's behavior when absent. This validates the core mechanism — "an explicit mapping unblocks a header shape the fixed aliases miss" — with zero schema or persistence commitment, before any `ImportMappingProfile` design decision (Q3/Q4) is locked in.

If that validates, the natural sequencing for the rest (each its own approved slice, same pattern as 4D-1→4D-3):

1. **4D-5a** — `ImportMappingProfile` schema only (additive table + nullable `ImportBatch.mappingProfileId`), nothing wired up. Mirrors 4B's "schema only" precedent.
2. **4D-5b** — Manual mapping wired into the route, profile saved on submit, looked up by header-signature on the next upload. No auto-detect, no preview yet.
3. **4D-5c** — Fuzzy auto-suggest (Q6) + preview screen (Q7) on top of the now-proven backend.

## 10. Explicitly out of scope

QuickBooks parsing itself (stays its own separately-approved slice). Step 5's cross-provider sync-adapter abstraction (Plaid/wallet/future-exchange normalization) — this stays import/file-upload scoped. Retroactively reinterpreting or auto-reimporting past batches when a new profile is saved (a saved profile only affects future uploads). Any ML/trained-classifier confidence scoring — plain string-similarity against the existing alias lists is enough, and the financial stakes argue for predictable, inspectable logic over a model. Currency conversion (the optional `currency` field is captured and stored, never converted). And, restating Part A's standing constraint going forward: no widening of `HEADER_ALIASES` itself — the mapping layer is additive alongside it, never a substitute that erodes the zero-config fast path's precision.

---

**No implementation follows from this document. Each numbered slice in §9 still needs its own short implementation checklist, submitted for approval, before any code is written — same standing rule as every other D2 step.**
