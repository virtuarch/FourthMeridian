> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5c — Import Preview & Suggestions (Architecture Investigation)

**Investigation only. No code, schema, migration, roadmap, or UI changes accompany this document.** Answers the 10 questions raised for this step. Nothing here is approved for implementation — each recommendation still needs its own short implementation checklist, submitted for approval, before any code is written, per the standing D2 working style (4B, 4C, 4D-1 → 4D-5b were each individually approved the same way).

This step was already anticipated, not invented here: `docs/initiatives/d2/D2_IMPORT_MAPPING_LAYER_ROADMAP_PLACEMENT.md` §9 named it explicitly as the third sub-slice — *"4D-5c — Fuzzy auto-suggest (Q6) + preview screen (Q7) on top of the now-proven backend"* — after 4D-5a (explicit mapping, shipped) and 4D-5b (`ImportMappingProfile`, shipped). This document is that slice's investigation, covering both halves the title names: **Preview** (this document's main focus, and the focus of the 10 questions asked) and **Suggestions** (the fuzzy best-guess mapping, addressed in §1/§3/§11 below since the questions didn't ask about it directly but the step's own name commits to it).

## Grounding: what exists today

The current pipeline, traced end-to-end from `app/api/accounts/[id]/import/route.ts` and its two collaborators:

1. **Parse** — `parseCsvText()` (`lib/imports/csv.ts`) or `parseExcelFile()`'s workbook-loading half (`lib/imports/excel.ts`) → raw headers + raw rows.
2. **Column resolution** — `resolveColumns()` (`lib/imports/csv.ts:290`), called identically by the CSV branch (`route.ts:262`) and from inside `parseExcelFile()` (`excel.ts:352`). Priority: caller-supplied `explicitMapping` → `detectColumns()`'s fixed-alias auto-detect → the Space's saved `ImportMappingProfile` rows, trial-applied in recency order. Returns `{ columns: CsvColumnMap, matchedProfileId }` or `{ error }`.
3. **Normalize** — `normalizeRow()` (CSV) / `normalizeExcelRow()` (Excel) → `NormalizedTransaction[]` (typed date/merchant/amount/category, or `.error` set for an unusable row). Both converge on the identical shape (`csv.ts:439-448`).
4. **Classify** — for each row that passed normalization, `resolveFingerprintOutcome()` (`csv.ts:526`) does up to two read-only DB lookups (`db.transaction.findFirst` on `externalTransactionId`, then `findByFingerprint()` from `lib/transactions/fingerprint.ts`, then an ambiguity check via `db.transaction.findMany`) and returns `CREATE | MATCH | SKIP`. Rows that failed normalization never reach this stage — they're `FAILED` directly in the route's loop (`route.ts:314-318`).
5. **Persist** — `db.importBatch.create()` (`route.ts:278`, status `PROCESSING`) happens *before* the row loop, immediately after column resolution succeeds — i.e., today, a batch is created as soon as the file's shape is known-valid, not after the rows are actually classified. The loop then writes a `Transaction` row per `CREATE` (`route.ts:330`), and finally `db.importBatch.update()` (`route.ts:359`) sets final counts/status. A matched profile's `useCount`/`lastUsedAt` are bumped only after the batch reaches its final status (`route.ts:379-391`).

Two facts from this trace matter most for Preview's design:

- **Classification already requires nothing but read-only DB calls.** `resolveFingerprintOutcome()` never writes. Steps 1-4 above can run to completion with zero persistence — only step 5 writes anything.
- **`ImportBatchStatus.PENDING` exists in the enum (`schema.prisma:1168`) but is never actually used by the route** — `db.importBatch.create()` sets `PROCESSING` directly, skipping past the schema's own default. This is a real, currently-dead lifecycle state, relevant to §6 below.

## 1. Preview architecture — what should it receive, how much work happens before it?

**Preview should receive exactly what the confirm endpoint receives today — the raw file plus the same optional `signConvention`/`columnMapping` fields — and should run the *entire* pipeline (parse → resolve → normalize → classify) before returning anything.** Not raw rows, not a pre-resolved mapping, not pre-computed fingerprint results — the file itself, because every one of those intermediate artifacts is cheap to (re-)derive from the file and expensive/fragile to keep in sync if computed twice by two different callers.

Concretely, rejecting the alternatives the question raises:

- **Raw rows as input** would mean the client parses the file itself (duplicating `parseCsvText`/`parseExcelFile` in the browser, or requiring a prior "parse" round-trip) just to hand rows back to the server — pure waste; the server already does this for free on upload.
- **Pre-resolved mapping as input** (client says "use this `CsvColumnMap`") collapses to the existing `explicitMapping` field, already supported by `resolveColumns()`. Nothing new needed there.
- **Pre-computed fingerprint results as input** doesn't make sense — fingerprinting is a server-side DB read against `Transaction`; the client has no way to compute it.
- **Classifications as input** would mean the client is told what the server should tell it — backwards.

So "how much work happens before preview" is the right framing, and the answer is: **everything except the write.** Preview is not a lighter-weight pass that skips classification to be fast — skipping classification would mean the single most important number a user wants ("how many of these already exist") is simply unavailable at preview time, which defeats the feature's purpose. The cost of full classification is discussed honestly as a risk in §10, not avoided by scoping it out.

## 2. Transaction classifications

**Keep exactly the existing four: `CREATE`, `MATCH`, `SKIP`, `FAILED`. Do not add `REVIEW`, `POTENTIAL_DUPLICATE`, or `UPDATE` as new classification values in this slice.**

- **`REVIEW`** — this isn't a row classification at all; it's describing the *batch's* lifecycle state ("not yet confirmed"), not what would happen to any individual row. Modeling it as a row classification would mean every row in a preview gets tagged `REVIEW` in addition to its real `CREATE`/`MATCH`/`SKIP`/`FAILED` outcome, which is redundant — the fact that nothing has been written yet is already true of the *whole response*, not a per-row fact. See §6 for where this state actually belongs (an `ImportBatch` lifecycle question, not a classification question).
- **`POTENTIAL_DUPLICATE`** — `SKIP`'s existing reason string (`"ambiguous fingerprint match (N existing rows)"`, `csv.ts:561`) already *is* this concept; it's a duplicate candidate today, just not labeled that way. Renaming or adding a parallel classification would touch the same fingerprint-confidence territory this project already has a standing, deliberately-deferred design note about: `docs/initiatives/d2/D2_FINGERPRINT_CONFIDENCE_FUTURE_DESIGN_NOTE.md` explicitly states the current fingerprint strategy "is the correct, approved tradeoff for D2 and is unchanged," and that confidence-scoring/duplicate-candidate modeling is future, unscoped work. Recommend: Preview's UI may *display* `SKIP` rows under a "potential duplicates" heading using the existing reason string — a presentation choice, not a new backend value. Re-opening the underlying matching semantics is explicitly out of scope for 4D-5c (see §11).
- **`UPDATE`** — a real, already-identified future need, but it belongs to QuickBooks specifically, not to Preview generically. `docs/initiatives/d2/D2_STEP4D_SEQUENCING_REVISION_PROPOSAL.md` §1 already establishes that QuickBooks's differentiator is update-on-match behavior (a stable `TxnID`, transactions edited/voided/reclassified in place) — CSV/Excel import has no such behavior and isn't expected to grow one. Adding an `UPDATE` value with zero current producer would be exactly the kind of speculative, unused plumbing this project's history has consistently avoided (e.g., 4D-5a's `MAPPABLE_FIELDS` deliberately excluded `transactionType`/`balanceAfter`/`currency`/`rawMetadata` until something would actually read them). Recommend documenting, here, that the classification type is *intentionally* open for a future `UPDATE` member when QuickBooks needs it — not adding it speculatively now.

## 3. Preview payload

Recommended response shape (illustrative, not a final interface — the implementation checklist fixes exact types):

```ts
// POST /api/accounts/[id]/import/preview — multipart/form-data,
// same fields as POST /api/accounts/[id]/import: file, signConvention?, columnMapping?

interface ImportPreviewResponse {
  source: "CSV" | "EXCEL";

  // Present only when column resolution succeeded (detect, explicit
  // mapping, or a saved profile all funnel through the same resolveColumns()
  // already used today).
  resolved: true;
  resolvedColumnMapping: CsvColumnMap;     // identical to what ImportBatch.resolvedColumnMapping would store
  matchedProfileId: string | null;         // identical to what ImportBatch.mappingProfileId would store
  signConvention: "creditPositive" | "debitPositive"; // echoes what was actually used

  summary: {
    totalRows: number;
    willCreate: number;
    willMatch: number;
    willSkip: number;
    willFail: number;
  };

  dateRange: { earliest: string | null; latest: string | null }; // ISO, from successfully-parsed rows only

  rows: Array<{
    lineNumber: number;
    date: string | null;     // ISO date or null
    merchant: string | null;
    description: string | null;
    category: TransactionCategory;
    amount: number | null;
    externalTransactionId: string | null;
    classification: "CREATE" | "MATCH" | "SKIP" | "FAILED";
    reason: string | null;            // populated for SKIP/FAILED — same strings errorSummary already uses
    matchedTransactionId: string | null; // populated only for MATCH
  }>; // first N rows, in file order — see §10 risk #4 on what "first N" means

  errors: Array<{ row: number; reason: string }>; // mirrors ImportBatch.errorSummary's existing shape exactly
}

// When resolution itself fails (no detect, no explicit mapping, no saved
// profile match) — see §11 "Suggestions":
interface ImportPreviewUnresolved {
  source: "CSV" | "EXCEL";
  resolved: false;
  rawHeaders: string[];                    // this file's actual header strings, for a manual-mapping UI
  suggestedMapping: Partial<CsvColumnMap>;  // best-guess, never auto-applied — see §11
  error: string;                            // detectColumns()'s own message, for a UI that wants the raw text
}
```

Design notes:

- **`totalRows`/`willCreate`/`willMatch`/`willSkip`/`willFail`** deliberately mirror `ImportBatch.rowCount`/`importedCount`/`matchedCount`/`skippedCount`/`failedCount`'s existing names (just "will-" prefixed) so the preview summary and the eventual confirm response use the same vocabulary — no relearning between the two screens.
- **`account`** is deliberately *not* in the payload — the account is already the URL's `[id]`, already authorized by the same check confirm uses (§10 risk #7). Echoing it back would be redundant; a UI wanting the account's display name/balance already has the existing account-detail endpoint for that.
- **`dateRange`** is cheap to derive (min/max over already-parsed dates) and answers "does this file cover the period I expect" without scrolling the row list.
- **First N rows, not all rows** — `summary` counts are always computed over the *whole* file (cheap relative to the classification pass that already has to touch every row); only the row-level array is capped, to avoid serializing thousands of rows for a large file. Recommend N defaulting to a fixed, reasonable cap (e.g. 25-50) rather than a client-supplied limit in this first slice — keeps the contract simple; a `limit` parameter is a trivial additive follow-on if needed.
- **No `ImportBatch.id` anywhere in this payload** — there is no batch yet (§6/§7).

## 4. UX flow

What the user should be able to review, mapped onto the payload above: the mapping used (`resolvedColumnMapping`, with `matchedProfileId` letting the UI say "matched saved profile: Chase Checking" vs. "auto-detected" vs. "your manual mapping"), the sign convention used (with a re-preview-on-toggle affordance), the duplicate/skip summary (`summary.willSkip` plus the `SKIP` rows' `reason` text), and the first N transactions exactly as they'd be normalized — typed date, signed amount, resolved category.

**Editing the mapping or sign convention should happen here, by re-calling preview — not by any new "edit" endpoint.** Preview is naturally idempotent and side-effect-free (§1), so "user flips sign convention" or "user manually maps two columns" is just "call preview again with different `signConvention`/`columnMapping`," reusing 4D-5a's existing all-or-nothing explicit-mapping mechanism verbatim. No new mutation semantics needed for this.

**Editing individual rows (e.g., hand-fixing one row's category before import) should not happen here, and is recommended out of scope for this slice entirely.** That's a materially larger feature — an editable grid, per-cell validation, and somewhere to hold those edits until confirm (the file itself can't be mutated; edits would need their own temporary store) — and nothing in the existing pipeline implies it. `docs/initiatives/d2/D2_IMPORT_MAPPING_LAYER_ROADMAP_PLACEMENT.md` §7 already staked out this position when it first proposed a preview screen ("Rollback... remains the safety net for whatever preview review misses or whenever a user skips it; preview is the cheaper first line of defense, not a replacement for rollback") — this investigation reaffirms it rather than revisiting it. Rollback (4D-3, already implemented, unmodified by anything here) stays the mechanism for "something wrong got through anyway."

Confirm step: the client calls the existing `POST /api/accounts/[id]/import` (today's route, unchanged) with the *same* `signConvention`/`columnMapping` values the last successful preview call used, so the confirmed import is guaranteed to apply the same resolution logic the user reviewed. (It is not guaranteed to produce the *same classification numbers* — see §10 risk #1 on staleness — only the same resolution/normalization logic.)

## 5. Existing architecture — reuse, don't duplicate

**Yes, Preview must reuse the parse/resolve/normalize/classify functions verbatim — `parseCsvText`/`parseExcelFile`, `resolveColumns()`, `normalizeRow()`/`normalizeExcelRow()`, `resolveFingerprintOutcome()`. None of these need a single line changed for Preview to call them.**

The one piece of *new* shared code this implies (not written here, flagged for the eventual implementation checklist): `route.ts`'s lines ~198-273 — file-format sniffing, saved-profile fetch, the CSV/Excel branch, column resolution, and row normalization — are currently inlined in the confirm route. Recommend extracting that block into a shared helper (e.g. a new `lib/imports/pipeline.ts` exporting something like `runImportPipeline(file, financialAccountId, opts): Promise<{ source, resolvedColumns, matchedProfileId, rows } | { error }>`), called identically by both the existing confirm route and the new preview route. This is the **only** source-code change this investigation's recommendations imply, and it is explicitly *not* made here — this document stops at "recommend extracting," consistent with the no-implementation instruction.

Why this matters enough to call out as its own recommendation rather than leaving each route to assemble these calls independently: if Preview's route is built as a parallel copy of the confirm route's top half instead of a shared call, the two will drift the first time someone "quickly" patches one to fix a display-only bug — see §10 risk #3.

`resolveFingerprintOutcome()` itself needs zero modification — it already only reads (`db.transaction.findFirst`/`findMany`, both confirmed at `csv.ts:539-556`), so calling it from a non-persisting preview path is already safe today, with no new guard needed.

## 6. ImportBatch lifecycle

**Recommendation: no `ImportBatch` row exists until confirm. Preview never calls `db.importBatch.create()`.** This is option (b) below; the other three were seriously considered and rejected.

| Option | Description | Verdict |
|---|---|---|
| (a) Batch created before preview | Every preview call creates a real `ImportBatch` row immediately. | **Rejected.** Every accidental file pick or "let me see what this looks like" becomes a permanent batch row that was never actually imported, breaking 4D-1's own stated invariant ("a file with the wrong shape never becomes a batch" — now even a *right*-shaped file that's merely previewed becomes one). These rows would need their own cleanup story and would pollute any future "import history" UI with batches stuck forever at whatever status a preview leaves them in. |
| (b) No batch until confirm | Preview computes and returns everything, persists nothing; the existing confirm route (unchanged) is the only thing that ever calls `db.importBatch.create()`. | **Recommended.** Zero schema impact (satisfies this task's "no schema changes" constraint directly, not just incidentally). Preserves every existing invariant untouched. Preview is provably side-effect-free — nothing to clean up, ever, for an abandoned preview. The cost — confirm re-derives classification rather than reusing preview's — is a feature, not a bug (see §10 risk #1: confirm re-deriving at confirm-time is exactly what keeps it authoritative over a possibly-stale preview). |
| (c) Temporary/draft batch (e.g., reusing the currently-dead `PENDING` status, or a new status) | A batch is created at preview time in a draft state, then promoted to `PROCESSING` on confirm. | **Rejected for this slice** — requires a schema change (new status semantics for `PENDING`, or a new enum value), explicitly out of bounds here. Also reintroduces (a)'s cleanup problem for any draft nobody ever confirms (needs a TTL or cleanup job). The one real benefit — a stable id to reference across preview→confirm — isn't needed: confirm doesn't need to reference preview's "session," since it re-derives everything fresh from the re-submitted file + mapping/signConvention. |
| (d) No batch, but cache the parsed file/rows server-side keyed by a preview token | Avoids asking the client to re-upload the file bytes for confirm. | **Rejected for this slice** — solves a minor UX inconvenience (one extra HTTP upload) by introducing new server-side state (a cache, an expiry/eviction policy) that then needs its own lifecycle to reason about. The browser already holds the `File` object after the user picks it; submitting it to preview and then again to confirm is one extra request, not a new capability. Revisit only if real-world file sizes make re-upload itself the bottleneck (§10 risk #6) — not assumed here. |

This recommendation directly answers the **PENDING is currently dead** observation from "Grounding" above: this investigation recommends *not* reviving it for Preview's purposes. If a future slice wants a real persisted draft state for some other reason, that's a separate, schema-touching decision — not implied or required by Preview.

## 7. Rollback interaction

**Confirmed: preview creates nothing, anywhere, by construction of recommendation (b) in §6.** No `ImportBatch`, no `Transaction`, and — worth stating explicitly since it's easy to miss — no `ImportMappingProfile.useCount`/`lastUsedAt` bump either. The existing bump (`route.ts:379-391`) is wired to run only after `db.importBatch.update()` sets a final status; if Preview is built by extracting a *shared* pipeline helper per §5, that extraction must stop **before** the persistence section (batch create, row loop, batch update, profile bump) — the shared helper is parse-through-classify only, and both routes keep their own, separate persistence code after calling it. Preview's route simply never proceeds past the helper's return.

Given that, `app/api/imports/[id]/rollback/route.ts` needs zero changes and has zero interaction with Preview: rollback operates purely on an `ImportBatch.id` (`rollback/route.ts:88`), and no such id ever exists for a preview-only session. They don't intersect.

One forward-looking note, not a recommendation: if a future revision ever adopts option (c) from §6 (a real persisted draft batch), `ROLLBACK_ELIGIBLE_STATUSES` (`rollback/route.ts:71-75`, currently `COMPLETED`/`COMPLETED_WITH_ERRORS`/`FAILED`) would need to keep excluding that draft status explicitly — a draft with no `Transaction` rows has nothing to roll back. Moot under the recommended (b) lifecycle; noted only so it isn't rediscovered the hard way if (c) is ever revisited.

## 8. QuickBooks

Preview, once built CSV/Excel-first per this investigation, simplifies QuickBooks in three concrete ways:

1. **It gives QuickBooks's one real behavioral fork — update-on-match (§2, §`D2_STEP4D_SEQUENCING_REVISION_PROPOSAL.md` §1) — a safe place to be surfaced before commit.** CSV/Excel's `MATCH` is a silent no-op; QuickBooks's analogous case is "this row would *edit* an existing transaction's category/memo/status," a meaningfully higher-stakes operation than a no-op. If Preview already exists with a `CREATE`/`MATCH`/`SKIP`/`FAILED` summary and row list, QuickBooks's slice only has to add its own `UPDATE` branch to an already-working display, instead of inventing preview UX from scratch under whatever schedule pressure QuickBooks ships under.
2. **It turns "did this export's column shape map correctly" from a post-hoc rollback decision into a pre-commit check.** QuickBooks's export-shape heterogeneity (Desktop vs. Online vs. report-type variants, per the sequencing doc §2) means mapping mismatches are more likely for QuickBooks than they were for Excel. Today, discovering a bad mapping means rolling back an already-written batch; with Preview, it means re-previewing with a corrected mapping before anything is written — lower stakes, faster loop, no soft-deleted rows to reason about for the common case.
3. **Because Preview is built as a thin wrapper around the shared pipeline (§5), not a CSV-specific feature, QuickBooks's future parser inherits a working preview screen automatically** the moment it's plumbed into the same `runImportPipeline()`-shaped contract — no QuickBooks-specific preview code required, only QuickBooks-specific parsing code feeding the same shape.

## 9. Future provider adapters (Step 5)

`D2_ROADMAP.md`'s Step 5 already commits to "a shared normalized transaction format that every adapter maps into," and the sequencing doc already argues 4D-5's mapping work shrinks Step 5 by proving that contract across three file formats before Step 5 starts. Preview adds a second, complementary proof point that's independent of source format: **a confirm-vs-dry-run split at the API boundary.** Once Preview exists for file-based import, Step 5's adapter interface can specify "every import-style adapter exposes a side-effect-free preview call before its real run" as part of the interface itself, rather than each future adapter inventing that split ad hoc.

This generalizes further than it might first look. Sync adapters (Plaid-style, polling-based) don't have a literal "upload, then preview" moment, but the same dry-run principle applies to e.g. a first-time connection backfilling years of transaction history: "show what this sync cycle would create/match/skip before writing it" is the same `CREATE`/`MATCH`/`SKIP`/`FAILED`-shaped summary Preview already proves out for files. Step 5 inherits a tested precedent for what that contract should look like instead of designing dry-run semantics from zero — the same relationship 4D-5's `NormalizedTransaction` contract already has to Step 5's normalized-format promise.

## 10. Risks — what would I push back on before implementation

1. **Preview/confirm staleness.** `resolveFingerprintOutcome()`'s classification depends on the `Transaction` table's state *at the moment it runs*. Time passes between a preview call and the eventual confirm call — a concurrent Plaid sync, a second import, or a manual entry could change a row's outcome (e.g. `CREATE` → `MATCH`) by confirm time. The mitigation is already inherent in §6's recommendation: confirm re-derives classification itself rather than trusting preview's cached numbers, so confirm stays authoritative. But the UX needs to be honest about this — avoid copy like "this will create exactly N transactions"; prefer "as of right now, this would create approximately N" framing, and treat confirm's *actual* response counts as the numbers that matter, not preview's.
2. **Cost of full-file fingerprint classification on every preview call.** Computing accurate aggregate counts (§1) means running `resolveFingerprintOutcome()` — up to two sequential DB round trips each — for *every* row, not just the rows displayed. This cost already exists on confirm today; Preview doesn't introduce it, but it does mean paying it roughly twice per actual import (once to preview, once to confirm) instead of once. Worth flagging now rather than discovering it as a latency problem later: acceptable as-is at current scale, but batching the lookups (one query per file covering the account/date range, matched in memory) is a reasonable follow-on performance slice — not designed here.
3. **Two code paths silently drifting apart.** The single biggest risk if Preview is implemented as a copy-pasted near-duplicate of the confirm route rather than a shared call (§5's extraction). This has to be enforced at implementation/review time — "two routes call the same helper" is easy to state and easy to violate under pressure (e.g., a quick preview-only display fix gets inlined directly into the new route instead of the shared helper).
4. **What "first N rows" means is undecided, and shouldn't be decided by omission.** File order (simplest, "what would actually happen, in sequence") vs. per-bucket (first N of each classification, more useful for review, more complex payload/UI). This investigation recommends file order as the default and flags the alternative explicitly so whoever writes the implementation checklist makes the call on purpose, not by accident.
5. **Naive re-preview-on-every-keystroke.** If a future UI calls preview reactively on every mapping/toggle change rather than on an explicit action, each call repeats the full cost from risk #2 against the same file. Not a backend flaw, but worth flagging for whoever builds the screen: re-preview should be deliberately triggered (a button, or debounced), not input-reactive.
6. **Re-upload cost during an edit-and-preview loop.** Since preview takes the raw file as multipart input (§1), every "change sign convention, re-preview" cycle resubmits the full file bytes, not just the changed field. Irrelevant for typical CSV/Excel files; could matter for an unusually large one (file-size ceilings are already a known, deliberately-deferred gap from 4D-1/4D-2, not solved here either). This is the one place option (d) from §6 (server-side caching keyed by a token) would earn back its complexity — flagged as a candidate optimization, not adopted now.
7. **Authorization must not be relaxed "because nothing is written."** Preview must re-run the exact same `SpaceAccountLink`/legacy-`Account` authorization check the confirm route does (`route.ts:134-148`) — a preview call against an account the caller can't access must 404, identically to confirm. The temptation to loosen this because preview "only reads" should be explicitly rejected: a `MATCH` result already reveals something about that account's existing transaction history shape to the caller, which is exactly the information the existing authorization model is there to gate.
8. **Method/path bikeshed, resolved here so it doesn't stall implementation:** Preview must be `POST` (a multipart file body forces this regardless of "this doesn't mutate state" intuitions — `GET` with a body isn't reliably supported by frameworks/proxies). Recommend `POST /api/accounts/[id]/import/preview`, named so its non-persisting nature is obvious from the path, distinct from the existing `POST /api/accounts/[id]/import`.
9. **Scope-creep pressure toward a new classification value mid-implementation.** §2 recommends against `POTENTIAL_DUPLICATE`/`REVIEW`/`UPDATE` now. It would be easy, while actually building the preview UI, to decide `SKIP`'s reason string isn't expressive enough and reach for a new value ad hoc. That decision should route back through the existing, deliberately-deferred fingerprint-confidence design note rather than being made inside this slice's implementation.
10. **Preview "looks free" but isn't.** Because it mutates nothing, it's easy to assume it's safe to call without limit. It still does real parsing and O(rows) DB reads (risk #2). Whatever request-level protections apply to the confirm route should apply equally to preview.

## Recommended architecture (summary)

Preview is a new, additive `POST /api/accounts/[id]/import/preview` endpoint that: accepts the same inputs as the existing confirm route; calls a newly-extracted shared pipeline helper (parse → `resolveColumns()` → normalize) instead of duplicating that logic; runs `resolveFingerprintOutcome()` per successfully-normalized row exactly as confirm does; and returns a summary + capped row list + the resolved mapping/profile-match info, or — when resolution itself fails — the file's raw headers plus a best-guess suggested mapping (§11), without ever calling `db.importBatch.create()`, `db.transaction.create()`, or bumping a profile's usage counters. The existing confirm route, rollback route, and schema are all unmodified by this design.

## API contract recommendation

See §3 for the full payload shape. Key contract decisions worth restating: same request fields as confirm (no new upload mechanism); response vocabulary mirrors `ImportBatch`'s existing counter names; `resolved: false` is a normal (200) response shape, not a 400 error, specifically so the unresolved case can carry `rawHeaders`/`suggestedMapping` for a manual-mapping UI rather than just an error string — the *confirm* route's existing hard-error behavior on unresolved columns is unchanged.

## Lifecycle recommendation

No `ImportBatch` row until confirm (§6, option (b)). Zero schema impact. Confirm remains the sole writer of `ImportBatch`/`Transaction`/profile-usage-counters, exactly as today.

## Implementation sequencing (proposed, not approved)

| Sub-slice | What | Depends on |
|---|---|---|
| 4D-5c-1 | Extract the shared parse→resolve→normalize pipeline helper out of `route.ts` into e.g. `lib/imports/pipeline.ts`; re-point the existing confirm route onto it. Pure refactor, zero behavior change — validate the same way 4D-5b's Option A refactor was validated (byte-identical error strings, byte-identical classification, fixture-driven). | None |
| 4D-5c-2 | New `POST .../import/preview` route calling the 4D-5c-1 helper, returning the summary/row-list payload (§3) for the *resolved* case only. No suggestion logic yet. | 4D-5c-1 |
| 4D-5c-3 | "Suggestions" — fuzzy best-guess mapping + raw-header surfacing (§11) for the *unresolved* case, layered onto 4D-5c-2's response. | 4D-5c-2 |
| (separate, later) | Any UI consuming this contract. Explicitly out of scope for this investigation and recommended as its own, separately-approved slice — not bundled with the backend work above. | 4D-5c-3 |

Each row above is a candidate for its own short implementation checklist, following the same "produce checklist → wait for approval → implement only that decision" pattern as every prior D2 step.

## Validation strategy (for whenever this is implemented)

`npx tsc --noEmit` and `npm run lint`, as always. Fixture-driven (`tsx`) validation of the new pure pieces — the pipeline helper and the suggestion/similarity function — mirroring the existing fixture pattern used for `detectColumns()`/`applyExplicitMapping()`/`resolveColumns()`. A code-read (or grep) confirming the preview route contains zero calls to `db.importBatch.create`, `db.transaction.create`, or `db.importMappingProfile.update` — i.e., mechanically provable "creates nothing," not just asserted. `git diff --stat` scoped to exactly the new route file, the new pipeline-helper file, and the confirm route's edit to call that helper — no schema/migration files touched anywhere in this slice, consistent with the lifecycle recommendation in §6.

## Rollback strategy (for whenever this is implemented)

Because Preview persists nothing, ever (§7), reverting it is a pure code revert — delete the new route, delete the new pipeline-helper module, restore the confirm route's inlined version of that logic (or simply leave the helper in place and only revert the new route, since the extraction itself is behavior-preserving and safe to keep). No migration to reverse, no data to clean up, no interaction with the existing `ImportBatch`-rollback mechanism (4D-3) to reason about. This is a direct structural consequence of the §6 lifecycle recommendation, not a separate guarantee that needs its own machinery.

## 11. Suggestions (the other half of this step's name)

The 10 questions above are preview-centric; this step's own name ("Preview & Suggestions") and its origin in Part B §9 ("fuzzy auto-suggest + preview screen") commit to a second half worth addressing explicitly: **what happens when resolution fails outright** — no auto-detect hit, no explicit mapping supplied, no saved profile matches?

Today, that's a hard stop: `resolveColumns()` returns `detectColumns()`'s own error string (e.g. *"Could not find a date column..."*) and the only way forward is for a human to already know the file's headers (from having opened it elsewhere) and hand-construct a full `columnMapping` JSON object. There is no discovery mechanism at all today for "what are this file's actual headers."

Recommend Preview close this gap in two layers, matching Part B §6's already-established philosophy exactly ("confidence scoring should be a hint... never a silent auto-apply threshold"):

- **Layer 1 — always return the file's raw headers on an unresolved result** (`rawHeaders: string[]` in §3's `ImportPreviewUnresolved` shape). This alone turns "manually construct mapping JSON blind" into "pick from a list of this file's actual columns" — the bulk of the friction removed with no fuzzy logic at all.
- **Layer 2 — a best-guess `suggestedMapping`,** computed via simple string-similarity against the same `HEADER_ALIASES` table `detectColumns()` already uses (no ML, no trained classifier — Part B §10 already ruled that out for the financial-stakes reasons given there, and this investigation doesn't revisit that). Populated as a *pre-fill*, never auto-applied — the user still explicitly confirms (by re-calling preview with the confirmed mapping as `explicitMapping`, per §4's edit flow) before anything resolves.

Both layers are additive to the response contract already designed in §3 and require no change to `detectColumns()`, `HEADER_ALIASES`, or `applyExplicitMapping()` — the similarity function is new, small, and isolated (a candidate for the same module as the 4D-5c-1 pipeline helper, or its own tiny `lib/imports/suggest.ts`), consistent with this project's standing discipline of not widening the existing alias/detection machinery itself.

## Explicit out-of-scope list

Schema or migration changes of any kind (the recommended lifecycle in §6 requires none). Edits to `D2_ROADMAP.md` or the sequencing-proposal doc. Any UI implementation. Row-level editing of individual transactions during preview (§4). New backend classification values — `REVIEW`, `POTENTIAL_DUPLICATE`, `UPDATE` (§2). Any change to fingerprint-matching semantics or revisiting `D2_FINGERPRINT_CONFIDENCE_FUTURE_DESIGN_NOTE.md`'s deferral. Any ML/trained-model confidence scoring (carries forward Part B §10's existing constraint). QuickBooks parsing itself. Step 5's adapter-interface formalization. Performance optimization of the fingerprint-lookup cost flagged in §10 risk #2. Server-side caching/token-based linking between a preview call and a later confirm call (§6 option (d), §10 risk #6). An `IMPORT_BATCH_CREATED` audit-log action (already deferred since 4D-1, unaffected by — and inapplicable to — a flow that never creates a batch).

---

**Stopping here per the task's instruction — no code, schema, migration, roadmap, or UI changes made.** This is an investigation awaiting reaction/approval before any sub-slice in the sequencing table above is individually checklisted and implemented.
