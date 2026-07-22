/**
 * lib/settings/workspaces.ts  (UI Convergence Wave 1 — W1-B)
 *
 * TWO things, both Settings-domain-owned:
 *
 *   1. SETTINGS_WORKSPACES — the IDENTITY of every Settings section as a UNIVERSAL
 *      `WorkspaceDefinition` (the same type customer Spaces and Platform use),
 *      unioned into the ONE universal `WORKSPACE_REGISTRY` (lib/perspectives.ts).
 *      Settings is a USER-OWNED CONFIGURATION workspace (`domain: "settings"`): it
 *      declares NONE of the finance-scoped metadata (routing / dataNeeds /
 *      temporalCapability / envelope). The guard in workspaces.test.ts pins "no
 *      finance vocabulary on a Settings definition".
 *
 *   2. SETTINGS_WORKSPACE_ORDER — THE single composition owner: which sections the
 *      Settings rail exposes, in order, and the ROUTE each resolves to. Settings
 *      stays URL-DRIVEN (D3): the section pages remain server components with their
 *      own loaders; the rail navigates by `router.push(route)` and derives the
 *      active section from the pathname. Identity (label/icon) lives in
 *      SETTINGS_WORKSPACES; composition (order + route) lives here — no duplicated
 *      identity, mirroring PLATFORM_WORKSPACES / PLATFORM_AREA_WORKSPACES.
 *
 * D2 (global-nav peer): Settings is one of the five GLOBAL destinations. It reuses
 * SpaceShell for its frame + rail but does NOT enter customer Space mode.
 *
 * Ids are "settings-*"-namespaced so they never collide with a finance or platform
 * workspace id — and deliberately NOT the bare "settings" (which the finance
 * getWorkspaceForTab("SETTINGS") resolves to undefined). Client-safe (no server
 * imports), so the client SpaceShell layout can import it directly.
 */

import type { WorkspaceDefinition } from "@/lib/perspectives";

export const SETTINGS_WORKSPACES: Record<string, WorkspaceDefinition> = {
  "settings-account":       { id: "settings-account",       kind: "standard", domain: "settings", label: "Account",        icon: "User" },
  "settings-security":      { id: "settings-security",      kind: "standard", domain: "settings", label: "Security",       icon: "ShieldCheck" },
  "settings-preferences":   { id: "settings-preferences",   kind: "standard", domain: "settings", label: "Preferences",    icon: "SlidersHorizontal" },
  "settings-notifications": { id: "settings-notifications", kind: "standard", domain: "settings", label: "Notifications",  icon: "BellRing" },
  "settings-data":          { id: "settings-data",          kind: "standard", domain: "settings", label: "Data & Privacy", icon: "Database" },
};

/** One Settings section's place on the rail: its identity id (→ SETTINGS_WORKSPACES)
 *  plus the canonical URL it renders at (D3 — the URL stays authoritative). */
export interface SettingsWorkspaceComposition {
  /** Key into SETTINGS_WORKSPACES / WORKSPACE_REGISTRY. */
  workspaceId: string;
  /** The route this section renders at (preserved, not collapsed). */
  route: string;
}

/** THE single composition owner — the ordered Settings rail + its routes. */
export const SETTINGS_WORKSPACE_ORDER: readonly SettingsWorkspaceComposition[] = [
  { workspaceId: "settings-account",       route: "/dashboard/settings/account" },
  { workspaceId: "settings-security",      route: "/dashboard/settings/security" },
  { workspaceId: "settings-preferences",   route: "/dashboard/settings/preferences" },
  { workspaceId: "settings-notifications", route: "/dashboard/settings/notifications" },
  { workspaceId: "settings-data",          route: "/dashboard/settings/data" },
];

/** A Settings workspace identity by id, or undefined (fails safe). */
export function getSettingsWorkspace(id: string): WorkspaceDefinition | undefined {
  return SETTINGS_WORKSPACES[id];
}

/** True for a Settings-domain workspace id (the "settings-*" namespace). */
export function isSettingsWorkspaceId(id: string): boolean {
  return id in SETTINGS_WORKSPACES;
}
