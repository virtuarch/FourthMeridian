> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5c-1 — Import Pipeline Extraction (Implementation Plan)

**Checklist only. No code changes accompany this document.** First of the three 4D-5c sub-slices approved in `docs/initiatives/d2/D2_STEP4D5C_PREVIEW_INVESTIGATION.md`'s sequencing table (4D-5c-1 pipeline extraction → 4D-5c-2 preview endpoint → 4D-5c-3 suggestions → UI later). Scope: extract the parse → resolve → normalize portion of `app/api/accounts/[id]/import/route.ts` into a shared, reusable helper, with zero behavior change, so the future preview route (4D-5c-2) calls the same code the confirm route already calls instead of duplicating it.

## Grounding: exactly what moves

Read in full for this plan: `route.ts` (current, post-4D-5b), `lib/imports/csv.ts`, `lib/imports/excel.ts`. The block that needs to move is `route.ts` lines 198–273:

- `detectExcelFormat(file)` (module-level function, lines 106–113) and its two MIME-type constants (lines 95–96) — pure format sniff, no I/O.
- The legacy-`.xls` rejection (lines 203–208) — a hardcoded 400 with a fixed message, returned before any parsing is attempted.
- The saved-profile array (`savedProfilesLite`, lines 220–234) — **already fetched and shaped before this block**, passed in, not fetched inside it.
- The Excel branch (lines 241–250): `file.arrayBuffer()` → `Buffer.from()` → `parseExcelFile(buffer, signConvention, explicitMapping, savedProfilesLite)`, which internally calls `resolveColumns()` and `normalizeExcelRow()` in a loop and already returns `{ rows, columns, matchedProfileId }`.
- The CSV branch (lines 252–273): `file.text()` → `parseCsvText(text)` → `resolveColumns(parsed.headers, { explicitMapping, savedProfiles })` → `parsed.rows.map((raw, i) => normalizeRow(raw, resolved.columns, signConvention, i + 1))`.

Everything from line 275 onward (`db.importBatch.create()`, the per-row classify-and-write loop, `db.importBatch.update()`, the profile-usage bump, the response) stays in `route.ts`, untouched — confirm's writes are not part of this extraction.

## 1. Helper location and name

`lib/imports/pipeline.ts`, exporting `runImportPipeline()`. Sibling to `csv.ts`/`excel.ts`, not a method on either — it orchestrates both without belonging to either, the same relationship `excel.ts` already has to `csv.ts` (`excel.ts`'s own header: "deliberately reuses, unmodified, the source-agnostic pieces of csv.ts"). `detectExcelFormat()` and its two MIME constants move here too (unexported — nothing outside this module needs format-sniffing once `runImportPipeline()` owns the branch decision internally).

```ts
// lib/imports/pipeline.ts

export interface ImportPipelineResult {
  source:                ImportSource;            // CSV | EXCEL
  rows:                  NormalizedTransaction[];
  resolvedColumnMapping: CsvColumnMap;
  matchedProfileId:      string | null;
}

export interface ImportPipelineOptions {
  signConvention:   SignConvention;
  explicitMapping?: Record<string, string | null | undefined>;
  savedProfiles:    SavedMappingProfileLite[];     // caller-fetched, caller-sorted — see §2
}

export async function runImportPipeline(
  file: File,
  opts: ImportPipelineOptions
): Promise<ImportPipelineResult | { error: string }> { ... }
```

One naming cleanup folded in here, called out explicitly since it's a deviation from a pure cut-and-paste: the route's local variable is named `resolvedColumns`, but the `ImportBatch` field it's written to is `resolvedColumnMapping` (`route.ts:300`). The helper's return field is named `resolvedColumnMapping` to match the schema field it ultimately feeds, removing a small naming inconsistency. Purely cosmetic — same value, same type, no behavior change — flagged for awareness, not because it's risky.

## 2. Exact helper responsibility

**In the helper:** format sniffing (`detectExcelFormat`, relocated verbatim), the legacy-`.xls` rejection (relocated verbatim, same message/status — see §4), CSV parsing (`parseCsvText`), Excel parsing (`parseExcelFile`), column resolution (`resolveColumns`, called directly for CSV, called internally by `parseExcelFile` for Excel — both unchanged), and normalization (`normalizeRow` for CSV, `normalizeExcelRow` inside `parseExcelFile` for Excel — both unchanged). Returns `source`, `rows`, `resolvedColumnMapping`, `matchedProfileId` — exactly the four values `route.ts` currently assembles from the two branches into separate local variables (`rows`, `source`, `resolvedColumns`, `matchedProfileId`, lines 236–239).

**Saved profile loading vs. receiving saved profiles — recommendation: receive, don't load.** The helper takes `savedProfiles: SavedMappingProfileLite[]` as a required input; it does not call `db.importMappingProfile.findMany()` itself. Three reasons:

- The fetch (`route.ts:220-234`) is Space-scoped, not file-scoped — "what profiles does this Space have" has nothing to do with which file was uploaded or whether it's CSV or Excel. It belongs beside `spaceId` resolution at the route layer, which is exactly where it already lives today.
- Keeping the helper DB-free (when paired with §3's recommendation to also exclude classification) means its primary surface area — parse, resolve, normalize — stays pure and fixture-testable the same way 4D-5b's validation already exercised `detectColumns()`/`applyExplicitMapping()`/`resolveColumns()` directly, with no mocked `db` required.
- It minimizes this refactor's diff. The task's own goal is "no behavior change" — moving the profile fetch into the helper would be an additional relocation this refactor doesn't need, for no behavior benefit. The future preview route (4D-5c-2) will have `spaceId` in scope identically (via its own `getSpaceContext()` call) and can fetch+sort+map the same way `route.ts` does today; that one query+sort+map sequence is cheap enough that having two call sites isn't a meaningful duplication risk the way the parse/resolve/normalize logic was.

## 3. Classification — recommendation: leave it out of the helper

**Do not move `resolveFingerprintOutcome()` into the pipeline helper in this slice.** This is the one place where "just move the code" is not safe, for a reason specific to this codebase, not a general principle:

`route.ts`'s own module header (lines 69–74) documents that rows are processed *sequentially*, not via `Promise.all`, specifically so that **a duplicate row later in the same file sees the Transaction an earlier row in the same file already created**, landing on `MATCH` instead of racing into a second `CREATE`. Classification and the write are interleaved in the same loop iteration (lines 311–355: classify row → if `CREATE`, write it immediately → next row). If classification were hoisted into the pipeline helper as a batch-wide pre-pass (classify all rows, then return a `FingerprintOutcome[]` alongside `NormalizedTransaction[]`), two identical rows in one file would **both** classify `CREATE` — neither row's "earlier duplicate" would exist yet as a written `Transaction` at classification time, since nothing has been written until after the whole pre-pass returns. That changes a real, currently-relied-upon outcome (one `CREATE` + one `MATCH` would become two `CREATE`s), which is exactly the kind of behavior change this refactor must not introduce.

Secondary reason: `resolveFingerprintOutcome()` is the one DB-touching, order-sensitive piece of this pipeline. Keeping it out of the helper keeps the helper's tests at the same pure-fixture level §2 already argues for, rather than forcing classification's sequencing semantics to be re-validated as part of a "pure refactor" step.

This means `route.ts` keeps its existing loop exactly as-is (lines 311–355, unmodified) — it just iterates over `pipelineResult.rows` (from the new helper) instead of a locally-assembled `rows` variable. `resolveFingerprintOutcome` stays imported directly by `route.ts` from `csv.ts`, unchanged.

(Forward-looking note for whoever scopes 4D-5c-2, not a decision made here: a preview-time classification pass has no "write between rows" step at all, so the sequential-duplicate-detection concern doesn't constrain preview the way it constrains confirm — but two identical rows previewed together would still both show `CREATE` in preview's counts, since neither is actually written during preview either. That's a real, useful nuance for 4D-5c-2's design, explicitly out of scope here.)

## 4. Keeping confirm's behavior byte-for-byte stable

- The legacy-`.xls` case is the one path that changes *location* without changing *output*: today `route.ts` returns `{ error: "Legacy .xls files are not supported. Please save the file as .xlsx and re-upload." }` at 400 directly, before calling any parse function. After the move, that same string is returned by the helper as a normal `{ error }`, and `route.ts` handles it through the exact same `if ("error" in pipelineResult) return NextResponse.json({ error: pipelineResult.error }, { status: 400 })` branch it already uses for every other pipeline failure (unresolved columns, unparseable CSV, malformed workbook). Net effect on the wire: identical response body, identical status code, for a different reason internally (one unified error branch instead of a dedicated early-return). This consolidation is itself a small simplification, called out explicitly so it isn't mistaken for an oversight.
- `route.ts`'s post-extraction call site becomes a single call plus a single error check, replacing the two-branch `if (excelFormat === "xlsx") { ... } else { ... }` block:
  ```ts
  const pipelineResult = await runImportPipeline(file, {
    signConvention,
    explicitMapping,
    savedProfiles: savedProfilesLite,
  });
  if ("error" in pipelineResult) {
    return NextResponse.json({ error: pipelineResult.error }, { status: 400 });
  }
  const { source, rows, resolvedColumnMapping, matchedProfileId } = pipelineResult;
  ```
  Everything from `db.importBatch.create()` onward reads from these four destructured values instead of the five separately-assigned `let`s it uses today — same values, same names where they already match (`source`, `rows`, `matchedProfileId`), `resolvedColumnMapping` replacing `resolvedColumns` per §1's cleanup (the `ImportBatch.create()` call site already writes `resolvedColumnMapping: resolvedColumns as unknown as Prisma.InputJsonValue`, lines 300–301 — only the right-hand variable's name changes, not the field name or the cast).
- `route.ts`'s imports from `@/lib/imports/csv` shrink to just `resolveFingerprintOutcome` and the types it still needs (`SignConvention`, `NormalizedTransaction`, `CsvColumnMap`, `SavedMappingProfileLite`) — `parseCsvText`, `resolveColumns`, `normalizeRow` are no longer called directly by `route.ts`. The `@/lib/imports/excel` import (`parseExcelFile`) is dropped entirely from `route.ts` — only `pipeline.ts` calls it now.
- `csv.ts` and `excel.ts` themselves are not edited at all — `runImportPipeline()` calls their existing exported functions exactly as `route.ts` does today, with the same arguments in the same order. No internal logic of either file changes.
- Validation: re-run a version of 4D-5b's fixture-driven validation script (`tsx`-executed, no DB) directly against `runImportPipeline()`, asserting its output for each existing fixture (standard headers, explicit mapping, saved-profile match, unresolvable headers, malformed CSV, malformed/empty workbook, legacy-`.xls`) is identical to what manually re-deriving `route.ts`'s pre-refactor branch logic would have produced for the same input — particularly the exact error strings, since those are the most likely thing to drift during a copy-paste.

## 5. CSV vs. Excel — no forced shared abstraction

The two formats are **not symmetric today**, and this refactor should preserve that asymmetry rather than smooth it over: CSV's resolve-and-normalize steps are inline at the call site (three separate calls: `parseCsvText`, `resolveColumns`, `.map(normalizeRow)`), while Excel's are encapsulated inside `parseExcelFile()` itself (which already calls `resolveColumns()` and loops `normalizeExcelRow()` internally, returning the finished `{ rows, columns, matchedProfileId }` shape). This isn't an oversight to fix — `csv.ts`'s own module header explicitly rejects forcing a shared interface between formats ("deliberately not a generic `ImportAdapter`... a future Excel/QuickBooks source is expected to get its own sibling module, not a forced shared interface bolted on here").

`runImportPipeline()` should reproduce this exact asymmetry inside its own branch, just relocated: for the Excel case, call `parseExcelFile()` once, as today; for the CSV case, call `parseCsvText()` + `resolveColumns()` + `rows.map(normalizeRow)` inline, as today — not behind a new `parseCsvFile()`-style wrapper. Introducing such a wrapper inside `csv.ts` would make the two branches look more symmetric, but it's unneeded scope for a "pure refactor" (no other caller needs CSV's three steps bundled as a unit the way Excel's typed-cell complexity justifies `parseExcelFile()`'s own encapsulation) and it would mean editing `csv.ts`, which this plan otherwise keeps untouched.

## 6. Expected file changes

| File | Change |
|---|---|
| `lib/imports/pipeline.ts` | **New.** `runImportPipeline()`, `ImportPipelineResult`/`ImportPipelineOptions` types, relocated `detectExcelFormat()` + its two MIME constants. Imports `parseCsvText`/`resolveColumns`/`normalizeRow` from `csv.ts` and `parseExcelFile` from `excel.ts` — both unmodified. |
| `app/api/accounts/[id]/import/route.ts` | **Modified.** Lines 95–96 (MIME constants) and 106–113 (`detectExcelFormat`) deleted. Lines 198–273 collapse into the single `runImportPipeline()` call + error check shown in §4. Imports adjusted per §4. Lines 1–94 (module header) gets a short addendum noting the 4D-5c-1 extraction, mirroring how the header already documents 4D-5a/4D-5b's changes. Lines 275 onward: **unchanged**. |
| `lib/imports/csv.ts` | **Untouched.** |
| `lib/imports/excel.ts` | **Untouched.** |
| `prisma/schema.prisma` | **Untouched** (no schema changes, per constraint). |
| `app/api/imports/[id]/rollback/route.ts` | **Untouched** — no dependency on anything in this slice. |

Net: one new file, one modified file. Everything else in the diff should show zero lines changed.

## 7. Validation plan

- `npx tsc --noEmit` and `npm run lint` — clean, as always.
- Fixture-driven validation of `runImportPipeline()` directly (`tsx`, no DB — mirrors 4D-5b's `tmp-4d5b-validation.ts` pattern), covering every case the user listed:
  - Normal CSV import (standard auto-detectable headers) — `source: "CSV"`, expected row count/shape, `matchedProfileId: null`.
  - Excel import (`.xlsx` fixture) — `source: "EXCEL"`, same shape.
  - Explicit mapping (`columnMapping` supplied) — confirms the helper still routes through `resolveColumns()`'s `explicitMapping` priority branch, for both formats.
  - Saved profile path — a header set `detectColumns()` can't resolve, with a fixture profile supplied — confirms `matchedProfileId` comes back non-null, identically to today.
  - Malformed files fail the same way — no header row, missing required column, malformed CSV text, malformed/empty `.xlsx` workbook, and the legacy-`.xls` case specifically (§4) — assert byte-identical error strings and that `route.ts` still maps every one of them to a 400.
  - Within-file duplicate-row sequential classification is unaffected — re-run (or construct, if one doesn't already exist) a two-identical-rows-in-one-file fixture through the full route (not just the helper) and confirm row 1 still lands `CREATE` and row 2 still lands `MATCH`, exactly as before. This is the one regression check that matters most given §3's finding — even though classification deliberately stays out of the helper, it's worth proving the surrounding loop still sees the same `rows` array shape and ordering it always has.
- End-to-end: a real CSV upload and a real `.xlsx` upload against the live route in dev, each producing the same `importBatchId`/`status`/counts shape as before the refactor (compare a captured pre-refactor response against a post-refactor response for the same fixture file).
- `git diff --stat` scope check: expect exactly `lib/imports/pipeline.ts` (new) and `app/api/accounts/[id]/import/route.ts` (modified) — zero lines changed in `csv.ts`, `excel.ts`, `schema.prisma`, or the rollback route.

## 8. Rollback plan

Pure code revert — no migration, no data involved. Restoring `route.ts` to its pre-refactor content and deleting `lib/imports/pipeline.ts` fully reverses this slice, with no coordination needed in any other file, since `csv.ts` and `excel.ts` are never touched.

## Out of scope (carried from the task's constraints)

No schema changes. No migrations. No preview endpoint. No suggestions/fuzzy-mapping logic. No UI. No QuickBooks. No provider-adapter work. No changes to `HEADER_ALIASES`, `detectColumns()`'s matching algorithm, or `normalizeRow()`/`normalizeExcelRow()`'s bodies. No changes to fingerprint behavior (`resolveFingerprintOutcome()` untouched, and — per §3 — not relocated). No changes to the rollback route.

---

**Stopping here per the task's instruction — no code changes made.** Awaiting approval before implementing 4D-5c-1.
