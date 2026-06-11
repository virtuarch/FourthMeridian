import { InvestmentsClient } from "@/components/dashboard/InvestmentsClient";
import { getAccounts, getHoldings } from "@/lib/data/accounts";
import { getInvestmentTransactions } from "@/lib/data/transactions";
import { getPortfolioHistory } from "@/lib/data/snapshots";

interface PageProps {
  searchParams: Promise<{ account?: string }>;
}

export default async function InvestmentsPage({ searchParams }: PageProps) {
  const [accounts, holdings, investmentTransactions, portfolioHistory, params] = await Promise.all([
    getAccounts(),
    getHoldings(),
    getInvestmentTransactions(),
    getPortfolioHistory(),
    searchParams,
  ]);

  return (
    <InvestmentsClient
      accounts={accounts}
      holdings={holdings}
      investmentTransactions={investmentTransactions}
      portfolioHistory={portfolioHistory}
      preselectedId={params.account ?? null}
    />
  );
}
