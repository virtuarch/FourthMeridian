/**
 * lib/sync/computeCashResidual.ts
 *
 * Called by the Plaid sync job after writing holdings for any investment or
 * crypto account.  Computes the gap between the authoritative account balance
 * and the sum of real position values, then upserts (or deletes) a synthetic
 * CASH holding so the two always agree.
 *
 * Why: Plaid returns individual positions but the account balance also includes
 * uninvested settlement cash, pending credits, and USD balances (e.g. Coinbase).
 * Without this, the holdings donut never sums to the account balance.
 *
 * Usage:
 *   import { computeCashResidual } from "@/lib/sync/computeCashResidual";
 *   await computeCashResidual(db, accountId, accountBalance);
 */

import { PrismaClient } from "@prisma/client";

const CASH_SYMBOL   = "CASH";
const CASH_NAME     = "Uninvested Cash";
const MIN_THRESHOLD = 5; // ignore residuals below $5 (rounding noise)

export async function computeCashResidual(
  db:             PrismaClient,
  accountId:      string,
  accountBalance: number,
): Promise<void> {
  // Sum all real (non-cash) positions for this account
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const positions = await (db.holding as any).findMany({
    where:  { accountId, isCash: false },
    select: { value: true },
  });

  const positionsTotal = (positions as { value: number }[]).reduce((sum, h) => sum + h.value, 0);
  const residual       = accountBalance - positionsTotal;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = db.holding as any;

  if (residual >= MIN_THRESHOLD) {
    // Upsert: write or update the CASH row
    await h.upsert({
      where:  { accountId_symbol: { accountId, symbol: CASH_SYMBOL } },
      create: { accountId, symbol: CASH_SYMBOL, name: CASH_NAME, quantity: residual, price: 1, value: residual, change24h: 0, isCash: true },
      update: { quantity: residual, value: residual },
    });
  } else {
    // Residual is negligible — remove any stale CASH row
    await h.deleteMany({ where: { accountId, isCash: true } });
  }
}
