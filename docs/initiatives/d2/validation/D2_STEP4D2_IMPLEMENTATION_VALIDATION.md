> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-2 — Excel Import: Implementation + Validation

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`.

Implements the design in `D2_STEP4D2_EXCEL_IMPORT_INVESTIGATION.md`, per the approved scope:

> Add: `exceljs` dependency, `lib/imports/excel.ts`. Extend `app/api/accounts/[id]/import/route.ts` with a format-sniffing branch.
> Reuse, unmodified: `detectColumns`, `mapCategory`, `parseDate`, `parseAmount`, `resolveFingerprintOutcome`, the `NormalizedRow`/`CsvColumnMap`/`SignConvention` types — all from `lib/imports/csv.ts`.
> No: QuickBooks, rollback, UI, background jobs, a generic provider-adapter abstraction, multi-sheet selection, legacy `.xls`.

## 1. What was built

### Dependency

`exceljs@4.4.0`. No `@types/exceljs` — the package ships its own types (`node_modules/exceljs/index.d.ts`).

### `lib/imports/excel.ts` (new)

Mirrors `csv.ts`'s shape, not its code — a sibling module per the investigation, not a forced shared `ImportAdapter` interface. Two layers:

- **Typed-cell helpers** (`isCellErrorValue`, `cellToHeaderString`, `cellToText`, `excelSerialToDate`, `cellRawDate`, `cellRawNumber`) — read an `ExcelJS.CellValue` (which can be a plain string/number/Date, a rich-text run, a formula `{formula, result}`, or an error `{error}`) and coerce it into the same plain string/number/Date shapes `csv.ts`'s string-based parsers expect. `cellRawDate` branches on the cell's actual type: a real `Date` (re-anchored to UTC midnight from its own UTC fields), a string (reuses `parseDate()` as-is), a bare number (an unformatted serial, via `excelSerialToDate`), or a formula result (recurses into `.result`). `excelSerialToDate` implements the 1900-leap-year-bug offset (serial 60 is the fictitious `1900-02-29`; every real serial above it is shifted by one day relative to a correct proleptic count).
- **`normalizeExcelRow`** — field-for-field mirror of `csv.ts`'s `normalizeRow()`: same debit/credit-vs-single-amount branch, same `signConvention` application point, same merchant-or-description fallback, same error precedence. Only difference is sourcing each field from a typed cell instead of a raw string.
- **`parseExcelFile(buffer, signConvention)`** — the module's only export besides `ParsedExcel`. Loads the workbook, reads worksheet 1 only, resolves the header row's recognized aliases via `detectColumns()` (unmodified, looked up by name not position, so merged header cells are harmless), maps those names back to column indexes, then walks data rows with `eachRow({ includeEmpty: false })` (fully empty rows skipped without being counted — mirrors `Papa.parse`'s `skipEmptyLines`). Returns the same `NormalizedRow[]` shape CSV produces, or a file-level `{ error }` for no-worksheets / no-header-row / missing-required-column, same class of error CSV already returns.

`resolveFingerprintOutcome` is not called here — it's source-agnostic and the route calls it directly for both formats.

### `app/api/accounts/[id]/import/route.ts` (modified)

Added `detectExcelFormat(file)`: checks the uploaded filename extension first (`.xlsx` / `.xls`), then falls back to MIME type (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` / `application/vnd.ms-excel`) for a file whose name was stripped. Three-way branch:

- `.xls` (legacy binary) → 400, "save as .xlsx and re-upload" — exceljs only reads OOXML, so this is rejected before it can be mis-parsed.
- `.xlsx` → `parseExcelFile()`, `ImportSource.EXCEL`.
- Everything else → the original CSV path, byte-for-byte the same logic, just reindented under an `else` — this is **not** a new restriction; no file-type check existed before 4D-2, so the permissive fallback is preserved exactly.

Both branches converge on a `NormalizedRow[]` before the batch-create/loop/finalize body, which is otherwise untouched (only `parsed.rows[i]` / `normalizeRow(...)` inline calls were replaced with the already-normalized `rows` array, and `i + 1` became `row.lineNumber` since Excel rows carry their own line number from the worksheet walk).

No schema change — `ImportSource.EXCEL` already existed in the enum (added ahead of need in an earlier step), confirmed via clean `tsc` with no schema modifications in `git status`.

## 2. A real ecosystem typing gap, not a logic bug

`npx tsc --noEmit` initially failed on `lib/imports/excel.ts`'s `workbook.xlsx.load(buffer)` call:

```
error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'Buffer'.
```

Root cause, confirmed by inspection: `exceljs`'s own dependency `fast-csv` (`@fast-csv/parse`, `@fast-csv/format`) pins `@types/node@^14` as a regular (non-dev) dependency. That's semver-incompatible with this repo's top-level `@types/node@^20`, so npm nests two separate copies (`node_modules/@fast-csv/{parse,format}/node_modules/@types/node@14.18.63`). The resulting ambient `Buffer` type exceljs's `.d.ts` resolves through ends up structurally divergent from the one our own `Buffer.from()` produces — confirmed it's not a simple "wrong generic argument" issue: `buffer as unknown as Buffer` still hit the identical error, since the literal token `Buffer` elaborates to the same divergent type on both sides of that cast. `skipLibCheck` (already `true` in `tsconfig.json`) doesn't cover this — the mismatch surfaces at our call site, not inside a `.d.ts`.

Fix: a narrow `buffer as any` at the one call site, with an `eslint-disable-next-line` and a comment explaining why (`lib/imports/excel.ts`, in the `try` block of `parseExcelFile`). `Buffer.from()` still produces a real Node `Buffer` at runtime regardless of what TypeScript thinks; this only satisfies the type checker. Considered and rejected a tree-wide `package.json` `overrides` to dedupe `@types/node` — fixes the root cause more properly, but expands the diff to touch dependency resolution for the whole tree over one call site in one new file; flagging as a candidate for a future, separate dependency-hygiene pass rather than folding it into this slice.

## 3. Validation

**`npx tsc --noEmit`** — clean after the fix above. No other errors; `route.ts`'s format-sniffing branch and the rest of `excel.ts` type-check clean.

**`npm run lint`** — 0 errors, 4 pre-existing warnings (`<img>` in `AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx` — untouched by this change). The `eslint-disable-next-line` in `excel.ts` is the only lint-relevant addition and is itself why there isn't a 5th warning/error there.

**Pure-function tests** (`npx tsx`, ad hoc script against `lib/imports/excel.ts`'s real `parseExcelFile()`, built real `.xlsx` buffers in-memory with `exceljs` itself rather than hand-rolled fixtures, deleted after running — see §5 on why "deleted" needs a caveat this time):

| Case | Result |
|---|---|
| Happy path — single signed Amount, `creditPositive`, plain strings | ✅ correct date/merchant/amount/category |
| `debitPositive` sign flip (raw `4.5` → `-4.5`) | ✅ |
| Debit/Credit pair columns (sign-unambiguous) | ✅ debit row → `-4.5`, credit row → `2000` |
| Bare Excel serial date numbers `1`, `59`, `60`, `61` | ✅ → `1900-01-01`, `1900-02-28`, `1900-02-28` (phantom day collapses), `1900-03-01` — matches the investigation's documented mapping exactly |
| Formula cells (date + amount via `.result`) | ✅ both resolve correctly |
| Errored formula cell (`#REF!`) | ✅ → `amount: null`, `error: "unparseable amount"`, no throw/coercion |
| Rich-text header + rich-text merchant cell | ✅ both coerced to plain trimmed strings |
| Missing required column (`Foo`/`Bar` headers) | ✅ → file-level error |
| Header-only file (0 data rows) | ✅ → `rows.length === 0`, no error |
| Fully-empty row vs. sparse row | ✅ empty row excluded entirely (not counted); sparse row flows through as a FAILED row |
| Garbage string date / garbage string amount | ✅ → `"unparseable date"` / `"unparseable amount"`, reusing `parseDate`/`parseAmount` from `csv.ts` |
| Workbook with no worksheets | ✅ → file-level error, not a throw |
| Category alias mapping (`Restaurants` → Dining, unknown → Other, blank → Other) | ✅ |

13 cases, 32 assertions, 0 failures.

**A second, real sandbox gap surfaced here** (distinct from §2): importing `lib/imports/excel.ts` transitively imports `lib/imports/csv.ts` → `@/lib/db`, which eagerly constructs a real `PrismaClient` at module scope (`lib/db.ts:7-11`, no lazy guard). Its Node-API engine library load is asynchronous and runs regardless of whether any query is issued; in this sandbox the only generated client is `darwin-arm64` while the sandbox itself is `linux-arm64`, and `npx prisma generate` can't fetch a matching engine (`binaries.prisma.sh` → `403 Forbidden`, no egress) — the identical gap `D2_STEP4D1_IMPLEMENTATION_VALIDATION.md` §4/§95 already documented for the DB-touching path. The difference here: it fires from the *import* itself, not from a query, so it would have blocked even the pure-function tests above, not just a DB-dependent one. It surfaces as an unhandled rejection a tick after import — confirmed via an isolated probe (`import { db } from "./lib/db"` alone reproduces it) — and per Node's default `--unhandled-rejections` behavior, that crashes the process. Worked around in the throwaway test harness only, via `process.on("unhandledRejection", () => {})` at the top of the script, with a comment explaining why; no real source file was touched to make this work. `resolveFingerprintOutcome` itself (the one export that does real DB I/O) is still untested end-to-end for the same reason §4/§95 already gave — it's source-agnostic, called by the route for both CSV and Excel, and was already validated by code trace in 4D-1.

**Scope check** — `git diff --stat`: only `app/api/accounts/[id]/import/route.ts` (125 lines, the format-sniffing branch), `package.json` (+1 line, `exceljs`), `package-lock.json` (dependency tree) modified. New: `lib/imports/excel.ts`, this doc, and the investigation doc. `git diff --stat -- lib/transactions/fingerprint.ts lib/plaid/syncTransactions.ts lib/imports/csv.ts prisma/schema.prisma` is empty — none of those four were touched. No UI files. No legacy table removal. No `CreatorPayout`/billing/`Conversation`/`Message`/support-ticket tables. No `WorkspaceAccountShare` rename.

## 4. What's deferred (unchanged from the investigation's scope cut)

Legacy `.xls`, QuickBooks, rollback, any UI, background/async processing, a generic provider-adapter interface, multi-sheet selection, an `AuditLog` entry for imports (not part of either 4D-1's or 4D-2's approved "Add" list).

## 5. Three leftover scratch files need manual deletion

`_d2_4d2_validate.ts`, `_dbtest.ts` (validation harnesses, §3), and `__touchtest` (a permission probe, §3's investigation into why the first two couldn't be removed) are sitting in the project root, untracked, **not** added to git. The sandbox's virtiofs bridge to this folder doesn't support `unlink`/`rm` from this side — confirmed it's a mount-level restriction, not a per-file permission issue (a fresh empty file hit the same `EPERM`, and the file owner/mode matched the running process exactly). The two `.ts` files were overwritten with an inert one-line comment explaining this so nothing of substance is left behind even though the files themselves persist; `__touchtest` is genuinely empty (0 bytes). None of the three affect `git status`'s tracked-file view of this branch — please delete them directly (Finder or Terminal `rm` on your end will work fine; this is specific to the sandbox's side of the bridge, not a real permission problem on your Mac).

## 6. Rollback plan for this slice

Purely additive — reverting is a normal revert with no data-loss risk:
- Delete `lib/imports/excel.ts`.
- Revert `app/api/accounts/[id]/import/route.ts` to its pre-4D-2 state (the `else` branch is byte-for-byte the old CSV-only body).
- Remove `exceljs` from `package.json` + reinstall.
- No existing route, table, or column was modified — `ImportSource.EXCEL` already existed in the enum before this slice — so there is nothing schema-side to undo.
