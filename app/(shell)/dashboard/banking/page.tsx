import { BankingClient } from "@/components/dashboard/BankingClient";
import { getAccounts } from "@/lib/data/accounts";
import { getTransactions } from "@/lib/data/transactions";
import { getPortfolioHistory } from "@/lib/data/snapshots";
import { getSpaceContext } from "@/lib/space";
import { serializeSpaceConversionContext } from "@/lib/money/server-context";
import { yesterdayUTCISO } from "@/lib/fx/config";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

interface PageProps {
  searchParams: Promise<{ account?: string }>;
}

export default async function BankingPage({ searchParams }: PageProps) {
  const ctx = await getSpaceContext();
  const [accounts, transactions, portfolioHistory, params] = await Promise.all([
    getAccounts({ spaceId: ctx.spaceId }),
    getTransactions({ spaceId: ctx.spaceId }),
    getPortfolioHistory(),
    searchParams,
  ]);

  // MC1 Phase 3 Slice 6 (F-1, D-6) — serialized conversion context for the
  // client-side balance and flow totals. All-USD Spaces serialize empty
  // entries; math is identical. getSpaceContext() is cache()-deduped, so the
  // added call costs nothing when the data helpers resolve it internally too.
  const moneyCtx = await serializeSpaceConversionContext(ctx.space, {
    currencies: [
      ...accounts.map((a) => a.currency ?? null),
      ...transactions.map((t) => t.currency ?? null),
    ],
    dates: [yesterdayUTCISO(), ...transactions.map((t) => t.date)],
  });

  return (
    <BankingClient
      accounts={accounts}
      transactions={transactions}
      portfolioHistory={portfolioHistory}
      preselectedId={params.account ?? null}
      moneyCtx={moneyCtx}
    />
  );
}
