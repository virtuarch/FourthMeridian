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
 * This route is additive: /dashboard/accounts is untouched.
 */

import { getSpaceContext } from "@/lib/space";
import { loadConnectionsSpaceData } from "@/lib/connections/space-data";
import { ConnectionsList } from "@/components/connections/ConnectionsList";
import { ConnectionsActions } from "@/components/connections/ConnectionsActions";

export const preferredRegion = "sin1";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const { userId } = await getSpaceContext();

  // The single canonical read: sync status + per-connection account inventory
  // (NAMES ONLY), both keyed by connection id. No portfolio read.
  const { status: initialStatus, accountsByConnectionId } = await loadConnectionsSpaceData(userId);

  const hasConnections = initialStatus.connections.length > 0;

  return (
    <div className="space-y-4 pb-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Connections</h1>
          <p className="text-sm text-[var(--text-muted)]">Manage the institutions and providers connected to Fourth Meridian.</p>
        </div>
        {hasConnections && <ConnectionsActions />}
      </div>

      {hasConnections ? (
        <ConnectionsList
          initialStatus={initialStatus}
          accountsByConnectionId={accountsByConnectionId}
        />
      ) : (
        <div className="mx-auto max-w-md pt-4">
          <ConnectionsActions centered />
        </div>
      )}
    </div>
  );
}
