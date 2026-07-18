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
 * import wizard are ALL untouched. The PCS-2 ownership boundary holds — this surface
 * reads only { status, accountsByConnectionId } (NAMES ONLY), never balances,
 * valuations, positions, or debt.
 */

import { useState } from "react";
import { SpaceShell, type SpaceShellRailOption } from "@/components/space/shell/SpaceShell";
import { ConnectionsList } from "@/components/connections/ConnectionsList";
import { ConnectionsActions } from "@/components/connections/ConnectionsActions";
import { CONNECTIONS_WORKSPACE_ORDER, getConnectionsWorkspace } from "@/lib/connections/workspaces";
import type { ConnectionsSpaceData } from "@/lib/connections/space-data";

export function ConnectionsSpaceDashboard({ status, accountsByConnectionId }: ConnectionsSpaceData) {
  const hasConnections = status.connections.length > 0;

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
      subtitle="Manage the institutions and providers connected to Fourth Meridian."
      headerActions={hasConnections ? <ConnectionsActions /> : undefined}
      railOptions={railOptions}
      activeTab={activeTab}
      onSelectTab={setActiveTab}
    >
      {hasConnections ? (
        <ConnectionsList
          initialStatus={status}
          accountsByConnectionId={accountsByConnectionId}
        />
      ) : (
        <div className="mx-auto max-w-md pt-4">
          <ConnectionsActions centered />
        </div>
      )}
    </SpaceShell>
  );
}
