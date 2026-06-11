import { Suspense } from "react";
import { DashboardClient } from "@/components/dashboard/DashboardClient";
import { getAccounts, getHoldings, getFicoData } from "@/lib/data/accounts";
import { getRecentSnapshots } from "@/lib/data/snapshots";
import { getLatestAdvice } from "@/lib/data/advice";
import { getDebtTransactions } from "@/lib/data/transactions";

export default async function DashboardPage() {
  const [accounts, holdings, snapshots, advice, ficoData, debtTransactions] = await Promise.all([
    getAccounts(),
    getHoldings(),
    getRecentSnapshots(365),
    getLatestAdvice(),
    getFicoData(),
    getDebtTransactions(),
  ]);

  return (
    <Suspense fallback={null}>
      <DashboardClient
        accounts={accounts}
        holdings={holdings}
        snapshots={snapshots}
        advice={advice}
        ficoScore={ficoData.score}
        ficoUpdatedAt={ficoData.updatedAt}
        debtTransactions={debtTransactions}
      />
    </Suspense>
  );
}
