import { Suspense }                                   from "react";
import { DashboardClient }                             from "@/components/dashboard/DashboardClient";
import { WorkspaceDashboard }                          from "@/components/dashboard/WorkspaceDashboard";
import { getAccounts, getHoldings, getFicoData }       from "@/lib/data/accounts";
import { getRecentSnapshots }                          from "@/lib/data/snapshots";
import { getLatestAdvice }                             from "@/lib/data/advice";
import { getDebtTransactions }                         from "@/lib/data/transactions";
import { getWorkspaceContext }                         from "@/lib/workspace";

export default async function DashboardPage() {
  const ctx = await getWorkspaceContext();
  const isPersonal = ctx.workspace.type === "PERSONAL";

  // Non-personal workspaces render the planning dashboard (client-side data fetching)
  if (!isPersonal) {
    return (
      <Suspense fallback={null}>
        <WorkspaceDashboard
          workspaceId={ctx.workspaceId}
          workspaceName={ctx.workspace.name}
          workspaceType={ctx.workspace.type}
          category={ctx.workspace.category}
          myRole={ctx.role}
          currentUserId={ctx.userId}
        />
      </Suspense>
    );
  }

  // Personal workspace — existing full dashboard
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
