> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5c-3 — Suggestions (Implementation + Validation Report)

Implements `docs/initiatives/d2/D2_STEP4D5C3_IMPLEMENTATION_PLAN.md` (approved checklist) exactly. No scope beyond that checklist.

## 1. What changed

| File | Change |
|---|---|
| `lib/imports/suggest.ts` | New. `suggestColumnMapping(rawHeaders)` — deterministic Levenshtein-similarity best-guess mapping against `csv.ts`'s existing `HEADER_ALIASES`. No npm dependency, no ML. Pre-fill only; never read by `detectColumns()`/`resolveColumns()`/the confirm route, never auto-applied. |
| `lib/imports/csv.ts` | Visibility-only. `HEADER_ALIASES` and `normalizeHeader()` changed from module-private to `export`. No alias widened, no logic changed, bodies byte-identical otherwise. |
| `lib/imports/pipeline.ts` | `runImportPipeline()`'s return type widened to carry an optional `rawHeaders?: string[]` alongside `error`. CSV branch's resolution-failure return now spreads `parsed.headers` into `rawHeaders`. Excel branch needed no code change (type compatibility only, since `excel.ts` now carries the field). |
| `lib/imports/excel.ts` | `parseExcelFile()`'s return type widened the same way; its resolution-failure return now includes `rawHeaders: headers`. |
| `app/api/accounts/[id]/import/preview/route.ts` | Resolution-failure branch changed from `400 { error }` to `200 { resolved: false, rawHeaders, suggestedMapping, error }`. `suggestedMapping` computed via the new `suggestColumnMapping()`. Module header updated to document the new shape. Success path untouched. |

Confirm route (`app/api/accounts/[id]/import/route.ts`) — **not modified**, per the approved decision. Still returns `400 { error }` on resolution failure.

Nothing else touched. No `prisma/schema.prisma`, no migration, no UI, no QuickBooks, no provider adapter work.

## 2. tsc / lint

`npx tsc --noEmit` — clean (exit 0).

`npm run lint` — 0 errors, the same pre-existing 4 `@next/next/no-img-element` warnings as every prior step's baseline (`AccountModal.tsx:45`, `TotpSection.tsx:152`, `CoinIcon.tsx:78`, `CoinIcon.tsx:97`). The throwaway validation scripts (next section) briefly introduced 3 lint errors of their own (`no-require-imports` in the `.cjs` preload, `no-explicit-any` in the `.ts` script); resolved by emptying both files after the validation run completed, restoring the clean baseline — see §6.

## 3. Fixture + live-route validation

Same throwaway CJS `require.cache` preload technique as 4D-5c-1/4D-5c-2 (`lib/db.ts`/`lib/session.ts`/`lib/space.ts` stubbed; `server-only`/`client-only` bare specifiers redirected to a synthetic empty module), run under `tsx`. **33/33 checks passed.**

| # | Scenario | Result |
|---|---|---|
| 1 | Exact aliases (`Date`, `Merchant`, `Amount`, `Category`, `Reference`) | Every field suggested, mapped to the exact header |
| 2 | Near matches (`Trasaction Date`, `Payee`, `Debit Amunt`) | All three clear the 0.6 threshold and are suggested for the correct field |
| 3 | Unrelated headers (`Foo`, `Bar`, `Baz`, `Qux`) | Empty result — no field suggested |
| 4 | Empty headers (`[]`) | Empty result |
| 5 | CSV unresolved (`runImportPipeline()` direct call, unrelated headers) | `error` returned, string byte-identical to the pre-existing `detectColumns()` message; `rawHeaders` equals the parsed header row |
| 6 | Excel unresolved (`runImportPipeline()` direct call, unrelated headers) | Same `error` string; `rawHeaders` equals the worksheet's header row |
| 7 | Preview route, unresolved file (live `POST` handler) | `200`; `resolved: false`; `rawHeaders` present and correct; `suggestedMapping` present (object); `error` string unchanged |
| 8 | Confirm route, same unresolved file (live `POST` handler) | `400`; `error` string unchanged; **no** `resolved`/`rawHeaders`/`suggestedMapping` keys present — confirms the confirm route's response shape is untouched |
| 9 | Preview route, success path (live `POST` handler, resolvable CSV) | `200`; `source: "CSV"`; correct `summary` counts; no `resolved` key (only appears on the failure branch) — confirms the failure-branch edit didn't disturb the happy path |
| 10 | Unauthorized account, preview vs. confirm parity (live `POST` handlers) | Both `404`, byte-identical — confirms `lib/imports/authorize.ts` (unmodified) still drives both routes identically |

Scenarios 7–10 exercised the actual exported `POST` handlers from both route files with real `NextRequest`/`FormData`/`File` objects and real CSV/Excel parsing — only the `db`/session/space boundary was faked, same mechanism documented in `D2_STEP4D5C2_VALIDATION.md` §4.

## 4. Scope confirmation

```
$ git status --short
 M app/api/accounts/[id]/import/preview/route.ts
 M lib/imports/csv.ts
 M lib/imports/excel.ts
 M lib/imports/pipeline.ts
?? docs/initiatives/d2/D2_STEP4D5C3_IMPLEMENTATION_PLAN.md
?? lib/imports/suggest.ts
?? scripts/tmp-4d5c3-stub-preload.cjs
?? scripts/tmp-4d5c3-validation.ts

$ git diff --stat
 app/api/accounts/[id]/import/preview/route.ts | 39 ++++++++++++++++++---------
 lib/imports/csv.ts                            |  9 +++++--
 lib/imports/excel.ts                          |  6 +++--
 lib/imports/pipeline.ts                       | 13 +++++++--
 4 files changed, 48 insertions(+), 19 deletions(-)
```

Exactly the files the approved checklist named, plus this report, the new `suggest.ts`, and the now-emptied leftover scripts (next section). Confirm route untouched. No schema/migration/UI changes.

## 5. Confirm-route-untouched proof

`git diff --stat app/api/accounts/\[id\]/import/route.ts` → no output (zero diff). Scenario 8 above additionally proves this at runtime, not just structurally.

## 6. Known leftovers

`scripts/tmp-4d5c3-stub-preload.cjs` and `scripts/tmp-4d5c3-validation.ts` were throwaway validation artifacts, not part of the deliverable. As in 4D-5c-2, this sandbox's mounted filesystem doesn't permit unlinking newly created files, so both have been overwritten in place with a one-line "intentionally emptied" placeholder rather than deleted. Untracked, so they have no effect on the actual D2 Step 4D-5c-3 diff; safe to delete by hand outside this sandbox.

## 7. Not done (out of scope for this slice, per the approved checklist)

No schema changes. No migrations. No UI. No QuickBooks. No provider adapter work. No ML/trained classifier. No new npm dependency. `HEADER_ALIASES` not widened. `detectColumns()` logic unchanged. Fingerprint behavior unchanged. Confirm route unchanged.

---

Stopping here per instruction — implementation and validation only. Awaiting next direction before any further D2 decision.
