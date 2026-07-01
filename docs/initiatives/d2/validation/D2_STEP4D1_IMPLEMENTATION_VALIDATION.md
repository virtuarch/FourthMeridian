> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-1 — CSV Import MVP: Implementation + Validation

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`.

Implements the design in `D2_STEP4D1_CSV_IMPORT_MVP_INVESTIGATION.md`, per the approved scope:

> Add: `ImportBatch.matchedCount`, `ImportBatch.failedCount`, `papaparse` dependency, `app/api/accounts/[id]/import/route.ts`.
> Implement: CREATED, MATCHED, SKIPPED, FAILED outcomes.
> Use: `ImportBatch` (4B), fingerprint helper (4C).
> No: Excel, QuickBooks, rollback, UI, background jobs, provider abstraction work.

## 1. What was built

### Schema (additive)

`ImportBatch.matchedCount Int @default(0)` and `ImportBatch.failedCount Int @default(0)` — two new counters alongside the existing `importedCount`/`skippedCount`. `matchedCount` is semantically distinct from `skippedCount`: a MATCHED row resolved cleanly to an existing transaction (no write, not an error); a SKIPPED row is an ambiguous case that needed a human to look at it. Migration `20260624120718_d2_4d1_importbatch_counters` (hand-written — see §3).

### Dependency

`papaparse@5.5.4` + `@types/papaparse@5.5.2` (dev). No other new dependencies.

### `lib/imports/csv.ts` (new)

Not named in the literal "Add" list, but added as a focused helper module rather than inlining ~250 lines of parsing logic into the route — matches this codebase's existing convention of keeping route handlers thin and business logic in `lib/` (e.g. `lib/transactions/fingerprint.ts`, `lib/accounts/reconcile.ts`). It is **not** a generic adapter — no `ImportSource`-keyed interface, no shared base class. A future Excel/QuickBooks source gets its own sibling module. Flagging this explicitly since it wasn't in the literal file list.

Exports:
- `detectColumns(headers)` — resolves header aliases (date / merchant or description / amount or debit+credit / category / reference) into a column map, or a file-level `{ error }` if a required column is missing.
- `parseCsvText(text)` — wraps `Papa.parse`; throws if no header row is found.
- `parseDate`, `parseAmount`, `mapCategory` — field-level parsing. Dates: ISO or US slash form, parsed via explicit `Date.UTC()` construction (not `new Date(str)`) to avoid the timezone ambiguity the US form would otherwise introduce. Amounts: strips `$`/commas/whitespace, treats parenthesized values as negative. Category: substring-alias table defaulting to `Other`, mirroring `mapPlaidCategory()`'s fallback philosophy.
- `normalizeRow(...)` — combines the above into one row result; sets `.error` (never throws) for anything unparseable.
- `resolveFingerprintOutcome(...)` — see next section. The one DB-touching export.

### `app/api/accounts/[id]/import/route.ts` (new)

`POST`, multipart/form-data (`file`, optional `signConvention`). Flow:

1. `requireUser()`, then resolve `id` against `SpaceAccountLink` (ACTIVE) with a legacy-`Account` fallback check — same pattern as `GET .../transactions`. Unlike that read route, a legacy-only match is rejected with 400: `ImportBatch.financialAccountId` is a required FK to `FinancialAccount`, and the two id spaces never overlap, so there's no row to attach a batch to.
2. Parse the file, run `detectColumns()`. A file with the wrong shape returns 400 **before** any `ImportBatch` row is created.
3. Create `ImportBatch` (status `PROCESSING`).
4. Loop rows **sequentially** (not `Promise.all`) — later rows must see earlier rows' commits so two identical rows in the same file resolve to one CREATE + one MATCH instead of racing into two CREATEs. Same race lesson as `dualWriteSpaceAccountLink` in `app/api/accounts/manual/route.ts`, different table.
5. Finalize the batch: `COMPLETED` if `failedCount === 0`, else `COMPLETED_WITH_ERRORS`. Returns the batch id and all five counters plus `errorSummary`.

No `AuditLog` entry was added — it wasn't part of the approved "Add" list, and skipping it keeps this slice to exactly what was asked rather than smuggling in adjacent scope. Flagged in the roadmap as a natural follow-up, not done here.

## 2. The SKIPPED design decision (investigation §7, left open)

The investigation flagged a fork: extend `lib/transactions/fingerprint.ts` itself to expose ambiguity, or build something additive alongside it. The instruction to implement SKIPPED *and* "use: fingerprint helper" (singular, as-is) pointed at a third option that's cleaner than either one in the investigation: **zero changes to `fingerprint.ts`**, calling `findByFingerprint()` as the primary match path (real usage, not a workaround), and layering a small supplementary check in `lib/imports/csv.ts` that reuses the already-exported `normalizeMerchantKey()` to detect when more than one existing row matches. `findByFingerprint()` itself still resolves ambiguity by picking the first candidate and logging a warning — correct for Plaid sync, where there's no human in the loop to ask. For CSV import there is, so the ambiguous case is surfaced as SKIPPED instead. This means one extra `db.transaction.findMany` query on the rows that do find a fingerprint match (a second query with the same shape `findByFingerprint` already ran internally) — a deliberate clarity-over-micro-optimization tradeoff at MVP row volumes.

## 3. Migration — hand-written, same sandbox gap as 4B

`npx prisma generate` and `npx prisma migrate dev` both fail in this sandbox the same way they did for 4B/4C: the Prisma engine binary fetch returns `403 Forbidden` (no egress to `binaries.prisma.sh`), and `DATABASE_URL` points at `localhost:5432`, which is the user's machine, not reachable from here. `prisma/migrations/20260624120718_d2_4d1_importbatch_counters/migration.sql` was written by hand, matching Prisma's standard output shape for adding two `NOT NULL ... DEFAULT 0` columns to an existing table:

```sql
-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "matchedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedCount" INTEGER NOT NULL DEFAULT 0;
```

**Action needed from you:** run `npx prisma generate` and `npx prisma migrate dev` locally (same as after 4B) to apply this migration and regenerate the Prisma Client with the new fields.

## 4. Validation

**`npx tsc --noEmit`** — 3 errors, all on `matchedCount`/`failedCount` in the new route file:

```
app/api/accounts/[id]/import/route.ts(195,7): error TS2353: ... 'matchedCount' does not exist ...
app/api/accounts/[id]/import/route.ts(210,30): error TS2339: Property 'matchedCount' does not exist ...
app/api/accounts/[id]/import/route.ts(212,30): error TS2339: Property 'failedCount' does not exist ...
```

Confirmed these are the stale-client gap, not real errors: `grep matchedCount node_modules/.prisma/client/index.d.ts` returns nothing — the currently-generated client predates this schema change (it was generated locally for 4B/4C, before today's edit), and can't be regenerated in this sandbox (§3). They will disappear after you run `npx prisma generate` locally. No other errors — `lib/imports/csv.ts` and the rest of the route type-check clean.

**`npm run lint`** — clean for both new files. Repo-wide: 0 errors, 4 pre-existing warnings (`<img>` usage in `AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx` — untouched by this change).

**Pure-function tests** (`npx tsx`, ad hoc script against `lib/imports/csv.ts`, deleted after running):

| Case | Result |
|---|---|
| ISO date `2026-06-24` | ✅ → `2026-06-24T00:00:00.000Z` |
| US date `6/24/2026`, `06/01/2026` | ✅ → correct UTC dates |
| Garbage/empty date | ✅ → `null` |
| Amount `$1,234.56`, `(12.34)`, `-50.00`, `+50.00`, `($1,234.56)` | ✅ → `1234.56`, `-12.34`, `-50`, `50`, `-1234.56` |
| Amount `N/A`, empty | ✅ → `null` |
| Category aliases (`Groceries`, `Restaurants`, unknown, absent) | ✅ → `Groceries`, `Dining`, `Other`, `Other` |
| `detectColumns` — Date/Description/Amount header set | ✅ → resolved, no error |
| `detectColumns` — Posted Date/Merchant/Debit/Credit/Category header set | ✅ → resolved, no error |
| `detectColumns` — Foo/Bar (no usable columns) | ✅ → file-level error message |
| `normalizeRow` happy path (single signed Amount, `creditPositive`) | ✅ → correct merchant/date/amount/category |
| `normalizeRow` sign flip (`debitPositive`, raw `4.50`) | ✅ → `amount: -4.5` |
| `normalizeRow` debit/credit pair (debit `4.50` / credit `2000.00`) | ✅ → `-4.5` / `2000` |
| Malformed rows (bad date / missing merchant / bad amount) | ✅ → each sets the expected `.error`, none throws |
| Header-only file (0 data rows) | ✅ → `rows.length === 0`, no throw |
| Empty string (no header at all) | ✅ → throws `"No header row found."` |

**DB-dependent path (`resolveFingerprintOutcome`)** — could not be executed: importing it transitively loads `lib/db.ts`, and `PrismaClient` fails to instantiate in this sandbox (`Prisma Client was generated for "darwin-arm64", but the actual deployment required "linux-arm64-openssl-3.0.x"` — the locally-generated client's engine binary doesn't match this sandbox's architecture, on top of `DATABASE_URL` pointing at a `localhost` Postgres this sandbox can't reach regardless). Verified by code trace instead:

- **Within-file duplicate** (two identical rows, same date/amount/merchant, no existing history): row 1 → `findByFingerprint` finds nothing → CREATE. Row 2 → `findByFingerprint` now finds row 1 (committed by the sequential loop) → ambiguity re-check finds exactly 1 candidate → MATCH. Confirms the sequential-loop requirement actually does what it's there for.
- **True ambiguity** (two *pre-existing* rows already share date/amount/merchant, e.g. two genuine same-day same-amount Plaid transactions with no distinguishing field): `findByFingerprint` returns its first match (with its own internal `console.warn`); the supplementary check re-queries, finds 2 candidates, returns `SKIP`. Confirms the ambiguous case is surfaced rather than silently resolved.
- **Header-only file**: 0 rows in the loop → all counters stay 0, `errorSummary` stays `undefined` → finalized `COMPLETED` (not `COMPLETED_WITH_ERRORS`) — a deliberate refinement from the investigation, since an empty file is a no-op success, not an error.

**Scope check** — `git diff --stat`: only `package.json`, `package-lock.json`, `prisma/schema.prisma` modified (the schema diff is exactly the two new counter fields, confirmed via `git diff prisma/schema.prisma`). `git diff --stat -- lib/transactions/fingerprint.ts lib/plaid/syncTransactions.ts` is empty — neither file was touched. New files are scoped to the route, the one new lib module, the hand-written migration, and docs. No UI files, no legacy table removal, no `CreatorPayout`/billing/`Conversation`/`Message` tables, no `WorkspaceAccountShare` rename.

## 4a. Post-regeneration confirmation (run locally, re-verified after the fact)

`npx prisma generate` and `npx prisma migrate dev` were run locally per §3's action item. Re-confirmed from this side:

- `node_modules/.prisma/client/index.d.ts` now contains `matchedCount`/`failedCount` (57 occurrences each, across the model type, `ImportBatchSelect`, `ImportBatchUpdateInput`, etc.) — the stale-client gap from §3/§4 is closed.
- Migration directory `prisma/migrations/20260624120718_d2_4d1_importbatch_counters/` is present with the hand-written `migration.sql` from §3, unchanged.
- **`npx tsc --noEmit`** — clean, exit 0. The 3 `matchedCount`/`failedCount` errors reported in §4 are gone, as expected.
- **`npm run lint`** — clean, exit 0. Same 4 pre-existing warnings as §4 (`<img>` in `AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx`), 0 errors, none in the new files.
- **Scope re-check** — `git status --short` / `git diff --stat`: modified `docs/initiatives/d2/D2_ROADMAP.md`, `package.json`, `package-lock.json`, `prisma/schema.prisma` (schema diff confirmed as exactly the two counter fields, comment included); untracked `app/api/accounts/[id]/import/`, `lib/imports/`, `prisma/migrations/20260624120718_d2_4d1_importbatch_counters/`, and the three `docs/initiatives/d2/D2_STEP4D*` docs. Nothing outside this set. `lib/transactions/fingerprint.ts` and `lib/plaid/syncTransactions.ts` confirmed still untouched (`git diff --stat` on both is empty).
- **`package-lock.json` note (minor, non-blocking):** alongside the expected `papaparse`/`@types/papaparse` entries, the diff also drops `"dev": true` from the pre-existing `@types/node` and `undici-types` entries. Checked who requires `@types/node` in the lock tree — only `@types/papaparse` and the pre-existing `@types/qrcode`, both still `dev: true` — so this isn't caused by a new non-dev path to `@types/node`; it's npm recomputing dev-flag placement across the whole lockfile on install, a known npm cosmetic behavior, not specific to this change. Practical effect: `npm ci --omit=dev` would now also pull in `@types/node`/`undici-types` (pure type packages, no runtime code) into a production install — harmless, but flagging it since it's a side effect outside the literal "Add: papaparse dependency" scope.

No code changes were made in this confirmation pass — read-only checks only.

## 5. What's deferred (unchanged from the investigation's scope cut)

Excel, QuickBooks, rollback (`ImportBatch.status = ROLLED_BACK` + the `deletedAt: null` read-path audit it requires first), any UI, background/async processing for large files, a generic provider-adapter interface (Step 5), and an `AuditLog` entry for CSV imports (not in the approved "Add" list for this slice).

## 6. Rollback plan for this slice

Purely additive — reverting is a normal revert with no data-loss risk:
- Drop `matchedCount`/`failedCount` columns (or just leave them — unused columns with a default are harmless) and delete the migration directory.
- Delete `app/api/accounts/[id]/import/route.ts` and `lib/imports/csv.ts`.
- Remove `papaparse`/`@types/papaparse` from `package.json` + reinstall.
- No existing route, table, or column was modified, so there is nothing to "undo" on the read side — this slice has no blast radius outside its own new files plus the two new nullable-default counter columns.
