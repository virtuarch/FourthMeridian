import { Suspense }                                   from "react";
import { SpaceDashboard }                          from "@/components/dashboard/SpaceDashboard";
import { PersonalDashboard }                       from "@/components/dashboard/PersonalDashboard";
import { getAccounts, getFicoData }                    from "@/lib/data/accounts";
import { getRecentSnapshots }                          from "@/lib/data/snapshots";
import { getTransactions }                             from "@/lib/data/transactions";
import { getSpaceContext }                         from "@/lib/space";
import { serializeSpaceConversionContext }        from "@/lib/money/server-context";
import { yesterdayUTCISO }                         from "@/lib/fx/config";
import { DisplayCurrencyProvider }                 from "@/lib/currency-context";

// Co-locate compute with the Singapore-region Supabase instance — see
// lib/space.ts / perf audit notes. Applies to this page's serverless
// function only; does not affect local dev (Vercel-only config).
export const preferredRegion = "sin1";
export const runtime = "nodejs";

/**
 * SP-2A-4c — map a legacy Personal `?tab=` deep link onto the shared shell's
 * tab vocabulary. The unified SpaceDashboard has no URL sync, so this is a
 * one-shot initial-tab hint (applied once via the `initialTab` seam).
 * Unknown/absent values (including the old `dashboard`/`overview` ids) fall
 * back to OVERVIEW — the shell's own default.
 */
function mapLegacyTabToShell(raw: string | undefined): string {
  switch (raw) {
    case "banking":      return "ACCOUNTS";
    case "transactions": return "TRANSACTIONS";
    case "members":      return "MEMBERS";
    case "settings":     return "SETTINGS";
    case "credit":       return "DEBT";
    case "investments":  return "INVESTMENTS";
    case "activity":
    case "timeline":     return "TIMELINE";
    default:             return "OVERVIEW";
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await getSpaceContext();
  const isPersonal = ctx.space.type === "PERSONAL";

  // Non-personal spaces render the planning dashboard (client-side data fetching)
  //
  // MC1 nav currency-staleness fix — source the display currency from THIS
  // page's freshly resolved Space context (the page re-runs on every
  // navigation, including a Space switch), not only from the shared /dashboard
  // layout provider (which App Router preserves across same-layout navigation
  // and would keep the previous Space's currency until a manual refresh). A
  // nested provider overrides the ambient one; all-USD is unchanged.
  // key={ctx.spaceId} remounts the host on a same-type switch so no stale
  // client state (widget/space moneyCtx, snapshots) carries between Spaces.
  if (!isPersonal) {
    return (
      <DisplayCurrencyProvider currency={ctx.space.reportingCurrency}>
        <Suspense fallback={null}>
          <SpaceDashboard
            key={ctx.spaceId}
            spaceId={ctx.spaceId}
            spaceName={ctx.space.name}
            spaceType={ctx.space.type}
            category={ctx.space.category}
            myRole={ctx.role}
            currentUserId={ctx.userId}
          />
        </Suspense>
      </DisplayCurrencyProvider>
    );
  }

  // Personal space — SP-2A-4c: renders through the shared SpaceDashboard
  // shell, with PersonalHero injected via the renderHero seam. Server fetches
  // are trimmed to what the hero needs (accounts, snapshots, FICO,
  // transactions + hero moneyCtx); the shell client-fetches sections, goals,
  // accounts, etc. itself, exactly like every other Space.
  //
  // Context is resolved exactly once above (and cache()-deduped even if it
  // weren't — see lib/space.ts). Pass the already-resolved spaceId/userId
  // into each helper below so this page makes zero redundant context lookups.
  const sp = await searchParams;
  const rawTab = typeof sp?.tab === "string" ? sp.tab : undefined;

  const [accounts, snapshots, ficoData, transactions] = await Promise.all([
    getAccounts({ spaceId: ctx.spaceId }),
    getRecentSnapshots(365, { spaceId: ctx.spaceId }),
    getFicoData({ userId: ctx.userId }),
    getTransactions({ spaceId: ctx.spaceId }),
  ]);

  // MC1 Phase 3 Slice 6 (F-1, D-6) — serialize the Space's conversion context
  // for the hero's client-side classify/flow math. Currencies and dates cover
  // everything the hero aggregates: account balances (latest close) plus every
  // provided transaction row's own date. All-USD Spaces serialize an empty
  // entry table (a few bytes; identical math).
  const moneyCtx = await serializeSpaceConversionContext(ctx.space, {
    currencies: [
      ...accounts.map((a) => a.currency ?? null),
      ...transactions.map((t) => t.currency ?? null),
    ],
    dates: [
      yesterdayUTCISO(),
      ...transactions.map((t) => t.date),
    ],
  });

  return (
    <DisplayCurrencyProvider currency={ctx.space.reportingCurrency}>
      <Suspense fallback={null}>
        <PersonalDashboard
          key={ctx.spaceId}
          spaceId={ctx.spaceId}
          spaceName={ctx.space.name}
          spaceType={ctx.space.type}
          category={ctx.space.category}
          myRole={ctx.role}
          currentUserId={ctx.userId}
          initialTab={mapLegacyTabToShell(rawTab)}
          accounts={accounts}
          snapshots={snapshots}
          transactions={transactions}
          ficoScore={ficoData.score}
          moneyCtx={moneyCtx}
        />
      </Suspense>
    </DisplayCurrencyProvider>
  );
}
