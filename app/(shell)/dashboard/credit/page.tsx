import { DebtClient } from "@/components/dashboard/DebtClient";
import { getFicoData, getAccounts } from "@/lib/data/accounts";
import { getDebtTransactions, getDebtPaymentRows } from "@/lib/data/transactions";
import { getSpaceContext } from "@/lib/space";
import { serializeSpaceConversionContext } from "@/lib/money/server-context";
import { yesterdayUTCISO } from "@/lib/fx/config";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function CreditPage() {
  const ctx = await getSpaceContext();
  const [{ score, updatedAt }, accounts, debtTxns, paymentTxns] = await Promise.all([
    getFicoData({ userId: ctx.userId }),
    getAccounts({ spaceId: ctx.spaceId }),
    getDebtTransactions({ spaceId: ctx.spaceId }), // TX-2 bounded (default cap)
    // v2.6-TRUTH-7 — the debt-payment authority counts the CASH leg, which lives on
    // the account the money LEFT. A liability-scoped read cannot see it.
    getDebtPaymentRows({ spaceId: ctx.spaceId }),
  ]);
  const transactions = debtTxns.rows;

  const debtAccounts = accounts.filter((a) => a.type === "debt");
  // Every account, for the tier resolver the authority needs — NOT for display.
  const accountTiers = accounts.map((a) => ({ id: a.id, type: a.type }));

  // MC1 Phase 3 Slice 6 (F-1, D-6) — serialized conversion context for the
  // client-side per-liability rollup (each debt leg converts at its own row
  // date). All-USD Spaces serialize empty entries; math is identical.
  const moneyCtx = await serializeSpaceConversionContext(ctx.space, {
    currencies: [
      ...debtAccounts.map((a) => a.currency ?? null),
      ...transactions.map((t) => t.currency ?? null),
      ...paymentTxns.rows.map((t) => t.currency ?? null),
    ],
    dates: [yesterdayUTCISO(), ...transactions.map((t) => t.date), ...paymentTxns.rows.map((t) => t.date)],
  });

  return (
    <DebtClient
      initialFico={score}
      lastUpdatedAt={updatedAt}
      accounts={debtAccounts}
      transactions={transactions}
      paymentRows={paymentTxns.rows}
      accountTiers={accountTiers}
      moneyCtx={moneyCtx}
    />
  );
}
