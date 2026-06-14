import { BankingClient } from "@/components/dashboard/BankingClient";
import { getAccounts } from "@/lib/data/accounts";
import { getTransactions } from "@/lib/data/transactions";
import { getPortfolioHistory } from "@/lib/data/snapshots";

interface PageProps {
  searchParams: Promise<{ account?: string }>;
}

export default async function BankingPage({ searchParams }: PageProps) {
  const [accounts, transactions, portfolioHistory, params] = await Promise.all([
    getAccounts(),
    getTransactions(),
    getPortfolioHistory(),
    searchParams,
  ]);

  return (
    <BankingClient
      accounts={accounts}
      transactions={transactions}
      portfolioHistory={portfolioHistory}
      preselectedId={params.account ?? null}
    />
  );
}
