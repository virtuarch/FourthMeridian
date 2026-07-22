"use client";

/**
 * components/space/widgets/liquidity/useLiquiditySpaceData.ts
 *
 * SD-6B — the client binding for the canonical Liquidity workspace contract
 * (LiquiditySpaceData, lib/liquidity/space-data.ts). It activates the historical
 * engine end-to-end for the Liquidity Workspace, mirroring the sibling hooks:
 *
 *   • PRESENT DAY (asOf >= today, no comparison): NO fetch. The contract is
 *     SYNTHESIZED client-side from the host's already-fetched present-day lens
 *     (`presentLens` = lensResults["liquidity"]) via the PURE assembleLiquidity-
 *     SpaceData — current only, atAsOf/atCompareTo/delta/trust all null. Byte-
 *     identical to today's current-state Liquidity render (no round-trip, no
 *     second lens computation).
 *   • HISTORICAL / COMPARISON (asOf < today, or a valid compareTo): fetch the WHOLE
 *     composed contract from GET /api/spaces/[id]/liquidity/space-data. The server
 *     loader is the single authority — it runs the splice engine at each date and
 *     assembles delta + trust; the client only consumes.
 *
 * It owns NO time state — the Perspective Shell owns preset / asOf / compareTo and
 * passes the ALREADY-RESOLVED dates in. Two honesty guards mirror the Investments /
 * Debt hooks:
 *   1. compareTo is sent only when non-null AND strictly < asOf (the route 400s on
 *      compareTo >= asOf) — an invalid ordering becomes an honest omission, never an
 *      error.
 *   2. The last successful server contract stays visible during a refetch (no flash
 *      on every As-Of / Compare-To nudge); stale responses are cancelled via `alive`,
 *      and a failed fetch keeps the last contract and flags `error`.
 *
 * `assembleLiquiditySpaceData` is imported from the PURE core (space-data-core), so
 * nothing from the DB-binding loader (space-data.ts) is bundled client-side.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import type { LensResult } from "@/lib/perspective-engine/types";
import {
  assembleLiquiditySpaceData,
  type LiquiditySpaceData,
} from "@/lib/liquidity/space-data-core";

export interface UseLiquiditySpaceData {
  /** The composed contract. null only before the FIRST historical fetch resolves
   *  (or while the host present-day lens is still loading) — the workspace renders
   *  its current-anchor widgets from `accounts` regardless. */
  data:    LiquiditySpaceData | null;
  /** True while a historical fetch is in flight AND no prior contract is shown yet. */
  loading: boolean;
  /** True when the most recent historical fetch failed (network / non-2xx). */
  error:   boolean;
  /** Imperative refetch for the retry affordance. */
  reload:  () => void;
}

export function useLiquiditySpaceData(args: {
  spaceId:     string;
  /** Resolved closing date (YYYY-MM-DD) from the shell. */
  asOf:        string;
  /** Resolved opening date, or null; drives the comparison delta. */
  compareTo:   string | null;
  /** The shell's "today" — asOf >= today with no comparison ⇒ present-day (no fetch). */
  today:       string;
  /** Gate — only fetch while the Liquidity workspace is open. */
  active:      boolean;
  /** The host's already-fetched present-day liquidity lens (lensResults["liquidity"]).
   *  Used as `current` on the present-day branch (no round-trip). */
  presentLens: LensResult | null;
}): UseLiquiditySpaceData {
  const { spaceId, asOf, compareTo, today, active, presentLens } = args;

  // Send compareTo only when it defines a valid strictly-earlier window.
  const compareToForFetch = compareTo && compareTo < asOf ? compareTo : null;
  // The server is needed for any historical read: an as-of before today, OR a
  // comparison (atCompareTo + delta the client cannot compute). Present-day with no
  // comparison is synthesized locally from the host lens.
  const needsServer = active && (asOf < today || compareToForFetch != null);

  const [serverData, setServerData] = useState<LiquiditySpaceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;

    // Present-day (no comparison) never fetches — the host lens is authoritative.
    // Clear any stale error without a synchronous setState in the effect body
    // (react-hooks/set-state-in-effect) by deferring to a microtask.
    if (!needsServer) {
      Promise.resolve().then(() => { if (alive) setError(false); });
      return () => { alive = false; };
    }

    const params = new URLSearchParams({ asOf });
    if (compareToForFetch) params.set("compareTo", compareToForFetch);

    // Defer the loading flip to a microtask so no setState runs synchronously in
    // the effect body — the sibling hooks' pattern.
    Promise.resolve().then(() => { if (alive) setLoading(true); });

    fetch(`/api/spaces/${spaceId}/liquidity/space-data?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: LiquiditySpaceData) => {
        if (!alive) return;
        setServerData(d);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        // Keep the last contract (no flash); surface the retry affordance.
        setError(true);
        setLoading(false);
      });

    return () => { alive = false; };
  }, [spaceId, asOf, compareToForFetch, needsServer, nonce]);

  // Present-day contract synthesized purely from the host lens (current only). Null
  // while the host lens is still loading — the workspace's current widgets render
  // from `accounts` regardless, so this only gates the lede + temporal panels.
  const presentData = useMemo<LiquiditySpaceData | null>(
    () => (presentLens
      // reportingCurrency is a placeholder here: the present-day contract has NO
      // atAsOf/atCompareTo, so the display-conversion pass has nothing historical to
      // convert, and the present-day lede reads `current` (already in the display
      // currency — the host fetches the present lens with the view-as target).
      ? assembleLiquiditySpaceData({
          asOf, compareTo: null, reportingCurrency: DEFAULT_DISPLAY_CURRENCY,
          current: presentLens, atAsOf: null, atCompareTo: null,
        })
      : null),
    [presentLens, asOf],
  );

  const data = needsServer ? serverData : presentData;

  // Only "loading" while the FIRST historical contract is in flight; a refetch keeps
  // the last composed view, and present day is never loading (no fetch).
  return { data, loading: loading && needsServer && serverData === null, error, reload };
}
