# D2 Step 4D-5a — Caller-Supplied Column Mapping (Validation Report)

Implements the approved checklist in `docs/initiatives/d2/D2_STEP4D5A_IMPLEMENTATION_PLAN.md`. No schema, migration, UI, QuickBooks, or provider-adapter work was done.

## Summary

`POST /api/accounts/[id]/import` now accepts an optional `columnMapping` form field (JSON-encoded, keyed on `CsvColumnMap`'s 8 fields). Absent → unchanged `detectColumns()` auto-detection. Present → used all-or-nothing in a new `applyExplicitMapping()` function, never merged with auto-detection. `NormalizedRow` was renamed to `NormalizedTransaction` throughout.

## Files changed

```
app/api/accounts/[id]/import/route.ts |  56 ++++++++++++++++---
lib/imports/csv.ts                    | 100 +++++++++++++++++++++++++++++++++-
lib/imports/excel.ts                  |  63 +++++++++++++--------
3 files changed, 187 insertions(+), 32 deletions(-)
```

No other tracked file changed. `prisma/schema.prisma`: untouched. No migration created.

- **`lib/imports/csv.ts`** — `NormalizedRow` → `NormalizedTransaction` (interface + `normalizeRow()`'s return type). Added `applyExplicitMapping(headers, mapping)`, validating unknown keys, header existence, and the same three required-field rules `detectColumns()` enforces (date; merchant-or-description; amount-or-debit/credit). `HEADER_ALIASES`, `detectColumns()`, and `normalizeRow()`'s body are untouched.
- **`lib/imports/excel.ts`** — import/type updated to `NormalizedTransaction`. `parseExcelFile()` gained an optional `explicitMapping` parameter; when present, `applyExplicitMapping()` replaces `detectColumns()` for that call, same `if ("error" in columns)` branch.
- **`app/api/accounts/[id]/import/route.ts`** — import/type updated to `NormalizedTransaction`. Reads `columnMapping`, JSON-parses it (400 on parse failure, non-object, or non-string values), and passes it to `parseExcelFile()` (Excel branch) or `applyExplicitMapping()` (CSV branch) in place of auto-detection. All shape/field/header validation happens before `db.importBatch.create`.

## Validation results

### tsc / lint

- `npx tsc --noEmit` — clean, exit 0.
- `npm run lint` — clean, exit 0; 4 pre-existing `@next/next/no-img-element` warnings in `components/dashboard/AccountModal.tsx`, `components/dashboard/TotpSection.tsx`, `components/ui/CoinIcon.tsx` — unrelated to this change, no `<img>` tags touched.

### Weird-header fixture (`Posting Date,Narrative,Transaction Type,Debit Amount,Credit Amount`)

Run via direct calls to the pure parsing/mapping functions (`tsx`, no DB — sandbox cannot reach Postgres), same method as Part A.

| Case | Result |
|---|---|
| No mapping, CSV (regression) | `{"error":"Could not find a date column. Expected one of: date, transaction date, posted date, post date."}` — byte-identical to Part A's recorded result |
| No mapping, Excel (regression) | Same error — identical to CSV |
| Explicit mapping, CSV | Success — 2 rows: row 1 `amount: -4.5`, row 2 `amount: 1500`, both `error: null` |
| Explicit mapping, Excel | Success — identical rows to the CSV case, confirming CSV/Excel share one mapping shape |
| Unknown mapping key (`foo`) | `{"error":"Unrecognized column mapping field: \"foo\"."}` |
| Mapped header not in file | `{"error":"Mapped column \"Not A Real Header\" for field \"date\" was not found in the file's headers."}` |
| Mapping missing `date` | `{"error":"Column mapping did not specify a date column."}` |
| Mapping missing `merchant`/`description` | `{"error":"Column mapping did not specify a merchant or description column."}` |
| Mapping missing `amount`/`debit`/`credit` | `{"error":"Column mapping did not specify an amount column, or a debit/credit pair."}` |
| Malformed JSON in `columnMapping` | Route-level `JSON.parse` throws → `{"error":"Could not parse columnMapping as JSON."}` (code-read confirmed at `route.ts:163-184`) |
| `columnMapping` is an array | `{"error":"columnMapping must be a JSON object."}` |
| `columnMapping` value not a string | `{"error":"columnMapping values must be strings or null."}` |

All malformed cases resolve before any `db.importBatch.create` call — confirmed by code-read: `route.ts`'s shape checks and the `applyExplicitMapping`/`detectColumns` error branches both `return` ahead of the batch-create block at `route.ts:233`.

### Rollback

Code-read confirmation (no behavior change, so no new test): `app/api/imports/[id]/rollback/route.ts`'s soft-delete is scoped only by `importBatchId` + `deletedAt: null` (`route.ts:134`), with zero reference to `columnMapping`, `detectColumns`, or `applyExplicitMapping`. A batch's rows are indistinguishable at rollback time regardless of how their columns were resolved — rollback works structurally, unchanged.

## Scope confirmation

No changes to: `prisma/schema.prisma`, any migration, `HEADER_ALIASES`, `detectColumns()`'s logic, any UI, QuickBooks, provider adapters, `ImportMappingProfile` (no such table exists), fuzzy matching, preview UI. `normalizeRow()`, `normalizeExcelRow()`, `resolveFingerprintOutcome()`, and the rollback route are all untouched.

## Known leftovers (pre-existing, not from this step)

Three throwaway scripts/files cannot be deleted from this sandbox (no unlink access to the mounted folder) and need manual removal:

```
rm scripts/tmp-4d5a-validation.ts scripts/tmp-4d3-weird-header-validation.ts scripts/__delete_test__.txt
```

All three are already neutralized to inert placeholders/empty content and are not imported anywhere.
