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
 *   - eventProjectionWhere()  — REVIEW-3: one row per logical event (L8-B1)
 *   - BANKING_POPULATION      — REVIEW-3: the banking semantic population
 *
 * Fails closed by construction: a nonexistent id, a soft-deleted row, a row
 * in another Space, a BALANCE_ONLY / SUMMARY_ONLY / PRIVATE / SHARED-only
 * link, a soft-deleted FinancialAccount, a SUPERSEDED event row, or a row
 * outside the banking population (crypto ledger / investment activity) all
 * simply fail to match, and the caller returns 404 — indistinguishable from
 * "does not exist" (no existence disclosure). See
 * docs/investigations/TRANSACTION_INTELLIGENCE_DETAIL_VIEW_INVESTIGATION_2026-07-06.md §1.3, §2.
 */

import { ShareStatus } from "@prisma/client";

import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
// REVIEW-3 (matrix row 36, divergence 3) — the detail read now carries the SAME
// population fragments as every LIST read. Both modules are pure query shapes,
// so this one stays DB-free and directly assertable.
import { BANKING_POPULATION } from "@/lib/data/banking-population";
import { eventProjectionWhere } from "@/lib/transactions/event-projection";

/**
 * Build the WHERE clause for a single-transaction detail read scoped to a
 * Space. Passed verbatim to `db.transaction.findFirst` by
 * getTransactionDetail() (lib/data/transactions.ts).
 *
 * ── Population alignment (REVIEW-3 row 36) ─────────────────────────────────
 * Before this fix the detail read applied ONLY visibility + soft-delete: a
 * superseded pending row (event projection excluded it from every list) or a
 * CRYPTO_LEDGER / INVESTMENT row (banking population excluded it everywhere)
 * still returned a full banking-framed detail DTO by direct id — a row absent
 * from every list had a drawer. The detail read now ANDs the exact fragments
 * the list reads compose (`bankingTransactionWhere`):
 *
 *   - eventProjectionWhere() — one row per logical event; a superseded row
 *     404s here exactly as it vanishes from the lists (L8-B1).
 *   - BANKING_POPULATION     — no banking-framed detail for investment
 *     security-activity or crypto-ledger rows the banking authorities refuse.
 *
 * INTENTIONAL remaining differences from the list read, in full:
 *   - `id` scoping instead of ordering/limit — a point read has no window, and
 *     admitting any date is correct (the drawer must open on an OLD row a list
 *     happens to be showing).
 *   - No relation include here — the caller owns its include; this module owns
 *     only the WHERE.
 * There are deliberately NO other differences. A row that leaves the banking
 * population after a reclassification 404s on its next detail read, which is
 * the same moment it disappears from every list — one population, two shapes.
 */
export function transactionDetailWhere(id: string, spaceId: string) {
  return {
    id,
    // Composed with AND, never spread: both fragments carry an `OR`, and a
    // spread would silently keep only the last one (the exact hazard
    // bankingTransactionWhere documents — v2.6-POP-1).
    AND: [eventProjectionWhere(), BANKING_POPULATION],
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
