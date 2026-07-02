> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-4 — QuickBooks Transaction History Import: Implementation Checklist

Checklist only. No code, schema, or migration changes in this document. Implements the
approved architecture from `D2_STEP4D4_QUICKBOOKS_IMPORT_INVESTIGATION.md` as refined
in the follow-up architectural review (source labeling and update-on-match ship together;
`matchedVia` gates the overwrite; no new parser/normalization/chart-of-accounts/balances/
API/IIF/adapter/Provider Catalog work).

Reuses unchanged: `runImportPipeline()`'s format-sniffing, `NormalizedTransaction`,
`ImportMappingProfile` resolution, `findByFingerprint()`/`normalizeMerchantKey()`,
`ImportBatch`. No new parser. No new normalization layer.

---

## 1. `matchedVia`

**File:** `lib/imports/csv.ts`

Extend the `MATCH` variant of `FingerprintOutcome` (currently `{ outcome: "MATCH";
transactionId: string }`, line ~507) to:

```ts
| { outcome: "MATCH"; transactionId: string; matchedVia: "externalId" | "fingerprint" }
```

- [ ] Update the `FingerprintOutcome` type definition.
- [ ] Tag `matchedVia: "externalId"` on the exact-`externalTransactionId` return (line ~548).
- [ ] Tag `matchedVia: "fingerprint"` on the post-ambiguity-check fingerprint return (line ~568).
- [ ] No change to `resolveFingerprintOutcome()`'s parameters, no new queries, no change to
      `findByFingerprint()`/`normalizeMerchantKey()` in `lib/transactions/fingerprint.ts`.
- [ ] Confirm existing callers (confirm route, preview route) compile unchanged — both
      destructure `.outcome`/`.transactionId` only today, so the extra field is inert for them.

## 2. Source override

**File:** `lib/imports/pipeline.ts`

`ImportPipelineOptions` (line ~89) gains one optional field:

```ts
export interface ImportPipelineOptions {
  signConvention:   SignConvention;
  explicitMapping?: Record<string, string | null | undefined>;
  savedProfiles:    SavedMappingProfileLite[];
  sourceOverride?:  ImportSource; // D2 Step 4D-4 — caller-asserted label; never inferred from content
}
```

- [ ] Add `sourceOverride` to the options interface.
- [ ] At the Excel return site (line ~126): `source: opts.sourceOverride ?? ImportSource.EXCEL`.
- [ ] At the CSV return site (line ~155): `source: opts.sourceOverride ?? ImportSource.CSV`.
- [ ] No change to `detectExcelFormat()`, `parseExcelFile()`, `parseCsvText()`, or
      `resolveColumns()` — format-sniffing and column resolution stay 100% content-driven.
      QuickBooks intent is asserted by the caller, never detected from the file.
- [ ] Confirm field-shape detection is untouched: a QuickBooks CSV export parses through the
      identical CSV code path as any other CSV.

## 3. Update-on-match gate

**Files:** `app/api/accounts/[id]/import/route.ts` (confirm), shared helper in `lib/imports/csv.ts`

Overwrite logic executes only when **both**:
- `batch.source === ImportSource.QUICKBOOKS`, and
- `result.matchedVia === "externalId"`

Fingerprint-matched rows (`matchedVia === "fingerprint"`) keep today's MATCH/no-op behavior
unconditionally, regardless of source. This is the central safety property of the slice — a
row that merely shares date+amount+normalized-merchant with existing history is materially
weaker evidence than a durable TxnID hit, and must never trigger an overwrite.

- [ ] In the write loop's `MATCH` branch (currently `route.ts` line ~305: `matched++; // no
      write`), add the conditional: if the gate above is true, fetch the existing row's
      allow-listed fields and proceed to step 4/5; otherwise, behavior is unchanged
      (`matched++`, no write).
- [ ] Extract the diff/allow-list logic (step 4/5) into one function shared between the
      confirm route and the preview route — do not duplicate it across both call sites.

## 4. Allow-list for updates

Overwrite **only** these `Transaction` fields, when the gate in §3 is satisfied:

| Field | Overwrite? |
|---|---|
| `date` | Yes |
| `amount` | Yes |
| `merchant` | Yes |
| `description` | Yes |
| `category` | Yes |
| `pending` | Yes |
| `externalTransactionId` | No — this is the match key itself; identical by construction |
| `importBatchId` | No — provenance of original CREATE, never reassigned |
| `financialAccountId` | No |
| `createdAt` | No |
| `deletedAt` | No |
| `plaidTransactionId` | No |
| `id` | No |

- [ ] Implement the allow-list as an explicit field set in the shared helper (step 3) — no
      generic/spread-based "overwrite whatever changed" logic, to prevent accidental
      expansion of the writable surface later.
- [ ] Confirm `amount`/`date` are only ever overwritten via this path (`externalId` match) —
      for a fingerprint match these fields are part of the match key and are already
      identical between old and new, so there is nothing to diff in that branch.

## 5. Diff-before-write

- [ ] Before issuing `db.transaction.update()`, compare the incoming normalized row's
      allow-listed fields against the existing row's current values.
- [ ] If every allow-listed field is equal, skip the write entirely — treat as an ordinary
      no-op MATCH (no `updatedAt` churn, no audit entry contribution for that row).
- [ ] If any allow-listed field differs, write only the differing fields (or the full
      allow-list set — either is acceptable; do not write fields outside the allow-list
      either way).
- [ ] No new `ImportBatch` counter for "updated" rows — `matchedCount` continues to mean
      what it means today (MATCH outcomes, written or not). The "how many were actually
      updated" signal lives in the new AuditLog entry's metadata (§8), not in a new schema
      column. This is a deliberate choice to avoid schema growth for a derivable count.

## 6. Preview parity

**File:** `app/api/accounts/[id]/import/preview/route.ts`

- [ ] Preview's classification loop (`MATCH` branch, currently lines ~244-246) calls the
      same shared helper from §3/§4/§5 to determine whether the row would update — read-only,
      never writes.
- [ ] Add `wouldUpdate: boolean` to each previewed row and a `willUpdate` count to `summary`.
- [ ] Do **not** serialize `matchedVia` anywhere in the preview (or confirm) JSON response —
      it is an internal classification detail. Only the derived, user-facing `wouldUpdate`/
      `willUpdate` fields are exposed.
- [ ] Preview must accept the same new source-indicating request field as confirm (§2/§9) so
      a QuickBooks preview and a QuickBooks confirm classify identically.

## 7. Rollback honesty

**File:** `app/api/imports/[id]/rollback/route.ts`

- [ ] No new revert capability. No snapshot table. No schema change.
- [ ] Update the module header comment to state explicitly: rollback soft-deletes rows this
      batch *created* (`importBatchId`-tagged); rows this batch *updated* via §3 are not
      reverted and remain in their post-update state after a rollback.
- [ ] Confirm this is consistent with existing, unmodified behavior — the soft-delete query
      (`importBatchId` + `deletedAt: null`) already only ever touches CREATE-origin rows;
      this step documents that fact in terms of update-on-match, it does not change the query.

## 8. Audit

**File:** `lib/audit-actions.ts`

`AuditLog.action` is a plain `String` column (`schema.prisma:1364`); `AuditAction` is an
app-level TS constant object, not a Prisma enum. Adding a new action is a code-only change.

- [ ] Add one new constant: `IMPORT_BATCH_UPDATED_ON_MATCH: "IMPORT_BATCH_UPDATED_ON_MATCH"`,
      grouped under the existing `// ── Imports` comment alongside `IMPORT_BATCH_ROLLED_BACK`.
- [ ] Add it to the `"Imports"` entry in `AUDIT_ACTION_GROUPS` (admin filter dropdown).
- [ ] In the confirm route, after the write loop finishes (same point `ImportBatch` is
      finalized, ~line 320), write **one** `AuditLog` row per batch — not per row — if and
      only if at least one row was actually updated (diff in §5 was non-empty for at least
      one row). Metadata: `{ importBatchId, financialAccountId, updatedTransactionIds:
      string[] }`.
- [ ] A QUICKBOOKS batch where every match was a no-op (§5) writes zero new audit rows —
      audit reflects actual overwrites, not attempted ones.
- [ ] Mirrors the existing `IMPORT_BATCH_ROLLED_BACK` pattern exactly (single row, structured
      metadata, no per-row spam) — no new audit architecture introduced.

---

## Schema / migration required?

**No.**

- `ImportSource.QUICKBOOKS` already exists in the Prisma enum (added at 4B, unused until now).
- `ImportBatch` already has every field this slice touches (`source`, `matchedCount`,
  `errorSummary`, etc.) — no new counter is added; see §5's explicit decision to derive the
  "updated" count from AuditLog metadata instead of a new column.
- `Transaction` already has every field the §4 allow-list touches, plus the unchanged
  `externalTransactionId` / `deletedAt` / `importBatchId` columns this slice reads but never
  newly writes.
- `AuditLog.action` is a `String` column read by an app-level TS constant
  (`lib/audit-actions.ts`), not a Prisma enum — adding `IMPORT_BATCH_UPDATED_ON_MATCH` has
  zero Prisma schema impact.
- `matchedVia` and `sourceOverride` are TypeScript-only additions to function signatures and
  return types — neither is persisted.

`npx prisma generate` and `npx prisma migrate dev` are still run per the standing validation
list below — a clean run with no proposed diff is the actual confirmation that this claim
holds, not an assumption to skip.

## Files expected to change

| File | Change |
|---|---|
| `lib/imports/csv.ts` | `FingerprintOutcome.MATCH` gains `matchedVia`; new shared allow-list diff helper (§3/§4/§5) |
| `lib/imports/pipeline.ts` | `ImportPipelineOptions` gains `sourceOverride?: ImportSource`; both return sites apply it |
| `app/api/accounts/[id]/import/route.ts` | Accepts new source-indicating field; threads `sourceOverride`; write loop's `MATCH` branch gated update; post-loop audit write |
| `app/api/accounts/[id]/import/preview/route.ts` | Accepts the same field; threads `sourceOverride`; classification loop computes `wouldUpdate`; response gains `wouldUpdate`/`willUpdate` |
| `lib/audit-actions.ts` | New `IMPORT_BATCH_UPDATED_ON_MATCH` constant + admin filter group entry |
| `app/api/imports/[id]/rollback/route.ts` | Doc-comment only — explicit CREATE-vs-UPDATE rollback scope statement |

**Not expected to change:** `lib/imports/excel.ts` (sourceOverride is applied at the pipeline
level, after Excel parsing returns), `lib/transactions/fingerprint.ts` (matching semantics
unchanged), `lib/imports/suggest.ts` (unrelated), `prisma/schema.prisma` (no schema change).

## Validation strategy

Standing validation, run in order:
- [ ] `npx prisma generate`
- [ ] `npx prisma migrate dev` — expect no proposed migration; a non-empty diff here is a stop
      signal, not something to accept and continue past.
- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`

Targeted manual/fixture validation (no automated test framework exists for this pipeline
today — consistent with how every prior 4D slice has been validated):
- [ ] QuickBooks-labeled CSV fixture, one row with an `externalTransactionId` matching an
      existing `Transaction` and a changed `amount`/`merchant` → confirm updates that row in
      place; unrelated allow-list fields untouched; one `IMPORT_BATCH_UPDATED_ON_MATCH` audit
      row listing that transaction id.
- [ ] Same fixture through preview first → `wouldUpdate: true` on that row, accurate
      `willUpdate` in summary, no `matchedVia` key anywhere in the response.
- [ ] QuickBooks-labeled batch, one row that matches only via fingerprint fallback (no
      `externalTransactionId`, or one that misses) → **no update occurs**; behaves identically
      to today's MATCH/no-op. This is the single most important case to verify by hand — it's
      the gate the whole slice's safety rests on.
- [ ] Plain CSV/Excel upload, no source field supplied → byte-for-byte identical responses to
      current behavior; confirms zero regression on the existing path.
- [ ] Rollback called on a QuickBooks batch that performed at least one update → created rows
      soft-deleted as today; updated rows remain in their post-update state; this matches the
      documented limitation from §7, not a bug.

## Rollback plan (for this implementation)

- No schema/migration means reverting is a pure code revert — `git revert` the commit(s),
  no data migration or backfill needed to undo it.
- `sourceOverride` and `matchedVia` are additive/optional; removing the code that sets/reads
  them doesn't strand data — `ImportBatch.source = QUICKBOOKS` rows already written stay
  valid regardless (the enum value has existed since 4B).
- The update-on-match gate (§3) is a single centralized condition in the write loop. If a
  bug is found post-merge and a full revert is overkill, flipping that condition to
  never-true is a one-line, low-risk mitigation that disables overwriting while leaving
  source labeling, preview parity, and audit logging intact.
- What a revert **cannot** do: undo `Transaction` rows already overwritten before the revert
  lands — same limitation named in §7. A code revert stops future updates; it does not
  restore prior field values for updates already written. Stated plainly here so "rollback
  plan" isn't read as more protective than it is.

---

Stopping here. No code, schema, or migration changes have been made. Awaiting approval to
implement.
