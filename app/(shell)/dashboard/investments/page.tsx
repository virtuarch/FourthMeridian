import { InvestmentsClient } from "@/components/dashboard/InvestmentsClient";
import { getAccounts, getHoldings } from "@/lib/data/accounts";
import { getInvestmentTransactions } from "@/lib/data/transactions";
import { getPortfolioHistory } from "@/lib/data/snapshots";
import { getSpaceContext } from "@/lib/space";
import { serializeSpaceConversionContext } from "@/lib/money/server-context";
import { yesterdayUTCISO } from "@/lib/fx/config";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

interface PageProps {
  searchParams: Promise<{ account?: string }>;
}

export default async function InvestmentsPage({ searchParams }: PageProps) {
  const ctx = await getSpaceContext();
  const [accounts, holdings, investmentTransactions, portfolioHistory, params] = await Promise.all([
    getAccounts({ spaceId: ctx.spaceId }),
    getHoldings({ spaceId: ctx.spaceId }),
    getInvestmentTransactions(),
    getPortfolioHistory(),
    searchParams,
  ]);

  // MC1 Phase 4 Slice 5 (F-5, D-6) — serialized conversion context for the
  // client-side investment totals (account balances at the latest close).
  // All-USD Spaces serialize empty entries; math is identical.
  const moneyCtx = await serializeSpaceConversionContext(ctx.space, {
    currencies: [
      ...accounts.map((a) => a.currency ?? null),
      ...holdings.map((h) => h.currency ?? null),
    ],
    dates: [yesterdayUTCISO()],
  });

  return (
    <InvestmentsClient
      accounts={accounts}
      holdings={holdings}
      investmentTransactions={investmentTransactions}
      portfolioHistory={portfolioHistory}
      preselectedId={params.account ?? null}
      moneyCtx={moneyCtx}
    />
  );
}
