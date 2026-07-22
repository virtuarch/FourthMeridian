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
import { CheckCircle2 } from "lucide-react";
import { SpaceShell, type SpaceShellRailOption } from "@/components/space/shell/SpaceShell";
import { ConnectionsList } from "@/components/connections/ConnectionsList";
import { ConnectionsActions } from "@/components/connections/ConnectionsActions";
import { CONNECTIONS_WORKSPACE_ORDER, getConnectionsWorkspace } from "@/lib/connections/workspaces";
import type { ConnectionsSpaceData } from "@/lib/connections/space-data";

/**
 * CONN-2H — the empty state explains the TRANSFORMATION, not just "connect an
 * account." A first-time user should understand that connecting acquires data
 * AND that Fourth Meridian then builds financial intelligence from it — the L1→L2
 * story the whole reconstruction experience is about. Presentation only.
 */
function ConnectionsEmptyState({ plaidEnabled = true }: { plaidEnabled?: boolean }) {
  const steps = [
    "Import your transactions",
    "Build your financial timeline",
    "Generate cash-flow insights",
    "Create your wealth picture",
  ];
  return (
    <div className="mx-auto max-w-md pt-4 text-center">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">Connect your first account</h2>
      <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
        Your transactions come in first — then Fourth Meridian builds your financial intelligence from them.
      </p>
      <ul className="mx-auto mt-5 mb-6 inline-flex flex-col gap-2 text-left">
        {steps.map((s) => (
          <li key={s} className="flex items-center gap-2.5 text-sm text-[var(--text-secondary)]">
            <CheckCircle2 size={16} className="shrink-0 text-[var(--accent-positive,#34d399)]" />
            <span>{s}</span>
          </li>
        ))}
      </ul>
      <p className="mb-5 text-xs text-[var(--text-muted)]">Your first build happens automatically.</p>
      <ConnectionsActions centered plaidEnabled={plaidEnabled} />
    </div>
  );
}

export function ConnectionsSpaceDashboard({
  status,
  accountsByConnectionId,
  intelligenceByConnectionId,
  plaidEnabled = true,
}: ConnectionsSpaceData & { plaidEnabled?: boolean }) {
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
        />
      ) : (
        <ConnectionsEmptyState plaidEnabled={plaidEnabled} />
      )}
    </SpaceShell>
  );
}
