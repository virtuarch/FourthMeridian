"use client";

/**
 * components/space/widgets/investments/useInvestmentsSpaceData.ts
 *
 * SD-4A — client fetch hook for the canonical Investments workspace contract
 * (`InvestmentsSpaceData`, PCS-1D), served by GET /api/spaces/[id]/investments/
 * space-data. It is the Investments Workspace's sole data source (it superseded — and
 * CLEAN-0 removed — the raw A10 `useInvestmentsTimeMachine` hook + its `/investments/
 * time-machine` route): the composed envelope carries `current` (getCurrentPositions,
 * the canonical CURRENT path) AND `historical`/`activity`/`trust` (A10) in one read,
 * never cross-derived.
 *
 * It owns NO time state — the Perspective Shell owns preset / asOf / compareTo and
 * passes the ALREADY-RESOLVED dates in. Two honesty guards:
 *   1. `compareTo` is sent only when non-null AND strictly < asOf (the route 400s on
 *      compareTo >= asOf) — an invalid ordering becomes an honest omission
 *      (null flows/reconciliation), never an error.
 *   2. The last successful `data` stays visible during a refetch (no spinner flash on
 *      every As-Of/Compare-To nudge); stale responses are cancelled via `alive`.
 *
 * The DTO type is imported type-only so nothing from the server loader is bundled.
 */

import { useCallback, useEffect, useState } from "react";
import type { InvestmentsSpaceData } from "@/lib/investments/space-data-core";
import type { PortfolioValuePoint } from "@/lib/investments/portfolio-series";

/** The /space-data response: the composed contract PLUS the Portfolio Value series. */
type InvestmentsWorkspaceResponse = InvestmentsSpaceData & { series: PortfolioValuePoint[] };

export interface UseInvestmentsSpaceData {
  /** The latest successfully-fetched contract; kept during refetch, null until first success. */
  data:    InvestmentsSpaceData | null;
  /** The Portfolio Value Over Time series (empty until first success). */
  series:  PortfolioValuePoint[];
  /** True while a fetch is in flight (only blanks the grid when data is still null). */
  loading: boolean;
  /** True when the most recent fetch failed (network / non-2xx). */
  error:   boolean;
  /** Imperative refetch for the retry affordance. */
  reload:  () => void;
}

/**
 * @param spaceId    the Space whose investments to read
 * @param asOf       resolved closing date (YYYY-MM-DD) from the shell
 * @param compareTo  resolved opening date, or null; sent only when `< asOf`
 * @param active     gate — fetch only while the Investments workspace is open
 */
export function useInvestmentsSpaceData(
  spaceId:   string,
  asOf:      string,
  compareTo: string | null,
  active:    boolean,
): UseInvestmentsSpaceData {
  const [data, setData] = useState<InvestmentsWorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Send compareTo only when it defines a valid strictly-earlier window.
  const compareToForFetch = compareTo && compareTo < asOf ? compareTo : null;

  useEffect(() => {
    if (!active) return;
    let alive = true;

    const params = new URLSearchParams({ asOf });
    if (compareToForFetch) params.set("compareTo", compareToForFetch);

    // Defer the loading flip to a microtask so no setState runs synchronously in
    // the effect body (react-hooks/set-state-in-effect) — the A10 hook's pattern.
    Promise.resolve().then(() => { if (alive) setLoading(true); });

    fetch(`/api/spaces/${spaceId}/investments/space-data?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: InvestmentsWorkspaceResponse) => {
        if (!alive) return;
        setData({ ...d, series: Array.isArray(d.series) ? d.series : [] });
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError(true);
        setLoading(false);
      });

    return () => { alive = false; };
  }, [spaceId, asOf, compareToForFetch, active, nonce]);

  return { data, series: data?.series ?? [], loading, error, reload };
}
