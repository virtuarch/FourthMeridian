"use client";

/**
 * lib/space/use-platform-workspace-navigation.ts  (UX-P1 Change A)
 *
 * THE PLATFORM SPACE'S NAVIGATION AUTHORITY — the Platform counterpart of
 * use-space-navigation.ts, deliberately smaller: a Platform Space has the
 * workspace axis (Operations · Providers · AI & Costs · Policies …) and, since
 * PLATFORM OPS PHASE 1 UX, an optional VIEW axis beneath it (`?view=<id>`,
 * Operations › Jobs) — no lenses and no time slice.
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
 *
 * VIEWS (PLATFORM OPS PHASE 1 UX) follow the same rules on their own param:
 *   • the DEFAULT (first) view writes `null` — `?view=` appears only for a
 *     non-default view;
 *   • a user view change is a PUSH, exactly like a workspace change (owner
 *     brief: Back/Forward walk views as they walk workspaces). This DELIBERATELY
 *     differs from a customer Space's views (REPLACE): a Platform view is a
 *     former workspace (Jobs, Pipeline), so it keeps the history it had;
 *   • switching workspace resets the view to the destination's view, or the
 *     default; an unknown view id falls back to the default
 *     (`resolvePlatformViewId`, shared with the server's first paint);
 *   • a retired workspace id that became a view (`?workspace=platform-jobs`)
 *     opens that view and canonicalizes in place.
 *
 * WORKSPACE-SCOPED FILTERS (PB-4, S2 ruling 2026-11-02) — a param that belongs
 * to ONE workspace's content (Customer Success's `?attention=`) is DELETED by a
 * user workspace switch, in the SAME write that changes `?workspace=` (one
 * commit carrying both keys, with the switch's declared intent). A filter set in
 * Customers therefore never silently re-applies when the operator comes back
 * later from another workspace. Hydration and Back/Forward never strip it:
 * returning to the entry that had it restores it, as any history entry is
 * restored (and React StrictMode's double mount is irrelevant — nothing is
 * cleared on unmount).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import { buildSpaceUrl, readSpaceParam } from "@/lib/space/space-url";
import { resolveSelectedWorkspaceKey, type MountWorkspaceSummary } from "@/lib/space/mount-context";
import {
  canonicalPlatformWorkspaceId,
  parsePlatformDestination,
  resolvePlatformViewId,
  resolveRequestedPlatformView,
} from "@/lib/platform/workspaces";

/** The Space-scoped param carrying the open Platform workspace. */
export const PLATFORM_WORKSPACE_PARAM = "workspace";

/** The Space-scoped param carrying the open view of that workspace (non-default only). */
export const PLATFORM_VIEW_PARAM = "view";

/** Params scoped to one workspace's content, deleted by a user workspace switch (see the header). */
export const PLATFORM_WORKSPACE_SCOPED_PARAMS: readonly string[] = ["attention"];

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
 * shared serializer. `viewId` is written as given — callers pass a NON-default
 * view only (the default view is the bare workspace link).
 */
export function platformWorkspaceHref(area: string, workspaceId: string, viewId?: string | null): string {
  return buildSpaceUrl(`${PLATFORM_ROUTE_PREFIX}${area}`, "", {
    [PLATFORM_WORKSPACE_PARAM]: workspaceId === PLATFORM_DEFAULT_WORKSPACE_ID ? null : workspaceId,
    [PLATFORM_VIEW_PARAM]: viewId ?? null,
  });
}

/** Stable "no views anywhere" map (an area without views, e.g. Security). */
const NO_VIEWS: Readonly<Record<string, readonly string[]>> = {};

export interface PlatformWorkspaceNavigationInput {
  /** The contract's workspace projection (SpaceMountContext.workspaces.available). */
  available: readonly MountWorkspaceSummary[];
  /** The server-resolved first-paint selection (SpaceMountContext.workspaces.selectedKey). */
  selectedKey: string;
  /** workspaceId → ordered view ids (first = default); workspaces without views
   *  are absent (lib/platform/workspaces.ts `platformAreaViewIds`). Must be
   *  referentially stable. Absent ⇒ no workspace has views. */
  viewIds?: Readonly<Record<string, readonly string[]>>;
  /** The server-resolved first-paint view (null/absent ⇒ the default view). */
  selectedView?: string | null;
}

export interface PlatformWorkspaceNavigation {
  /** The open workspace id — always one of `available` (or the default). */
  activeTab: string;
  /** The open view of that workspace — one of its view ids, or null when it has none. */
  activeView: string | null;
  /** USER navigation: rail pill, sidebar row, Overview doorway. Declares PUSH.
   *  Takes any destination id (workspace, view target, or retired alias); a
   *  destination without a view opens the workspace's DEFAULT view. */
  setActiveTab: (id: string) => void;
  /** USER navigation within the open workspace (the view control). Declares PUSH. */
  setActiveView: (viewId: string) => void;
}

interface NavState { tab: string; view: string | null }

export function usePlatformWorkspaceNavigation({
  available,
  selectedKey,
  viewIds = NO_VIEWS,
  selectedView = null,
}: PlatformWorkspaceNavigationInput): PlatformWorkspaceNavigation {
  // The ONE serializer + Back/Forward listener (SD-0A).
  const spaceUrl = useSpaceUrl();

  // ── HISTORY INTENT — declared by the entry point, never inferred ────────────
  const historyIntent = useRef<"push" | "replace">("replace");
  /** The workspace the URL last carried — a USER switch away from it clears the workspace-scoped params. */
  const committedTab = useRef<string | null>(null);

  // First paint = the server's resolution of the same URL, so hydration never
  // diverges; everything after mount is URL-driven.
  const [state, setStateRaw] = useState<NavState>(() => ({
    tab: selectedKey,
    view: resolvePlatformViewId(viewIds[selectedKey], selectedView),
  }));
  /** Set only on a real change, so an in-sync rebuild never re-renders or re-writes. */
  const setState = useCallback((next: NavState, intent: "push" | "replace") => {
    setStateRaw((prev) => {
      if (prev.tab === next.tab && prev.view === next.view) return prev;
      historyIntent.current = intent;
      return next;
    });
  }, []);

  const setActiveTab = useCallback((id: string) => {
    const { workspaceId, viewId } = parsePlatformDestination(id);
    // Switching workspace RESETS the view: the destination's own view, else the default.
    setState({ tab: workspaceId, view: resolvePlatformViewId(viewIds[workspaceId], viewId) }, "push");
  }, [setState, viewIds]);
  const setActiveView = useCallback((viewId: string) => {
    setStateRaw((prev) => {
      const view = resolvePlatformViewId(viewIds[prev.tab], viewId);
      if (view === prev.view) return prev;
      historyIntent.current = "push";
      return { tab: prev.tab, view };
    });
  }, [viewIds]);

  // The ONE validator the server used (unknown ⇒ default, never a ghost id).
  const resolveFromUrl = useCallback((): NavState => {
    const search = spaceUrl.getSearch();
    const requested = readSpaceParam(search, PLATFORM_WORKSPACE_PARAM);
    const tab = resolveSelectedWorkspaceKey(available, canonicalPlatformWorkspaceId(requested), PLATFORM_DEFAULT_WORKSPACE_ID);
    return { tab, view: resolveRequestedPlatformView(viewIds[tab], tab, requested, readSpaceParam(search, PLATFORM_VIEW_PARAM)) };
  }, [available, spaceUrl, viewIds]);

  // ── URL READ: hydration (post-mount, SSR-safe) + Back/Forward ───────────────
  //    The URL is the authority on traversal: state is rebuilt FROM it with the
  //    raw (system) setter, so the writer below finds the URL in sync and
  //    writes nothing — Back/Forward never creates or rewrites an entry.
  useEffect(() => {
    historyIntent.current = "replace";
    setState(resolveFromUrl(), "replace");
    return spaceUrl.subscribe(() => {
      historyIntent.current = "replace";
      setState(resolveFromUrl(), "replace");
    });
  }, [spaceUrl, resolveFromUrl, setState]);

  // ── THE URL writer — one history write per state change, with the declared
  //    intent; the default workspace and the default view delete their keys
  //    (clean canonical URL). Unrelated params are preserved by the core.
  useEffect(() => {
    const history = historyIntent.current;
    historyIntent.current = "replace";
    const defaultView = viewIds[state.tab]?.[0] ?? null;
    // A USER switch (declared PUSH) to another workspace — never hydration or Back/Forward (REPLACE / no write).
    const switched = history === "push" && committedTab.current !== null && committedTab.current !== state.tab;
    committedTab.current = state.tab;
    spaceUrl.commit(
      {
        [PLATFORM_WORKSPACE_PARAM]: state.tab === PLATFORM_DEFAULT_WORKSPACE_ID ? null : state.tab,
        [PLATFORM_VIEW_PARAM]: state.view && state.view !== defaultView ? state.view : null,
        ...(switched ? Object.fromEntries(PLATFORM_WORKSPACE_SCOPED_PARAMS.map((k) => [k, null])) : {}),
      },
      { history },
    );
  }, [state, spaceUrl, viewIds]);

  return { activeTab: state.tab, activeView: state.view, setActiveTab, setActiveView };
}
