import { DebtClient } from "@/components/dashboard/DebtClient";
import { getFicoData, getAccounts } from "@/lib/data/accounts";
import { getDebtTransactions } from "@/lib/data/transactions";

export default async function CreditPage() {
  const t0 = Date.now();
  const time = <T,>(label: string, p: Promise<T>): Promise<T> => {
    const s = Date.now();
    return p.then((r) => { console.log(`[page:credit]   ${label}: ${Date.now() - s}ms`); return r; });
  };
  const [{ score, updatedAt }, accounts, transactions] = await Promise.all([
    time("getFicoData", getFicoData()),
    time("getAccounts", getAccounts()),
    time("getDebtTransactions", getDebtTransactions()),
  ]);
  console.log(`[page:credit] total: ${Date.now() - t0}ms`);

  const debtAccounts = accounts.filter((a) => a.type === "debt");

  return (
    <DebtClient
      initialFico={score}
      lastUpdatedAt={updatedAt}
      accounts={debtAccounts}
      transactions={transactions}
    />
  );
}
