"use client";

/**
 * components/history/useHistoryExploration.ts
 *
 * The URL ⇄ panel binding. One hook, shared by every stock lens.
 *
 * There is deliberately NO navigation store. The URL is the state (see
 * `lib/history/exploration-url.ts`): drilling pushes an entry, back pops it, a
 * refresh or a pasted link restores the same node over the same window. A store
 * kept "in sync" with the URL would be a second source of truth that drifts the
 * first time an update path forgets it.
 *
 * The hook holds no financial data and makes no financial decision — it decides
 * which node is being asked about, and nothing about what that node is worth.
 */

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  readExplorationUrl, explorationOpenUpdate, explorationCloseUpdate,
} from "@/lib/history/exploration-url";
import { buildSpaceUrl } from "@/lib/space/space-url";
import type { ExplorationNodeType } from "@/lib/history/exploration";
import type { LensRoot } from "@/lib/history/lens-root-node";

export interface HistoryExploration {
  open: boolean;
  /** The question being asked. Carried, never derived from the node. */
  root: LensRoot;
  nodeType: ExplorationNodeType;
  nodeId: string | null;
  /**
   * The selected date, read from the SAME URL the panel writes.
   *
   * Deliberately not taken from the shell's `asOf` prop: clicking a point writes
   * `asof` and the prop arrives a render later, so the panel would briefly show
   * a different date's numbers under the new date's heading. One source of truth
   * removes the window entirely.
   */
  dateISO: string | null;
  fromISO: string;
  toISO: string;
  /** Open the sheet at a lens ROOT for a clicked chart point. */
  openPoint: (root: LensRoot, dateISO: string, fromISO: string, toISO: string) => void;
  /** Drill to another node. The window is INHERITED, never recomputed. */
  navigate: (nodeType: ExplorationNodeType, nodeId: string | null) => void;
  close: () => void;
}

export function useHistoryExploration(): HistoryExploration {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const searchString = search?.toString() ?? "";

  const state = useMemo(() => readExplorationUrl(searchString), [searchString]);
  const dateISO = useMemo(() => {
    const v = new URLSearchParams(searchString).get("asof");
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  }, [searchString]);

  const push = useCallback(
    (updates: Record<string, string | null>, replace = false) => {
      const url = buildSpaceUrl(pathname ?? "", searchString, updates);
      if (replace) router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    },
    [router, pathname, searchString],
  );

  const openPoint = useCallback(
    (root: LensRoot, dateISO: string, fromISO: string, toISO: string) => {
      // `asof` moves with the selection so the chart and the sheet agree about
      // which point is selected; the exploration window is pinned separately so
      // a preset change later cannot silently re-derive it.
      push({
        asof: dateISO,
        ...explorationOpenUpdate({ root, nodeType: "lens", nodeId: null, fromISO, toISO }),
      });
    },
    [push],
  );

  const navigate = useCallback(
    (nodeType: ExplorationNodeType, nodeId: string | null) => {
      if (!state) return;
      // WINDOW INHERITANCE: the child is asked about exactly the window the
      // parent was showing. No reset, no preset re-derivation, no clamp.
      // The ROOT is preserved across a drill: the user is still asking the same
      // question, just about a deeper node.
      push(explorationOpenUpdate({
        root: state.root, nodeType, nodeId, fromISO: state.fromISO, toISO: state.toISO,
      }));
    },
    [push, state],
  );

  const close = useCallback(() => {
    // Clears ONLY exploration's own keys. The lens, the as-of date and the range
    // survive: closing a drill-down must not move the chart behind it.
    push(explorationCloseUpdate(), true);
  }, [push]);

  return {
    open: state !== null,
    root: state?.root ?? "net-worth",
    nodeType: state?.nodeType ?? "lens",
    nodeId: state?.nodeId ?? null,
    dateISO,
    fromISO: state?.fromISO ?? "",
    toISO: state?.toISO ?? "",
    openPoint, navigate, close,
  };
}
