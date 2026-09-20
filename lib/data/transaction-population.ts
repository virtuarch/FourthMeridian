/**
 * lib/data/transaction-population.ts   (M1 — measures & comparison)
 *
 * WHICH ACCOUNTS PUT ROWS INTO THE BANKING POPULATION, and through when.
 *
 * ⚠️ FOR POPULATION-AWARE COMPLETENESS, NOT FOR TOTALS. A flow measure is only as
 * complete as the sources that feed it, and a source feeds it only if its
 * accounts have banking rows at all. The recovered live Space proved the naive
 * rule wrong: a NEEDS_RECONNECT brokerage with zero banking rows would have
 * marked every spending figure incomplete. This read names the accounts that
 * actually contribute, with each one's newest dated row, so a caller can attach
 * source health to the components of THIS population and ignore the rest.
 *
 * ⚠️ ITS OWN MODULE, ON PURPOSE. `transaction-query.ts` is a pager and a min/max
 * span and `transaction-count.ts` is a count; each carries a source-scan that
 * forbids a grouped read, because a grouped read there would be the first step
 * toward a second analytics authority. This groups by ACCOUNT and returns a row
 * count and a date — never a sum, never an amount, never a currency.
 *
 * Same population authority as every banking read (`bankingTransactionWhere`),
 * same ceiling rule as `transactionCorpusSpan`. READ-ONLY.
 */

import "server-only";

import { db } from "@/lib/db";
import { bankingTransactionWhere } from "@/lib/data/banking-population";
import { toDbDate } from "@/lib/data/transaction-query-core";

export interface AccountPopulationEntry {
  accountId: string;
  /** Banking rows on or before the ceiling. */
  rows: number;
  /** The newest dated row, YYYY-MM-DD, or null when none is dated. */
  lastDate: string | null;
}

export async function transactionAccountPopulation(args: {
  spaceId: string;
  /** Information ceiling: rows dated after this do not count. */
  asOf?: string;
}): Promise<AccountPopulationEntry[]> {
  const ceiling = args.asOf ? toDbDate(args.asOf) : null;
  const grouped = await db.transaction.groupBy({
    by: ["financialAccountId"],
    where: {
      AND: [
        bankingTransactionWhere(args.spaceId),
        { economicDate: { not: null, ...(ceiling ? { lte: ceiling } : {}) } },
      ],
    },
    _count: { _all: true },
    _max: { economicDate: true },
  });
  return grouped
    .filter((g) => typeof g.financialAccountId === "string")
    .map((g) => ({
      accountId: g.financialAccountId as string,
      rows: g._count._all,
      lastDate: g._max.economicDate ? g._max.economicDate.toISOString().slice(0, 10) : null,
    }));
}
