/**
 * lib/prices/registry.ts
 *
 * A8-3A — ordered price-provider registry (failover priority), cloned from
 * lib/fx/registry.ts. Pure module: contains NO real vendor adapter. A real
 * historical-price vendor (A8-3B) is an EXTERNAL, LICENSING-GATED decision and
 * has NOT been selected — persistent storage / redistribution rights for
 * derived historical prices must be verified before any adapter is written
 * (investigation §3.2, plan §9). Until then defaultPriceRegistry() is EMPTY: the
 * backfill/job infrastructure is complete and a no-op, and a vendor adapter
 * drops into this seam without touching any consumer.
 *
 * The fixture adapter (providers/fixture.ts) is the injectable test/dry-run
 * provider; production wires a real adapter here once it clears licensing.
 */

import type { PriceProviderAdapter, PriceRegistry } from "./types";

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
 * The production registry. EMPTY by design until a vendor is selected AND its
 * storage/redistribution licensing is verified (A8-3B, externally blocked). An
 * empty registry makes fetchInstrumentWindow return `source: null` and the
 * backfill/daily job a clean no-op — historical coverage stays whatever A8-2
 * same-day capture has accrued, never fabricated. Adding a vendor is a one-line
 * change here plus the adapter file; no consumer changes.
 */
export function defaultPriceRegistry(): PriceRegistry {
  // Intentionally no adapters — see the module header and A8-3B stop-gate.
  return createPriceRegistry([]);
}
