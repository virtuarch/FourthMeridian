/**
 * lib/prices/registry.ts
 *
 * A8-3A — ordered price-provider registry (failover priority), cloned from
 * lib/fx/registry.ts.
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

import type { PriceProviderAdapter, PriceRegistry } from "./types";
import { createTiingoPriceProvider } from "./providers/tiingo";

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
 * The production registry. Registers the Tiingo adapter when TIINGO_API_KEY is
 * present; otherwise stays EMPTY (fetchInstrumentWindow → source null, and the
 * backfill/daily job are clean no-ops — historical coverage stays whatever A8-2
 * same-day capture has accrued, never fabricated). Adding a further vendor is a
 * one-line change here plus its adapter file; no consumer changes.
 */
export function defaultPriceRegistry(): PriceRegistry {
  const tiingoKey = process.env.TIINGO_API_KEY;
  if (tiingoKey) {
    return createPriceRegistry([createTiingoPriceProvider(tiingoKey)]);
  }
  // No key ⇒ no adapter — the pre-vendor no-op path stays intact.
  return createPriceRegistry([]);
}
