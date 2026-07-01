> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D — Weird Header Failure Test (Validation Report, Part A)

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`.

Validation only. No application code, route, schema, or migration was changed. `lib/imports/csv.ts` and `lib/imports/excel.ts` are untouched.

## 1. Why this couldn't be a real HTTP test

The route (`POST /api/accounts/[id]/import`) sits behind `requireUser()`, which needs a live NextAuth session backed by Postgres. This sandbox cannot reach the project's database (`localhost:5432` → `ECONNREFUSED`, re-confirmed via a raw TCP connect test), so no authenticated request can be made to the real endpoint from here — consistent with every prior D2 step's validation section.

Instead, this test called the exact two functions the route calls to validate file shape — `detectColumns()` (via `parseCsvText()`) and `parseExcelFile()` — directly, via a temporary `tsx`-executed script. These are pure functions with no DB calls, so this exercises the real, unmodified production logic, just without the HTTP/auth wrapper around it. The route-level behavior is then established by code-read (§4 below), not by assumption.

## 2. Request used

Deliberately unsupported headers, as specified:

```
Posting Date,Narrative,Transaction Type,Debit Amount,Credit Amount
06/01/2026,COFFEE SHOP PURCHASE,DEBIT,4.50,
06/02/2026,PAYROLL DEPOSIT,CREDIT,,1500.00
```

Tested in two forms: as raw CSV text (`parseCsvText()` → `detectColumns()`, the path `POST /api/accounts/[id]/import` takes for non-Excel uploads), and as an equivalent in-memory `.xlsx` workbook with the same headers/rows (`parseExcelFile()`, the Excel branch).

None of `Posting Date`, `Narrative`, `Transaction Type`, `Debit Amount`, or `Credit Amount` match any entry in `HEADER_ALIASES` in `lib/imports/csv.ts` (`date`, `transaction date`, `posted date`, `post date` for the date column; similarly fixed lists for the others), and matching is exact-string-equality after normalization, not substring — so this fixture is a true miss, not a near-miss.

## 3. Response status and body

**CSV path** — `detectColumns()` returns:

```json
{ "error": "Could not find a date column. Expected one of: date, transaction date, posted date, post date." }
```

Date is checked first inside `detectColumns()`, so this is the error returned regardless of the other four unsupported headers. The route's CSV branch (`app/api/accounts/[id]/import/route.ts:180-183`) wraps this directly:

```ts
const columns = detectColumns(parsed.headers);
if ("error" in columns) {
  return NextResponse.json({ error: columns.error }, { status: 400 });
}
```

**Equivalent HTTP response:** `400`, body `{"error":"Could not find a date column. Expected one of: date, transaction date, posted date, post date."}`.

**Excel path** — `parseExcelFile()` calls the same `detectColumns()` internally and returns the identical error object. The route's Excel branch (lines 164-167):

```ts
const parsed = await parseExcelFile(buffer, signConvention);
if ("error" in parsed) {
  return NextResponse.json({ error: parsed.error }, { status: 400 });
}
```

**Equivalent HTTP response:** `400`, same body as the CSV path.

Both formats fail identically, for the identical reason, since the Excel parser delegates column detection to the same shared function.

## 4. Whether failure happens before `ImportBatch.create` — code-read proof

In `app/api/accounts/[id]/import/route.ts`:

- Excel branch error-return: lines 165-166
- CSV branch error-return: lines 181-182
- `const batch = await db.importBatch.create({...})`: line 191

Line 191 is the **only** `ImportBatch.create` call in the file, and it is lexically and sequentially after both error-return points — there is no branch, loop, or early-return path that reaches line 191 without first passing the Excel check (165) or the CSV check (181). The route's own comment directly above line 191 states this invariant: "Only created once the file shape is known-valid — a file with the wrong columns never becomes an ImportBatch row."

The only `db.transaction.create` call in the file is inside the per-row loop, which runs strictly after `batch` exists (it needs `batch.id`) and after `rows` has been built from already-validated columns. So a header-shape failure also can't reach that call.

**Conclusion: failure happens before any `ImportBatch` or `Transaction` row would be created.** This is a structural guarantee from control flow, not a runtime observation — confirmed by reading the route, not by hitting a live database.

## 5. Database verification

Not performed against a live database — the sandbox can't reach Postgres (§1). This isn't a gap specific to this test: no D2 step in this initiative has been able to run live-DB verification from this sandbox. The structural proof in §4 is offered as the substitute: since the code path that would create rows is unreachable when `detectColumns()`/`parseExcelFile()` return an error, there are no rows to find regardless of which database holds them. Existing imported/rolled-back rows are untouched for the same reason — nothing on this path writes, reads, or deletes any `Transaction` or `ImportBatch` row belonging to a different batch.

If you want this re-confirmed against the real database, the fastest check is: note current `ImportBatch` and `Transaction` row counts, submit the fixture above through the real UI/endpoint, and confirm the counts are unchanged and the response was a 400.

## 6. Safety assessment

The failure mode is safe: it's a synchronous, pre-write validation check returning a 400 with a specific, actionable error message ("Could not find a date column. Expected one of: ..."), not a 500, not a silent partial import, and not a thrown unhandled exception. Both formats fail through the same shared `detectColumns()` logic, so the guarantee is uniform across CSV and Excel rather than something that happens to hold for one format and not the other. No code change is required to make this safe — it already is.

## 7. Sandbox note (unrelated finding, disclosed for completeness)

Running this test surfaced a more precise diagnosis of the long-standing "DB unreachable" sandbox limitation: `lib/imports/csv.ts` imports `lib/db.ts` at module scope, which calls `new PrismaClient(...)` at load time. This sandbox's generated Prisma Client targets `darwin-arm64` (the user's Mac) but the sandbox runtime is `linux-arm64` — an environment mismatch, not an application bug. The engine loader's background probe doesn't surface as a `PrismaClientInitializationError` until the event loop yields, which is why the CSV half of this test (fully synchronous) ran clean while the Excel half (awaits `ExcelJS`) tripped it — needed a `process.on("unhandledRejection", ...)` guard in the throwaway test harness only; no application file was touched to work around this.

**Separately:** this sandbox cannot unlink files inside this mounted folder — `rm`, `unlink`, cross-filesystem `mv`, and Python's `os.remove()` all returned "Operation not permitted" (same restriction already seen on `.git/index.lock` in prior steps' validation sections, just hit directly here for the first time). The throwaway test script (`scripts/tmp-4d3-weird-header-validation.ts`) could not be deleted; its content has been overwritten with an inert placeholder explaining this and naming the file. Same for an empty scratch file created while diagnosing this (`scripts/__delete_test__.txt`). Both are untracked (`git status --short` shows `??`, never committed) and harmless to the app, but need a manual:

```
rm scripts/tmp-4d3-weird-header-validation.ts scripts/__delete_test__.txt
```

---

**Result: both CSV and Excel weird-header uploads fail safely with a 400 before any `ImportBatch` or `Transaction` row is created. No application code was modified to reach this conclusion.**
