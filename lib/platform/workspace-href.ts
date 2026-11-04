/**
 * lib/platform/workspace-href.ts  (the ONE Platform workspace / view link builder)
 *
 * PURE and server-safe: no "use client", no hooks, no React. The client
 * navigation hook (lib/space/use-platform-workspace-navigation.ts) RE-EXPORTS
 * these, and the navigation registry (lib/platform/intelligence/navigation/
 * registry.ts) builds every Platform href through the SAME function, so the
 * sidebar, the doorways and a future copilot share one link authority by
 * identity, not by an equality test.
 *
 * The default workspace is the bare area URL; every other workspace appends
 * `?workspace=<id>` through the shared serializer (space-url.ts). `viewId` is
 * written as given — callers pass a NON-default view only (the default view is
 * the bare workspace link).
 */

import { buildSpaceUrl } from "@/lib/space/space-url";
import { platformAreaHref } from "@/lib/platform/directory";

/** The Space-scoped param carrying the open Platform workspace. */
export const PLATFORM_WORKSPACE_PARAM = "workspace";

/** The Space-scoped param carrying the open view of that workspace (non-default only). */
export const PLATFORM_VIEW_PARAM = "view";

/**
 * The Platform default workspace id. Mirrors the server resolver's default
 * (lib/space/mount-context.server.ts `PLATFORM_DEFAULT_WORKSPACE`);
 * lib/space/mount-context.test.ts pins the two agree. It is the id that writes
 * NO param (the clean area URL).
 */
export const PLATFORM_DEFAULT_WORKSPACE_ID = "platform-overview";

/** The canonical deep link for a Platform workspace (and, optionally, a non-default view). */
export function platformWorkspaceHref(area: string, workspaceId: string, viewId?: string | null): string {
  return buildSpaceUrl(platformAreaHref(area), "", {
    [PLATFORM_WORKSPACE_PARAM]: workspaceId === PLATFORM_DEFAULT_WORKSPACE_ID ? null : workspaceId,
    [PLATFORM_VIEW_PARAM]: viewId ?? null,
  });
}
