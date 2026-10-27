"use client";

/**
 * lib/space/use-platform-workspace-navigation.ts  (UX-P1 Change A)
 *
 * THE PLATFORM SPACE'S NAVIGATION AUTHORITY — the Platform counterpart of
 * use-space-navigation.ts, deliberately smaller: a Platform Space has ONE
 * navigation axis (which workspace is open: Overview · Jobs · Policies …) and no
 * views, lenses or time slice beneath it.
 *
 * Before this hook the open workspace was a `useState` cell inside the host:
 * no deep link, no Back/Forward, and a reload reset the operator to Overview.
 * Now the URL is the authority — `?workspace=<id>` — written through the ONE
 * runtime seam (components/space/shell/useSpaceUrl.ts) and serialized through
 * the ONE core (lib/space/space-url.ts), exactly as the customer Space does:
 *
 *   • HISTORY INTENT is DECLARED, never inferred: a user workspace change is a
 *     PUSH (a Back/Forward step); hydration, canonicalization and the popstate
 *     re-sync are REPLACE / no write.
 *   • The DEFAULT workspace writes `null` — the canonical area URL stays clean
 *     (`/dashboard/platform/PLATFORM_OPS`, no `?workspace=platform-overview`).
 *     Next 16 skips its router sync on a `__NA` write, so the seam passes no
 *     state and the clean URL must be produced by deleting the key, not by
 *     writing an empty value.
 *   • Back/Forward REBUILDS state from the URL with the raw (system) setter, so
 *     the writer finds the URL already in sync and writes nothing.
 *
 * The server resolves the same param for the first paint
 * (app/(shell)/dashboard/platform/[area]/page.tsx → platformMountContext
 * `selectedKey`), so SSR and the hydrated client agree before any effect runs.
 * Validation is the ONE shared validator both sides use
 * (`resolveSelectedWorkspaceKey`, lib/space/mount-context.ts): an unknown id
 * degrades to the area default, never to a workspace that does not exist.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import { buildSpaceUrl, readSpaceParam } from "@/lib/space/space-url";
import { resolveSelectedWorkspaceKey, type MountWorkspaceSummary } from "@/lib/space/mount-context";
import { canonicalPlatformWorkspaceId } from "@/lib/platform/workspaces";

/** The Space-scoped param carrying the open Platform workspace. */
export const PLATFORM_WORKSPACE_PARAM = "workspace";

/**
 * The Platform default workspace id. Mirrors the server resolver's default
 * (lib/space/mount-context.server.ts `PLATFORM_DEFAULT_WORKSPACE`), which a
 * client module cannot import; lib/space/mount-context.test.ts pins the two
 * agree. It is the id that writes NO param (the clean area URL).
 */
export const PLATFORM_DEFAULT_WORKSPACE_ID = "platform-overview";

/** The ONLY route that renders a Platform Space (one definition for hrefs). */
const PLATFORM_ROUTE_PREFIX = "/dashboard/platform/";

/**
 * The canonical deep link for a Platform workspace — what the sidebar row's
 * href carries and what the URL writer commits. The default workspace is the
 * bare area URL; every other workspace appends `?workspace=<id>` through the
 * shared serializer.
 */
export function platformWorkspaceHref(area: string, workspaceId: string): string {
  return buildSpaceUrl(`${PLATFORM_ROUTE_PREFIX}${area}`, "", {
    [PLATFORM_WORKSPACE_PARAM]: workspaceId === PLATFORM_DEFAULT_WORKSPACE_ID ? null : workspaceId,
  });
}

export interface PlatformWorkspaceNavigationInput {
  /** The contract's workspace projection (SpaceMountContext.workspaces.available). */
  available: readonly MountWorkspaceSummary[];
  /** The server-resolved first-paint selection (SpaceMountContext.workspaces.selectedKey). */
  selectedKey: string;
}

export interface PlatformWorkspaceNavigation {
  /** The open workspace id — always one of `available` (or the default). */
  activeTab: string;
  /** USER navigation: rail pill, sidebar row, Overview doorway. Declares PUSH. */
  setActiveTab: (id: string) => void;
}

export function usePlatformWorkspaceNavigation({
  available,
  selectedKey,
}: PlatformWorkspaceNavigationInput): PlatformWorkspaceNavigation {
  // The ONE serializer + Back/Forward listener (SD-0A).
  const spaceUrl = useSpaceUrl();

  // First paint = the server's resolution of the same URL, so hydration never
  // diverges; everything after mount is URL-driven.
  const [activeTab, setActiveTabState] = useState<string>(selectedKey);

  // ── HISTORY INTENT — declared by the entry point, never inferred ────────────
  const historyIntent = useRef<"push" | "replace">("replace");
  const setActiveTab = useCallback((id: string) => {
    setActiveTabState((prev) => {
      if (prev !== id) historyIntent.current = "push";
      return id;
    });
  }, []);

  // The ONE validator the server used (unknown ⇒ default, never a ghost id).
  const resolveFromUrl = useCallback(
    () =>
      resolveSelectedWorkspaceKey(
        available,
        canonicalPlatformWorkspaceId(readSpaceParam(spaceUrl.getSearch(), PLATFORM_WORKSPACE_PARAM)),
        PLATFORM_DEFAULT_WORKSPACE_ID,
      ),
    [available, spaceUrl],
  );

  // ── URL READ: hydration (post-mount, SSR-safe) + Back/Forward ───────────────
  //    The URL is the authority on traversal: state is rebuilt FROM it with the
  //    raw (system) setter, so the writer below finds the URL in sync and
  //    writes nothing — Back/Forward never creates or rewrites an entry.
  useEffect(() => {
    historyIntent.current = "replace";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTabState(resolveFromUrl());
    return spaceUrl.subscribe(() => {
      historyIntent.current = "replace";
      setActiveTabState(resolveFromUrl());
    });
  }, [spaceUrl, resolveFromUrl]);

  // ── THE URL writer — one history write per state change, with the declared
  //    intent; the default workspace deletes the key (clean canonical URL).
  //    Unrelated params are preserved by the core.
  useEffect(() => {
    const history = historyIntent.current;
    historyIntent.current = "replace";
    spaceUrl.commit(
      { [PLATFORM_WORKSPACE_PARAM]: activeTab === PLATFORM_DEFAULT_WORKSPACE_ID ? null : activeTab },
      { history },
    );
  }, [activeTab, spaceUrl]);

  return { activeTab, setActiveTab };
}
