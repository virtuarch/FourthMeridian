/**
 * lib/platform/intelligence/ai/authz/scope.ts  (Platform AI P1b — THE scope + area binder, I-7)
 *
 * The ONE place a Platform AI turn's scope is decided and an area is bound. Both
 * callers use it: the stateless ask route (app/api/platform/ai/ask/route.ts — its
 * primary area and every other held area) and the conversations' step-6 area guard
 * (app/api/platform/ai/conversations/area-access.ts). Before P1b each carried its own
 * copy of the same five-case binder (`bindingFor` / `bindArea`).
 *
 * SCOPE (design §6.1, invariant I-7 — no break-glass, SYSTEM_ADMIN or all-areas scope):
 *   scopeFromGuard(auth, area, operatorId) admits ONLY a fresh guard result with
 *     · a real grant (auth.grant !== null — a break-glass SYSTEM_ADMIN resolves to
 *       grant:null in lib/platform/authorize.ts, so it is never in scope),
 *     · for EXACTLY that area (auth.grant.area === area),
 *     · held by THAT operator (auth.user.id === operatorId),
 *     · and a non-SYSTEM_ADMIN role (belt and braces: the adapter never issues one a grant).
 *   The result is an unforgeable ScopedArea (only this module issues one).
 *
 * BINDING: bindArea(scope, tokens) builds the PlatformAiBinding for a ScopedArea with
 * a STRING-LITERAL surface per case (the metric and navigation literal-surface pins
 * scan this file). It MINTS NOTHING: the caller mints the metric / incident tokens
 * from its OWN guard result (the guard-provenance pins stay on the callers), and the
 * binder refuses any token that is not a real metric token for exactly this one area
 * (an all-areas break-glass token is refused) or an incident token above the area tier.
 *
 * No other module decides a Platform AI area scope; nothing under ai/** reads the
 * SYSTEM_ADMIN kill switch or the break-glass decision (authz/scope.test.ts scans).
 */

import "server-only";

import { UserRole, type PlatformArea } from "@prisma/client";
import type { PlatformAuth } from "@/lib/platform/authorize";
import { ALL_PLATFORM_AREAS, PLATFORM_AREAS } from "@/lib/platform/policy";
import { describeMetric, isMetricAccessToken, listMetrics, type MetricAccessToken } from "@/lib/platform/intelligence/metrics/access";
import { retrieveMetric, type RetrievalContext } from "@/lib/platform/intelligence/metrics/retrieve";
import { listNavigationTargets, resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";
import type { PlatformAiBinding } from "../core";

declare const SCOPED_AREA_BRAND: unique symbol;

/** One area a turn may read, for one operator. Unforgeable: only scopeFromGuard issues one. */
export interface ScopedArea {
  readonly __brand: typeof SCOPED_AREA_BRAND;
  readonly area: PlatformArea;
  readonly operatorId: string;
}

const ISSUED_SCOPES = new WeakSet<object>();

/** True only for a ScopedArea this module issued. */
export function isScopedArea(x: unknown): x is ScopedArea {
  return typeof x === "object" && x !== null && ISSUED_SCOPES.has(x);
}

/** The guard-result shape scope depends on (a PlatformAuth, or the parts of one a test supplies). */
export type ScopeAuth = { user: Pick<PlatformAuth["user"], "id" | "role">; grant: PlatformAuth["grant"] };

/** The I-7 predicate, as a boolean (scopeFromGuard is the same rule returning the scope). */
export function inScope(auth: ScopeAuth | null | undefined, area: PlatformArea, operatorId: string): boolean {
  return !!auth
    && auth.grant !== null && auth.grant !== undefined
    && auth.grant.area === area
    && (ALL_PLATFORM_AREAS as readonly string[]).includes(area)
    && typeof operatorId === "string" && operatorId.length > 0
    && auth.user?.id === operatorId
    && auth.user.role !== UserRole.SYSTEM_ADMIN;
}

/** The scope for `area`, or null — see the header (I-7). */
export function scopeFromGuard(auth: ScopeAuth | null | undefined, area: PlatformArea, operatorId: string): ScopedArea | null {
  if (!inScope(auth, area, operatorId)) return null;
  const s = Object.freeze({ area, operatorId }) as unknown as ScopedArea;
  ISSUED_SCOPES.add(s);
  return s;
}

/**
 * Several guard results (one per held area) → the in-scope areas, registry order,
 * each area at most once. A refused / mismatched result contributes nothing.
 */
export function scopeFromGuards(results: readonly { area: PlatformArea; auth: ScopeAuth | null | undefined }[], operatorId: string): ScopedArea[] {
  const out: ScopedArea[] = [];
  for (const area of ALL_PLATFORM_AREAS) {
    const r = results.find((x) => x.area === area && inScope(x.auth, area, operatorId));
    const s = r ? scopeFromGuard(r.auth, area, operatorId) : null;
    if (s) out.push(s);
  }
  return out;
}

/** The tokens the CALLER minted from its own guard result (this module mints nothing). */
export interface AreaTokens {
  metricToken: MetricAccessToken | null;
  incidentToken: RetrievalContext["incidentToken"];
}

/** A metric token for exactly this one area — never the break-glass all-areas token. */
function tokenForArea(t: MetricAccessToken | null, area: PlatformArea): t is MetricAccessToken {
  return isMetricAccessToken(t) && t.grants.length === 1 && t.grants[0].area === area;
}

/** An incident token no higher than the area's own tier (never the SYSTEM token). */
function incidentTokenOk(t: AreaTokens["incidentToken"]): boolean {
  if (t === null || t === undefined) return true;
  const audience = (t as { audience?: unknown }).audience;
  return audience === "PLATFORM_OPS" || audience === "CUSTOMER_SUCCESS";
}

/** The binding for a ScopedArea: every accessor call takes a STRING-LITERAL surface (pinned). null when refused. */
export function bindArea(scope: ScopedArea, tokens: AreaTokens): PlatformAiBinding | null {
  if (!isScopedArea(scope)) return null;
  const t = tokens.metricToken;
  if (!tokenForArea(t, scope.area) || !incidentTokenOk(tokens.incidentToken)) return null;
  const ctx: RetrievalContext = { metricToken: t, incidentToken: tokens.incidentToken };
  const common = (label: string) => ({
    surfaceLabel: label,
    describeMetric: (id: string) => describeMetric(t, id),
  });
  switch (scope.area) {
    case "PLATFORM_OPS": return {
      ...common(PLATFORM_AREAS.PLATFORM_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "PLATFORM_OPS" }),
      readMetric: (id, p) => retrieveMetric("PLATFORM_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("PLATFORM_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("PLATFORM_OPS", t, id, p),
    };
    case "SECURITY_OPS": return {
      ...common(PLATFORM_AREAS.SECURITY_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "SECURITY_OPS" }),
      readMetric: (id, p) => retrieveMetric("SECURITY_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("SECURITY_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("SECURITY_OPS", t, id, p),
    };
    case "GROWTH_REVENUE": return {
      ...common(PLATFORM_AREAS.GROWTH_REVENUE.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "GROWTH_REVENUE" }),
      readMetric: (id, p) => retrieveMetric("GROWTH_REVENUE", ctx, id, p),
      listPages: (f) => listNavigationTargets("GROWTH_REVENUE", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("GROWTH_REVENUE", t, id, p),
    };
    case "CUSTOMER_SUCCESS": return {
      ...common(PLATFORM_AREAS.CUSTOMER_SUCCESS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "CUSTOMER_SUCCESS" }),
      readMetric: (id, p) => retrieveMetric("CUSTOMER_SUCCESS", ctx, id, p),
      listPages: (f) => listNavigationTargets("CUSTOMER_SUCCESS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("CUSTOMER_SUCCESS", t, id, p),
    };
    case "MERCHANT_OPS": return {
      ...common(PLATFORM_AREAS.MERCHANT_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "MERCHANT_OPS" }),
      readMetric: (id, p) => retrieveMetric("MERCHANT_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("MERCHANT_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("MERCHANT_OPS", t, id, p),
    };
    default: return null;
  }
}
