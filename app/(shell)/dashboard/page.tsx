import { Suspense }                                   from "react";
import { DashboardClient }                             from "@/components/dashboard/DashboardClient";
import { WorkspaceDashboard }                          from "@/components/dashboard/WorkspaceDashboard";
import { getAccounts, getHoldings, getFicoData }       from "@/lib/data/accounts";
import { getRecentSnapshots }                          from "@/lib/data/snapshots";
import { getLatestAdvice }                             from "@/lib/data/advice";
import { getDebtTransactions }                         from "@/lib/data/transactions";
import { getWorkspaceContext }                         from "@/lib/workspace";

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
  // NOTE: each of these 6 helpers independently calls getWorkspaceContext()
  // again internally — watch for 6 more "[wsctx ...] ENTER" log blocks here.
  // Each member is timed individually (via `time()`, which doesn't delay
  // the promise — it still starts immediately, this only wraps the .then())
  // so we can see if they truly run in parallel or serialize on the DB
  // connection (connection_limit on the pooler would show up here as each
  // member's time roughly stacking instead of overlapping).
  const time = <T,>(label: string, p: Promise<T>): Promise<T> => {
    const s = Date.now();
    return p.then((r) => { console.log(`[page:dashboard]   ${label}: ${Date.now() - s}ms`); return r; });
  };
  const [accounts, holdings, snapshots, advice, ficoData, debtTransactions] = await Promise.all([
    time("getAccounts", getAccounts()),
    time("getHoldings", getHoldings()),
    time("getRecentSnapshots(365)", getRecentSnapshots(365)),
    time("getLatestAdvice", getLatestAdvice()),
    time("getFicoData", getFicoData()),
    time("getDebtTransactions", getDebtTransactions()),
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
