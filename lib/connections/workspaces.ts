/**
 * lib/connections/workspaces.ts  (UI Convergence Wave 1 — W1-A)
 *
 * The IDENTITY of the Connections destination as a UNIVERSAL `WorkspaceDefinition`
 * (the same type customer Spaces and Platform use). Unioned into the ONE universal
 * `WORKSPACE_REGISTRY` (lib/perspectives.ts) so Connections reuses the universal
 * Workspace identity authority — NOT a parallel identity system.
 *
 * Connections is a USER-OWNED INFRASTRUCTURE workspace (`domain: "connections"`):
 * the credential / provider / sync-lifecycle surface. It declares NONE of the
 * finance-scoped metadata (routing / dataNeeds / temporalCapability / envelope) —
 * it owns no financial data, no canonical time, and no trust envelope. The guard in
 * workspaces.test.ts pins "no finance vocabulary on a Connections definition".
 *
 * D2 (global-nav peer): Connections is one of the five GLOBAL destinations
 * (Spaces · Brief · AI · Connections · Settings). It reuses SpaceShell for its frame
 * but does NOT enter customer Space mode (no ContextualNavbar takeover). Wave 1 is a
 * single workspace; Activity / Diagnostics workspaces are demand-pulled later.
 *
 * Ids are "connections-*"-namespaced so they never collide with a finance or
 * platform workspace id in the shared registry. Client-safe (no server imports).
 */

import type { WorkspaceDefinition } from "@/lib/perspectives";

export const CONNECTIONS_WORKSPACES: Record<string, WorkspaceDefinition> = {
  "connections-overview": {
    id: "connections-overview", kind: "standard", domain: "connections",
    label: "Connections", icon: "PlugZap",
  },
  // ── forward (demand-pulled, not built in Wave 1): ──
  // "connections-activity":    { …, label: "Activity",    icon: "History" },
  // "connections-diagnostics": { …, label: "Diagnostics", icon: "Stethoscope" },
};

/** The ordered Connections workspaces (Wave 1: a single Overview). */
export const CONNECTIONS_WORKSPACE_ORDER: readonly string[] = ["connections-overview"];

/** A Connections workspace identity by id, or undefined (fails safe). */
export function getConnectionsWorkspace(id: string): WorkspaceDefinition | undefined {
  return CONNECTIONS_WORKSPACES[id];
}

/** True for a Connections-domain workspace id (the "connections-*" namespace). */
export function isConnectionsWorkspaceId(id: string): boolean {
  return id in CONNECTIONS_WORKSPACES;
}
