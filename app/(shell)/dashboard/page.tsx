import { Suspense }                                   from "react";
import { SpaceDashboard }                          from "@/components/dashboard/SpaceDashboard";
import { PersonalDashboard }                       from "@/components/dashboard/PersonalDashboard";
import { getFicoData }                                 from "@/lib/data/accounts";
import { getSpaceContext }                         from "@/lib/space";
import { financialMountContext }                   from "@/lib/space/mount-context.server";
import { composeFinancialInitialWorkspace }        from "@/lib/space/mount-composition";
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
    case "timeline":     return "ACTIVITY";
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

  // PS-6A/6E — compose the domain-neutral SpaceMountContext from the ALREADY-
  // AUTHORIZED financial SpaceContext (getSpaceContext above ran the
  // cookie→preferred→personal resolution and the SpaceMember gate). This gives the
  // financial route resolver PARITY with platformMountContext. The financial shell
  // does NOT consume it: the fan-out fix shipped via server hydration
  // (composeFinancialInitialWorkspace below + useSpaceData, PS-6B), and the shell
  // reads native props + that payload. Platform is the context's end-to-end
  // consumer (PS-6C). Full financial consumption is a PS-6 FOLLOW-UP.
  const spAll = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const mountContext = financialMountContext(ctx, {
    selectedKey: str(spAll?.perspective) ?? str(spAll?.tab),
    asOf:        str(spAll?.asof),
    compareTo:   str(spAll?.compareto) ?? null,
  });

  // PS-6B — compose the finance initial-Workspace payload (sections + accounts +
  // member count) ONCE from the already-authorized ctx.spaceId, so the shell
  // hydrates instead of the client re-fetching those three eager resources (each
  // of which independently re-ran session + spaceMember). The three loaders are
  // the SAME ones the API routes now delegate to (no duplication). Snapshots /
  // perspectives / transactions stay lazy/client — deferred.
  const initialWorkspace = await composeFinancialInitialWorkspace(ctx.spaceId);

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
            mountContext={mountContext}
            initialWorkspace={initialWorkspace}
          />
        </Suspense>
      </DisplayCurrencyProvider>
    );
  }

  // Personal space — SP-2A-4c: renders through the shared SpaceDashboard
  // shell, with the "view as" currency control injected via PersonalDashboard's
  // displayCurrencyControl seam. The shell client-fetches its own sections,
  // goals, accounts, snapshots, transactions, etc. exactly like every other
  // Space, so this page loads only what the shell cannot derive for itself:
  // the user's FICO score (the Debt workspace's credit-health companion).
  //
  // CLEAN-0 — the former accounts / snapshots / transactions reads and the
  // serialized FX context were fetch-and-discard: PersonalDashboard declared
  // them as props but never consumed any of them (the shell re-fetches its
  // own). They have been removed here and from PersonalDashboard's contract.
  //
  // Context is resolved exactly once above (and cache()-deduped even if it
  // weren't — see lib/space.ts). Pass the already-resolved userId into
  // getFicoData so this page makes zero redundant context lookups.
  const rawTab = str(spAll?.tab);

  const ficoData = await getFicoData({ userId: ctx.userId });

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
          ficoScore={ficoData.score}
          mountContext={mountContext}
          initialWorkspace={initialWorkspace}
        />
      </Suspense>
    </DisplayCurrencyProvider>
  );
}
