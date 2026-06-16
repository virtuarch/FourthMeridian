import { Suspense }                                   from "react";
import { DashboardClient }                             from "@/components/dashboard/DashboardClient";
import { WorkspaceDashboard }                          from "@/components/dashboard/WorkspaceDashboard";
import { getAccounts, getHoldings, getFicoData }       from "@/lib/data/accounts";
import { getRecentSnapshots }                          from "@/lib/data/snapshots";
import { getLatestAdvice }                             from "@/lib/data/advice";
import { getDebtTransactions }                         from "@/lib/data/transactions";
import { getWorkspaceContext }                         from "@/lib/workspace";

// Co-locate compute with the Singapore-region Supabase instance — see
// lib/workspace.ts / perf audit notes. Applies to this page's serverless
// function only; does not affect local dev (Vercel-only config).
export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function DashboardPage() {
  // ── Timing instrumentation (temporary — perf audit) ─────────────────────
  const t0 = Date.now();
  const lap = (label: string, from: number) => {
    console.log(`[page:dashboard] ${label}: ${Date.now() - from}ms`);
    return Date.now();
  };

  const ctx = await getWorkspaceContext();
  let t = lap("getWorkspaceContext", t0);
  const isPersonal = ctx.workspace.type === "PERSONAL";

  // Non-personal workspaces render the planning dashboard (client-side data fetching)
  if (!isPersonal) {
    console.log(`[page:dashboard] total (shared-workspace branch): ${Date.now() - t0}ms`);
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
  // Context is resolved exactly once above (and cache()-deduped even if it
  // weren't — see lib/workspace.ts). Pass the already-resolved
  // workspaceId/userId into each helper below instead of letting them call
  // getWorkspaceContext() again, so this page makes zero redundant context
  // lookups instead of relying solely on the cache() dedupe.
  const time = <T,>(label: string, p: Promise<T>): Promise<T> => {
    const s = Date.now();
    return p.then((r) => { console.log(`[page:dashboard]   ${label}: ${Date.now() - s}ms`); return r; });
  };
  const [accounts, holdings, snapshots, advice, ficoData, debtTransactions] = await Promise.all([
    time("getAccounts", getAccounts({ workspaceId: ctx.workspaceId })),
    time("getHoldings", getHoldings({ workspaceId: ctx.workspaceId })),
    time("getRecentSnapshots(365)", getRecentSnapshots(365, { workspaceId: ctx.workspaceId })),
    time("getLatestAdvice", getLatestAdvice({ workspaceId: ctx.workspaceId })),
    time("getFicoData", getFicoData({ userId: ctx.userId })),
    time("getDebtTransactions", getDebtTransactions({ workspaceId: ctx.workspaceId })),
  ]);
  t = lap("Promise.all [accounts, holdings, snapshots, advice, ficoData, debtTransactions] (wall clock)", t);
  console.log(`[page:dashboard] total: ${Date.now() - t0}ms`);

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
