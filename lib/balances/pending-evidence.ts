/**
 * lib/balances/pending-evidence.ts   (V27-L3 — RECONCILIATION)
 *
 * The ONE reader of provider-observed pending movements. READ-ONLY: a single
 * SELECT, no writes, no mutation, ever.
 *
 * ── What counts as evidence ─────────────────────────────────────────────────
 *
 * Only rows a provider (or an import) actually delivered. Nothing here infers,
 * projects, or extrapolates: no recurring payroll, no historical averages, no
 * expected bills, no merchant patterns, no habits. A prediction whose inputs the
 * provider did not attest is a forecast wearing an accounting costume, and the
 * whole point of this slice is that we do not ship one.
 *
 * ── The lifecycle boundary (temporary, and deliberately narrow) ─────────────
 *
 * Two columns claim to hold the lifecycle and they are not co-maintained. Live
 * counts on the corpus (2026-08-04, active rows):
 *
 *     settlementState=POSTED   pending=false   4036
 *     settlementState=null     pending=false    348
 *     settlementState=PENDING  pending=true       6
 *     settlementState=null     pending=true       4
 *
 * So `settlementState` is simply UNPOPULATED on 352 older rows — it does not
 * contradict the boolean anywhere. In particular **settlementState=PENDING with
 * pending=false is 0 rows**, so the boolean is today the complete superset and
 * the strongest single signal available.
 *
 * This reader therefore gates on `pending = true` AND additionally excludes
 * `settlementState = 'POSTED'`. That second clause is a no-op today; it exists
 * because it defends the ONE disagreement direction that would double-count — a
 * row the settlement column knows has posted while the boolean still says
 * pending. Retiring one of the two columns is Slice 4's job (L6), and this
 * module must be revisited then; it deliberately does not begin that work.
 *
 * ── Counting each movement exactly once ─────────────────────────────────────
 *
 * A pending row whose posted successor is ALSO live would contribute twice: once
 * as pending here, once as a posted row in the balance the provider already
 * reflects. The corpus currently has 0 such pairs (the sync tombstones the
 * pending predecessor), but "currently zero" is not an invariant, so the query
 * excludes any pending row referenced by a live posted row's
 * `pendingTransactionRef`.
 */

import { db } from "@/lib/db";

/** Provider-observed pending movements for one account. */
export interface PendingContribution {
  /** How many pending rows were counted. */
  count: number;
  /**
   * Σ of their stored `amount` values, in Fourth Meridian's sign convention:
   * NEGATIVE is money out. (Plaid's opposite convention is flipped once, at
   * ingest — lib/plaid/syncTransactions.ts: `const amount = -txn.amount`.)
   */
  sum: number;
  /** The row ids counted, so single-counting is provable rather than asserted. */
  transactionIds: string[];
}

export const NO_PENDING: PendingContribution = { count: 0, sum: 0, transactionIds: [] };

/**
 * Load pending evidence for the given accounts, scoped per account.
 *
 * Returns a map keyed by financialAccountId. An account with no pending rows is
 * ABSENT from the map — callers should treat absence as NO_PENDING, which is a
 * real answer ("nothing pending"), not a missing one.
 */
export async function loadPendingEvidence(
  accountIds: string[],
): Promise<Map<string, PendingContribution>> {
  const byAccount = new Map<string, PendingContribution>();
  if (accountIds.length === 0) return byAccount;

  const rows = await db.transaction.findMany({
    where: {
      financialAccountId: { in: accountIds },
      deletedAt: null,
      pending: true,
      // See the header: a no-op today, and the guard against the one
      // disagreement direction that would double-count.
      //
      // ⚠️ Written as an explicit OR-with-null, NOT `NOT: { settlementState:
      // "POSTED" }`. `settlementState` is NULLABLE and SQL's three-valued logic
      // makes `NOT (col = 'POSTED')` evaluate to NULL — i.e. FALSE — for every
      // row where the column is null. That silently dropped all 4 seed pending
      // rows (10 → 6) and under-counted pending evidence on four accounts. A
      // null lifecycle column means "unpopulated", never "posted".
      OR: [
        { settlementState: null },
        { settlementState: { not: "POSTED" } },
      ],
    },
    select: {
      id: true,
      financialAccountId: true,
      amount: true,
      plaidTransactionId: true,
    },
  });
  if (rows.length === 0) return byAccount;

  // Exclude any pending row whose posted successor is ALSO live — that row's
  // effect is already inside the provider's observed balance.
  const pendingProviderIds = rows
    .map((r) => r.plaidTransactionId)
    .filter((v): v is string => v !== null);
  const supersededRefs = pendingProviderIds.length
    ? new Set(
        (
          await db.transaction.findMany({
            where: {
              deletedAt: null,
              pendingTransactionRef: { in: pendingProviderIds },
            },
            select: { pendingTransactionRef: true },
          })
        )
          .map((r) => r.pendingTransactionRef)
          .filter((v): v is string => v !== null),
      )
    : new Set<string>();

  for (const r of rows) {
    if (!r.financialAccountId) continue;
    if (r.plaidTransactionId && supersededRefs.has(r.plaidTransactionId)) continue;
    const e = byAccount.get(r.financialAccountId) ?? { count: 0, sum: 0, transactionIds: [] };
    e.count += 1;
    e.sum += r.amount;
    e.transactionIds.push(r.id);
    byAccount.set(r.financialAccountId, e);
  }
  return byAccount;
}
