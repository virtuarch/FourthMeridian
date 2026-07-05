/**
 * lib/fx/registry.ts
 *
 * MC1 Phase 1 Slice 2 — ordered provider registry. Order = failover priority
 * (plan D2): fetch walks adapters first→last and stores the first COMPLETE
 * batch. Pure module: contains no real adapters (Slice 3 adds
 * openexchangerates then frankfurter); tests inject fakes via createFxRegistry.
 */

import type { FxProviderAdapter, FxRegistry } from "./types";

/**
 * Build a registry from an ordered adapter list (dependency-injection seam —
 * plan §3.1/§4). Duplicate `source` identifiers are a programmer error: the
 * archive stamps provenance by source, so two adapters must never share one.
 */
export function createFxRegistry(adapters: readonly FxProviderAdapter[]): FxRegistry {
  const seen = new Set<string>();
  for (const a of adapters) {
    if (seen.has(a.source)) {
      throw new Error(`[fx] duplicate adapter source in registry: "${a.source}"`);
    }
    seen.add(a.source);
  }
  return { adapters: Object.freeze([...adapters]) };
}

/**
 * The production registry. EMPTY in Slice 2 by design — Phase 1 Slice 3
 * populates it with [openexchangerates, frankfurter] in that priority order
 * (plan D1/D2). Nothing calls this yet; it exists so Slice 3 adds adapters
 * without reshaping any consumer.
 */
export function defaultFxRegistry(): FxRegistry {
  return createFxRegistry([]);
}
