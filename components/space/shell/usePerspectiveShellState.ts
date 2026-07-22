"use client";

/**
 * components/space/shell/usePerspectiveShellState.ts
 *
 * The React binding for the canonical shell time model (lib/perspectives/
 * time-range.ts). It is the ONE owner of {preset, asOf, compareTo} for the
 * Perspectives view: shell controls dispatch reducer actions (plus the single
 * sanctioned exception — the chart's onSelectAsOf, routed through setAsOf), and
 * it mirrors the state into the URL (?asof&compareto&preset) alongside the tab/
 * perspective params SpaceDashboard already manages.
 *
 * SSR-safe: initial state is the deterministic MTD default (identical on server
 * and client — no hydration mismatch); URL hydration runs post-mount in an
 * effect, exactly like the existing tab-URL sync. All date arithmetic lives in
 * the pure reducer; this hook owns only React state.
 *
 * SD-0A: the hook no longer writes browser History or registers its own popstate
 * listener. It serializes {preset, asOf, compareTo} into the canonical Space URL
 * authority (useSpaceUrl → the pure lib/space/space-url.ts core) and re-hydrates
 * from it on Back/Forward through that authority's single listener. The reducer
 * still owns time semantics; the authority owns serialization.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import { readSpaceParam } from "@/lib/space/space-url";
import {
  defaultPerspectiveTimeState,
  historicalCompareTo,
  hydrateShellTimeState,
  serializeShellTimeState,
  shellTimeReducer,
  type PerspectiveTimeState,
  type ShellTimeAction,
  type ShellTimeContext,
  type TimePreset,
} from "@/lib/perspectives/time-range";

export interface ShellTimeActions {
  selectPreset:   (preset: Exclude<TimePreset, "CUSTOM">) => void;
  setAsOf:        (asOf: string) => void;
  setCompareTo:   (compareTo: string | null) => void;
  clearCompareTo: () => void;
  swap:           () => void;
}

export interface PerspectiveShellState {
  state:   PerspectiveTimeState;
  actions: ShellTimeActions;
  derived: {
    /** Wealth chart window [compareTo ?? coverageFrom, asOf]; read model applies the fallback. */
    chartWindow:    [string | null, string];
    /**
     * The Cash Flow period the shell slice implies, or null under CUSTOM — the
     * host then holds Cash Flow's last period (§3.5), never forcing it to a
     * default when the shell has no relative slice to impose.
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

function readTimeParams(search: string): { asOf: string | null; compareTo: string | null; preset: string | null } {
  return {
    asOf:      readSpaceParam(search, "asof"),
    compareTo: readSpaceParam(search, "compareto"),
    preset:    readSpaceParam(search, "preset"),
  };
}

export function usePerspectiveShellState(args: {
  spaceId:                string;
  today:                  string;
  earliestDefensibleDate: string | null;
}): PerspectiveShellState {
  const { today, earliestDefensibleDate } = args;

  // The canonical Space URL authority (SD-0A) — the single serializer + the
  // single Back/Forward listener. This hook never touches window.history.
  const spaceUrl = useSpaceUrl();

  // Reducer context (today + coverage) lives in a ref so dispatch reads the
  // latest at event time without re-creating callbacks. Written in an effect
  // (never during render); the ctx-update effect is declared before any effect
  // that reads it, so a coverage change refreshes the ref first.
  const ctxRef = useRef<ShellTimeContext>({ today, coverageFrom: earliestDefensibleDate });
  useEffect(() => { ctxRef.current = { today, coverageFrom: earliestDefensibleDate }; }, [today, earliestDefensibleDate]);

  const [state, setState] = useState<PerspectiveTimeState>(() => defaultPerspectiveTimeState(today));

  const dispatch = useCallback(
    (action: ShellTimeAction) => setState((s) => shellTimeReducer(s, action, ctxRef.current)),
    [],
  );

  const actions = useMemo<ShellTimeActions>(() => ({
    selectPreset:   (preset) => dispatch({ type: "selectPreset", preset }),
    setAsOf:        (asOf) => dispatch({ type: "setAsOf", asOf }),
    setCompareTo:   (compareTo) => dispatch({ type: "setCompareTo", compareTo }),
    clearCompareTo: () => dispatch({ type: "clearCompareTo" }),
    swap:           () => dispatch({ type: "swap" }),
  }), [dispatch]);

  // The Cash Flow period the shell slice implies (identity for relative presets;
  // null under CUSTOM so the host holds Cash Flow's last period — §3.5). Pure.
  const cashFlowPeriod: CashFlowPeriod | null = state.preset === "CUSTOM" ? null : state.preset;

  // ALL depends on coverage, which loads async — re-derive when it arrives.
  useEffect(() => {
    setState((s) => (s.preset === "ALL" ? shellTimeReducer(s, { type: "selectPreset", preset: "ALL" }, ctxRef.current) : s));
  }, [earliestDefensibleDate]);

  // Hydrate from the URL once, post-mount (client only) — avoids SSR mismatch.
  // Back/Forward re-hydration comes through the canonical authority's single
  // popstate listener (SD-0A), not a listener of our own.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const raw = readTimeParams(spaceUrl.getSearch());
    if (raw.asOf || raw.compareTo || raw.preset) setState(hydrateShellTimeState(raw, ctxRef.current));
    setHydrated(true);
    return spaceUrl.subscribe(() => {
      setState(hydrateShellTimeState(readTimeParams(spaceUrl.getSearch()), ctxRef.current));
    });
  }, [spaceUrl]);

  // Mirror state → URL through the canonical authority (only after hydration, so
  // we never clobber the incoming params with the default before hydration
  // commits). The authority replaces on the first real write (canonicalize) and
  // pushes after, so Back/Forward works; it preserves every unrelated param.
  const urlInit = useRef(false);
  useEffect(() => {
    if (!hydrated) return;
    const ser = serializeShellTimeState(state);
    const wrote = spaceUrl.commit(
      { asof: ser.asOf, compareto: ser.compareTo, preset: ser.preset },
      { history: urlInit.current ? "push" : "replace" },
    );
    if (wrote) urlInit.current = true;
  }, [state, hydrated, spaceUrl]);

  return {
    state,
    actions,
    derived: {
      chartWindow: [state.compareTo, state.asOf],
      cashFlowPeriod,
      historicalCompareTo: historicalCompareTo(state.asOf, state.compareTo),
    },
  };
}
