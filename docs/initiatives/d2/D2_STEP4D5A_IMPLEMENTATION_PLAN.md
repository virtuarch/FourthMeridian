# D2 Step 4D-5a — Caller-Supplied Column Mapping (Implementation Plan)

Planning only. No code, schema, or migration changes. Per the standing working style ("first produce a short implementation checklist, wait for approval, then implement only that decision") and your explicit "stop after the plan" instruction.

Scope: the smallest safe slice of 4D-5 — let `POST /api/accounts/[id]/import` accept an explicit, caller-supplied column mapping. No persistence, no `ImportMappingProfile` table, no fuzzy matching, no preview UI, no QuickBooks, no provider adapters. Fixed aliases (`detectColumns()`) remain the fast path; if no mapping is supplied, behavior is unchanged.

---

## 1. `NormalizedRow` → `NormalizedTransaction`: rename now or alias first?

**Rename now, as part of 4D-5a.** Not an alias.

Grep confirms `NormalizedRow` is referenced in exactly 3 places: its declaration in `lib/imports/csv.ts`, and imports in `lib/imports/excel.ts` and `app/api/accounts/[id]/import/route.ts`. It's a TS interface only — not a Prisma model, not serialized, not persisted, not consumed outside this repo. A missed reference is a compile error (`tsc --noEmit`), not a runtime bug.

An alias-first strategy earns its cost when a type has many call sites across unrelated subsystems, or crosses a package/serialization boundary where a missed reference could silently misbehave. Neither applies here. Introducing `NormalizedTransaction` as an alias now would just relocate the real rename to a future step without buying any safety — and it means the new 4D-5a mapping code gets written against a temporary name instead of the final one.

Mechanical change: rename the interface in `csv.ts`, update the two import sites, grep-confirm zero remaining `NormalizedRow` references. This can be its own commit, separate from the new mapping logic, but doesn't need to be its own approved slice — it's a pure rename.

Not in scope: `CsvColumnMap` is a different concept (the resolved header-to-field mapping, not the per-row output) and is not renamed.

## 2. Mapping request shape

Add an optional form field, `columnMapping`, a JSON-encoded object whose keys are `CsvColumnMap`'s existing field names and whose values are the exact header string as it appears in the uploaded file:

```
columnMapping: JSON.stringify({
  "date": "Posting Date",
  "merchant": "Narrative",
  "debit": "Debit Amount",
  "credit": "Credit Amount"
})
```

Reasoning: the route already exclusively accepts `multipart/form-data` (`file` + `signConvention`) — there's no JSON body parsing anywhere in this route, and switching the route's content-type contract to carry binary + structured data some other way isn't justified by this slice. A second form field carrying a JSON string is the smallest addition consistent with what's already there.

Field naming: use `reference`, not `externalTransactionId`, for the reference-number field — `reference` is `CsvColumnMap`'s actual key today (it's `normalizeRow()` that maps `reference` → `externalTransactionId` internally). Using `CsvColumnMap`'s own names end-to-end avoids inventing a second vocabulary for the same 8 fields.

**Resolution semantics — explicit mapping is all-or-nothing, never merged with auto-detection:**

- `columnMapping` absent → exactly today's behavior: `detectColumns(headers)` runs unchanged.
- `columnMapping` present → it fully replaces `detectColumns()` for that request. It is validated (next section) and used directly; auto-detection is not consulted for any field, mapped or not.

Partial-merge (explicit mapping for some fields, auto-detect for the rest) was considered and rejected: it's an implicit fallback that contradicts "mapping must be explicit and caller-supplied," and it would mean a request's effective column resolution depends on two different code paths agreeing, which is exactly the kind of surprising interaction this slice should avoid.

## 3. Which of the 12 fields should the mapping support in 4D-5a?

| Field | Support in 4D-5a? | Why |
|---|---|---|
| `date` | Yes | Already a `CsvColumnMap` field |
| `amount` | Yes | Already a `CsvColumnMap` field |
| `debit` | Yes | Already a `CsvColumnMap` field |
| `credit` | Yes | Already a `CsvColumnMap` field |
| `merchant` | Yes | Already a `CsvColumnMap` field |
| `description` | Yes | Already a `CsvColumnMap` field |
| `category` | Yes | Already a `CsvColumnMap` field |
| `reference` (→ `externalTransactionId`) | Yes | Already a `CsvColumnMap` field |
| `transactionType` | No — deferred | Not on `NormalizedTransaction` yet; nothing downstream reads it |
| `balanceAfter` | No — deferred | Same |
| `currency` | No — deferred | Same |
| `rawMetadata` | No — deferred | Same |

The 8 "yes" fields are exactly `CsvColumnMap`'s existing fields — mapping support in 4D-5a is "let the caller supply any subset of `CsvColumnMap` instead of having it auto-detected," nothing more. The 4 "no" fields don't exist on the contract yet; per the sequencing-revision proposal (§5), extending `NormalizedTransaction`'s optional surface is its own piece of work, done once. Wiring mapping support for fields nothing in `normalizeRow()`/`normalizeExcelRow()` populates yet would be dead plumbing — it would pass `tsc`/lint cleanly but have no observable effect, which is the opposite of "smallest safe slice." Recommend doing the contract extension in whichever of 4D-5b/4D-5c actually starts populating those fields, and adding mapping support for them at the same time, not before.

If you'd rather support all 12 now to avoid a second pass through this code later, that's a reasonable call to make — flagging it as an explicit choice rather than deciding it silently.

## 4. Preserving today's behavior when no mapping is supplied

By construction, not by special-casing: the route checks for `columnMapping` in `formData` exactly once, before choosing which function produces `columns`. If absent, the existing line `const columns = detectColumns(parsed.headers)` (CSV) / the existing internal `detectColumns(headers)` call inside `parseExcelFile()` (Excel) runs completely unchanged — same function, same inputs, same `HEADER_ALIASES`, same error shape. Nothing about `normalizeRow()`, `normalizeExcelRow()`, `resolveFingerprintOutcome()`, batch creation, or the per-row loop changes at all in this slice — only what produces the `CsvColumnMap` that feeds them.

## 5. Can CSV and Excel share one mapping shape?

Yes. CSV's headers are already plain strings (`parsed.headers` from `parseCsvText`). Excel's headers are also already coerced to plain strings today (`cellToHeaderString()` inside `parseExcelFile()`, building a `headerIndex: Map<string, number>`) before being handed to `detectColumns()`. A header-string-keyed mapping resolves identically for both: validate the caller's header strings against the same `headers: string[]` list, using the same `normalizeHeader()` comparison `detectColumns()` already uses. Excel's existing `headerIndex` lookup is exactly what's needed to turn a validated header name back into a column index — no new lookup mechanism required.

This means one new function, used by both formats, can replace `detectColumns()` in the explicit-mapping case for both CSV and Excel.

## 6. Schema changes required?

**No.** `CsvColumnMap` and `NormalizedTransaction` are TypeScript interfaces, not Prisma models. `columnMapping` is read from the request and discarded after the column-resolution step — nothing about it is written to any table. `prisma/schema.prisma` is untouched.

## 7. Migration required?

**No.** Follows directly from #6 — no schema change means no migration.

## 8. Validation plan (reusing the existing weird-header fixture)

Same fixture as Part A:

```
Posting Date,Narrative,Transaction Type,Debit Amount,Credit Amount
06/01/2026,COFFEE SHOP PURCHASE,DEBIT,4.50,
06/02/2026,PAYROLL DEPOSIT,CREDIT,,1500.00
```

1. **Regression — without mapping.** Re-run Part A's exact test (no `columnMapping` field) against the post-4D-5a code. Must reproduce Part A's recorded result byte-for-byte: `400`, `{"error":"Could not find a date column. Expected one of: date, transaction date, posted date, post date."}`, for both CSV and Excel. Confirms the no-mapping path is untouched.
2. **Success — with explicit mapping, CSV.** Same fixture, with `columnMapping = {"date":"Posting Date","merchant":"Narrative","debit":"Debit Amount","credit":"Credit Amount"}`. Expect both rows to resolve (row 1: amount `0 - 4.50 = -4.50`; row 2: amount `1500 - 0 = 1500`), no existing fingerprint matches assumed → 2× `CREATE`, response `201` with `importedCount: 2`, `status: "COMPLETED"`.
3. **Success — with explicit mapping, Excel.** Same fixture as an equivalent `.xlsx` workbook, same `columnMapping`. Expect an identical result to #2 — this is the actual test of §5's claim that CSV and Excel can share one mapping shape.
4. **Malformed-mapping cases** (all expected `400`, route-level, before `ImportBatch.create`):
   - Unknown key in `columnMapping` (e.g. `"foo": "bar"`).
   - A mapped value that doesn't match any real header in the file (case/whitespace-insensitively).
   - A mapping supplied but missing `date`.
   - A mapping supplied but missing both `merchant`/`description`.
   - A mapping supplied but missing `amount` and both of `debit`/`credit`.
   - Malformed JSON in the `columnMapping` field itself.
5. **Rollback still works.** Roll back the `ImportBatch` created in #2 via the existing `POST /api/imports/[id]/rollback`. Expect identical behavior to any other batch — confirmed by code-read, not new behavior: the rollback route's soft-delete is scoped only by `importBatchId` + `deletedAt: null` (`app/api/imports/[id]/rollback/route.ts:134`), with no reference anywhere to column mapping or `detectColumns()`. A batch's rows are indistinguishable at rollback time regardless of how their columns were originally resolved, so this needs no new rollback-side logic and no new rollback-side test — only this explicit confirmation that the claim holds, the same structural-proof approach Part A used.

Execution mechanism: identical to Part A — direct `tsx`-executed calls to the pure functions (no DB), since the sandbox still can't reach Postgres or run the real Prisma engine. Route-level wiring (steps 1–4 as HTTP-equivalent results) is established by code-read against the actual route changes, the same substitution Part A used.

## 9. Files expected to change

- **`lib/imports/csv.ts`** — rename `NormalizedRow` → `NormalizedTransaction` (declaration + `normalizeRow()`'s return type). Add a new exported function (working name `applyExplicitMapping(headers: string[], mapping: Record<string, string | null | undefined>): CsvColumnMap | { error: string }`) that validates keys, resolves each mapped value against the real `headers` via the existing `normalizeHeader()`, and enforces the same required-field rules `detectColumns()` enforces (date; merchant-or-description; amount-or-debit/credit). No change to `HEADER_ALIASES`, `detectColumns()`, `normalizeRow()`'s body, `CsvColumnMap`, `parseDate`/`parseAmount`/`mapCategory`.
- **`lib/imports/excel.ts`** — update the `NormalizedRow` import to `NormalizedTransaction` (type-only, 2 usages: `ParsedExcel.rows`, `normalizeExcelRow()`'s return type). Add an optional `explicitMapping` parameter to `parseExcelFile()`; when present, call `applyExplicitMapping(headers, explicitMapping)` instead of `detectColumns(headers)` — same `if ("error" in columns)` branch already there, just a different producer.
- **`app/api/accounts/[id]/import/route.ts`** — update the `NormalizedRow` import to `NormalizedTransaction`. Read the new optional `columnMapping` form field, `JSON.parse` it inside a try/catch (→ 400 on malformed JSON, same pattern as the existing malformed-CSV catch), and either pass it through to `parseExcelFile()` (Excel branch) or call `applyExplicitMapping()` in place of `detectColumns()` (CSV branch, line ~180).
- **New doc** — `docs/initiatives/d2/D2_STEP4D5A_VALIDATION.md`, written after implementation, same paper trail every prior 4D sub-step has.

**Not touched:** `prisma/schema.prisma`, any migration, `lib/transactions/fingerprint.ts`, `app/api/imports/[id]/rollback/route.ts`, `lib/audit-actions.ts`, any UI, `lib/data/transactions.ts`.

## 10. Risk level and rollback plan

**Risk: low.**

- No schema/migration — there's no database-state concern to roll back, only code.
- The no-mapping path is provably unchanged (same function, same call, gated behind a single new `if (columnMapping present)` check) rather than restructured.
- The rename is compile-time-checked, not a runtime risk — `tsc --noEmit` catches any missed reference; there's no DB-persisted name or external consumer to break silently.
- Blast radius is exactly 3 files, all enumerated above.

**Rollback plan:** revert the 4D-5a commit/PR. Since nothing is persisted (no `ImportMappingProfile`, no new column, no new table), there's no migration-down step and no orphaned-data cleanup — any import that used an explicit mapping while this was live produced an ordinary `ImportBatch` + `Transaction` rows, indistinguishable from an auto-detected import, because the mapping itself is never stored anywhere. A code revert alone is fully sufficient.

---

## Impact map

| Area | Affected? | Detail |
|---|---|---|
| `prisma/schema.prisma` / migrations | No | Pure code change, see §6/§7 |
| `detectColumns()` / `HEADER_ALIASES` | No | Untouched; remains the fast path (no-mapping case) |
| `normalizeRow()` / `normalizeExcelRow()` | No | Consume `CsvColumnMap` regardless of producer; no change needed |
| `resolveFingerprintOutcome()` / `lib/transactions/fingerprint.ts` | No | Downstream of column resolution; unaffected |
| Rollback route | No | Scoped by `importBatchId`/`deletedAt` only; see §8.5 |
| `lib/imports/csv.ts` | Yes | Rename + new `applyExplicitMapping()` |
| `lib/imports/excel.ts` | Yes | Rename (type-only) + optional new param |
| `app/api/accounts/[id]/import/route.ts` | Yes | Rename (type-only) + read/parse/branch on `columnMapping` |
| UI | No | Out of scope per your constraints |
| QuickBooks / provider adapters | No | Out of scope per your constraints |

## Implementation checklist (for approval — not yet executed)

1. Rename `NormalizedRow` → `NormalizedTransaction` in `lib/imports/csv.ts`; update the two import sites in `excel.ts` and `route.ts`; grep-confirm zero remaining `NormalizedRow` references.
2. Add `applyExplicitMapping(headers, mapping)` to `lib/imports/csv.ts`, next to `detectColumns()`, reusing `normalizeHeader()`.
3. Add the optional `explicitMapping` parameter to `parseExcelFile()` in `lib/imports/excel.ts`.
4. Wire `columnMapping` form-field parsing + branch into `app/api/accounts/[id]/import/route.ts` (CSV and Excel branches).
5. Run `npx tsc --noEmit` and `npm run lint`.
6. Run the validation plan in §8 (regression, success ×2, malformed-mapping ×6, rollback confirmation).
7. Write `D2_STEP4D5A_VALIDATION.md`.
8. Confirm scope via `git diff --stat` (expect exactly the 3 files in §9 plus the new doc).

## Out of scope (4D-5a)

`ImportMappingProfile` table or any persistence of a mapping. Header-signature hashing or lookup. Fuzzy/string-similarity suggestion. Preview UI or any UI at all. `transactionType`/`balanceAfter`/`currency`/`rawMetadata` mapping support (deferred per §3). QuickBooks parsing. Step 5 provider/sync adapter work. Any widening of `HEADER_ALIASES`. Any change to `detectColumns()`'s own logic, error messages, or alias lists.

---

**Stopping here per your instruction — no code, schema, or migration changes made. Awaiting approval before implementing this checklist.**
