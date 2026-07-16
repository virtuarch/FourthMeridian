"use client";

/**
 * components/space/widgets/debt/useDebtSpaceData.ts
 *
 * SD-6A — the client composition hook for the canonical Debt workspace contract
 * (DebtSpaceData, lib/debt-space-data.ts). The Debt analogue of the Investments
 * binding, but CLIENT-COMPOSED (not a server loader): the visible Debt figures are
 * client-side authority (computeDebtKpis over the accounts array), so the contract
 * is assembled in the browser via the PURE assembleDebtSpaceData — it injects the
 * host's already-loaded `snapshots` + FICO and clips the Balance-Over-Time series
 * to the shell window. The ONE thing it cannot compute locally — the debt lens AT
 * asOf (a DB read) — it fetches from GET /api/spaces/[id]/debt/space-data.
 *
 * It owns NO time state — the Perspective Shell owns preset / asOf / compareTo and
 * passes the ALREADY-RESOLVED dates in. Two branches, one kill switch:
 *   • PRESENT DAY (asOf >= today): NO fetch. The lens is the host's already-fetched
 *     present-day batch result (`presentLens`); the history clip to [null, today] is
 *     the full series — byte-identical to today's Debt render.
 *   • HISTORICAL (asOf < today): fetch the lens AT asOf (carries the as-of
 *     `completeness` envelope), then compose. compareTo clips the history window.
 *
 * Honesty guards mirror the Investments hook: the last successful as-of lens stays
 * during a refetch (no lede flash on every As-Of nudge); stale responses are
 * cancelled via `alive`; a failed fetch keeps the last lens and flags `error`.
 *
 * PURE composition, cheap: assembleDebtSpaceData does no DB / clock / network — it
 * runs in a useMemo over the resolved lens + host inputs, so `data` is always a
 * fully-formed DebtSpaceData (never null); `loading`/`error` drive only the chart's
 * spinner and the retry affordance.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Snapshot } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import { assembleDebtSpaceData, type DebtSpaceData } from "@/lib/debt-space-data";

export interface UseDebtSpaceData {
  /** The composed contract — always present (pure assembly of the resolved lens + host inputs). */
  data:    DebtSpaceData;
  /** True while the as-of lens fetch is in flight AND no prior lens is shown yet. */
  loading: boolean;
  /** True when the most recent as-of lens fetch failed (network / non-2xx). */
  error:   boolean;
  /** Imperative refetch for the retry affordance. */
  reload:  () => void;
}

export function useDebtSpaceData(args: {
  spaceId:         string;
  /** Resolved closing date (YYYY-MM-DD) from the shell. */
  asOf:            string;
  /** Resolved opening date, or null; clips the history window's lower bound. */
  compareTo:       string | null;
  /** The shell's "today" — asOf >= today ⇒ present-day (no fetch). */
  today:           string;
  /** Gate — only fetch while the Debt workspace is open. */
  active:          boolean;
  /** The host's already-fetched present-day debt lens (lensResults["debt"]). */
  presentLens:     LensResult | null;
  /** SpaceSnapshot history (host state); null while still loading. */
  snapshots:       Snapshot[] | null | undefined;
  /** The stamped currency of the snapshot series (the history basis). */
  snapshotCurrency: string;
  /** FICO passthrough (Personal host only in practice). */
  fico:            { score: number | null; updatedAt: string | null };
  /** MC1 "view as" override — forwarded to the as-of lens fetch. */
  targetCurrency?: string;
}): UseDebtSpaceData {
  const {
    spaceId, asOf, compareTo, today, active,
    presentLens, snapshots, snapshotCurrency, fico, targetCurrency,
  } = args;
  // Primitive FICO fields — depended on directly so the memo stays stable across
  // the fresh `fico` object the caller builds each render (exhaustive-deps honest).
  const ficoScore = fico.score;
  const ficoUpdatedAt = fico.updatedAt;

  // Historical only when the shell window closes strictly before today.
  const historical = active && asOf < today;

  const [asOfLens, setAsOfLens] = useState<LensResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;

    // Present day never fetches — the host's present-day lens is authoritative.
    // Clear any stale error without a synchronous setState in the effect body
    // (react-hooks/set-state-in-effect) by deferring to a microtask.
    if (!historical) {
      Promise.resolve().then(() => { if (alive) setError(false); });
      return () => { alive = false; };
    }

    const params = new URLSearchParams({ asOf });
    if (targetCurrency) params.set("target", targetCurrency);

    // Defer the loading flip to a microtask so no setState runs synchronously in
    // the effect body (react-hooks/set-state-in-effect) — the Investments pattern.
    Promise.resolve().then(() => { if (alive) setLoading(true); });

    fetch(`/api/spaces/${spaceId}/debt/space-data?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { lens: LensResult | null }) => {
        if (!alive) return;
        setAsOfLens(d.lens ?? null);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        // Keep the last as-of lens (no flash); surface the retry affordance.
        setError(true);
        setLoading(false);
      });

    return () => { alive = false; };
  }, [spaceId, asOf, historical, targetCurrency, nonce]);

  // The resolved lens: present-day host batch, or the as-of fetch when historical.
  const lens = historical ? asOfLens : presentLens;

  const data = useMemo<DebtSpaceData>(
    () => assembleDebtSpaceData({
      asOf,
      compareTo,
      lens,
      snapshots: snapshots ?? null,
      snapshotCurrency,
      fico: { score: ficoScore, updatedAt: ficoUpdatedAt },
    }),
    [asOf, compareTo, lens, snapshots, snapshotCurrency, ficoScore, ficoUpdatedAt],
  );

  // Only blank the chart before the FIRST historical lens arrives; a refetch keeps
  // the last composed view. Present day is never "loading" (no fetch).
  return { data, loading: loading && historical && asOfLens === null, error, reload };
}
