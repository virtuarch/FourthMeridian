/**
 * lib/fx/registry.ts
 *
 * MC1 Phase 1 Slice 2 — ordered provider registry. Order = failover priority
 * (plan D2): fetch walks adapters first→last and stores the first COMPLETE
 * batch. Pure module: contains no real adapters (Slice 3 adds
 * openexchangerates then frankfurter); tests inject fakes via createFxRegistry.
 */

import type { FxProviderAdapter, FxRegistry } from "./types";
import { createOpenExchangeRatesAdapter } from "./providers/openExchangeRates";
import { createFrankfurterAdapter } from "./providers/frankfurter";

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
 * The production registry (Slice 3): [openexchangerates, frankfurter] in
 * approved priority order (plan D1/D2). Open Exchange Rates requires
 * OXR_APP_ID — when the key is absent the adapter is omitted and coverage
 * degrades to Frankfurter's ECB subset (no SAR/AED), which is the approved
 * safe-disable posture (plan §5). Env is read here, at construction, so
 * adapters themselves stay injectable and key-agnostic.
 */
export function defaultFxRegistry(): FxRegistry {
  const appId = process.env.OXR_APP_ID;
  const adapters: FxProviderAdapter[] = [];
  if (appId) {
    adapters.push(createOpenExchangeRatesAdapter(appId));
  } else {
    console.warn(
      "[fx] OXR_APP_ID not set — primary provider (Open Exchange Rates) disabled; " +
      "Frankfurter-only coverage (ECB subset: no SAR/AED).",
    );
  }
  adapters.push(createFrankfurterAdapter());
  return createFxRegistry(adapters);
}
