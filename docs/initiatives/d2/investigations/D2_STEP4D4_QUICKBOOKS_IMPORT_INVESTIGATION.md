> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-4 — QuickBooks Transaction History Import (Investigation)

Investigation only. No code, schema, or migration changes. Builds on completed
D2 Step 4D-5 (4D-5a explicit mapping, 4D-5b `ImportMappingProfile` +
`resolveColumns()`, 4D-5c-1 pipeline extraction, 4D-5c-2 preview endpoint,
4D-5c-3 suggestions) — none of those decisions are revisited here. Also builds
on the original `D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §6 ("QuickBooks
compatibility") and `D2_STEP4D_SEQUENCING_REVISION_PROPOSAL.md`, both of which
already analyzed QuickBooks ahead of implementation — this report confirms
those findings still hold against the pipeline as it actually exists today,
rather than re-deriving them from scratch.

Architectural constraints treated as already decided, per instruction:
QuickBooks is a transaction-history import rail, not a live connection
method; CSV/Excel remain the historical import mechanisms; live institution
connections and provider-adapter work are out of scope here; no UI; no schema
changes unless proven required; no IIF unless proven required.

---

## 1. Which QuickBooks export format should 4D-4 support?

**Flat, tabular exports only** — whatever a user downloads from QuickBooks
Online ("Banking → Download Transactions" or a Transaction List report) or
QuickBooks Desktop, saved as `.csv` or `.xlsx`. No new file format needs to be
introduced; this is the same two shapes `runImportPipeline()` already
sniffs (`detectExcelFormat()` in `lib/imports/pipeline.ts`).

**IIF is explicitly out of scope, and nothing in this investigation finds a
reason to revisit that.** IIF (`!TRNS`/`TRNS`/`!SPL`/`SPL`/`ENDTRNS`) is a
line-prefix-tagged, record-based interchange format, not a header-and-rows
file — it has no "ambiguous header" problem for the mapping layer to solve,
and would need its own structural parser feeding directly into
`NormalizedTransaction`, bypassing `resolveColumns()`/`detectColumns()`
entirely. That's a different feature, not a smaller version of this one. No
evidence anywhere in the codebase, schema, or roadmap calls for it. Per the
"no IIF unless investigation proves it is required" constraint: not proven,
stays out.

**Live QuickBooks Online API/OAuth sync is out of scope** — confirmed by both
the original pipeline investigation (§6: "scope 4D's QuickBooks to the
file-export case only") and the task's own constraints. `ImportBatch
.connectionId`'s nullable FK seam (added in 4B) already anticipates this fork
without committing to it.

One labeling note, not a blocker: the task's constraints describe live
institution connections as belonging to "the future Provider Catalog (D4)."
In this repo's own numbering, Provider Catalog work is tracked as D6/D7, and
the live-sync-adapter generalization is D2's own Step 5/Step 6 — D4 (per the
Phase 2 decision list) is the AI Context Builder, a different decision. This
doesn't change anything concluded here (live QuickBooks sync is deferred
either way) but is worth a heads-up in case "D4" was shorthand rather than a
deliberate re-numbering.

## 2. Pipeline reuse

| Component | Reusable as-is for QuickBooks? | Notes |
|---|---|---|
| `runImportPipeline()` | **Yes, unmodified.** | Format-sniffing, parse, `resolveColumns()`, and normalize are already format-agnostic. A QuickBooks `.csv`/`.xlsx` flows through the exact same CSV or Excel branch any other source would. |
| `NormalizedTransaction` | **Yes, unmodified.** | Already carries `externalTransactionId` — exactly the field QuickBooks's durable `TxnID` needs (confirmed by the sequencing-revision report §5: "no change needed there"). The optional contract extensions proposed twice (`transactionType`/`balanceAfter`/`currency`/`rawMetadata`, Part B §5 and sequencing-revision §5) were never built — `lib/imports/csv.ts`'s `NormalizedTransaction` is still the same 8 fields today. |
| Mapping profiles (`ImportMappingProfile` / `resolveColumns()`) | **Yes, unmodified.** | `resolveColumns()` doesn't know or care what produced the headers — explicitMapping → `detectColumns()` → saved profiles, in that order. `ImportMappingProfile.source: ImportSource` already includes `QUICKBOOKS` (schema, currently unused) — a saved profile can already be informationally tagged "QuickBooks" with zero schema change. |
| Preview | **Yes, unmodified, with one caveat.** | The preview route is pure pipeline + classification, source-agnostic. Caveat: preview's `MATCH` classification has no concept of "would update" vs. "would no-op" — fine today (everything no-ops on MATCH), but would need attention if update-on-match (§3) ever ships, so preview doesn't mis-describe what confirm will actually do. |
| Rollback | **Yes, unmodified, with one named limitation.** | Rollback soft-deletes by `importBatchId` only, never by source — confirmed in `app/api/imports/[id]/rollback/route.ts`. It undoes anything a QuickBooks batch *created*. It does **not** undo an update-on-match field overwrite on a previously-existing row, because only `CREATE` rows ever get `importBatchId` set (by design, per the confirm route's own comment). This is a real, pre-existing-and-named gap (original investigation §3) that becomes live the moment update-on-match ships — not a 4D-4 blocker by itself, but should be called out explicitly in whichever checklist implements update-on-match. |
| Fingerprinting | **Yes, unmodified.** | `resolveFingerprintOutcome()` already checks `externalTransactionId` exact match first, then falls back to `findByFingerprint()`. QuickBooks's `TxnID` flows into `externalTransactionId` via the same "reference" column resolution every other source uses. |
| `ImportBatch` | **Yes, unmodified.** | `ImportSource.QUICKBOOKS` already exists in the schema enum (added at 4B, unused until now). `matchedCount`/`failedCount`/`resolvedColumnMapping`/`mappingProfileId` are all already source-agnostic. |

## 3. What is actually QuickBooks-specific?

Two things, and only two:

**1. Source labeling.** `runImportPipeline()` derives `ImportSource` purely
from file shape today — `ImportSource.CSV` or `ImportSource.EXCEL`, never
`QUICKBOOKS` (`lib/imports/pipeline.ts` lines 126 and 155). Nothing currently
tells the pipeline "this upload is a QuickBooks export." For an
`ImportBatch.source` to ever read `QUICKBOOKS`, something has to say so —
cheapest option is a caller-supplied hint (a form field, the same pattern
`signConvention` already uses), not content-sniffing. This is a small,
real, QuickBooks-specific decision, but it's a labeling change, not a
pipeline change.

**2. The update-on-match fork.** The one piece of genuinely new logic. Per
the original investigation §6 (not re-litigated, never implemented):
QuickBooks transactions can be edited/voided/reclassified after the fact, and
a re-export of the same period should propagate that edit to the matched row
— unlike CSV/Excel, where a re-upload is far more likely to be an accidental
duplicate than an intentional edit. Today's confirm route has exactly one
universal rule at the classify/write stage (`route.ts` lines 290–310):
`CREATE` writes, `MATCH`/`SKIP` never write. Implementing update-on-match
means a per-`ImportSource` branch at that exact point — when
`result.outcome === "MATCH"` and `source === QUICKBOOKS`, update the existing
`Transaction`'s fields instead of no-op. Everything upstream of this point
(parse, resolve, normalize, fingerprint-match) is unaffected.

Everything else — structural parsing, header resolution, dedupe — is shared,
unmodified infrastructure.

## 4. Is any normalization work missing?

No new normalization mechanism appears necessary. Two open questions, neither
blocking, both needing a real sample export to close:

- **A "Type" column.** QuickBooks reports commonly include a transaction-type
  label (Check/Deposit/Transfer/Invoice/etc.) that isn't a category in this
  schema's sense. Today's `mapCategory()`/`CATEGORY_ALIASES` would
  substring-match it where possible (e.g. "transfer" → `Transfer`) and fall
  back to `Other` otherwise — acceptable Day-1 behavior, consistent with the
  existing "an unmapped category should never block an import" philosophy.
  A true `transactionType` field would model this better but isn't required.
- **Sign convention.** No universal rule exists for any source — QuickBooks
  is no different. The existing `creditPositive`/`debitPositive` toggle
  already covers this without new code, assuming a single signed Amount
  column or a Debit/Credit pair, which needs confirming against a real
  export rather than assumed here.

## 5. Does QuickBooks require new fingerprint logic?

No. `externalTransactionId` exact-match-first, `findByFingerprint()`
fallback — unchanged. QuickBooks's `TxnID` is a better fit for the exact-match
path than almost anything else this pipeline has seen (more durable than
Plaid's `transaction_id`, present where plain bank CSVs often have nothing),
but that's a data-quality improvement, not a logic change.

## 6. Does it require new transaction fields?

No. Confirms the original investigation's §7 schema-impact assessment still
holds: zero new `Transaction` columns, as long as the existing behavioral rule
(`importBatchId` set only on `CREATE`, never on `MATCH`) is kept — and it has
been, unchanged, through every slice since 4B. The proposed
`transactionType`/`balanceAfter`/`currency`/`rawMetadata` extensions remain
optional and undemonstrated as required; nothing surfaced here changes that.

## 7. Does it require account-balance support?

No. A transaction-history import only ever creates/matches `Transaction`
rows; nothing in the existing pipeline (CSV, Excel, or the shared write loop)
touches `FinancialAccount.balance`, and rollback's own doc comment already
establishes the precedent that import/rollback never touches balance or
triggers `SpaceSnapshot` regeneration. No evidence this needs to change for
QuickBooks.

## 8. Does it require chart-of-accounts support?

No. Nothing in `prisma/schema.prisma` models a chart-of-accounts concept
today, and a transaction-history import doesn't need one — each row lands in
one user-selected `FinancialAccount` and gets one `TransactionCategory`, the
same as CSV/Excel. Treating QuickBooks as a transaction-history rail rather
than an accounting-ledger integration (per the standing architectural
constraint) is exactly what keeps chart-of-accounts modeling out of scope.

## 9. Smallest implementation that fits the current D2 architecture

Given §2–§8, almost the entire surface area is "reuse, unmodified." The real
work reduces to the two items in §3, and they're separable:

- **If update-on-match is deferred to its own follow-on slice** (QuickBooks
  ships Day 1 with the same no-op-on-match behavior CSV/Excel already use,
  accepting that re-importing an edited QuickBooks period won't propagate the
  edit yet), then 4D-4's Day-1 slice shrinks to just **source labeling** — a
  caller-supplied "this is a QuickBooks export" hint so `ImportBatch.source`
  reads `QUICKBOOKS` instead of being inferred as `CSV`/`EXCEL`. No pipeline
  change, no new branch in the write loop, no schema change. This would be
  smaller than every prior 4D-* slice.
- **If update-on-match ships as part of 4D-4 itself**, the slice additionally
  needs the per-source branch described in §3.2, plus an explicit decision on
  what "update" means field-by-field (full overwrite of date/merchant
  /description/category/amount/pending? a subset?) and an explicit
  acknowledgment of the rollback limitation in §2's rollback row.

Either way: **no schema changes are required.** `ImportSource.QUICKBOOKS`
already exists; everything else reused is already source-agnostic. This
satisfies the "no schema changes unless absolutely required" constraint —
nothing in this investigation proves a requirement.

Recommend splitting these the same way 4D-5 was sub-split (5a/b/c-1/c-2/c-3)
rather than attempting both in one slice: source-labeling first (mirrors the
"smallest safe slice" precedent every prior D2 step has followed), then
update-on-match as its own separately-approved follow-on once the labeling
slice is validated.

## 10. Explicitly deferred (belongs in Step 5/6, D4, or elsewhere)

- **IIF support** — its own structural-parser slice, unrelated to the mapping
  layer or this pipeline. Not started, not proposed for 4D-4.
- **Live QuickBooks Online API/OAuth sync** — Step 5/6 (D2's own Adapter
  Interface / first-new-provider) or the project-level Provider Catalog work,
  not 4D-4. `ProviderType` still lacks `QUICKBOOKS`/`EXCEL` entries — a
  known, harmless, already-named gap (original investigation §6), not this
  slice's to fix.
- **Chart-of-accounts modeling** — out of scope per §8, nothing requests it.
- **Account-balance sync from QuickBooks** — out of scope per §7.
- **`NormalizedTransaction` contract extensions** (`transactionType`/
  `balanceAfter`/`currency`/`rawMetadata`) — proposed twice, never built, not
  proven required by this investigation. Stays deferred unless a real
  QuickBooks sample file demonstrates otherwise.
- **Reconciliation-status modeling** (QuickBooks's own bank-rec flag) — a
  named, deliberately-ignored gap since the original investigation §6,
  unchanged here.
- **A persisted `fingerprintHash` column, a `Transaction.source`
  discriminator enum, a row-level `ImportBatchRow` table** — all
  independently deferred by 4A/4C/the original 4D investigation; nothing
  here changes that.
- **Update-on-match**, if the Day-1 option in §9 is taken — deferred to its
  own follow-on slice, not dropped, just sequenced after source-labeling.

## 11. Open items requiring a real QuickBooks export sample

Cannot be closed by code-reading alone — flag for whoever writes the next
checklist:

- Actual header text QuickBooks Online/Desktop exports use for date, amount,
  description, and the transaction-id-equivalent column (does it land on
  `detectColumns()`'s existing aliases, or does every real-world QuickBooks
  export need a saved `ImportMappingProfile`/explicit mapping on first use?).
- Actual sign convention QuickBooks's export uses for deposits vs. payments.
- Whether QuickBooks Desktop exports have any encoding quirks (e.g. non-UTF8)
  that the current `file.text()`/Papa.parse path doesn't already handle.

## Before finishing: Step 4 roadmap vs. implemented work

**`D2_ROADMAP.md` (live document) is stale, in a way already self-diagnosed
by an earlier report.** Its Step 4 table still shows a single "4D
(remainder) — ⏳ Not started" row bundling Excel import, rollback, and the
read-path audit. All three have since shipped individually:
4D-2 (Excel) ✅, 4D-R (read-path audit) ✅, 4D-3 (rollback) ✅. This staleness
was already flagged by name in `D2_STEP4D_SEQUENCING_REVISION_PROPOSAL.md`'s
closing note and remains uncorrected as of this investigation — not a new
finding, just still outstanding.

**`D2_STEP4D_SEQUENCING_REVISION_PROPOSAL.md`'s own table is now also
stale**, in a new way this investigation surfaces: it lists "4D-5 — Import
Mapping Profiles — ⏳ Proposed next" as a single row, but the work actually
shipped as five separately-approved, separately-validated sub-slices —
4D-5a (explicit mapping), 4D-5b (`ImportMappingProfile` schema +
`resolveColumns()`), 4D-5c-1 (pipeline extraction), 4D-5c-2 (preview
endpoint), 4D-5c-3 (suggestions) — all five complete, per their own
validation reports. The proposal's sequencing call ("mapping before
QuickBooks") was followed, and "4D-4 — ⏳ After 4D-5" is correctly unblocked
now.

**Net accurate status for Step 4D, as of this investigation:**

| Sub-step | What | Status |
|---|---|---|
| 4D-1 | CSV import MVP | ✅ |
| 4D-2 | Excel import | ✅ |
| 4D-R | `deletedAt` read-path audit + fix | ✅ |
| 4D-3 | Rollback | ✅ |
| 4D-5a | Explicit column mapping | ✅ |
| 4D-5b | `ImportMappingProfile` schema + `resolveColumns()` | ✅ |
| 4D-5c-1 | Pipeline extraction (`runImportPipeline()`) | ✅ |
| 4D-5c-2 | Preview endpoint | ✅ |
| 4D-5c-3 | Suggestions | ✅ |
| 4D-4 | QuickBooks file import | ⏳ Not started (this investigation) |

**No remaining Step 4 deliverable is being forgotten.** The only two things
left before Step 4 can be considered closed are 4D-4 itself (this
investigation's subject) and a text-only correction to `D2_ROADMAP.md`'s
stale "4D (remainder)" row — neither is a newly-discovered gap; both were
already named in prior reports. The roadmap *wording* is stale; the
underlying work it under-describes is real and already validated.

---

## Validation

| Check | Result |
|---|---|
| Code changes | None |
| Schema changes | None |
| Migrations | None |
| Files read for this investigation | `D2_ROADMAP.md`, `D2_STEP4_ROADMAP_REFINEMENT.md`, `D2_STEP4D_SEQUENCING_REVISION_PROPOSAL.md`, `D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md`, `D2_IMPORT_MAPPING_LAYER_ROADMAP_PLACEMENT.md`, `D2_STEP4D5C3_VALIDATION.md`, `lib/imports/pipeline.ts`, `lib/imports/csv.ts`, `lib/imports/excel.ts`, `lib/imports/suggest.ts`, `lib/transactions/fingerprint.ts`, `app/api/accounts/[id]/import/route.ts`, `app/api/accounts/[id]/import/preview/route.ts`, `app/api/imports/[id]/rollback/route.ts`, relevant `prisma/schema.prisma` sections |

---

**Stopping here per instruction — investigation only. No implementation. Awaiting direction on: (a) whether 4D-4's Day-1 slice should be source-labeling-only with update-on-match as its own follow-on, or both together; (b) a real QuickBooks export sample to close the open items in §11; (c) whether to correct `D2_ROADMAP.md`'s stale wording now or alongside 4D-4's own checklist.**
