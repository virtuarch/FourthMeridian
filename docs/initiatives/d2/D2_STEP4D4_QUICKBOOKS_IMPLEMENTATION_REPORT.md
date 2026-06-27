# D2 Step 4D-4 — QuickBooks Transaction History Import: Implementation Report

Implements `D2_STEP4D4_QUICKBOOKS_IMPLEMENTATION_CHECKLIST.md` exactly, with the one
approved refinement (the `source === QUICKBOOKS` gate is documented in code as
intentionally temporary, expected to migrate to adapter capabilities in D2 Step 5 — Step 5
itself is not implemented). No schema, no migration, no new parser, no IIF, no QuickBooks
API, no chart-of-accounts, no Provider Catalog work.

## Files changed

| File | Change |
|---|---|
| `lib/imports/csv.ts` | `FingerprintOutcome.MATCH` gains `matchedVia: "externalId" \| "fingerprint"`, tagged at both existing return sites in `resolveFingerprintOutcome()`. New `QuickBooksUpdatableFields` interface + `computeQuickBooksUpdateDiff()` — the single shared allow-list/diff helper used by both routes. |
| `lib/imports/pipeline.ts` | `ImportPipelineOptions` gains optional `sourceOverride?: ImportSource`. Applied via `opts.sourceOverride ?? ImportSource.EXCEL` / `?? ImportSource.CSV` at the two existing return sites. Format-sniffing itself untouched. |
| `app/api/accounts/[id]/import/route.ts` | Parses new `source` form field → `sourceOverride`; threads it into `runImportPipeline()`. `MATCH` branch gated update: `source === QUICKBOOKS && matchedVia === "externalId"` → fetch existing row → `computeQuickBooksUpdateDiff()` → conditional `db.transaction.update()` → collect `updatedTransactionIds`. One non-fatal batch-level `IMPORT_BATCH_UPDATED_ON_MATCH` audit write after `ImportBatch.update()` finalizes, gated on `updatedTransactionIds.length > 0`. Doc-comment updated (`source` field, MATCHED outcome, removed "QuickBooks" from out-of-scope list). |
| `app/api/accounts/[id]/import/preview/route.ts` | Same `source` parsing/threading. Classification loop's `MATCH` branch computes `wouldUpdate` read-only via the same gate + shared helper — never writes. `ImportPreviewRow` gains `wouldUpdate: boolean`; response `summary` gains `willUpdate`. `matchedVia` never serialized. Doc-comment updated. |
| `lib/audit-actions.ts` | New constant `IMPORT_BATCH_UPDATED_ON_MATCH`. Added to the `"Imports"` `AUDIT_ACTION_GROUPS` entry. |
| `app/api/imports/[id]/rollback/route.ts` | Comment-only: documents that update-on-match overwrites are not reverted by rollback (no schema, no snapshot, no versioning, no query change). |

Not changed (per checklist): `lib/imports/excel.ts`, `lib/transactions/fingerprint.ts`,
`lib/imports/suggest.ts`, `prisma/schema.prisma`.

## Scope confirmation

- No schema or migration changes. `ImportSource.QUICKBOOKS` already existed (added at 4B);
  `AuditAction` is a plain TS constant backing a `String` column, not a Prisma enum;
  `matchedVia`/`sourceOverride`/`wouldUpdate`/`willUpdate` are TypeScript-only, never
  persisted.
- No new parser, normalization layer, chart-of-accounts, balances, QuickBooks API, IIF,
  adapter work, or Provider Catalog work.
- The `source === ImportSource.QUICKBOOKS` gate is implemented inline at both call sites
  (not abstracted into a helper), with a code comment at each site stating it is
  intentionally temporary and expected to migrate to an adapter-capability check during D2
  Step 5 — Step 5 itself is untouched.
- `matchedVia` is never exposed through either route's public JSON response — confirmed by
  inspection of every object literal returned by both routes.
- Existing validation/error strings are unchanged. No row-level audit entries, no
  before/after snapshots, no transaction versioning — one batch-level `AuditLog` row only.
- CSV/Excel behavior is preserved exactly when `source` is absent or anything other than
  `"QUICKBOOKS"`: `sourceOverride` is `undefined`, the nullish-coalescing leaves
  `runImportPipeline()`'s sniffed `source` untouched, and the update-on-match gate's
  `source === QUICKBOOKS` check is false, so the `MATCH` branch behaves exactly as
  `matched++; // no write` did before this slice.
- Preview's response shape gains `wouldUpdate`/`willUpdate` unconditionally (default
  `false`/`0` for non-QuickBooks uploads) — this is the approved, explicit requirement of
  checklist §6, not an unintended regression.

## Validation summary

Standing validation commands, run in this sandboxed shell:

- `npx prisma generate` — **could not complete**: this sandbox has no network path to
  `binaries.prisma.sh` (403 Forbidden fetching the linux-arm64 engine), and only
  darwin-arm64 engine binaries are present locally. Not a code issue — confirmed by
  inspecting the already-generated client at `node_modules/.prisma/client/index.d.ts`,
  which already includes `QUICKBOOKS: 'QUICKBOOKS'` and every `Transaction` field this slice
  reads/writes, consistent with this slice making zero schema changes.
- `npx prisma migrate dev` — **could not complete**: no Postgres reachable at the
  `DATABASE_URL` configured for this environment (`localhost:5432`, connection refused),
  and the same linux engine-fetch block applies. No migration is expected to be generated
  by this slice in any case (no schema diff).
- `npx tsc --noEmit` — **passed, exit code 0, no output.**
- `npm run lint` — **passed, 0 errors.** 4 pre-existing warnings (`@next/next/no-img-element`
  in `AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx`) — none in files this slice
  touched.

### Checklist validation cases (static code-trace — no live DB in this sandbox)

No automated test framework exists for this pipeline (consistent with every prior 4D
slice); the checklist's cases are normally exercised by hand against a running app + DB,
which this sandboxed shell doesn't have. Each case was instead traced directly against the
final code:

- **QuickBooks externalId match + changed amount/merchant** — `source` form field
  `"QUICKBOOKS"` → `sourceOverride = QUICKBOOKS` → pipeline returns `source: QUICKBOOKS`.
  `resolveFingerprintOutcome()` finds the exact `externalTransactionId` → `matchedVia:
  "externalId"`. Gate passes → existing row fetched → `computeQuickBooksUpdateDiff()`
  returns a diff containing only `amount`/`merchant` (other allow-list fields equal) →
  `db.transaction.update({ data: diff })` writes only those two fields → id pushed to
  `updatedTransactionIds` → one `IMPORT_BATCH_UPDATED_ON_MATCH` audit row written listing it.
- **Preview parity** — identical gate and `computeQuickBooksUpdateDiff()` call, read-only;
  `wouldUpdate: true` on that row, `willUpdate` reflects the count, and no object literal in
  the preview response includes a `matchedVia` key.
- **Fingerprint-fallback match on a QUICKBOOKS batch** — `matchedVia === "fingerprint"`
  fails the gate's strict `=== "externalId"` check regardless of `source` → falls straight
  to `matched++` (confirm) / `willMatch++` (preview) with no update logic ever entered. This
  is the slice's central safety property and it is enforced unconditionally by the gate
  expression.
- **Plain CSV/Excel, no `source` field** — `sourceRaw` is `null` → `sourceOverride`
  `undefined` → pipeline's `source` is sniffed exactly as before → gate's `source ===
  QUICKBOOKS` is false → confirm's JSON response is unchanged (no new keys were added to
  it). Preview's response gains `wouldUpdate: false` / `willUpdate: 0`, per the approved,
  unconditional §6 requirement — not a regression.
- **Rollback on a QuickBooks batch with updates** — unchanged query, scoped to
  `importBatchId + deletedAt: null`; update-on-match never sets `importBatchId` (only
  `CREATE` does), so updated rows were already outside this query's reach before this slice
  existed. Rollback soft-deletes created rows; updated rows remain in their post-update
  state — matching the new doc-comment exactly.

## Rollback plan

Unchanged from the approved checklist: this is a pure code revert (no schema/migration to
unwind). `sourceOverride`/`matchedVia` are additive/optional and safe to remove. The
update-on-match gate is a single centralized condition at each of the two call sites; if a
bug surfaces post-merge, flipping that condition to never-true is a one-line mitigation that
disables overwriting while leaving source labeling, preview parity, and audit logging
intact. A revert cannot restore `Transaction` field values already overwritten before the
revert lands — same limitation stated in the checklist and in the rollback route's new
doc-comment.

---

Implementation and validation complete per this report. Stopping here.
