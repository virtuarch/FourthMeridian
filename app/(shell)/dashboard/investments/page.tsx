import { InvestmentsClient } from "@/components/dashboard/InvestmentsClient";
import { getAccounts, getHoldings } from "@/lib/data/accounts";
import { getInvestmentTransactions } from "@/lib/data/transactions";
import { getPortfolioHistory } from "@/lib/data/snapshots";

interface PageProps {
  searchParams: Promise<{ account?: string }>;
}

export default async function InvestmentsPage({ searchParams }: PageProps) {
  const t0 = Date.now();
  const time = <T,>(label: string, p: Promise<T>): Promise<T> => {
    const s = Date.now();
    return p.then((r) => { console.log(`[page:investments]   ${label}: ${Date.now() - s}ms`); return r; });
  };
  const [accounts, holdings, investmentTransactions, portfolioHistory, params] = await Promise.all([
    time("getAccounts", getAccounts()),
    time("getHoldings", getHoldings()),
    time("getInvestmentTransactions", getInvestmentTransactions()),
    time("getPortfolioHistory", getPortfolioHistory()),
    time("searchParams", searchParams),
  ]);
  console.log(`[page:investments] total: ${Date.now() - t0}ms`);

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
