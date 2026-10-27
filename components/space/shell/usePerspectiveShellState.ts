"use client";

/**
 * components/space/shell/usePerspectiveShellState.ts
 *
 * The React binding for the canonical shell time model (lib/perspectives/
 * time-range.ts). It is the ONE owner of {preset, asOf, compareTo} for the
 * Perspectives view: shell controls dispatch reducer actions (plus the single
 * sanctioned exception — the chart's onSelectAsOf, routed through setAsOf), and
 * it mirrors the state into the URL alongside the tab/perspective params
 * useSpaceNavigation manages.
 *
 * v2.7 — PER-GROUP TIME (owner decision, final perspective UX pass). The hook
 * holds TWO independent slices (lib/space/perspective-time-groups.ts):
 *   position — Net Worth / Assets / Debt + every non-Overview tab (?asof&compareto&preset)
 *   flow     — Cash Flow + Spending (?fasof&fcompareto&fpreset + ?fperiod, an explicit
 *              calendar Month / Quarter / Year chosen from the heatmap)
 * `group` (from the rendered destination) selects which slice `state` / `actions`
 * read and write; the other slice is untouched, so changing Cash Flow's period never
 * moves Net Worth's and vice versa. Both slices are serialized on every write, so a
 * reload, Back/Forward and a shared link restore both.
 *
 * SSR-safe: initial state is the deterministic 1M default (identical on server
 * and client — no hydration mismatch); URL hydration runs post-mount in an
 * effect, exactly like the existing tab-URL sync. All date arithmetic lives in
 * the pure reducer; this hook owns only React state.
 *
 * SD-0A: the hook never writes browser History or registers its own popstate
 * listener. It serializes through the canonical Space URL authority (useSpaceUrl
 * → the pure lib/space/space-url.ts core) and re-hydrates from it on Back/Forward
 * through that authority's single listener.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CashFlowPeriod, ExplicitCashFlowPeriod } from "@/lib/transactions/cash-flow";
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import {
  historicalCompareTo,
  type PerspectiveTimeState,
  type ShellTimeAction,
  type ShellTimeContext,
  type TimePreset,
} from "@/lib/perspectives/time-range";
import {
  defaultGroupedShellTime,
  groupPeriod,
  hydrateGroupedShellTime,
  reduceGroupTime,
  rederiveAllPreset,
  resetGroupTime,
  rollGroupedShellTime,
  sameGroupTime,
  serializeGroupedShellTime,
  setGroupExplicit,
  type GroupedShellTime,
  type TimeGroup,
} from "@/lib/space/perspective-time-groups";

export interface ShellTimeActions {
  selectPreset:   (preset: Exclude<TimePreset, "CUSTOM">) => void;
  setAsOf:        (asOf: string) => void;
  setCompareTo:   (compareTo: string | null) => void;
  clearCompareTo: () => void;
  swap:           () => void;
}

export interface PerspectiveShellState {
  /** The ACTIVE group's canonical time. */
  state:   PerspectiveTimeState;
  /** Header actions — they write the ACTIVE group only. */
  actions: ShellTimeActions;
  /** The active group. */
  group:   TimeGroup;
  /**
   * The active group's effective period: an explicit calendar period chosen from the
   * heatmap, else the relative preset, else (CUSTOM) the group's last relative
   * preset (§3.5). This is what Cash Flow / Spending (and the Assets cash section)
   * read — never null.
   */
  period:  CashFlowPeriod;
  /** The active group's explicit calendar period (heatmap Month · Quarter · Year), or null. */
  explicitPeriod: ExplicitCashFlowPeriod | null;
  /** Choose (or clear) an explicit calendar period on the ACTIVE group (a user change ⇒ PUSH). */
  setExplicitPeriod: (p: ExplicitCashFlowPeriod | null) => void;
  /**
   * The heatmap's Reset: the ACTIVE group back to its default — no explicit unit
   * (?fperiod cleared), the default preset (1M) at a rolling As Of. A user change ⇒
   * PUSH, exactly like the Month · Quarter · Year pick it undoes (Back returns to
   * the pinned unit). The other group is untouched; nothing else is reset.
   */
  resetPeriod: () => void;
  derived: {
    /** Wealth chart window [compareTo ?? coverageFrom, asOf]; read model applies the fallback. */
    chartWindow:    [string | null, string];
    /**
     * The relative period the active slice implies, or null under CUSTOM (the
     * period above then holds the group's last relative one).
     */
    cashFlowPeriod: CashFlowPeriod | null;
    /**
     * The canonical compareTo, exposed only when strictly earlier than asOf (else
     * null) — the strict baseline the window-constrained lenses (Debt / Investments
     * / Liquidity) consume. Wealth keeps the raw `state.compareTo`.
     */
    historicalCompareTo: string | null;
  };
}

export function usePerspectiveShellState(args: {
  spaceId:                string;
  today:                  string;
  earliestDefensibleDate: string | null;
  /** The rendered destination's time group (timeGroupFor). Absent ⇒ "position". */
  group?:                 TimeGroup;
}): PerspectiveShellState {
  const { today, earliestDefensibleDate } = args;
  const group: TimeGroup = args.group ?? "position";

  // The canonical Space URL authority (SD-0A) — the single serializer + the
  // single Back/Forward listener. This hook never touches window.history.
  const spaceUrl = useSpaceUrl();

  // Reducer context (today + coverage) lives in a ref so dispatch reads the
  // latest at event time without re-creating callbacks. Written in an effect
  // (never during render); the ctx-update effect is declared before any effect
  // that reads it, so a coverage change refreshes the ref first.
  const ctxRef = useRef<ShellTimeContext>({ today, coverageFrom: earliestDefensibleDate });
  useEffect(() => { ctxRef.current = { today, coverageFrom: earliestDefensibleDate }; }, [today, earliestDefensibleDate]);

  const [groups, setGroups] = useState<GroupedShellTime>(() => defaultGroupedShellTime(today));

  // HISTORY INTENT (the Space contract — see useSpaceNavigation): a time change
  // the USER makes is a navigation step (PUSH, so Back undoes it — the SD-0A
  // behaviour); everything the SYSTEM does — URL hydration, popstate re-sync,
  // re-deriving ALL when coverage arrives, the midnight roll — REPLACES. Declared
  // at the entry point: only user actions mark push, and only when the active
  // group's slice CHANGES.
  const historyIntent = useRef<"push" | "replace">("replace");
  const update = useCallback(
    (g: TimeGroup, fn: (s: GroupedShellTime[TimeGroup]) => GroupedShellTime[TimeGroup]) =>
      setGroups((all) => {
        const next = fn(all[g]);
        if (next === all[g] || sameGroupTime(next, all[g])) return all;
        historyIntent.current = "push";
        return { ...all, [g]: next };
      }),
    [],
  );

  // v2.7 — UTC midnight passed with the page open: roll each group's ROLLING
  // state (As Of was the previous today) onto the new day; explicit dates and
  // calendar periods stay. A system change ⇒ REPLACE. Identity otherwise, and the
  // rolling As Of is never written to the URL, so this cannot loop.
  const prevToday = useRef(today);
  useEffect(() => {
    const prev = prevToday.current;
    if (prev === today) return;
    prevToday.current = today;
    historyIntent.current = "replace";
    setGroups((g) => rollGroupedShellTime(g, prev, { today, coverageFrom: earliestDefensibleDate }));
  }, [today, earliestDefensibleDate]);

  const actions = useMemo<ShellTimeActions>(() => {
    const dispatch = (action: ShellTimeAction) => update(group, (s) => reduceGroupTime(s, action, ctxRef.current));
    return {
      selectPreset:   (preset) => dispatch({ type: "selectPreset", preset }),
      setAsOf:        (asOf) => dispatch({ type: "setAsOf", asOf }),
      setCompareTo:   (compareTo) => dispatch({ type: "setCompareTo", compareTo }),
      clearCompareTo: () => dispatch({ type: "clearCompareTo" }),
      swap:           () => dispatch({ type: "swap" }),
    };
  }, [update, group]);
  const setExplicitPeriod = useCallback(
    (p: ExplicitCashFlowPeriod | null) => update(group, (s) => setGroupExplicit(s, p)),
    [update, group],
  );
  const resetPeriod = useCallback(
    () => update(group, () => resetGroupTime(ctxRef.current)),
    [update, group],
  );

  // ALL depends on coverage, which loads async — re-derive when it arrives.
  useEffect(() => {
    setGroups((g) => rederiveAllPreset(g, ctxRef.current));
  }, [earliestDefensibleDate]);

  // Hydrate from the URL once, post-mount (client only) — avoids SSR mismatch.
  // Back/Forward re-hydration comes through the canonical authority's single
  // popstate listener (SD-0A), not a listener of our own. Both groups hydrate.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setGroups(hydrateGroupedShellTime(spaceUrl.getSearch(), ctxRef.current));
    setHydrated(true);
    return spaceUrl.subscribe(() => {
      historyIntent.current = "replace";
      setGroups(hydrateGroupedShellTime(spaceUrl.getSearch(), ctxRef.current));
    });
  }, [spaceUrl]);

  // Mirror BOTH groups → URL through the canonical authority (only after
  // hydration, so we never clobber the incoming params with the default before
  // hydration commits), with the DECLARED intent above; it preserves every
  // unrelated param and writes nothing when the URL is already in sync.
  useEffect(() => {
    if (!hydrated) return;
    const history = historyIntent.current;
    historyIntent.current = "replace";
    spaceUrl.commit(serializeGroupedShellTime(groups, ctxRef.current.today), { history });
  }, [groups, hydrated, spaceUrl]);

  const active = groups[group];
  const state = active.time;
  return {
    state,
    actions,
    group,
    period: groupPeriod(active),
    explicitPeriod: active.explicit,
    setExplicitPeriod,
    resetPeriod,
    derived: {
      chartWindow: [state.compareTo, state.asOf],
      cashFlowPeriod: state.preset === "CUSTOM" ? null : state.preset,
      historicalCompareTo: historicalCompareTo(state.asOf, state.compareTo),
    },
  };
}
