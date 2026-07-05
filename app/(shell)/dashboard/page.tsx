import { Suspense }                                   from "react";
import { DashboardClient }                             from "@/components/dashboard/DashboardClient";
import { SpaceDashboard }                          from "@/components/dashboard/SpaceDashboard";
import { getAccounts, getHoldings, getFicoData }       from "@/lib/data/accounts";
import { getRecentSnapshots }                          from "@/lib/data/snapshots";
import { getLatestAdvice }                             from "@/lib/data/advice";
import { getDebtTransactions, getTransactions }        from "@/lib/data/transactions";
import { getSpaceContext }                         from "@/lib/space";
import { serializeSpaceConversionContext }        from "@/lib/money/server-context";
import { yesterdayUTCISO }                         from "@/lib/fx/config";

// Co-locate compute with the Singapore-region Supabase instance — see
// lib/space.ts / perf audit notes. Applies to this page's serverless
// function only; does not affect local dev (Vercel-only config).
export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function DashboardPage() {
  const ctx = await getSpaceContext();
  const isPersonal = ctx.space.type === "PERSONAL";

  // Non-personal spaces render the planning dashboard (client-side data fetching)
  if (!isPersonal) {
    return (
      <Suspense fallback={null}>
        <SpaceDashboard
          spaceId={ctx.spaceId}
          spaceName={ctx.space.name}
          spaceType={ctx.space.type}
          category={ctx.space.category}
          myRole={ctx.role}
          currentUserId={ctx.userId}
        />
      </Suspense>
    );
  }

  // Personal space — existing full dashboard.
  // Context is resolved exactly once above (and cache()-deduped even if it
  // weren't — see lib/space.ts). Pass the already-resolved
  // spaceId/userId into each helper below instead of letting them call
  // getSpaceContext() again, so this page makes zero redundant context
  // lookups instead of relying solely on the cache() dedupe.
  const [accounts, holdings, snapshots, advice, ficoData, debtTransactions, transactions] = await Promise.all([
    getAccounts({ spaceId: ctx.spaceId }),
    getHoldings({ spaceId: ctx.spaceId }),
    getRecentSnapshots(365, { spaceId: ctx.spaceId }),
    getLatestAdvice({ spaceId: ctx.spaceId }),
    getFicoData({ userId: ctx.userId }),
    getDebtTransactions({ spaceId: ctx.spaceId }),
    getTransactions({ spaceId: ctx.spaceId }),
  ]);

  // MC1 Phase 3 Slice 6 (F-1, D-6) — serialize the Space's conversion context
  // for the client-side classify/flow math. Currencies and dates cover
  // everything this client aggregates: account balances (latest close) plus
  // every provided transaction row's own date. All-USD Spaces serialize an
  // empty entry table (a few bytes; identical math).
  const moneyCtx = await serializeSpaceConversionContext(ctx.space, {
    currencies: [
      ...accounts.map((a) => a.currency ?? null),
      ...transactions.map((t) => t.currency ?? null),
      ...debtTransactions.map((t) => t.currency ?? null),
    ],
    dates: [
      yesterdayUTCISO(),
      ...transactions.map((t) => t.date),
      ...debtTransactions.map((t) => t.date),
    ],
  });

  return (
    <Suspense fallback={null}>
      <DashboardClient
        spaceId={ctx.spaceId}
        spaceName={ctx.space.name}
        category={ctx.space.category}
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
        moneyCtx={moneyCtx}
      />
    </Suspense>
  );
}
