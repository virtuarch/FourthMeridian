import { BankingClient } from "@/components/dashboard/BankingClient";
import { getAccounts } from "@/lib/data/accounts";
import { getTransactions } from "@/lib/data/transactions";
import { getPortfolioHistory } from "@/lib/data/snapshots";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

interface PageProps {
  searchParams: Promise<{ account?: string }>;
}

export default async function BankingPage({ searchParams }: PageProps) {
  const t0 = Date.now();
  const time = <T,>(label: string, p: Promise<T>): Promise<T> => {
    const s = Date.now();
    return p.then((r) => { console.log(`[page:banking]   ${label}: ${Date.now() - s}ms`); return r; });
  };
  const [accounts, transactions, portfolioHistory, params] = await Promise.all([
    time("getAccounts", getAccounts()),
    time("getTransactions", getTransactions()),
    time("getPortfolioHistory", getPortfolioHistory()),
    time("searchParams", searchParams),
  ]);
  console.log(`[page:banking] total: ${Date.now() - t0}ms`);

  return (
    <BankingClient
      accounts={accounts}
      transactions={transactions}
      portfolioHistory={portfolioHistory}
      preselectedId={params.account ?? null}
    />
  );
}
