"use client";

/**
 * components/space/widgets/investments/useInvestmentsTimeMachine.ts
 *
 * Client fetch hook for the A10 Investments Time Machine read model. It owns NO
 * time state — the Perspective Shell owns preset / asOf / compareTo and passes
 * the ALREADY-RESOLVED dates in. This hook only turns (spaceId, asOf,
 * compareTo) into a fetch against the membership-gated route and hands back
 * `{ result, loading, error, reload }`.
 *
 * Two honesty guards, both from the plan (§3.5):
 *   1. The route 400s when `compareTo >= asOf` (an ordering the shell reducer can
 *      transiently produce via swap / manual edits). So we send `compareTo` ONLY
 *      when it is non-null AND strictly < asOf; otherwise we omit it and the DTO
 *      comes back with null flows/reconciliation — an honest "no comparison",
 *      never an error state.
 *   2. We keep the last successful result visible while a refetch is in flight
 *      (no flash to a spinner on every As-Of/Compare-To nudge), and cancel stale
 *      responses via an `active` flag — the goals-fetch pattern
 *      (SpaceDashboard.tsx:2626–2634).
 *
 * The DTO type is imported type-only (`import type`) so nothing from the pure
 * assembly core is bundled into the client — the import is erased at build time.
 */

import { useCallback, useEffect, useState } from "react";
import type { InvestmentsTimeMachineResult } from "@/lib/investments/investments-time-machine-core";

export interface UseInvestmentsTimeMachine {
  /** The latest successfully-fetched result; kept during refetch, null until first success. */
  result:  InvestmentsTimeMachineResult | null;
  /** True while a fetch is in flight (only blanks the grid when result is still null). */
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
 * @param active     gate — fetch only while the Investments perspective is open
 */
export function useInvestmentsTimeMachine(
  spaceId:   string,
  asOf:      string,
  compareTo: string | null,
  active:    boolean,
): UseInvestmentsTimeMachine {
  const [result, setResult] = useState<InvestmentsTimeMachineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Bumped by reload() to force the effect to re-run on demand.
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Send compareTo only when it defines a valid strictly-earlier window; the
  // route 400s on compareTo >= asOf, so an invalid ordering becomes an honest
  // omission (null flows/reconciliation) rather than an error.
  const compareToForFetch = compareTo && compareTo < asOf ? compareTo : null;

  useEffect(() => {
    if (!active) return;
    let alive = true;

    const params = new URLSearchParams({ asOf });
    if (compareToForFetch) params.set("compareTo", compareToForFetch);

    // Every setState runs inside an async callback, never synchronously in the
    // effect body — the house pattern (InvestmentAccountsWidget / the goals
    // fetch) that satisfies react-hooks/set-state-in-effect. The loading flip is
    // deferred to a microtask for the same reason.
    Promise.resolve().then(() => { if (alive) setLoading(true); });

    fetch(`/api/spaces/${spaceId}/investments/time-machine?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: InvestmentsTimeMachineResult) => {
        if (!alive) return;
        setResult(data);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        // Keep the last good `result` visible; surface the error alongside it so
        // the retry affordance shows without blanking a previously-loaded grid.
        setError(true);
        setLoading(false);
      });

    return () => { alive = false; };
  }, [spaceId, asOf, compareToForFetch, active, nonce]);

  return { result, loading, error, reload };
}
