/**
 * lib/transactions/merchant-credit-evidence.ts   (REFUND-1)
 *
 * The ONE read that supplies lib/transactions/merchant-credit.ts with its
 * evidence: the categories of the same merchant's prior purchases on the same
 * account. Shared by the live Plaid sync seam and the historical repair so the
 * two can never select different evidence for the same row.
 *
 * READ-ONLY (a single findMany). The decision itself is pure and lives in
 * merchant-credit.ts; this file decides nothing.
 *
 * ── The evidence set, exactly ────────────────────────────────────────────────
 *   • the SAME financial account           (a card's refunds reverse that card's purchases)
 *   • ACTIVE rows (deletedAt null)         (a superseded pending twin is not a purchase)
 *   • amount < 0 and flowType SPENDING     (purchases — never payments, fees or credits)
 *   • dated ON OR BEFORE the credit        (a refund cannot reverse a future purchase,
 *                                           and the answer must not drift as history grows)
 *   • the SAME merchant, by EXACT equality on any of: the provider's merchant
 *     entity id (when the credit has one), the stored merchant name, or the raw
 *     issuer descriptor. The descriptor arm is load-bearing and MEASURED: the
 *     provider enriches a PURCHASE (merchant "Hungerstation LLC" / "Hunger
 *     Station") but leaves the CREDIT raw (merchant "HUNGERSTATION LLC"), so the
 *     names differ on all 14 prior purchases while the descriptor the issuer
 *     printed is identical on every one. No normalisation, no substring, no
 *     similarity — the resolver's unanimity rule is only meaningful over an
 *     exact set.
 */

/** The narrow client shape this read needs — a Prisma client or a test double. */
export interface MerchantCreditEvidenceClient {
  transaction: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { category: true };
    }): Promise<{ category: string }[]>;
  };
}

export interface MerchantCreditEvidenceQuery {
  financialAccountId: string;
  /** Provider merchant entity id of the credit, when it has one. */
  merchantEntityId: string | null;
  /** The credit's stored merchant name (Plaid `merchant_name ?? name`). */
  merchant: string;
  /** The credit's raw issuer descriptor (Plaid `name`), when stored. */
  description: string | null;
  /** The credit's posting date. */
  onOrBefore: Date;
}

/** The exact `where` — exported so a test can pin the evidence set. */
export function priorPurchaseWhere(q: MerchantCreditEvidenceQuery): Record<string, unknown> {
  const sameMerchant: Record<string, unknown>[] = [{ merchant: q.merchant }];
  if (q.description) sameMerchant.push({ description: q.description });
  if (q.merchantEntityId) sameMerchant.unshift({ merchantEntityId: q.merchantEntityId });
  return {
    financialAccountId: q.financialAccountId,
    deletedAt:          null,
    amount:             { lt: 0 },
    flowType:           "SPENDING",
    date:               { lte: q.onOrBefore },
    OR:                 sameMerchant,
  };
}

export async function readPriorPurchaseCategories(
  client: MerchantCreditEvidenceClient,
  q: MerchantCreditEvidenceQuery,
): Promise<string[]> {
  const rows = await client.transaction.findMany({
    where:  priorPurchaseWhere(q),
    select: { category: true },
  });
  return rows.map((r) => r.category);
}
