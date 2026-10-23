/**
 * lib/prices/registry.ts
 *
 * A8-3A / V26-PRICE-PROVIDER-UNIFICATION — the price-provider registry.
 *
 * ORDER IS NOT SIGNIFICANT. Routing resolves exactly ONE provider from each
 * adapter's DECLARED capability (resolveProviderForInstrument), so editing the
 * registration list cannot repoint a price series at a different vendor. The
 * previous contract — "order = failover priority", first adapter that returns
 * usable data wins — made routing a positional accident: a vendor hiccup
 * silently substituted another source, and adding an adapter could change which
 * vendor served an existing instrument. Both are invisible afterwards, because
 * PriceObservation records `source` but never why.
 *
 * A8-3B — Tiingo is the selected vendor (free tier, daily EOD for US equities,
 * a real API contract). It registers ONLY when TIINGO_API_KEY is set — the same
 * kill-switch pattern every other flag in this codebase uses. With the key
 * absent the registry stays EMPTY and the prior no-op behavior is unchanged
 * (fetchInstrumentWindow → source null; backfill/daily job clean no-ops), so
 * this code lands safely before the Tiingo account exists.
 *
 * The fixture adapter (providers/fixture.ts) remains the injectable test/dry-run
 * provider; createPriceRegistry stays the DI seam for tests.
 */

import type {
  PriceProviderAdapter, PriceRegistry, ProviderResolution, ProviderRoutingKey,
} from "./types";
import { createTiingoPriceProvider } from "./providers/tiingo";
import { createCoinGeckoPriceProvider } from "./providers/coingecko";

/**
 * Build a registry from an ordered adapter list (dependency-injection seam).
 * Duplicate `source` identifiers are a programmer error: the archive stamps
 * provenance by source, so two adapters must never share one.
 */
export function createPriceRegistry(adapters: readonly PriceProviderAdapter[]): PriceRegistry {
  const seen = new Set<string>();
  for (const a of adapters) {
    if (seen.has(a.source)) {
      throw new Error(`[prices] duplicate adapter source in registry: "${a.source}"`);
    }
    seen.add(a.source);
  }
  return { adapters: Object.freeze([...adapters]) };
}

/**
 * Resolve the ONE provider that serves this instrument, from declared capability
 * alone.
 *
 * Deterministic and order-independent by construction: the capable adapters are
 * reduced to a SORTED list of source identifiers, and the winner is looked up by
 * source rather than by position. Shuffling `adapters` cannot change the result.
 *
 * Three outcomes, none of them a silent fall-through:
 *   - exactly one capable adapter → that provider;
 *   - none → `unsupported`, naming what was considered. Removing an adapter
 *     therefore produces a stated outcome, not an accidental hand-off;
 *   - more than one → `ambiguous`. Two adapters claiming one instrument have no
 *     capability-based winner, and choosing between them by position would be
 *     precisely the guess this replaces. It is a configuration defect, reported.
 */
export function resolveProviderForInstrument(
  registry: PriceRegistry,
  key:      ProviderRoutingKey,
): ProviderResolution {
  const capable = registry.adapters
    .filter((a) => a.supportedBases().includes(key.basis) && a.supportsInstrument(key))
    .map((a) => a.source)
    .sort();

  if (capable.length === 0) {
    return { kind: "unsupported", sourcesConsidered: registry.adapters.map((a) => a.source).sort() };
  }
  if (capable.length > 1) return { kind: "ambiguous", sources: capable };

  const adapter = registry.adapters.find((a) => a.source === capable[0]);
  if (!adapter) return { kind: "unsupported", sourcesConsidered: capable };
  return { kind: "provider", adapter };
}

/**
 * The production registry. Registers each vendor behind its own key gate:
 * Tiingo for listed equities/ETFs, CoinGecko for crypto. With neither key the
 * registry stays EMPTY and every acquisition path is a clean no-op — historical
 * coverage stays whatever has accrued, never fabricated.
 *
 * Their declared capabilities are DISJOINT (asset class), so routing is
 * unambiguous. Adding a further vendor is a one-line change here plus its
 * adapter file; no consumer changes, and no ordering to get right.
 */
export function defaultPriceRegistry(): PriceRegistry {
  const adapters: PriceProviderAdapter[] = [];
  const tiingoKey = process.env.TIINGO_API_KEY;
  if (tiingoKey) adapters.push(createTiingoPriceProvider(tiingoKey));
  const coingeckoKey = process.env.COINGECKO_API_KEY;
  if (coingeckoKey) adapters.push(createCoinGeckoPriceProvider(coingeckoKey));
  return createPriceRegistry(adapters);
}
