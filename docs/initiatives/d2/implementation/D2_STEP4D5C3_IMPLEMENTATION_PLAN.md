> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5c-3 — Suggestions (Implementation Plan)

**Checklist only. No code changes accompany this document.** Third and last of the three 4D-5c sub-slices sequenced in `docs/initiatives/d2/D2_STEP4D5C_PREVIEW_INVESTIGATION.md` (4D-5c-1 pipeline extraction ✅ → 4D-5c-2 preview endpoint ✅ → **4D-5c-3 suggestions** → UI later, separately approved). Depends on 4D-5c-2, complete. Scope: close the §11 gap — when column resolution fails outright on the preview route, surface the file's raw headers plus a deterministic best-guess mapping. Pre-fill only, never auto-applied.

## Grounding: current state (read directly, this turn)

- `lib/imports/pipeline.ts`'s `runImportPipeline()` returns `ImportPipelineResult | { error: string }`. On the CSV branch's `resolveColumns()` failure (line 139-141: `if ("error" in resolved) { return resolved; }`), `parsed.headers` (available since line 135) is computed but discarded — only the error string survives.
- `lib/imports/excel.ts`'s `parseExcelFile()` has the identical gap: `headers` is built (lines 338-348) before `resolveColumns(headers, ...)` is called (line 352); on failure (line 353: `if ("error" in resolved) return resolved;`) the headers are likewise discarded.
- `app/api/accounts/[id]/import/preview/route.ts` (4D-5c-2, lines 181-186) maps any pipeline error straight to `NextResponse.json({ error }, { status: 400 })` — explicitly flagged in that route's own module header and the 4D-5c-2 validation report as a provisional placeholder pending this slice ("no resolved:false/suggestion shape in this slice (4D-5c-3)").
- The confirm route (`app/api/accounts/[id]/import/route.ts`, lines 225-233) only ever reads `pipelineResult.error` off the same union — verified directly this turn. Adding an optional field to the error variant is wire-compatible with confirm; it stays a plain `{ error }` / 400.
- `detectColumns()` (`csv.ts:119-156`) does exact, normalized-string matching against `HEADER_ALIASES` (`csv.ts:68-77`, module-private — not exported). No fuzzy matching exists anywhere in the codebase today.

## Decisions

**1. Preview's unresolved-case response contract.** Change the preview route's resolution-failure branch from `400 { error }` to `200 { resolved: false, rawHeaders, suggestedMapping, error }`, matching the investigation's §3 `ImportPreviewUnresolved` shape. The confirm route is **not** touched — it keeps its existing hard `400 { error }`, per the investigation's explicit instruction that confirm's hard-error behavior is unmodified. Safe to change now specifically because no UI consumes the preview contract yet (this is the reason 4D-5c-2 deferred the decision here rather than shipping a half-built shape).

**2. Threading raw headers through the error path (additive, two files).**
- `lib/imports/pipeline.ts`: CSV branch — when `resolveColumns()` fails, return `{ ...resolved, rawHeaders: parsed.headers }` instead of `resolved` unchanged.
- `lib/imports/excel.ts`: `parseExcelFile()`'s `resolveColumns()` failure branch (line 353) — same pattern, `{ ...resolved, rawHeaders: headers }`. This is the one previously-"untouched" file (4D-5c-1's plan named it explicitly as such) needing a one-line additive change — flagged since every prior 4D-5c report has called out `excel.ts` as zero-diff.
- `ImportPipelineResult`'s error variant becomes `{ error: string; rawHeaders?: string[] }` — optional, additive.
- Failure modes with no header row ever parsed (legacy `.xls`, unparseable CSV text, malformed/empty workbook, no header row) leave `rawHeaders` undefined — unchanged `{ error }` shape for both routes in those cases.

**3. Suggestion algorithm (Layer 2).** New module `lib/imports/suggest.ts` exporting `suggestColumnMapping(rawHeaders: string[]): Partial<CsvColumnMap>`. Deterministic string-similarity only — no ML/trained model, carrying forward the investigation's (and Part B §10's) existing constraint. Proposed: a small, locally-implemented normalized Levenshtein similarity (no new npm dependency) comparing each raw header against each field's alias list in `HEADER_ALIASES`, keeping the best-scoring header per field independently; a field is included only if its best score clears a fixed threshold (proposed 0.6 on a 0–1 scale) — otherwise omitted (not `null`, genuinely absent, keeping the return type `Partial`). Requires exporting `HEADER_ALIASES` and `normalizeHeader` from `csv.ts` (currently module-private) — additive visibility change only, no logic touched. Never auto-applied: a caller wanting to use a suggestion must explicitly resubmit it as `columnMapping` on a later call, exactly like any other explicit mapping today.

**4. Where suggestion runs.** Only inside the new preview-route failure branch, after `runImportPipeline()` returns `{ error, rawHeaders }`. Not computed on the success path (no consumer for it there). Confirm route never calls `suggestColumnMapping` — zero change to confirm beyond the wire-compatible field addition in #2.

## Expected file changes

| File | Change |
|---|---|
| `lib/imports/suggest.ts` | **New.** `suggestColumnMapping()` + local Levenshtein helper. |
| `lib/imports/csv.ts` | Export `HEADER_ALIASES` and `normalizeHeader` (visibility only — no logic change). |
| `lib/imports/excel.ts` | One-line addition: attach `rawHeaders` on `parseExcelFile()`'s resolution-failure return. |
| `lib/imports/pipeline.ts` | CSV branch: attach `rawHeaders` on resolution failure. `ImportPipelineResult`'s error type gains optional `rawHeaders`. |
| `app/api/accounts/[id]/import/preview/route.ts` | Resolution-failure branch: `400 { error }` → `200 { resolved: false, rawHeaders, suggestedMapping, error }`. |
| `app/api/accounts/[id]/import/route.ts` (confirm) | Untouched. |
| `prisma/schema.prisma` | Untouched — no schema/migration in this slice. |

## Validation plan

- `npx tsc --noEmit`, `npm run lint` — clean.
- Fixture-driven (`tsx`, no DB) tests of `suggestColumnMapping()` directly: exact-alias headers score above threshold; near-miss headers ("Trans Date", "Desc.") score above threshold; unrelated headers ("Notes", "Foo") stay below threshold and are omitted; empty header list returns `{}`.
- Fixture-driven test of `runImportPipeline()`'s new `rawHeaders` field: an unresolvable CSV/Excel fixture returns `{ error, rawHeaders }` with headers matching the file's actual header row; every other existing 4D-5c-1 fixture (resolved CSV/Excel, explicit mapping, saved profile, legacy `.xls`, malformed CSV/workbook, empty file) unchanged — same error strings, `rawHeaders` absent where no header row was ever parsed.
- Preview route: extend 4D-5c-2's stub-preload execution harness with the new unresolved-case scenario — assert `200`, `resolved: false`, `rawHeaders` present, `suggestedMapping` populated per the fixture's actual headers, error string unchanged from today's.
- Confirm-route regression via the same harness: an unresolvable file still returns `400 { error }`, identical message, unaffected by this slice.
- `git diff --stat` scope check: `lib/imports/suggest.ts` (new) + small diffs in `csv.ts`, `excel.ts`, `pipeline.ts`, `preview/route.ts` only — zero lines in the confirm route, rollback route, or `schema.prisma`.

## Rollback plan

Pure code revert, no migration, no persisted data anywhere in this slice (preview still creates nothing — §6/§7 of the investigation unaffected). Revert = delete `suggest.ts`, revert the four small diffs. No coordination with `ImportBatch`/`Transaction`/`ImportMappingProfile` needed.

## Out of scope

ML/trained confidence scoring. UI. QuickBooks. Schema/migration changes. Any change to `detectColumns()`'s matching algorithm or `HEADER_ALIASES`'s contents (only its export visibility changes). Confirm-route behavior or status codes. New classification values (`REVIEW`/`POTENTIAL_DUPLICATE`/`UPDATE`). Fingerprint-matching changes. New npm dependency (Levenshtein implemented locally unless you'd rather use a package).

---

Awaiting approval before implementing 4D-5c-3.
