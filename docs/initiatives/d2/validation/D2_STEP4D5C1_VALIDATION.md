> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5c-1 — Import Pipeline Extraction (Implementation + Validation Report)

Implements the approved checklist in `docs/initiatives/d2/D2_STEP4D5C1_IMPLEMENTATION_PLAN.md`: extracted the parse → resolve → normalize sequence out of `app/api/accounts/[id]/import/route.ts` into a new `lib/imports/pipeline.ts`, exporting `runImportPipeline()`. Zero behavior change. No schema, migration, preview endpoint, suggestions, UI, QuickBooks, or provider-adapter work was done.

## Files changed

```
app/api/accounts/[id]/import/route.ts | 132 +++++++++++++---------------------
1 file changed, 48 insertions(+), 84 deletions(-)
```

New, untracked (not modifications): `lib/imports/pipeline.ts`, this report, `docs/initiatives/d2/D2_STEP4D5C1_IMPLEMENTATION_PLAN.md`, `docs/initiatives/d2/D2_STEP4D5C_PREVIEW_INVESTIGATION.md` (both written in the prior two turns, planning-only), and three temporary validation scripts (see "Known leftovers"). No other tracked file changed — `lib/imports/csv.ts` and `lib/imports/excel.ts` are byte-for-byte untouched.

- **`lib/imports/pipeline.ts`** — new. Exports `runImportPipeline(file, opts)`, `ImportPipelineResult`, `ImportPipelineOptions`. Owns format-sniffing (`detectExcelFormat()`, relocated verbatim, plus the two MIME constants), the legacy-`.xls` rejection, CSV parsing/resolution/normalization (`parseCsvText` → `resolveColumns` → `.map(normalizeRow)`), and the Excel call (`parseExcelFile`). Never imports or calls `db` — confirmed by inspection (zero `db.`/`import { db }` references in the file) and by the validation suite below, which calls it successfully with `lib/db.ts` itself stubbed out.
- **`app/api/accounts/[id]/import/route.ts`** — module header gained a short addendum documenting the extraction (mirroring how it already documents 4D-5a/4D-5b); imports shrank to `resolveFingerprintOutcome` + the types it still needs from `csv.ts`, plus `runImportPipeline` from the new module; the two-branch CSV/Excel block collapsed into one `runImportPipeline()` call + error check; the `ImportBatch.create()` call site's `resolvedColumns` variable renamed to `resolvedColumnMapping` (cosmetic — matches the field it feeds, per the plan's §1 naming cleanup, no value/type change). Everything from `db.importBatch.create()` onward — the sequential classify-and-write loop, `resolveFingerprintOutcome()`, `db.importBatch.update()`, the profile-usage bump, the response shape — is unchanged.

## Validation results

### tsc / lint

- `npx tsc --noEmit` — clean (exit 0).
- `npm run lint` — clean (0 errors); the same 4 pre-existing `@next/next/no-img-element` warnings as the established baseline (`AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx` — unrelated to this change).

### A sandbox constraint discovered this step, and how it was worked around

Running the fixture suite hit a blocker beyond the already-documented "this sandbox can't run `prisma generate`/`migrate dev` directly": **importing `lib/imports/csv.ts` at all — which `pipeline.ts` does — crashes the process**, even though `runImportPipeline()` itself never touches `db`. `csv.ts` does `import { db } from "@/lib/db"` at module scope, and `lib/db.ts` constructs `new PrismaClient()` eagerly on import. This sandbox has no `linux-arm64` Prisma query engine binary on disk anywhere (only `darwin-arm64`, from your local `prisma generate` runs — confirmed via a filesystem search), and fetching one requires network access to `binaries.prisma.sh`, which is blocked from this sandbox per the existing precedent. The engine load is asynchronous, so the failure doesn't surface as an import-time exception — it surfaces a tick later as an unhandled rejection, after any script's synchronous body has already run.

Worked around it without touching any tracked file: `scripts/tmp-4d5c1-db-stub-preload.cjs` pre-seeds Node's CJS `require.cache` for `lib/db.ts`'s resolved absolute path with a stub `{ db: <throwing Proxy> }` before anything requires it, so the real `lib/db.ts` source is never read or executed. (An ESM `module.register()` loader-hook approach was tried first and abandoned — this project's `tsx` runs in CJS mode, since `package.json` has no `"type": "module"`, so the ESM resolve/load hooks never fired for any specifier here; the dead attempt is `scripts/tmp-4d5c1-db-stub-loader.mjs`, neutralized, see "Known leftovers.") The stub's `db` throws if ever accessed — it wasn't, in any of the 39 checks below, which is itself evidence `runImportPipeline()` stays DB-free in practice, not just by code-read.

Run as:
```
node --import tsx -r ./scripts/tmp-4d5c1-db-stub-preload.cjs scripts/tmp-4d5c1-validation.ts
```

### Functional validation suite — 39/39 checks passed

Direct calls to `runImportPipeline()` against real fixtures (CSV text via the platform `File` API; `.xlsx` buffers built with `exceljs`, the same library `lib/imports/excel.ts` uses). Mapped onto the implementation plan's §7 scenario list:

| # | Scenario | Result |
|---|---|---|
| 1 | Normal CSV import, auto-detected headers | `source: "CSV"`, 2 rows, `matchedProfileId: null`, `resolvedColumnMapping` matches the file's actual headers, row values/line numbers correct. |
| 2 | Excel import (`.xlsx`), auto-detected headers | `source: "EXCEL"`, same shape and values as the CSV case for identical data. |
| 3 | Explicit mapping — CSV, headers `detectColumns()` can't resolve | Routes through `resolveColumns()`'s explicit-mapping priority; `resolvedColumnMapping`/row values reflect the caller-supplied mapping, `matchedProfileId: null`. |
| 4 | Explicit mapping — Excel, same odd headers | Same outcome via the Excel branch (`parseExcelFile()`, unmodified). |
| 5 | Saved profile path — CSV, no explicit mapping, headers `detectColumns()` can't resolve | Falls through to the supplied saved profile; `matchedProfileId` comes back as that profile's `id`. |
| 6 | Unresolvable headers, no explicit mapping, no saved profile | Returns `detectColumns()`'s own error string, byte-identical: `"Could not find a date column. Expected one of: date, transaction date, posted date, post date."` |
| 7 | Malformed CSV (empty file, no header row) | `{ error: "Could not parse file as CSV." }` — `parseCsvText()`'s thrown `"No header row found."` is caught and remapped exactly as before. |
| 8a/8b | Legacy `.xls` — by extension, and by MIME-type fallback (no recognizable extension) | Both return the exact pre-existing string: `"Legacy .xls files are not supported. Please save the file as .xlsx and re-upload."` — now surfaced as a normal pipeline `{ error }` per the plan's §4 consolidation, same wire output. |
| 9 | Malformed `.xlsx` (unparseable workbook buffer) | `{ error: "Could not parse file as an Excel (.xlsx) workbook." }` |
| 10 | Empty `.xlsx` worksheet (valid workbook, zero rows) | `{ error: "No header row found." }` |
| 11 | Within-file duplicate rows — pipeline output | Both identical rows come back, in original order, uncollapsed (`lineNumber` 1 then 2) — confirms the array `route.ts`'s sequential loop receives still has the shape and ordering the duplicate-detection invariant (§3 of the implementation plan) depends on. This checks the pipeline's *input* to that invariant, not classification itself — see the code-read note below for the loop itself. |
| 12 | Debit/credit pair amount-sign logic (bonus, beyond the plan's required list) | `amount` computed as `credit − debit` exactly as `normalizeRow()` always has, confirming the extraction didn't disturb a field-level branch in passing. |

### Sequential duplicate-row classification loop — code-read (not DB-executable here)

This is the one piece of behavior this extraction was most at risk of breaking, and it can't be exercised without a live database (it requires real `Transaction` rows to exist mid-loop) — consistent with this project's established precedent of validating DB-write-order invariants by code-read rather than live execution (see `D2_STEP4D5B_VALIDATION.md`'s items 7–9). Confirmed via a full post-edit read of `route.ts`: the loop (current lines 275–319) is structurally identical to its pre-extraction form — same `for (const row of rows)` (not `Promise.all`), same `await resolveFingerprintOutcome(...)` per iteration, same immediate `db.transaction.create()` on `CREATE` before the next iteration runs. The only change anywhere near it is that `rows` is now one of four values destructured from `pipelineResult` (line 236) instead of a locally-built `let rows` — the loop body itself, `resolveFingerprintOutcome`'s import site, and every line from `db.importBatch.create()` onward are untouched. Item 11 above is the complementary, executable half of this proof: it confirms the array now arriving into that unchanged loop still has both within-file duplicate rows present and in order.

### End-to-end live-route check

Not run against a live dev server this turn — out of reach from this sandbox (no reachable app server), and the fixture suite above already exercises the exact code path `route.ts` now calls, with the same inputs a real upload would produce. If you want a live confirmation, re-uploading a known CSV/`.xlsx` fixture through the running app and comparing the response shape (`importBatchId`, `status`, counts) against a pre-refactor capture would close this out — nothing in the diff suggests it would differ.

## Scope confirmation

```
$ git status --short
 M app/api/accounts/[id]/import/route.ts
?? docs/initiatives/d2/D2_STEP4D5C1_IMPLEMENTATION_PLAN.md
?? docs/initiatives/d2/D2_STEP4D5C_PREVIEW_INVESTIGATION.md
?? lib/imports/pipeline.ts
?? scripts/tmp-4d5c1-db-stub-loader.mjs
?? scripts/tmp-4d5c1-db-stub-preload.cjs
?? scripts/tmp-4d5c1-validation.ts

$ git diff --stat
 app/api/accounts/[id]/import/route.ts | 132 +++++++++++++---------------------
 1 file changed, 48 insertions(+), 84 deletions(-)
```

Exactly the one new module and one modified route the approved plan scoped, plus the two pre-existing planning docs, this report, and three temporary scripts. `lib/imports/csv.ts`, `lib/imports/excel.ts`, `prisma/schema.prisma`, and `app/api/imports/[id]/rollback/route.ts` all show zero diff. No UI files, no QuickBooks/billing/provider-adapter files, no schema/migration files.

## Known leftovers

None of the three temporary scripts can be deleted from this sandbox (no unlink access to the mounted folder — same constraint noted in every prior validation report in this initiative). Manual removal:

```
rm scripts/tmp-4d5c1-validation.ts
rm scripts/tmp-4d5c1-db-stub-preload.cjs
rm scripts/tmp-4d5c1-db-stub-loader.mjs
```

`tmp-4d5c1-db-stub-loader.mjs` is a dead end specifically (an ESM loader-hook approach that doesn't fire under this project's CJS-mode `tsx` setup) — it's been neutralized to an inert `export {}` placeholder rather than left as a script that looks live but does nothing. The other two are the scripts actually used for this step's validation; their headers explain why they exist and how to re-run them.

The pre-existing stale `.git/index.lock` (zero bytes, sandbox-permission-limited, doesn't block `git status`/`git diff --stat`) is unchanged from prior reports.

---

**4D-5c-1 is complete.** Per `D2_STEP4D5C_PREVIEW_INVESTIGATION.md`'s approved sequencing, the next slice is 4D-5c-2 (the preview endpoint, calling this same `runImportPipeline()`) — not started here, per this step's "stop after implementation and validation" instruction.
