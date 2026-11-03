/**
 * lib/platform/intelligence/metrics/retrieve.ts  (Platform Intelligence — Phase 3 retrieval contracts, slice 1)
 *
 * `retrieveMetric(surface, ctx, id, params)` — one registered metric's value
 * as an identity-free envelope, read through the SAME reader its Platform tile
 * reads. The contract, tiering and projections live in ./retrieve-core.ts (its
 * header is the design); this file only binds each reader key to the real
 * function the registry's first `path` hop calls (pinned by retrieve.test.ts:
 * key → READER_SYMBOL → registry path → this source).
 *
 * Read-only, no caching, no writes. No route uses it in this slice. A future
 * route is GET + `Cache-Control: no-store`, guarded by the metric's own
 * `requirePlatformAccess(area, level)` for the surface, and passes the surface
 * as a string literal; an AI / chat caller uses this same function — no bypass.
 */

import "server-only";
import { getProviderHealth } from "@/lib/platform/provider-health";
import { loadAiBudgetUtilization } from "@/lib/platform/ai/ai-budget";
import { getAcquisition } from "@/lib/platform/growth/acquisition";
import { getProductAnalytics } from "@/lib/platform/growth/product-analytics";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import { getMerchantOverview } from "@/lib/platform/merchant/overview";
import { getCsOverview } from "@/lib/platform/customer/overview";
import {
  retrieveWith,
  type MetricEnvelope, type MetricSurface, type RetrievalContext, type RetrievalParams, type RetrievalReaders,
} from "./retrieve-core";

export type { MetricEnvelope, MetricSurface, RetrievalContext, RetrievalParams } from "./retrieve-core";

/** The real readers — each exactly the call its route makes (the windowed overviews at their route default, 30). */
const READERS: RetrievalReaders = {
  providerHealth: () => getProviderHealth(),
  aiBudget: () => loadAiBudgetUtilization(),
  acquisition: (windowDays) => getAcquisition(windowDays),
  productAnalytics: () => getProductAnalytics(),
  incidentSearch: (token, query, opts) => incidentAccessors.search(token, query, opts),
  merchantOverview: () => getMerchantOverview(30),
  csOverview: (token) => getCsOverview(30, token),
};

/**
 * `surface` MUST be a string literal at the call site (pinned): the Platform
 * area whose page shows the value, never a request parameter.
 */
export function retrieveMetric(surface: MetricSurface, ctx: RetrievalContext, id: string, params: RetrievalParams = {}): Promise<MetricEnvelope | null> {
  return retrieveWith(surface, READERS, ctx, id, params);
}
