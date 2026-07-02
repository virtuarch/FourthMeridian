> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5b — ImportMappingProfile (Implementation + Validation Report)

Implements the approved checklist in `docs/initiatives/d2/D2_STEP4D5B_IMPLEMENTATION_PLAN.md`: Option A (`validateResolvedColumns()` extracted, both `detectColumns()`/`applyExplicitMapping()` refactored onto it, all existing error strings preserved exactly), `ImportMappingProfile` keeping `lastUsedAt`/`useCount`. No UI, QuickBooks, billing, or unrelated-decision work was done.

## Update — local Prisma generate/migrate succeeded

This sandbox itself cannot run `npx prisma generate` or `npx prisma migrate dev` directly (direct `curl` confirms `binaries.prisma.sh`, Prisma's engine-binary CDN, returns `403 Forbidden` / `X-Proxy-Error: blocked-by-allowlist` from this sandbox, while general internet access works fine — `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` doesn't help, since it only skips checksum verification *after* a download, not the blocked download itself). **You ran both locally and they succeeded**: `npx prisma generate` and the migration applied cleanly, and your local lint run was clean (0 errors, same 4 pre-existing warnings). Because this sandbox shares the same mounted project folder, the regenerated Prisma Client (TypeScript types) is now visible here too, which is what let the remaining steps below be re-verified from this sandbox.

That local run surfaced one residual error, now fixed (see "JSON-typing fix" below): `resolvedColumnMapping: resolvedColumns` at `route.ts:289` didn't satisfy Prisma's Json input type. All stale-client-type errors from the earlier draft of this report (the `importMappingProfile does not exist on PrismaClient` ones) are gone now that the client reflects the new schema — confirmed by the clean `tsc` run below.

### JSON-typing fix

`CsvColumnMap` (a plain interface: `date: string` plus seven `string | null` fields) is structurally JSON-compatible, but TypeScript doesn't treat it as assignable to Prisma's `InputJsonObject` (`{ readonly [Key in string]?: InputJsonValue | null }`) — a named interface without its own index signature isn't assignable to an indexed type, even when every property's type would satisfy that signature. A direct `as Prisma.InputJsonValue` cast was rejected by `tsc` itself ("neither type sufficiently overlaps with the other"), so the fix goes through `unknown` first: `resolvedColumns as unknown as Prisma.InputJsonValue`, applied only at the `ImportBatch.create()` call site (`route.ts:296`, after adding `Prisma` to the existing `@prisma/client` import). No schema, migration, `CsvColumnMap`, or route-behavior change — the value written is identical, this only satisfies the type checker. Same `as unknown as X` pattern as the pre-existing exceljs `Buffer`-typing workaround in `lib/imports/excel.ts`'s `parseExcelFile()`, called out there for an analogous reason (a real, compatible value whose declared type doesn't line up with what the library's `.d.ts` expects).

`npx tsc --noEmit` is now clean (exit 0) and `npm run lint` is unchanged (0 errors, the same 4 pre-existing `@next/next/no-img-element` warnings) — both re-verified from this sandbox after the fix, using the Prisma Client your local `generate` produced.

## Bug found and fixed during validation

While reading `lib/imports/excel.ts` end-to-end before writing the validation script, `parseExcelFile()` had two `const resolved` declarations in the same function scope: `const resolved = resolveColumns(...)` and, later, `const resolved: ResolvedColumnIndexes = {...}`. That's a duplicate block-scoped identifier — a hard `tsc` error (`Cannot redeclare block-scoped variable 'resolved'`), not a runtime ambiguity. Renamed the second one to `resolvedIndexes` (and its one downstream use in the `eachRow` callback). No behavior change — purely a naming collision introduced while writing the 4D-5b edit, caught by `tsc` rather than by inspection alone. This is reflected in the `lib/imports/excel.ts` diff stat below.

## Files changed

```
app/api/accounts/[id]/import/route.ts | 104 +++++++++++++++++++++---
lib/imports/csv.ts                    | 146 +++++++++++++++++++++++++++++++---
lib/imports/excel.ts                  |  53 ++++++++----
prisma/schema.prisma                  |  66 +++++++++++++++
4 files changed, 334 insertions(+), 35 deletions(-)
```

(`route.ts` grew from the pre-fix 91/322 to 104/334 insertions — the added `Prisma` import, the cast's explanatory comment, and the `as unknown as Prisma.InputJsonValue` cast itself, all from the JSON-typing fix below.)

New, untracked (not modifications): `prisma/migrations/20260627130000_d2_4d5b_import_mapping_profiles/`, `docs/initiatives/d2/D2_ARCHITECTURE_REVIEW_PRE_4D5B.md`, `docs/initiatives/d2/D2_STEP4D5B_IMPLEMENTATION_PLAN.md`, this report, `docs/initiatives/d2/D2_FINGERPRINT_CONFIDENCE_FUTURE_DESIGN_NOTE.md`, and a temporary validation script (see Known leftovers). No other tracked file changed.

- **`prisma/schema.prisma`** — new `ImportMappingProfile` model (`id`, `spaceId`/`space`, `name`, `source`, `institutionLabel`, `mapping: Json`, `createdByUserId`/`createdByUser`, `lastUsedAt`, `useCount @default(0)`, `createdAt`/`updatedAt`, `@@unique([spaceId, name])`, `@@index([spaceId])`, `@@index([createdByUserId])`); `ImportBatch.mappingProfileId`/`mappingProfile` relation (`onDelete: SetNull`) + `resolvedColumnMapping: Json?`; back-relations on `User`/`Space`.
- **`lib/imports/csv.ts`** — added `ColumnValidationFailure` + `validateResolvedColumns()` (the 3 required-field rules, extracted once); refactored `detectColumns()`/`applyExplicitMapping()` to call it while keeping each function's own pre-existing error strings; added `SavedMappingProfileLite` + `resolveColumns()` (priority: explicitMapping → detectColumns → first-matching saved profile in caller-supplied order).
- **`lib/imports/excel.ts`** — `parseExcelFile()` gained a `savedProfiles?` 4th parameter; delegates header resolution to `resolveColumns()` instead of its own `explicitMapping ? applyExplicitMapping(...) : detectColumns(...)` ternary; `ParsedExcel` now also returns `columns`/`matchedProfileId`. Fixed the `resolved`/`resolvedIndexes` naming collision described above.
- **`app/api/accounts/[id]/import/route.ts`** — fetches this Space's `ImportMappingProfile` rows (`lastUsedAt desc nulls last, createdAt desc`) once per request; CSV branch calls `resolveColumns()`, Excel branch's call to `parseExcelFile()` gains the `savedProfiles` argument; `db.importBatch.create()` now sets `resolvedColumnMapping` (every path) and `mappingProfileId` (saved-profile path only); after the batch reaches a final status, a matched profile's `useCount`/`lastUsedAt` are bumped via atomic `{ increment: 1 }`, wrapped in try/catch so a bump failure can't fail an otherwise-successful import response.

## Validation results

### tsc / lint

- `npx tsc --noEmit` — **clean (exit 0).** The 4 errors originally reported here (`importMappingProfile does not exist on PrismaClient` ×2, `resolvedColumnMapping does not exist in type ImportBatchUncheckedCreateInput`, and one cascading implicit-`any`) were all stale-Prisma-Client artifacts of this sandbox's inability to run `npx prisma generate`/`migrate dev` directly — they cleared once you ran both locally (see "Update" section at top). That local run surfaced one further, real typing gap — `CsvColumnMap` not satisfying Prisma's Json input type at the `ImportBatch.create()` call site — fixed narrowly via the `as unknown as Prisma.InputJsonValue` cast described above. Re-run from this sandbox after the fix, using the Prisma Client your local `generate` produced: 0 errors.
- `npm run lint` — clean; 4 pre-existing `@next/next/no-img-element` warnings in `AccountModal.tsx`/`TotpSection.tsx`/`CoinIcon.tsx` — unrelated, no `<img>` tags touched. Matches your local lint run.

### Functional validation suite

Run via `npx tsx scripts/tmp-4d5b-validation.ts` — direct calls to `detectColumns()`, `applyExplicitMapping()`, `resolveColumns()`, and `validateResolvedColumns()` (pure functions, no DB). 27/27 checks passed. Mapped onto the 9-point "Required" step 6 checklist:

| # | Checklist item | Result |
|---|---|---|
| 1 | No-profile/no-mapping regression unchanged | `detectColumns()` on an unresolvable header set returns the exact pre-4D-5b error; `resolveColumns()` with no `explicitMapping`/`savedProfiles` falls through to the identical error. Standard auto-detectable headers resolve identically to pre-4D-5b, `matchedProfileId: null`. |
| 2 | Explicit mapping still works | `applyExplicitMapping()` unchanged; `resolveColumns()` with `explicitMapping` set never consults `savedProfiles` (proved with a profile deliberately positioned to match if it were reached) and wins priority even when `detectColumns()` would also have succeeded on the same headers. |
| 3 | Saved profile works | A header set `detectColumns()` cannot resolve, with a saved profile supplied, resolves via that profile and returns its `id` as `matchedProfileId`. First-array-match-wins confirmed both directions (reordering two equally-matching profiles changes which one's `id` comes back) — `resolveColumns()` does no internal sorting, as documented. |
| 4 | Saved profile survives an added unrelated column | Same profile, same base headers, plus an extra `"Running Balance"` column — still matches, extra column ignored. |
| 5 | Saved profile fails when a mapped required column is renamed/removed | Profile's mapped `"date"` header (`"Posting Date"`) renamed to `"Txn Date"` or removed outright — `resolveColumns()` falls through to `detectColumns()`'s own error (its documented fallback). Confirmed directly via `applyExplicitMapping()` that the underlying failure mode is "mapped column ... was not found in the file's headers" — the same pre-existing error string, just not the one `resolveColumns()` ultimately surfaces (it surfaces `detectColumns()`'s error as the final fallback, per its own priority-order documentation, not `applyExplicitMapping()`'s). |
| 6 | Error strings from `detectColumns()`/`applyExplicitMapping()` byte-identical | All 8 distinct error strings (3 from `detectColumns()`, 5 from `applyExplicitMapping()`) checked verbatim against their pre-4D-5b text — all 8 byte-identical. |
| 7 | `resolvedColumnMapping` stored on `ImportBatch` | Code-read: `route.ts:286-291` — `db.importBatch.create()`'s `data` always includes `resolvedColumnMapping: resolvedColumns`, on both the CSV branch (`resolved.columns` from `resolveColumns()`, route.ts:270) and the Excel branch (`parsed.columns` from `parseExcelFile()`, route.ts:249) — set unconditionally, never inside an `if`. |
| 8 | `mappingProfileId` stored only for saved-profile path | Code-read: `matchedProfileId` is declared `let matchedProfileId: string \| null = null` (route.ts:239) and only reassigned from `resolved.matchedProfileId` (CSV, route.ts:271) or `parsed.matchedProfileId` (Excel, route.ts:250) — both of which trace back to `resolveColumns()`'s own return value, which is non-null *only* inside its saved-profile loop (`csv.ts:307-312`); the `explicitMapping` branch and the `detectColumns()` branch each explicitly return `matchedProfileId: null` (`csv.ts:299`, `csv.ts:304`). |
| 9 | Rollback route unaffected | Code-read: `app/api/imports/[id]/rollback/route.ts` (full file, unmodified this step) has zero references to `resolveColumns`, `resolvedColumnMapping`, `mappingProfileId`, or `ImportMappingProfile`. Its `Transaction` soft-delete is scoped only by `importBatchId` + `deletedAt: null` (line 134) and its eligibility/permission/audit logic is unchanged — a batch's rows are indistinguishable at rollback time regardless of which of the three resolution sources produced their columns. |

### Usage-counter bump (code-read, not DB-executable here)

`route.ts:368-380` — guarded by `if (matchedProfileId)`, so it only runs on the saved-profile path (item 8's null-by-default guarantee applies here too). Runs after `db.importBatch.update()` sets the batch's final status, using `{ useCount: { increment: 1 } }` (atomic, not read-then-write) and `lastUsedAt: new Date()`. Wrapped in try/catch with `console.error` — a bump failure is logged but does not change the route's response or the import's outcome, matching the plan's "non-fatal" requirement.

## Scope confirmation

```
$ git status --short
 M app/api/accounts/[id]/import/route.ts
 M lib/imports/csv.ts
 M lib/imports/excel.ts
 M prisma/schema.prisma
?? docs/initiatives/d2/D2_ARCHITECTURE_REVIEW_PRE_4D5B.md
?? docs/initiatives/d2/D2_FINGERPRINT_CONFIDENCE_FUTURE_DESIGN_NOTE.md
?? docs/initiatives/d2/D2_STEP4D5B_IMPLEMENTATION_PLAN.md
?? docs/initiatives/d2/D2_STEP4D5B_VALIDATION.md
?? prisma/migrations/20260627130000_d2_4d5b_import_mapping_profiles/
?? scripts/tmp-4d5b-validation.ts
```

Exactly the 4 files the approved checklist scoped, plus the new migration directory, the two planning docs already produced before implementation began, and the temporary validation script below. No UI files, no QuickBooks/billing/provider-adapter files, no unrelated schema models, no removal of any legacy table or column. `HEADER_ALIASES`, `detectColumns()`'s alias-matching algorithm, and `normalizeRow()`'s body are all untouched — confirmed both by code-read and by checklist item 6's byte-identical error strings.

## Known leftovers

The temporary validation script cannot be deleted from this sandbox (no unlink access to the mounted folder — same constraint noted in `D2_STEP4D5A_VALIDATION.md`). It's been neutralized to an inert comment-only placeholder. Manual removal:

```
rm scripts/tmp-4d5b-validation.ts
```

A stale `.git/index.lock` (zero bytes) also exists in the repo and could not be removed from this sandbox for the same reason; it didn't block `git status`/`git diff --stat` above, but you may want to `rm .git/index.lock` locally if `git` complains.
