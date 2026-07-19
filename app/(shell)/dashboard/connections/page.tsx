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
import { ConnectionsSpaceDashboard } from "@/components/connections/ConnectionsSpaceDashboard";

export const preferredRegion = "sin1";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const { userId } = await getSpaceContext();

  // The single canonical read: sync status + per-connection account inventory
  // (NAMES ONLY), both keyed by connection id. No portfolio read (PCS-2). The
  // Workspace frame + body is composed by the client host.
  const { status, accountsByConnectionId, intelligenceByConnectionId } =
    await loadConnectionsSpaceData(userId);

  return (
    <ConnectionsSpaceDashboard
      status={status}
      accountsByConnectionId={accountsByConnectionId}
      intelligenceByConnectionId={intelligenceByConnectionId}
    />
  );
}
