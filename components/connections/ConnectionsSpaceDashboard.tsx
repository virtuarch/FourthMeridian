"use client";

/**
 * components/connections/ConnectionsSpaceDashboard.tsx  (UI Convergence Wave 1 — W1-A)
 *
 * The Connections render surface, promoted onto the Workspace model. It renders
 * through the SHARED, universal SpaceShell frame (the same primitive customer Spaces
 * and Platform use) — Connections' identity is now a `WorkspaceDefinition` in the ONE
 * WORKSPACE_REGISTRY (lib/connections/workspaces.ts), not a bespoke page frame.
 *
 * D2 — Connections is a GLOBAL-nav destination (Spaces · Brief · AI · Connections ·
 * Settings), NOT a customer Space. It uses SpaceShell's `variant="utility"`: it draws
 * its own identity header and does NOT publish into the ContextualNavbar's Space mode
 * (no useSpaceChromePublisher). Wave 1 is a single workspace, so the rail is
 * suppressed (the frame == the Connections view); Activity / Diagnostics workspaces
 * are demand-pulled later and will make the rail appear automatically.
 *
 * This host is a THIN wrapper: the data contract (loadConnectionsSpaceData), the
 * ConnectionsList poller, ConnectionCard, ConnectionsActions, wallet sync, and the
 * import wizard are ALL untouched. The PCS-2 ownership boundary holds for provider
 * connections — { status, accountsByConnectionId } are NAMES ONLY, never balances,
 * positions, or debt.
 *
 * Connections 2.0 — the user's own manual assets (`manualAssets`) are listed too,
 * with the user's own estimate (owner-approved carve-out; real-assets.core.ts).
 * The onboarding view is the empty state only when there is NOTHING at all: a
 * user whose only entries are real assets sees the list (Real assets category),
 * not "Connect an account" — those assets are theirs and must stay reachable.
 */

import { useState } from "react";
import { SpaceShell, type SpaceShellRailOption } from "@/components/space/shell/SpaceShell";
import { ConnectionsList } from "@/components/connections/ConnectionsList";
import { ConnectionsActions } from "@/components/connections/ConnectionsActions";
import { ConnectionsOnboarding } from "@/components/connections/ConnectionsOnboarding";
import { CONNECTIONS_WORKSPACE_ORDER, getConnectionsWorkspace } from "@/lib/connections/workspaces";
import type { ConnectionsSpaceData } from "@/lib/connections/space-data";

export function ConnectionsSpaceDashboard({
  status,
  accountsByConnectionId,
  intelligenceByConnectionId,
  manualAssets = [],
  plaidEnabled = true,
  welcome = false,
  firstName = null,
}: Omit<ConnectionsSpaceData, "manualAssets"> & { manualAssets?: ConnectionsSpaceData["manualAssets"]; plaidEnabled?: boolean; welcome?: boolean; firstName?: string | null }) {
  // Anything at all — a provider connection OR a real asset — shows the list.
  const hasConnections = status.connections.length > 0 || manualAssets.length > 0;

  // Identity comes from the registry (no hardcoded rail JSX). Single workspace in
  // Wave 1 → SpaceShell suppresses the rail; activeTab is still tracked for when the
  // forward Activity/Diagnostics workspaces land.
  const [activeTab, setActiveTab] = useState<string>(CONNECTIONS_WORKSPACE_ORDER[0]);
  const railOptions: SpaceShellRailOption[] = CONNECTIONS_WORKSPACE_ORDER.map((id) => ({
    id,
    label: getConnectionsWorkspace(id)?.label ?? id,
  }));

  return (
    <SpaceShell
      mobileOptimized
      variant="utility"
      title="Connections"
      subtitle="Manage the institutions, wallets and assets you've brought into Fourth Meridian."
      headerActions={hasConnections ? <ConnectionsActions plaidEnabled={plaidEnabled} /> : undefined}
      railOptions={railOptions}
      activeTab={activeTab}
      onSelectTab={setActiveTab}
    >
      {hasConnections ? (
        <ConnectionsList
          initialStatus={status}
          accountsByConnectionId={accountsByConnectionId}
          initialIntelligence={intelligenceByConnectionId}
          manualAssets={manualAssets}
        />
      ) : (
        // Connections pass PR 2 — the first-time welcome (?welcome=1) and the
        // empty state are one view: three ways in, and "Explore My Space" out.
        <ConnectionsOnboarding welcome={welcome} firstName={firstName} plaidEnabled={plaidEnabled} />
      )}
    </SpaceShell>
  );
}
