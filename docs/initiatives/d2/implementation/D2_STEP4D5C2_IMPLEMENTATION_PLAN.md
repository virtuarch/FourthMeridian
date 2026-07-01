> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5c-2 — Import Preview Endpoint (Implementation Checklist)

**Checklist only. No code, schema, or migration changes accompany this document.** Treats `docs/initiatives/d2/D2_STEP4D5C_PREVIEW_INVESTIGATION.md` (approved investigation) and the completed 4D-5c-1 extraction as authoritative. Does not re-litigate either.

Scope: add `POST /api/accounts/[id]/import/preview`. Read-only. Persists nothing — no `ImportBatch`, no `Transaction`, no `ImportMappingProfile.useCount`/`lastUsedAt` bump. No suggestions/fuzzy mapping (4D-5c-3). No UI.

## 1. Route file

New file: `app/api/accounts/[id]/import/preview/route.ts`. Exports `POST` only, wrapped in `withApiHandler(...)`, same as the existing confirm route — Next.js app-router convention, `[id]` continues to mean `FinancialAccount.id`.

## 2. Sharing auth/account-visibility logic

The confirm route's account-resolution block (`route.ts` current lines ~116-139: `SpaceAccountLink` lookup → legacy-`Account` fallback → 404/400) is exactly the check preview must not relax (investigation §10 risk #7 — a `MATCH` result already reveals something about the account's existing history, so preview needs the same gate as confirm, not a looser one).

**Recommendation: extract this block into a small shared helper, `lib/imports/authorize.ts` → `resolveImportableFinancialAccount(spaceId, id)`,** returning a discriminated result so both routes keep their own early-return control flow:

```ts
type ImportAccountAccess =
  | { ok: true; financialAccountId: string }
  | { ok: false; response: NextResponse };
```

Both routes call it identically:
```ts
const access = await resolveImportableFinancialAccount(spaceId, id);
if (!access.ok) return access.response;
const { financialAccountId } = access;
```

Why extract rather than duplicate: this is the same drift risk the investigation flags for the pipeline itself (§10 risk #3) — if preview's copy of this check silently rots while confirm's gets patched (or vice versa), the inconsistency is an authorization bug, not a display bug. The block is small (~25 lines, two `db` reads, no business logic), so extracting it is mechanical and behavior-preserving — the same character of change as 4D-5c-1's pipeline extraction, not a new design.

This means the confirm route gets one more small edit in this slice (replace its inline block with the helper call). That edit is pure refactor — same two queries, same NextResponse bodies/status codes, byte-identical responses — and should be validated the same way 4D-5c-1's route edit was (diff review + the existing rollback fixture/route behavior unchanged).

**Deliberately not extracted further** (to avoid over-refactoring beyond what this slice needs): the `FormData`/`signConvention`/`explicitMapping` JSON-parsing block (~45 lines of input-shape validation) and the saved-profile fetch (~15 lines, a single sorted `findMany`). Both are duplicated verbatim into the new preview route. Neither is the kind of logic the investigation's drift concern is about (no classification, no persistence, no auth decision) — they're per-request input plumbing. If this duplication becomes a real maintenance problem later, extracting it is a trivial additive follow-on, not something to preempt now.

## 3. Preview response shape

Narrower than the investigation's full §3 draft, because suggestions (4D-5c-3) aren't built yet. Two scope decisions worth flagging explicitly before implementation:

- **Resolution failure (no auto-detect, no explicit mapping, no saved-profile match) returns the same `{ error }` / 400 the confirm route returns today** — not the investigation's `resolved: false` / `rawHeaders` / `suggestedMapping` shape. That shape only makes sense once 4D-5c-3 exists to populate `suggestedMapping`; shipping it now with an always-empty suggestion would be a half-built contract that 4D-5c-3 would then have to change. Confirm's existing hard-error behavior is unaffected either way.
- **No `matchedTransactionId` on `MATCH` rows.** The confirm route's loop never reads an id off `resolveFingerprintOutcome()`'s `MATCH` result — it only checks `result.outcome`. Populating this field would mean changing that function's return shape, which conflicts with "no fingerprint behavior changes." Dropped from this slice's payload; revisit only if a later UI slice needs it (would be a small, additive change to `resolveFingerprintOutcome()`'s return type, not a behavior change to classification itself).

Resolved-case shape for this slice:

```ts
interface ImportPreviewResponse {
  source: "CSV" | "EXCEL";
  resolvedColumnMapping: CsvColumnMap;
  matchedProfileId: string | null;
  signConvention: "creditPositive" | "debitPositive";

  summary: {
    totalRows: number;
    willCreate: number;
    willMatch: number;
    willSkip: number;
    willFail: number;
  };

  dateRange: { earliest: string | null; latest: string | null }; // ISO, successfully-parsed rows only

  rows: Array<{
    lineNumber: number;
    date: string | null;
    merchant: string | null;
    description: string | null;
    category: NormalizedTransaction["category"];
    amount: number | null;
    externalTransactionId: string | null;
    classification: "CREATE" | "MATCH" | "SKIP" | "FAILED";
    reason: string | null; // populated for SKIP/FAILED, same strings errorSummary already uses
  }>; // capped — see §4

  errors: Array<{ row: number; reason: string }>; // same shape as ImportBatch.errorSummary, capped — see §4
}
```

`summary`/`dateRange` are computed over every row in the file (classification already has to touch every row to produce accurate counts — see §5). Only `rows` and `errors` are capped.

## 4. Row cap

Fixed server-side constant, not a client-supplied parameter, per investigation §3's recommendation. **`PREVIEW_ROW_CAP = 50`**, defined in the new route file (no other consumer yet — promote to a shared constant only if a second caller appears). `rows` and `errors` are each truncated to the first `PREVIEW_ROW_CAP` entries in file order; `summary` counts are unaffected by the cap.

## 5. Classification loop design

Mirrors the confirm route's existing per-row branch (current lines ~275-319) as closely as possible, with persistence removed:

1. `for (const row of rows)` — sequential, same structure as confirm. Nothing is written here, so there's no within-file-duplicate race to protect against the way confirm's loop has to — but keeping the same sequential shape (rather than switching to `Promise.all`) keeps this slice's diff easy to reason about against confirm's loop, and avoids firing an unbounded burst of concurrent `resolveFingerprintOutcome()` calls (each up to two-three DB reads) per request. Parallelizing read-only classification is a legitimate future perf optimization (investigation §10 risk #2) — not done in this slice.
2. Same early-fail check: `if (row.error || !row.date || row.amount === null || !row.merchant)` → `willFail++`, push `{ row: lineNumber, reason }`, `continue` (never reaches classification) — identical to confirm.
3. Otherwise, `await resolveFingerprintOutcome(financialAccountId, row.date, row.amount, row.merchant, row.externalTransactionId)` wrapped in the same `try`/`catch` confirm uses (an unexpected error counts as `willFail`, logged via `console.error` — message text says "preview" instead of referencing a batch id, since there is no batch).
4. `CREATE` → `willCreate++` (no `db.transaction.create()` call — this is the entire point of this slice). `MATCH` → `willMatch++`. `SKIP` → `willSkip++`, push `{ row: lineNumber, reason: result.reason }`.
5. If `rows.length` (the array index, 0-based) is below `PREVIEW_ROW_CAP`, also push the row's preview shape (§3) into the capped output array. Capping the *output* array, not the loop itself — the loop must still run over every row so `summary` stays accurate (per §3/§4).

**Known, documented behavior difference from confirm, not a bug:** two identical rows within the same previewed file will both classify as `CREATE` in preview, because preview never writes the first one, so the second never finds it. Confirming the same file will correctly classify the second as `MATCH` against the `Transaction` the confirm route's loop just created for the first — that's the existing, unmodified within-file duplicate-detection invariant, untouched by this slice. This is the same staleness category the investigation already names in §10 risk #1 (preview is a snapshot; confirm is authoritative) — call it out in the route's module-header comment so it isn't later mistaken for a regression.

## 6. Proving no writes occur

Three layers, since this sandbox has no working Prisma engine to run a live-DB execution test against (per the 4D-5c-1 validation report's documented constraint):

1. **Structural, not just behavioral:** the new route's code simply never references `db.importBatch.create`, `db.transaction.create`, or `db.importMappingProfile.update` — confirmed by `grep -n "importBatch.create\|transaction.create\|importMappingProfile.update" app/api/accounts/\[id\]/import/preview/route.ts` returning nothing. Absence-by-construction, not a runtime guard.
2. **Reuse of already-proven code:** `runImportPipeline()` (zero `db` references, 39/39 fixture-validated in 4D-5c-1) and `resolveFingerprintOutcome()` (investigation-confirmed read-only: `findFirst`/`findMany` only) are both unmodified inputs to this route — their no-write property doesn't need to be re-proven, only their call sites need reviewing for what happens with their results.
3. **`git diff --stat` scoped check:** confirms the only files touched are the new preview route, the new `lib/imports/authorize.ts` helper, and the confirm route's small edit to call that helper — no schema/migration files, matching the investigation §6 lifecycle recommendation (no `ImportBatch` row until confirm, zero schema impact) exactly.

## 7. Validation plan

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (same pre-existing warning baseline as every prior step in this initiative).
- Grep-based no-write proof (§6.1).
- Fixture-driven (`tsx`) test of `lib/imports/authorize.ts`'s `resolveImportableFinancialAccount()` — DB-touching (`SpaceAccountLink.findFirst`/`Account.findFirst`), so subject to the same sandbox Prisma-engine constraint 4D-5c-1 hit; reuse the same CJS `require.cache` db-stub *technique* but this time the stub must return canned query results (active link / legacy-only / not-found cases) rather than throw, since this helper's logic is exercising the db-read branches themselves, not proving their absence. If that proves more fragile than it's worth, fall back to code-read-only validation for this one function (it's a direct lift of already-shipped, already-tested logic, low risk either way) and say so plainly in the validation report — don't force an execution test that isn't earning its cost.
- `git diff --stat` scoped check (§6.3).
- Manual/local route testing (this sandbox can't run a live dev server against a real DB) — to be run by whoever has a working local Prisma engine: normal CSV preview, normal Excel preview, explicit-mapping preview, saved-profile preview, a file that fails resolution (expect the same 400 `{ error }` confirm would give), an unauthorized/nonexistent account id (expect 404, identical to confirm), a file with >50 rows (expect `summary` counts reflect all rows, `rows`/`errors` arrays capped at 50), and — the one check that actually proves "no writes" end-to-end — record `ImportBatch`/`Transaction`/`ImportMappingProfile` row counts for the account before and after a preview call and confirm they're unchanged, then run the same file through the existing confirm endpoint afterward and confirm *that* still behaves exactly as it does today.

## 8. Files expected to change

| File | Change |
|---|---|
| `app/api/accounts/[id]/import/preview/route.ts` | New. The preview route. |
| `lib/imports/authorize.ts` | New. `resolveImportableFinancialAccount()`, extracted from the confirm route's inline auth block. |
| `app/api/accounts/[id]/import/route.ts` | Small edit — inline auth block replaced with a call to the new helper. No other change. |

Nothing else. No `prisma/schema.prisma`, no migration, no UI, no `app/api/imports/[id]/rollback/route.ts` (confirmed by the investigation §7 — rollback only ever operates on a real `ImportBatch.id`, and preview never creates one).

## 9. Rollback plan

Pure code revert, no data/migration to reverse (nothing was ever persisted by this slice, by construction): delete `app/api/accounts/[id]/import/preview/route.ts`; revert the confirm route's edit (restore its inline auth block) or, if the extraction is left in place, simply delete the new preview route and leave the helper — the extraction itself is behavior-preserving and safe to keep on its own, same reasoning the 4D-5c-1 report applied to its pipeline extraction. Delete `lib/imports/authorize.ts` only if reverting the confirm-route edit too. No interaction with the rollback feature (4D-3) either way.

---

**Stopping here per instruction — checklist only, no implementation.** Awaiting approval before writing any of the three files in §8.
