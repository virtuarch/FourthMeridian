import { DebtClient } from "@/components/dashboard/DebtClient";
import { getFicoData, getAccounts } from "@/lib/data/accounts";
import { getDebtTransactions } from "@/lib/data/transactions";
import { getSpaceContext } from "@/lib/space";
import { serializeSpaceConversionContext } from "@/lib/money/server-context";
import { yesterdayUTCISO } from "@/lib/fx/config";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function CreditPage() {
  const ctx = await getSpaceContext();
  const [{ score, updatedAt }, accounts, transactions] = await Promise.all([
    getFicoData({ userId: ctx.userId }),
    getAccounts({ spaceId: ctx.spaceId }),
    getDebtTransactions({ spaceId: ctx.spaceId }),
  ]);

  const debtAccounts = accounts.filter((a) => a.type === "debt");

  // MC1 Phase 3 Slice 6 (F-1, D-6) — serialized conversion context for the
  // client-side per-liability rollup (each debt leg converts at its own row
  // date). All-USD Spaces serialize empty entries; math is identical.
  const moneyCtx = await serializeSpaceConversionContext(ctx.space, {
    currencies: [
      ...debtAccounts.map((a) => a.currency ?? null),
      ...transactions.map((t) => t.currency ?? null),
    ],
    dates: [yesterdayUTCISO(), ...transactions.map((t) => t.date)],
  });

  return (
    <DebtClient
      initialFico={score}
      lastUpdatedAt={updatedAt}
      accounts={debtAccounts}
      transactions={transactions}
      moneyCtx={moneyCtx}
    />
  );
}
