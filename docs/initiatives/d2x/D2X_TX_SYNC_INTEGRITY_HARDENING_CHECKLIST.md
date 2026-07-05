# D2.x — Transaction Sync Integrity Hardening — Checklist + Slice 1

**Status:** Checklist + smallest schema-free slice implemented (soft-delete + recovery). Durable skip-persistence (needs schema) deferred to a follow-up.

## Decision: what's schema-free vs needs schema

- **Soft-delete `removed[]` + resurrection (parts 1, 2): SCHEMA-FREE.** `Transaction.deletedAt` already exists (used by import rollback, D2 Step 4D-3), and **every transaction reader already filters `deletedAt: null`** (`lib/data/transactions.ts`, `app/api/accounts/[id]/transactions/route.ts`, `lib/ai/assemblers/transactions.ts`, and the snapshot reconstruction). So tombstoned rows will **not** reappear in UI/AI/totals. Implemented in this slice.
- **Recovery script (part 6): SCHEMA-FREE.** The `syncTransactionsForItem` import chain is `server-only`-free, so a `tsx` script can reset one cursor and re-sync. Implemented in this slice.
- **Durable skip/error persistence (part 3): NEEDS SCHEMA** (a `TransactionSyncIssue` table) — or a schema-free `AuditLog` write. **Deferred** (see §Deferred). The correctness hole is closed by soft-delete without it; skip records are forensics.

## Answers to the checklist questions

- **Does soft-delete on `removed[]` break upsert/dedupe? No.** The row keeps its unique `plaidTransactionId`. `findUnique(plaidTransactionId)` still finds it (Prisma doesn't filter `deletedAt`), so a genuinely-returned transaction is **updated in place and resurrected** (`deletedAt: null` added to that update). Physical delete is replaced by `updateMany … { deletedAt: new Date() }` guarded on `deletedAt: null` (idempotent, preserves the first tombstone time).
- **Should `findUnique(plaidTransactionId)` include deleted rows? Yes — required.** `plaidTransactionId` is `@unique`; excluding deleted rows and then `create`-ing the same id would violate the constraint. Including them lets us resurrect (update + `deletedAt: null`) instead. Kept as-is; added the resurrect.
- **Removed pending returns as posted with a NEW id — avoid resurrecting the wrong pending? Handled.** The posted's new id misses `findUnique`; `findByFingerprint` filters `deletedAt: null`, so it does **not** match the tombstoned pending → the posted **inserts fresh**, the pending stays a tombstone. No wrong resurrection.
- **Fingerprint: ignore deleted rows or use for tombstone awareness? Ignore (keep `deletedAt: null`).** Matching against tombstones would risk resurrecting the wrong pending. Tombstones are for forensics/recovery, not matching. Unchanged.
- **Minimal schema for durable sync issues?** For **removed** rows: none — the soft-delete tombstone (`Transaction where deletedAt is not null`, `plaidTransactionId` preserved) is the record. For **skipped** rows (never inserted): no existing row to flag → a durable record needs either a new `TransactionSyncIssue` table or an `AuditLog` row (§Deferred). Not required for the correctness fix.
- **Rollback plan:** the sync change is additive/behavioral — revert the two edits in `syncTransactions.ts` to restore hard-delete. No schema touched. Tombstoned rows from the new behavior remain valid (readers already ignore them); to hard-purge if ever wanted: `DELETE FROM "Transaction" WHERE "deletedAt" IS NOT NULL AND "plaidTransactionId" IS NOT NULL` (not recommended). The recovery script is additive (delete the file).
- **How to recover the current missing payroll after hardening?** Run the recovery script (part 6) on Chase's PlaidItem: it nulls that one cursor and re-syncs, so Plaid replays the full window and the posted payroll inserts. Existing rows are updated-in-place (idempotent), so no duplicates. (If it still doesn't appear, it's the Q8 branches from the prior investigation — Plaid balance-only, or an identity gap.)

## Implemented in this slice

1. **`lib/plaid/syncTransactions.ts`**
   - `removed[]` → **soft-delete** (`updateMany deletedAt=now`, guarded on `deletedAt: null`) instead of `deleteMany`; logs the removed `plaidTransactionId`s (durable forensics via the tombstones + a structured log line).
   - `findUnique(plaidTransactionId)` update path now sets `deletedAt: null` → **resurrects** a tombstoned transaction Plaid re-sends as live.
   - Everything else (fingerprint `deletedAt: null`, create path, cursor progression, skip counts) unchanged.
2. **`scripts/recover-plaid-item-transactions.ts`** (new, read-only-by-default)
   - Dry-run default: prints the target PlaidItem (institution, cursor set?, `lastSyncedAt`) and what would happen; writes nothing.
   - `--apply`: sets that **one** item's `cursor = NULL`, runs `syncTransactionsForItem`, and reports `added / modified / removed / created / updatedByPlaidId / updatedByFingerprint / skippedMissingAccount`.
   - Scoped to a single `--item <PlaidItem.id>`; never touches other items; idempotent (dedupe protects against duplicates).

## Deferred (needs schema or a separate slice)

- **Durable skip persistence (part 3).** Smallest options, ranked:
  - **`AuditLog` write (schema-free):** on skip (missing-account / upsert-error), insert an `AuditLog` row `action='TRANSACTION_SYNC_SKIP'`, `metadata={ reason, plaidTransactionId, plaidAccountId, merchant, amount, date }`, `userId=item.userId`. No schema; slightly overloads AuditLog.
  - **`TransactionSyncIssue` table (cleaner, needs migration):** `id, plaidItemId, plaidAccountId, plaidTransactionId?, reason (enum: MISSING_ACCOUNT|UPSERT_ERROR), merchant?, amount?, date?, resolved Boolean, createdAt`. Purpose-built, queryable, no AuditLog pollution.
  - **Recommendation:** ship the correctness fix now (this slice); add skip persistence as a small follow-up — `AuditLog` if you want it schema-free today, or the table if you want a first-class forensic surface. **Not implemented here per the "stop if schema needed" rule.**
- **`pending_transaction_id` reconciliation** — deliberately not started (larger; the soft-delete + resurrection already prevents the permanent-loss window).

## Validation

- `npx tsc --noEmit`; `npm run lint` (scoped files).
- **Integration (needs dev DB — noted, not runnable in this sandbox):**
  - `removed[]` soft-delete: a row Plaid removes gets `deletedAt` set, keeps `plaidTransactionId`, and disappears from reads.
  - pending→posted id-change: pending exists → `removed[pending]` soft-deletes it → posted (new id) inserts fresh → final: posted active, pending tombstoned. No wrong resurrection.
  - posted insert fails / missing account: pending tombstoned + retained; skip logged (and, once part 3 ships, recorded).
  - recovery script: `--apply` on Chase recovers the missing payroll with **no duplicates** (existing rows updated in place).
