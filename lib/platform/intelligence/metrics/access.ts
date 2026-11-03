/**
 * lib/platform/intelligence/metrics/access.ts  (Platform Intelligence — the metric-definition accessor)
 *
 * READ-ONLY, DEFINITIONS ONLY. `describeMetric` and `listMetrics` return
 * registry entries (./registry.ts) — never a value, never a query. Values come
 * later through the Phase 3 retrieval contracts, via the permissioned readers
 * each definition already names.
 *
 * PERMISSION-FILTERED, mirroring the incident audience-token idiom
 * (lib/platform/incidents/intelligence/audience.ts):
 *   - an accessor never takes an area STRING; it takes a MetricAccessToken,
 *     which exists only if this module minted it from the caller's EXISTING
 *     guard result (`requirePlatformAccess` / `requireFreshPlatformAccess`);
 *   - the type is branded with a `unique symbol`, and every minted token is
 *     registered in a module-private WeakSet, so a hand-built or cast token is
 *     refused at runtime (FAILS CLOSED: nothing is listed).
 *
 * MINTING — metricAccessFor(auth)
 *   a grant { area, level }              → that one area at that level
 *   SYSTEM_ADMIN break-glass (grant null) → every area (decidePlatformAccess
 *                                           allows a SYSTEM_ADMIN unconditionally)
 *   anything else                         → null (no metric definitions)
 *
 * A metric is visible when the token satisfies ANY of its permission entries
 * (lib/platform/policy.ts hasPlatformAccess: same area, level rank ≥ needed).
 * Only the entries the caller satisfies are returned, so the identity tier a
 * caller sees is the one its own grant carries. An invisible metric is
 * indistinguishable from an unknown one (no existence oracle).
 *
 * Pure (no I/O). Mint and use a token within one request; never cache or
 * serialise it.
 */

import { UserRole, type PlatformAccessLevel, type PlatformArea } from "@prisma/client";
import type { PlatformAuth } from "@/lib/platform/authorize";
import { ALL_PLATFORM_AREAS, hasPlatformAccess } from "@/lib/platform/policy";
import { METRICS, metricKey, type MetricDefinition, type MetricDomain } from "./registry";

declare const METRIC_ACCESS_BRAND: unique symbol;

/** Unforgeable: only this module can produce a value of this type. */
export interface MetricAccessToken {
  readonly __brand: typeof METRIC_ACCESS_BRAND;
  readonly grants: readonly { area: PlatformArea; level: PlatformAccessLevel }[];
}

// Named ISSUED / issue, not MINTED / mint: lib/platform/incidents/intelligence/audience.test.ts
// pins that INCIDENT audience tokens are minted in exactly one module, by those names.
const ISSUED = new WeakSet<object>();

function issue(grants: MetricAccessToken["grants"]): MetricAccessToken {
  const token = Object.freeze({ grants: Object.freeze(grants.map((g) => Object.freeze({ ...g }))) }) as unknown as MetricAccessToken;
  ISSUED.add(token);
  return token;
}

/** Only the parts of a guard result the scope depends on. */
export type MetricAccessAuth = { user: Pick<PlatformAuth["user"], "role">; grant: PlatformAuth["grant"] };

/** The scope the route's EXISTING guard result entitles — never more. */
export function metricAccessFor(auth: MetricAccessAuth): MetricAccessToken | null {
  if (auth.grant === null) {
    // Break-glass: authorize.ts returns grant:null ONLY for an allowed SYSTEM_ADMIN.
    return auth.user.role === UserRole.SYSTEM_ADMIN
      ? issue(ALL_PLATFORM_AREAS.map((area) => ({ area, level: "CONTROL" as PlatformAccessLevel })))
      : null;
  }
  return issue([{ area: auth.grant.area, level: auth.grant.level }]);
}

/** True only for a token this module minted. */
export function isMetricAccessToken(t: unknown): t is MetricAccessToken {
  return typeof t === "object" && t !== null && ISSUED.has(t);
}

/** The definition as this caller may see it: only the permission entries its grant satisfies, or null. */
function visible(token: MetricAccessToken, m: MetricDefinition): MetricDefinition | null {
  const grants = token.grants.map((g) => ({ ...g, status: "ACTIVE" as const }));
  const permission = m.permission.filter((p) => hasPlatformAccess(p.area, p.level, grants));
  return permission.length > 0 ? { ...m, permission } : null;
}

export interface ListMetricsFilter {
  domain?: MetricDomain;
  /** Narrow to metrics readable under this area (still bounded by the token). */
  area?: PlatformArea;
}

/** Definitions visible to the caller, in registry order. A forged token lists nothing. */
export function listMetrics(token: MetricAccessToken, filter: ListMetricsFilter = {}): MetricDefinition[] {
  if (!isMetricAccessToken(token)) return [];
  const out: MetricDefinition[] = [];
  for (const m of METRICS) {
    if (filter.domain && m.domain !== filter.domain) continue;
    const v = visible(token, m);
    if (!v) continue;
    if (filter.area) {
      const inArea = v.permission.filter((p) => p.area === filter.area);
      if (inArea.length === 0) continue;
      out.push({ ...v, permission: inArea });
    } else out.push(v);
  }
  return out;
}

/**
 * One definition by "id@version", or by bare "id" (the highest registered
 * version). null when unknown OR not visible to the caller (no oracle).
 */
export function describeMetric(token: MetricAccessToken, id: string): MetricDefinition | null {
  if (!isMetricAccessToken(token)) return null;
  const at = id.indexOf("@");
  const candidates = at >= 0
    ? METRICS.filter((m) => metricKey(m) === id)
    : METRICS.filter((m) => m.id === id).sort((a, b) => b.version - a.version).slice(0, 1);
  const m = candidates[0];
  return m ? visible(token, m) : null;
}
