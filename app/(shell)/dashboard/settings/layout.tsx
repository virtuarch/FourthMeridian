"use client";

/**
 * app/(shell)/dashboard/settings/layout.tsx  (UI Convergence Wave 1 — W1-B)
 *
 * The Settings render frame, promoted onto the Workspace model. It mounts the
 * SHARED, universal SpaceShell (the same frame customer Spaces and Platform use)
 * and turns the five Settings sections into a persistent rail — replacing the old
 * hub-and-spoke (the index link-list + the per-page "‹ Settings" back-links).
 *
 * D2 — Settings is a GLOBAL-nav destination (Spaces · Brief · AI · Connections ·
 * Settings), NOT a customer Space. It uses SpaceShell's `variant="utility"`: it
 * draws its own identity header and does NOT publish into the ContextualNavbar's
 * Space mode.
 *
 * D3 — URL-driven. The rail is NAVIGATION, not local state: the active section is
 * derived from the pathname and selecting one is a real `router.push(route)`, so
 * every section keeps its canonical URL (deep-linkable, bookmarkable, correct back
 * button). The section pages stay SERVER components with their own loaders — this
 * client layout only frames the server-rendered `children`; ZERO data-loading
 * change.
 *
 * Identity (label) comes from SETTINGS_WORKSPACES and order+route from
 * SETTINGS_WORKSPACE_ORDER (the single composition owner) — no hardcoded rail JSX.
 * Routes OUTSIDE the rail (the archived-assets follow-up surface, D4 — not a
 * Settings section) render unwrapped: Settings does not own them.
 */

import type { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SpaceShell, type SpaceShellRailOption } from "@/components/space/shell/SpaceShell";
import { SETTINGS_WORKSPACE_ORDER, getSettingsWorkspace } from "@/lib/settings/workspaces";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const active = SETTINGS_WORKSPACE_ORDER.find(
    (w) => pathname === w.route || pathname.startsWith(`${w.route}/`),
  );

  // A route that is not one of the five rail sections (e.g. archived-assets, D4, or
  // the index during its redirect) is not framed by the Settings rail.
  if (!active) return <>{children}</>;

  const railOptions: SpaceShellRailOption[] = SETTINGS_WORKSPACE_ORDER.map((w) => ({
    id: w.workspaceId,
    label: getSettingsWorkspace(w.workspaceId)?.label ?? w.workspaceId,
  }));

  return (
    <SpaceShell
      variant="utility"
      title="Settings"
      subtitle="Manage your Fourth Meridian account."
      railOptions={railOptions}
      activeTab={active.workspaceId}
      onSelectTab={(id) => {
        const target = SETTINGS_WORKSPACE_ORDER.find((w) => w.workspaceId === id);
        if (target && target.route !== active.route) router.push(target.route);
      }}
    >
      {children}
    </SpaceShell>
  );
}
