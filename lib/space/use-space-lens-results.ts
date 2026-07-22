"use client";

/**
 * lib/space/use-space-lens-results.ts  (SD-9A)
 *
 * The Perspective-Engine result loader — extracted verbatim from SpaceDashboard.
 * lensResults are PERSPECTIVE-ENGINE output (present-day lens verdicts, keyed by
 * lensId), NOT structural Space data, so this is a SEPARATE runtime seam from
 * useSpaceData (never merged: different authority, different route, different
 * refresh signal). It owns exactly what the host used to:
 *   - the one batch fetch against the membership-gated /api/spaces/[id]/perspectives,
 *   - the "view as" target-currency param (recompute lenses in that currency),
 *   - currency invalidation (a SPACE_CURRENCY_CHANGED bump re-fetches converted metrics).
 *
 * Failure of any kind (network, 403, malformed) resolves to null: lens-backed cards
 * then keep their static descriptions — the engine's rollback property, live. This
 * is a straight relocation of the host's effect; behavior is byte-identical.
 */

import { useState, useEffect } from "react";
import { SPACE_CURRENCY_CHANGED_EVENT } from "@/lib/space-nav";
import type { LensResult } from "@/lib/perspective-engine/types";

export interface UseSpaceLensResultsArgs {
  spaceId: string;
  /** MC1 "view as" override — recompute the lenses in this currency (headline +
   *  verdict + sums together). Undefined ⇒ the Space's own reporting currency. */
  targetCurrency?: string;
}

export interface SpaceLensResults {
  /** lensId → result. null = not loaded / fetch failed (cards fall back to static). */
  lensResults: Record<string, LensResult> | null;
  /**
   * PRE-BETA-OPS-CLOSE — true when a provider connection behind THIS Space's
   * accounts is mid-sync, so balances may be ahead of transactions/history.
   * Rides this seam because it qualifies the very verdicts fetched alongside it.
   *
   * `null` = no claim (not loaded, fetch failed, or the server could not
   * determine it). Deliberately NOT collapsed to `false`: asserting "fully
   * synced" from a failed lookup is the quiet false-reassurance this whole
   * initiative removes. Consumers render the caveat only on an explicit `true`.
   */
  syncIncomplete: boolean | null;
}

export function useSpaceLensResults({ spaceId, targetCurrency }: UseSpaceLensResultsArgs): SpaceLensResults {
  const [lensResults, setLensResults] = useState<Record<string, LensResult> | null>(null);
  const [syncIncomplete, setSyncIncomplete] = useState<boolean | null>(null);

  // Currency-refresh nonce: a reporting-currency change bumps this so the converted
  // lens metrics re-fetch, exactly as the former host-local currencyNonce did. Same
  // spaceId-scoped SPACE_CURRENCY_CHANGED signal useSpaceData listens to for its own data.
  const [currencyNonce, setCurrencyNonce] = useState(0);
  useEffect(() => {
    function onCurrencyChanged(e: Event) {
      const detail = (e as CustomEvent<{ spaceId?: string }>).detail;
      if (detail?.spaceId && detail.spaceId !== spaceId) return;
      setCurrencyNonce((n) => n + 1);
    }
    window.addEventListener(SPACE_CURRENCY_CHANGED_EVENT, onCurrencyChanged);
    return () => window.removeEventListener(SPACE_CURRENCY_CHANGED_EVENT, onCurrencyChanged);
  }, [spaceId]);

  // Perspective Engine results — one batch fetch against the membership-gated route.
  useEffect(() => {
    let active = true;
    // MC1 view-as: when an override target is set, ask the engine to recompute the
    // lenses in that currency (headline + verdict + sums together).
    const url = targetCurrency
      ? `/api/spaces/${spaceId}/perspectives?target=${encodeURIComponent(targetCurrency)}`
      : `/api/spaces/${spaceId}/perspectives`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active) return;
        const results: LensResult[] = Array.isArray(data?.results) ? data.results : [];
        setLensResults(
          results.length ? Object.fromEntries(results.map((res) => [res.lensId, res])) : null,
        );
        // Only an explicit boolean is a claim. Anything else (absent field, an
        // older server, a `null` the server sent because it could not tell)
        // stays `null` — no claim either way.
        setSyncIncomplete(typeof data?.syncIncomplete === "boolean" ? data.syncIncomplete : null);
      })
      .catch(() => { if (active) { setLensResults(null); setSyncIncomplete(null); } });
    return () => { active = false; };
    // currencyNonce: refetch converted lens metrics after a currency change.
    // targetCurrency: refetch when the "view as" override changes.
  }, [spaceId, currencyNonce, targetCurrency]);

  return { lensResults, syncIncomplete };
}
