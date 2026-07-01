> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-3 — Import Rollback: Implementation + Validation

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`.

Implements the approved slice from `D2_STEP4D3_IMPORT_ROLLBACK_INVESTIGATION.md` exactly: the rollback route, the one new audit action, nothing else. No schema change, no migration, no CSV/Excel/QuickBooks/UI/provider-adapter work.

## 1. Exact files changed

| File | Change |
|---|---|
| `lib/audit-actions.ts` | +10 lines: `IMPORT_BATCH_ROLLED_BACK` constant + an "Imports" `AUDIT_ACTION_GROUPS` entry. No deletions, no existing constant touched. |
| `app/api/imports/[id]/rollback/route.ts` | New file, 178 lines. `POST` handler. |

`git status --short`: exactly these 2 files (one modified, one new), plus the already-existing investigation doc. `git diff --stat -- prisma/`: empty — confirmed no schema/migration touched.

## 2. Route

`POST /api/imports/[id]/rollback`, `[id]` = `ImportBatch.id` — as recommended in the investigation doc §1, not nested under `accounts/[id]/import`, since `ImportBatch` already carries its own `financialAccountId` and the batch row itself is the resource being acted on (same shape as the `accounts/[id]/restore` precedent).

## 3. Authorization behavior (exact)

1. `requireFreshUser()` — live revocation check against `UserSession`, not the 30s cache. 401 if no valid session.
2. `db.importBatch.findUnique({ where: { id } })` — 404 ("Not found") if the batch doesn't exist.
3. `getSpaceContext()` resolves the caller's active Space, then `db.spaceAccountLink.findFirst({ where: { spaceId, financialAccountId: batch.financialAccountId, status: ACTIVE } })` — 404 if no ACTIVE link. A batch that exists but sits in a Space the caller can't see returns the identical 404 a nonexistent batch would, so existence is never leaked through the auth check.
4. Permission: `batch.createdByUserId === user.id` (creator) **or** `permissions.canManage` (OWNER/ADMIN, from `derivePermissions()`) — 403 ("Forbidden") otherwise. A plain MEMBER can roll back their own imports but not another member's.

This is stricter on both axes than the sibling creation route (`POST /api/accounts/[id]/import`), which uses `requireUser()` with no role gate — exactly the asymmetry the investigation doc recommended and flagged for approval, now implemented as approved.

## 4. Status behavior (exact)

Inside one `db.$transaction(async (tx) => {...})`:

1. **Claim:** `tx.importBatch.updateMany({ where: { id, status: { in: [COMPLETED, COMPLETED_WITH_ERRORS, FAILED] } }, data: { status: ROLLED_BACK } })`.
2. **`claim.count === 0`** → re-read the batch inside the same transaction to disambiguate:
   - current status is already `ROLLED_BACK` → `{ kind: "already_rolled_back" }` — outer code returns 200, `alreadyRolledBack: true`, `rolledBackCount: 0`. No `Transaction.updateMany`, no `AuditLog` write.
   - current status is `PENDING` or `PROCESSING` → `{ kind: "ineligible" }` — outer code returns **409** with a message naming the current status and the eligible set.
3. **`claim.count === 1`** (this request won the claim) → `tx.transaction.updateMany({ where: { importBatchId: batch.id, deletedAt: null }, data: { deletedAt: new Date() } })`, scoped by `importBatchId` alone, **not** `financialAccountId` — exactly the §4 finding (account merges can re-point `Transaction.financialAccountId` without updating `ImportBatch.financialAccountId`, which would make that filter silently miss rows). Then one `AuditLog` row. Returns 200, `alreadyRolledBack: false`, `rolledBackCount` = the live `updateMany` count.

`completedAt`, `rowCount`, `importedCount`, `matchedCount`, `skippedCount`, `failedCount` are never written by this route — confirmed by reading the diff: the only `data:` blocks in the file are the status claim, the `Transaction.deletedAt` soft-delete, and the `AuditLog` create. The response simply echoes the batch's existing values for those fields.

No `regenerateSnapshotsForAccounts()` call exists anywhere in the file — confirmed by grep; not imported, not called.

## 5. Response payload (exact)

```json
{
  "importBatchId": "...",
  "status": "ROLLED_BACK",
  "rolledBackCount": 42,
  "alreadyRolledBack": false,
  "rowCount": 50,
  "importedCount": 45,
  "matchedCount": 3,
  "skippedCount": 1,
  "failedCount": 1
}
```

On the ineligible path: `{ "error": "Import batch is PROCESSING and cannot be rolled back. Only COMPLETED, COMPLETED_WITH_ERRORS, or FAILED batches are eligible." }`, 409.

## 6. Validation

**`npx tsc --noEmit`** — clean, no output, exit 0.

**`npm run lint`** — 0 errors, 4 pre-existing warnings (`<img>` in `AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx`) — identical, unrelated set to every prior D2 step's baseline; this change touches none of those files.

**Scope confirmation:**
- `git status --short`: `lib/audit-actions.ts` (modified), `app/api/imports/` (new), plus the pre-existing untracked investigation doc. Nothing else.
- `git diff -- lib/audit-actions.ts`: exactly the 10-line additive diff shown in §1 — no existing line changed or removed.
- `git diff --stat -- prisma/`: empty. No migration directory created.
- No file under `lib/imports/csv.ts`, `lib/imports/excel.ts`, any QuickBooks path, or any UI component (`components/`, `app/(dashboard)` or similar) was touched — confirmed by `git status --short` showing only the 2 files above.

**No live-DB validation was possible** — consistent with every prior D2 step, this sandbox cannot reach the Postgres instance at `localhost:5432`. The 6-scenario fixture-based validation plan from the investigation doc's §12 (imported rows disappear, matched rows remain, re-import after rollback creates fresh rows, Plaid sync doesn't adopt rolled-back rows, status-transition idempotency, ineligible-status rejection) has not been executed and should be run against a reachable database before this route is exposed to real users.

**Sandbox note:** the same benign `.git/index.lock` virtiofs warning seen in every prior step appeared again on `git diff`/`git status`; all git read commands still returned correct output. `rm .git/index.lock` from your end before your next local git operation.

## 7. Rollback safety assessment (of this feature)

- **Idempotency:** the conditional `updateMany` claim means concurrent or repeated rollback calls on the same batch can never double-soft-delete rows or write a second `AuditLog` row — the second call's claim always returns `count: 0` and falls into the idempotent-success path.
- **Atomicity:** the status flip, the soft-delete, and the audit write are one `db.$transaction` — there is no app-visible partial state (status says `ROLLED_BACK` but rows are still live, or vice versa). A failure mid-transaction rolls everything back at the Postgres level; the batch is left exactly as it was, eligible to retry.
- **Scope safety:** the soft-delete query cannot touch a row outside the batch (`importBatchId` is the sole filter) and cannot touch a row this batch only matched (matched rows never carry `importBatchId`, by the import route's own CREATE/MATCH branch — unchanged by this slice).
- **No destructive SQL:** every write here is either a soft-delete (`deletedAt`) or a status-enum transition — no `delete()`/`deleteMany()` call exists anywhere in the file. Reverting this feature, if a bug is found, is purely additive-revert: stop exposing the route (the mitigation named in both this and the 4D-R report) rather than attempting to mechanically "undo an undo." Any batch incorrectly rolled back before the route is pulled would need a manual, case-by-case fix informed by the `AuditLog.metadata.importBatchId` recorded at the time — same approach already named in the investigation doc's own "rollback plan for this feature" section.
- **Reverting the implementation itself:** two files, zero schema/migration — reverting the commit(s) is sufficient; nothing else depends on either file yet.

---

**Stopping here per scope. No schema changes. No migrations. No CSV/Excel/QuickBooks/UI/provider-adapter changes. Validated via `tsc --noEmit` (clean) and `npm run lint` (0 errors). Scope confirmed via `git status --short` / `git diff --stat` — exactly the 2 files above.**
