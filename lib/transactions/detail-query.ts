/**
 * lib/transactions/detail-query.ts
 *
 * TI-1 — the canonical single-transaction visibility WHERE clause.
 *
 * Pure query-shape module (enum values + the shared KD-15 predicate only —
 * no DB import), so the visibility matrix is directly assertable by
 * lib/data/transaction-detail.privacy.test.ts without a live database, the
 * same way lib/ai/visibility.ts keeps the predicate itself testable.
 *
 * This is the row-scoped form of the exact predicate every transaction LIST
 * read applies (lib/data/transactions.ts, lib/ai/assemblers/transactions.ts):
 *
 *   - id                      — the single row being inspected
 *   - deletedAt: null         — D2 Step 4D-R import-rollback soft delete
 *   - financialAccount        — financialAccount.deletedAt: null AND an
 *                               ACTIVE SpaceAccountLink at a visibility tier
 *                               granting transaction detail
 *                               (TRANSACTION_DETAIL_VISIBILITY — FULL only)
 *
 * Fails closed by construction: a nonexistent id, a soft-deleted row, a row
 * in another Space, a BALANCE_ONLY / SUMMARY_ONLY / PRIVATE / SHARED-only
 * link, or a soft-deleted FinancialAccount all simply fail to match, and the
 * caller returns 404 — indistinguishable from "does not exist" (no existence
 * disclosure). See
 * docs/investigations/TRANSACTION_INTELLIGENCE_DETAIL_VIEW_INVESTIGATION_2026-07-06.md §1.3, §2.
 */

import { ShareStatus } from "@prisma/client";

import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";

/**
 * Build the WHERE clause for a single-transaction detail read scoped to a
 * Space. Passed verbatim to `db.transaction.findFirst` by
 * getTransactionDetail() (lib/data/transactions.ts).
 */
export function transactionDetailWhere(id: string, spaceId: string) {
  return {
    id,
    financialAccount: {
      deletedAt: null,
      spaceAccountLinks: {
        some: {
          spaceId,
          status: ShareStatus.ACTIVE,
          visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
        },
      },
    },
    // Transaction-level soft delete (import rollback) — independent of, and
    // ANDed with, the financialAccount.deletedAt guard above.
    deletedAt: null,
  };
}
