import { Suspense }                                   from "react";
import { DashboardClient }                             from "@/components/dashboard/DashboardClient";
import { WorkspaceDashboard }                          from "@/components/dashboard/WorkspaceDashboard";
import { getAccounts, getHoldings, getFicoData }       from "@/lib/data/accounts";
import { getRecentSnapshots }                          from "@/lib/data/snapshots";
import { getLatestAdvice }                             from "@/lib/data/advice";
import { getDebtTransactions, getTransactions }        from "@/lib/data/transactions";
import { getWorkspaceContext }                         from "@/lib/workspace";

// Co-locate compute with the Singapore-region Supabase instance — see
// lib/workspace.ts / perf audit notes. Applies to this page's serverless
// function only; does not affect local dev (Vercel-only config).
export const preferredRegion = "sin1";
export const runtime = "nodejs";

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

  // Personal workspace — existing full dashboard.
  // Context is resolved exactly once above (and cache()-deduped even if it
  // weren't — see lib/workspace.ts). Pass the already-resolved
  // workspaceId/userId into each helper below instead of letting them call
  // getWorkspaceContext() again, so this page makes zero redundant context
  // lookups instead of relying solely on the cache() dedupe.
  const [accounts, holdings, snapshots, advice, ficoData, debtTransactions, transactions] = await Promise.all([
    getAccounts({ workspaceId: ctx.workspaceId }),
    getHoldings({ workspaceId: ctx.workspaceId }),
    getRecentSnapshots(365, { workspaceId: ctx.workspaceId }),
    getLatestAdvice({ workspaceId: ctx.workspaceId }),
    getFicoData({ userId: ctx.userId }),
    getDebtTransactions({ workspaceId: ctx.workspaceId }),
    getTransactions({ workspaceId: ctx.workspaceId }),
  ]);

  return (
    <Suspense fallback={null}>
      <DashboardClient
        workspaceId={ctx.workspaceId}
        workspaceName={ctx.workspace.name}
        category={ctx.workspace.category}
        myRole={ctx.role}
        currentUserId={ctx.userId}
        accounts={accounts}
        holdings={holdings}
        snapshots={snapshots}
        advice={advice}
        ficoScore={ficoData.score}
        ficoUpdatedAt={ficoData.updatedAt}
        debtTransactions={debtTransactions}
        transactions={transactions}
      />
    </Suspense>
  );
}
