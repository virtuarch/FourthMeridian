# D2 Step 4 — Closure Review

Review only. No code, schema, or roadmap-doc edits. Written as a sign-off
decision: can Step 4 ("Import & History Foundation") be considered closed
before moving to D2 Step 2/3 and eventually Step 5? Scope is Step 4 itself —
not Step 5, not D2 Step 2/3, not "D4," not Provider Catalog, not UI, not
documentation polish.

---

## 1. Roadmap cleanup

**The literal string "4D-5" does not appear anywhere in `D2_ROADMAP.md`.**
The canonical roadmap's Step 4 table never advanced past the 4D-1 checkpoint,
so there is no "4D-5 wording" in it to correct — the staleness predates that
label. Two spots in the live roadmap are stale for the same underlying
reason (work they describe as not-started has since shipped):

| Location | Current text | Why stale |
|---|---|---|
| `D2_ROADMAP.md` L60 (Step 4 status line) | "4D-1 CSV import MVP implemented. Rest of 4D (Excel, QuickBooks, rollback, optional account-creation) not started, not approved." | Excel (4D-2), rollback (4D-3), the read-path audit (4D-R), the mapping layer (4D-5a/b/c-1/c-2/c-3), and QuickBooks (4D-4) have all shipped. Only the optional account-creation flow and historical-backfill-beyond-Plaid's-retention-window remain genuinely not started. |
| `D2_ROADMAP.md` L67-68 (the "4D (remainder)" catch-all row) | Bundles Excel/QuickBooks/rollback/account-creation/backfill into one "⏳ Not started" row | Same as above — five of the six items it bundles are done. |

Two sequencing documents also carry stale wording, both already
self-diagnosed in prior reports rather than newly discovered here:

- `D2_STEP4D_SEQUENCING_REVISION_PROPOSAL.md` L55 lists the entire mapping
  layer as one undifferentiated row — `**4D-5** | **Import Mapping
  Profiles** ... | ⏳ Proposed next` — but it shipped as five separate,
  separately-approved sub-slices (4D-5a/b/c-1/c-2/c-3). This doc's own
  closing note (L59) already flagged the roadmap's staleness "whenever the
  roadmap doc itself is next edited" — that edit still hasn't happened.
- `D2_IMPORT_MAPPING_LAYER_ROADMAP_PLACEMENT.md` L68 says QuickBooks is
  "still not started, per the roadmap's '4D (remainder)' row" — stale for
  the identical reason, compounding the same uncorrected row.

`D2_STEP4D4_QUICKBOOKS_IMPORT_INVESTIGATION.md` (§"Before finishing: Step 4
roadmap vs. implemented work," L218-260) already worked out the precise,
correct replacement table. Recommend using it verbatim as the smallest
accurate fix — replacing the one stale status line and the one stale
catch-all row, nothing else in the roadmap needs to change:

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
| 4D-4 | QuickBooks file import + update-on-match | ✅ |
| 4D (remaining) | Optional create-new-account-from-import flow; historical backfill beyond Plaid's API retention window | ⏳ Not started |

No other part of the roadmap needs rewording — Steps 1, 2, 3, 5, 6, 7, and
the "Required notes (canon)" section are all still accurate. This is
deliberately the smallest fix: one status line, one table row, in one file.
Not applied here per Review Mode's no-roadmap-edits instruction.

---

## 2. Architectural closure review

**Verdict: Step 4 is architecturally complete for its approved scope, with
one exception worth pushing back on rather than waiving silently.**

### The one candidate gap: cross-request fingerprint-matching race

`D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md` (§"Risk," L62-64,
L112) identified this before any of 4D was built: fingerprint matching is a
"query an indexed scan, then filter in application memory" pattern with **no
DB-level uniqueness constraint** behind it. Within a single import request
this is provably safe — `D2_STEP4D1_CSV_IMPORT_MVP_INVESTIGATION.md` (L91)
explains rows are processed sequentially, not concurrently, specifically so
a duplicate row *within the same file* finds its own just-committed sibling
rather than racing past it. That guarantee does not extend across two
*separate* concurrent import requests into the same account (two uploads
submitted close together, or the same file submitted twice). 4C's own
recommendation — a persisted, indexed `fingerprintHash` column queried
set-wise, closing "a real concurrency gap" (4C, L64) — was never built; it's
listed as deferred in 4A, in 4C, and reaffirmed unchanged as of the 4D-4
investigation (§10: "a persisted `fingerprintHash` column ... independently
deferred by 4A/4C/the original 4D investigation; nothing here changes
that").

This sits squarely inside Step 4's own scope — it's a correctness property
of the dedup mechanism Step 4 built, not a cross-provider adapter question
(Step 5), not a Provider Catalog concern, not UI. "Import & History
Foundation" implies the history it foundationally records shouldn't be able
to silently duplicate under ordinary concurrent use.

Context that keeps this from being a blocker: realistic likelihood is low
(manual, infrequent, mostly single-user-triggered uploads, not a
high-concurrency path), the mitigation is already fully designed (not a new
investigation), and it's additive — a new column plus a set-based query, no
breaking change to any of the three formats' pipelines. Recommend treating
it as its own small, separately-approved follow-on slice, consistent with
every other Step 4 sub-step's "smallest safe slice" precedent — not as
something that needs to block declaring Step 4 closed, but as something
that shouldn't quietly stay deferred a fourth time.

### Candidates considered and ruled out (correctly out of Step 4's scope)

- **GET-list/history-read endpoint for `ImportBatch`.** Doesn't exist today.
  Already named and deferred by `D2_STEP4D3_IMPORT_ROLLBACK_INVESTIGATION.md`
  (L18), which categorizes it as "UI-adjacent" — consistent with this
  review's UI exclusion. Worth noting for whoever scopes that later: it's a
  backend API gap, not purely a frontend one, but the project's own prior
  call was to treat it as UI-adjacent, and this review isn't re-litigating
  that call.
- **IIF support, live QuickBooks OAuth sync, chart-of-accounts,
  `ProviderType.QUICKBOOKS`/`EXCEL` entries.** All explicitly named and
  scoped to Step 5/6 or Provider Catalog by `D2_STEP4D4_QUICKBOOKS_IMPORT_
  INVESTIGATION.md` §10. Correctly excluded from this review.
- **`NormalizedTransaction` contract extensions**
  (`transactionType`/`balanceAfter`/`currency`/`rawMetadata`). Proposed
  twice, never proven required by a real sample file. Not a gap — a
  reasonable "don't build until proven necessary" call.

---

## 3. Accepted limitations

Genuine, named, conscious deferrals — not bugs, not the gap flagged in §2.

- **`ImportMappingProfile` CRUD/UI** — the schema, lookup, and save path
  exist (4D-5b); there's no screen for a user to view, rename, or delete a
  saved mapping.
- **PROCESSING-stuck-batch recovery** — named since 4D-1; the rollback
  route's eligible-status list deliberately excludes PENDING/PROCESSING,
  with no recovery path for a batch stuck mid-run (e.g. a crashed request).
- **File streaming / large-file limits** — `papaparse` in-memory parsing was
  chosen over `csv-parse`'s streaming mode at 4D-1, explicitly "revisit
  if/when file sizes ... make streaming necessary."
- **Update-rollback snapshots** — rollback cannot revert QuickBooks
  update-on-match overwrites; it only undoes rows a batch created. No
  before/after snapshot or versioning exists (4D-4, documented in the
  rollback route's own header comment).
- **Reconciliation of disappeared transactions** — import is purely
  additive (create new rows, update matched rows); nothing reflects a
  transaction's absence from a newer export back onto previously-imported
  data.
- **Automated integration tests** — no test framework exists for this
  pipeline at any 4D slice; every validation pass has been manual or
  code-trace based.
- **Row-level/per-event audit granularity** — one batch-level `AuditLog` row
  per rollback or update-on-match event, no per-row entries, no field-level
  before/after values. An approved scope decision (4D-4 checklist §8), not
  an oversight.
- **No `AuditLog` entry for the creation side of an import** — only
  `IMPORT_BATCH_ROLLED_BACK` and `IMPORT_BATCH_UPDATED_ON_MATCH` exist;
  `IMPORT_BATCH_CREATED`/`COMPLETED` were deliberately deferred starting at
  4D-1 and never added since. The `ImportBatch` row itself remains the
  durable record of what an import did; this is the secondary admin-log
  trail, not the primary one.
- **IIF (QuickBooks' native export format)** — out of scope; only
  CSV-shaped QuickBooks exports are supported.

---

## 4. Step 5 readiness

**Yes — Step 5 (Adapter Interface) can be built on top of the current
import subsystem without revisiting Step 4.**

Step 4 already produced exactly the contracts Step 5's own roadmap text
promises to formalize ("a shared normalized transaction format that every
adapter maps into," `D2_ROADMAP.md` L81):

- A shared `NormalizedRow`/`NormalizedTransaction` shape that CSV, Excel,
  and QuickBooks all already converge on.
- A column-resolution fallback chain (`detectColumns()` → saved
  `ImportMappingProfile` → fuzzy suggestion) that's source-agnostic.
- A confirm/preview (dry-run) split at the API boundary —
  `D2_STEP4D5C_PREVIEW_INVESTIGATION.md` §9 already names this as a second
  proof point for Step 5: "every import-style adapter exposes a
  side-effect-free preview call before its real run."
- A shared classification engine (`resolveFingerprintOutcome()`) reused
  unmodified across all three formats.

The one seam that's explicitly a placeholder, not a finished abstraction:
the update-on-match gate is a hardcoded `source === ImportSource.QUICKBOOKS`
check, with an in-code comment on both routes stating it's "intentionally
temporary ... expected to migrate to an adapter-capability check during D2
Step 5." That migration is Step 5 doing its own job — formalizing a
capability model — not Step 5 needing to go back and fix something Step 4
left broken. It was designed to be replaced, not repaired.

The §2 fingerprint-race item doesn't block Step 5 either: it's an internal
correctness property of the import pipeline's matching mechanism, not part
of the adapter contract surface Step 5 defines. Step 5 can be designed
against today's contracts regardless of whether that race is later closed —
though it's worth closing before import volume grows (e.g. once Step 6
selects a new file-based provider to validate the adapter shape against).

One pre-existing, independently-tracked gap will land on Step 5/6's plate
regardless: `ProviderType` still lacks `QUICKBOOKS`/`EXCEL` entries. Step 4
never owned `ProviderType` (that's Provider Catalog scope), so this isn't a
Step 4 revisit — just a known dependency for whichever step formalizes the
adapter/provider model next.

---

**Closing note:** Step 4 can be considered closed pending two small,
independent follow-ups that don't require reopening Step 4's design: the
roadmap text correction in §1, and a decision on whether to schedule the
fingerprint-race fix from §2 as its own slice now or accept the risk and
revisit later. Neither blocks starting D2 Step 2/3 or, eventually, Step 5.
