/**
 * app/(shell)/dashboard/connections/page.tsx
 *
 * The permanent Connections hub — the single place users land after connecting a
 * provider. Server-renders the canonical Connections view model
 * (lib/connections/space-data → { status, accountsByConnectionId }) and hands off
 * to the ConnectionsList client poller which drives first-run "building" cards →
 * "ready".
 *
 * PCS-2 — this page NO LONGER reads the portfolio (getAccounts). The account
 * inventory is resolved per connection by stable id, gated to the owning user,
 * inside loadConnectionsSpaceData — no balances, no visibility redaction, no
 * institution-string grouping. See that module's header for the full rationale.
 *
 * Connections 2.0 — the same read also returns the user's own manual assets
 * (`manualAssets`, owner-gated, with the user's estimate), so a home or a car
 * added here is listed here again under Real assets.
 *
 * This route is additive: /dashboard/accounts is untouched.
 */

import { getSpaceContext } from "@/lib/space";
import { loadConnectionsSpaceData } from "@/lib/connections/space-data";
import { withTenantDb } from "@/lib/db/tenant-context";
import { ConnectionsSpaceDashboard } from "@/components/connections/ConnectionsSpaceDashboard";
import { env } from "@/lib/env";
import { recordOnboardingEvent } from "@/lib/onboarding/first-run";
import { isRouterPrefetch } from "@/lib/analytics/request-intent";

export const preferredRegion = "sin1";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** About a dozen grouped reads in one transaction; wider than Prisma's 5 s single-statement default. */
const CONNECTIONS_PHASE_TIMEOUT_MS = 15_000;

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { userId } = await getSpaceContext();
  // Connections pass PR 2 — ?welcome=1 is the one-time post-login redirect
  // (lib/onboarding). It only changes the greeting; the page is the same page.
  const welcome = (await searchParams).welcome === "1";

  // The single canonical read: sync status + per-connection account inventory
  // (NAMES ONLY), both keyed by connection id. No portfolio read (PCS-2). The
  // Workspace frame + body is composed by the client host.
  //
  // RLS-PREP-C — one tenant phase around the whole read. The loader used to
  // reach the migration principal on this page's behalf; it now takes the
  // authority it runs under, and this is it. Pure reads, no network.
  const { status, accountsByConnectionId, intelligenceByConnectionId, manualAssets } =
    await withTenantDb(userId, (tx) => loadConnectionsSpaceData(tx, userId), { timeout: CONNECTIONS_PHASE_TIMEOUT_MS });
  // The welcome records itself as shown HERE, on the server, so the one-time
  // redirect can never repeat because a client call failed or was blocked.
  // Idempotent; never on a prefetch; a failed write never breaks the page.
  if (welcome && !(await isRouterPrefetch())) {
    await recordOnboardingEvent(userId, "presented").catch((err) => console.error("[onboarding] presented marker failed:", err));
  }
  const me = welcome
    ? await withTenantDb(userId, (tx) => tx.user.findUnique({ where: { id: userId }, select: { firstName: true, name: true } })).catch(() => null)
    : null;

  return (
    <ConnectionsSpaceDashboard
      status={status}
      accountsByConnectionId={accountsByConnectionId}
      intelligenceByConnectionId={intelligenceByConnectionId}
      manualAssets={manualAssets}
      plaidEnabled={env.isPlaidEnabled}
      welcome={welcome}
      firstName={me?.firstName ?? me?.name?.split(" ")[0] ?? null}
    />
  );
}
