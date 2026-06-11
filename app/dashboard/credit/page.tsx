import { CreditClient } from "@/components/dashboard/CreditClient";
import { getFicoData, getAccounts } from "@/lib/data/accounts";
import { getDebtTransactions } from "@/lib/data/transactions";

export default async function CreditPage() {
  const [{ score, updatedAt }, accounts, transactions] = await Promise.all([
    getFicoData(),
    getAccounts(),
    getDebtTransactions(),
  ]);

  const debtAccounts = accounts.filter((a) => a.type === "debt");

  return (
    <CreditClient
      initialFico={score}
      lastUpdatedAt={updatedAt}
      accounts={debtAccounts}
      transactions={transactions}
    />
  );
}
