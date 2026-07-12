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
 * the pure reducer; this hook owns only React state + the browser History write.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import {
  defaultPerspectiveTimeState,
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
  };
}

function readTimeParams(): { asOf: string | null; compareTo: string | null; preset: string | null } {
  const p = new URLSearchParams(window.location.search);
  return { asOf: p.get("asof"), compareTo: p.get("compareto"), preset: p.get("preset") };
}

export function usePerspectiveShellState(args: {
  spaceId:                string;
  today:                  string;
  earliestDefensibleDate: string | null;
}): PerspectiveShellState {
  const { today, earliestDefensibleDate } = args;

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
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined") {
      const raw = readTimeParams();
      if (raw.asOf || raw.compareTo || raw.preset) setState(hydrateShellTimeState(raw, ctxRef.current));
    }
    setHydrated(true);
    // Back/forward: re-hydrate from the URL.
    function onPop() { if (typeof window !== "undefined") setState(hydrateShellTimeState(readTimeParams(), ctxRef.current)); }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Mirror state → URL (only after hydration, so we never clobber the incoming
  // params with the default before hydration commits). replaceState first
  // (canonicalize), pushState after (back/forward works).
  const urlInit = useRef(false);
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const ser = serializeShellTimeState(state);
    params.set("asof", ser.asOf);
    if (ser.compareTo) params.set("compareto", ser.compareTo); else params.delete("compareto");
    params.set("preset", ser.preset);
    const next = `${window.location.pathname}?${params.toString()}`;
    if (next === `${window.location.pathname}${window.location.search}`) return;
    if (!urlInit.current) { urlInit.current = true; window.history.replaceState(window.history.state, "", next); }
    else window.history.pushState(window.history.state, "", next);
  }, [state, hydrated]);

  return {
    state,
    actions,
    derived: { chartWindow: [state.compareTo, state.asOf], cashFlowPeriod },
  };
}
