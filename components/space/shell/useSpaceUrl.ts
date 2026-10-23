"use client";

/**
 * components/space/shell/useSpaceUrl.ts
 *
 * SD-0A — the ONE runtime Space URL authority. It is the single place that
 * writes browser History for Space state and the single owner of the popstate
 * (Back/Forward) listener; all serialization goes through the pure core
 * (lib/space/space-url.ts). Every consumer — SpaceDashboard's tab/perspective +
 * metric sync and the shell time hook (usePerspectiveShellState) — calls
 * `commit` to write and `subscribe` to react to Back/Forward, so none of them
 * touch window.history or register their own popstate listener.
 *
 * SSR-safe: every method guards on `window` and there is no render-time URL read,
 * so server and first client render never diverge (consumers hydrate post-mount,
 * exactly as before). It deliberately does NOT use next/navigation's
 * useSearchParams, which would force a new Suspense boundary and violate the
 * established shell invariant (see lib/space-shell-seams.test.ts). The
 * Transaction drawer remains the one Suspense-bounded useSearchParams reader, and
 * its opener serializes through the SAME core (buildSpaceUrl), so it can never
 * clobber the tab/perspective/time params.
 */

import { useCallback, useMemo } from "react";
import { applySpaceUrlUpdate, type SpaceUrlUpdate } from "@/lib/space/space-url";

// ── One process-wide popstate dispatcher ───────────────────────────────────────
// A single real window listener fans out to every subscriber, so there is
// exactly ONE Back/Forward synchronization path however many useSpaceUrl() call
// sites exist. Installed lazily, once; left installed for the app's lifetime
// (subscribers come and go through the Set as components mount/unmount).
const popSubscribers = new Set<() => void>();
let popInstalled = false;
function ensurePopstateListener(): void {
  if (popInstalled || typeof window === "undefined") return;
  popInstalled = true;
  window.addEventListener("popstate", () => {
    for (const cb of popSubscribers) cb();
  });
}

export interface SpaceUrlSeam {
  /** The current query string (no leading "?"), "" on the server. */
  getSearch(): string;
  /**
   * Canonically write `updates`, preserving all unrelated params. The caller
   * DECLARES the history intent — it is never inferred here:
   *   `"push"`    — a user NAVIGATION (a new Back/Forward entry);
   *   `"replace"` — a refinement of the current entry, or a SYSTEM write
   *                 (hydration, canonicalization, legacy-alias repair).
   * Returns `false` (no write) when the URL would not change (e.g. after popstate).
   */
  commit(updates: SpaceUrlUpdate, opts: { history: "push" | "replace" }): boolean;
  /** Subscribe to Back/Forward; returns an unsubscribe. One real listener. */
  subscribe(onNavigate: () => void): () => void;
}

export function useSpaceUrl(): SpaceUrlSeam {
  const getSearch = useCallback(
    () => (typeof window === "undefined" ? "" : window.location.search.replace(/^\?/, "")),
    [],
  );

  const commit = useCallback(
    (updates: SpaceUrlUpdate, opts: { history: "push" | "replace" }): boolean => {
      if (typeof window === "undefined") return false;
      const nextQs = applySpaceUrlUpdate(window.location.search, updates);
      const next = nextQs ? `${window.location.pathname}?${nextQs}` : window.location.pathname;
      const current = `${window.location.pathname}${window.location.search}`;
      if (next === current) return false; // already in sync (incl. after popstate)
      // NEXT.JS INTEGRATION — pass NO state. Next's app router patches
      // pushState/replaceState: for a write WITHOUT its private `__NA` marker it
      // copies its own entry state in AND syncs its router to the new URL
      // (ACTION_RESTORE). Passing `window.history.state` (which carries `__NA`)
      // made every Space write look like Next's own, so the sync was SKIPPED:
      // the router kept the page-load URL as its canonical URL and rewrote the
      // entry back to it (replaceState) on its next commit — the Space URL
      // silently reverted, and Back/Forward walked corrupted entries.
      if (opts.history === "replace") window.history.replaceState(null, "", next);
      else window.history.pushState(null, "", next);
      return true;
    },
    [],
  );

  const subscribe = useCallback((onNavigate: () => void): (() => void) => {
    ensurePopstateListener();
    popSubscribers.add(onNavigate);
    return () => {
      popSubscribers.delete(onNavigate);
    };
  }, []);

  return useMemo(() => ({ getSearch, commit, subscribe }), [getSearch, commit, subscribe]);
}
