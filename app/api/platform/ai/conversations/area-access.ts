/**
 * app/api/platform/ai/conversations/area-access.ts  (§3.1 step 6 — the conversation's OWN area, FRESH)
 *
 * Not a route (no route.ts). Every read, replay and delete re-checks a FRESH
 * grant for the area the conversation was created under (the LIST does not — it
 * filters by one directory read, so it never records a per-area refusal; see
 * handleListConversations):
 * requireFreshPlatformAccess(area, "READ") — the grant, operator 2FA when
 * enforced, the live session-revocation re-check — for THIS operator. ANY
 * refusal (no grant, revoked, insufficient, 2FA, a different session user,
 * break-glass with no grant) returns null, which the handlers turn into the
 * SAME 404 as not-found. No break-glass: a null grant is a refusal here.
 *
 * The tokens are minted from THIS function's own guard result (the metric
 * registry's guard-provenance pin), and every retrieveMetric /
 * listNavigationTargets / resolveNavigationTarget call passes a STRING-LITERAL
 * surface (the metric and navigation registries' pins) — the surface is never
 * taken from the request or the row without the guard.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import { describeMetric, listMetrics, metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { retrieveMetric, type RetrievalContext } from "@/lib/platform/intelligence/metrics/retrieve";
import { listNavigationTargets, resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import type { AreaAccess } from "@/lib/platform/intelligence/ai/conversations/handlers";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { composePlatformAiBindings, platformAiAreasFor, type PlatformAiAreaBinding, type PlatformAiBinding } from "@/lib/platform/intelligence/ai/core";

/**
 * B11 turn integration: the access for the conversation's area from THIS function's own
 * guard result — link re-resolution AND the turn's binding (v0's bindingFor shape: every
 * accessor call takes a STRING-LITERAL surface per case; tokens minted here from each
 * guard result, never taken from the request or the row).
 */
export async function conversationAreaAccess(area: PlatformArea, operatorId: string): Promise<AreaAccess | null> {
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err || !auth.grant || auth.grant.area !== area || auth.user.id !== operatorId) return null;
  const t = metricAccessFor(auth);
  if (!t) return null;
  const own = bindingFor(auth.grant.area, { metricToken: t, incidentToken: incidentAudienceFor(auth) });
  if (!own) return null;
  // MULTI-AREA (owner 2026-11-08): the conversation's own area GATES (above, unchanged); every
  // OTHER area the operator currently holds is added only behind ITS OWN fresh guard, tokens
  // minted from that guard result — a revoked / refused area is skipped. Links re-resolve
  // through the composed binding (each page id through its own area).
  const parts: PlatformAiAreaBinding[] = [{ area, binding: own }];
  for (const other of platformAiAreasFor(await loadPlatformDirectory(operatorId))) {
    if (other === area) continue;
    const [otherAuth, otherErr] = await requireFreshPlatformAccess(other, "READ");
    if (otherErr || !otherAuth.grant || otherAuth.grant.area !== other || otherAuth.user.id !== operatorId) continue;
    const otherToken = metricAccessFor(otherAuth);
    const b = otherToken ? bindingFor(otherAuth.grant.area, { metricToken: otherToken, incidentToken: incidentAudienceFor(otherAuth) }) : null;
    if (b) parts.push({ area: other, binding: b });
  }
  const binding = composePlatformAiBindings(parts);
  if (!binding) return null;
  return { resolvePage: (id, p) => binding.resolvePage(id, p), binding };
}

/** ONE area's binding from a context its caller minted from that area's own guard result — a literal surface per case. */
function bindingFor(area: PlatformArea, ctx: RetrievalContext): PlatformAiBinding | null {
  const t = ctx.metricToken;
  const common = (label: string) => ({ surfaceLabel: label, describeMetric: (id: string) => describeMetric(t, id) });
  switch (area) {
    case "PLATFORM_OPS": return { ...common(PLATFORM_AREAS.PLATFORM_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "PLATFORM_OPS" }),
      readMetric: (id, p) => retrieveMetric("PLATFORM_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("PLATFORM_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("PLATFORM_OPS", t, id, p) };
    case "SECURITY_OPS": return { ...common(PLATFORM_AREAS.SECURITY_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "SECURITY_OPS" }),
      readMetric: (id, p) => retrieveMetric("SECURITY_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("SECURITY_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("SECURITY_OPS", t, id, p) };
    case "GROWTH_REVENUE": return { ...common(PLATFORM_AREAS.GROWTH_REVENUE.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "GROWTH_REVENUE" }),
      readMetric: (id, p) => retrieveMetric("GROWTH_REVENUE", ctx, id, p),
      listPages: (f) => listNavigationTargets("GROWTH_REVENUE", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("GROWTH_REVENUE", t, id, p) };
    case "CUSTOMER_SUCCESS": return { ...common(PLATFORM_AREAS.CUSTOMER_SUCCESS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "CUSTOMER_SUCCESS" }),
      readMetric: (id, p) => retrieveMetric("CUSTOMER_SUCCESS", ctx, id, p),
      listPages: (f) => listNavigationTargets("CUSTOMER_SUCCESS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("CUSTOMER_SUCCESS", t, id, p) };
    case "MERCHANT_OPS": return { ...common(PLATFORM_AREAS.MERCHANT_OPS.label),
      listMetrics: (f) => listMetrics(t, { ...f, area: "MERCHANT_OPS" }),
      readMetric: (id, p) => retrieveMetric("MERCHANT_OPS", ctx, id, p),
      listPages: (f) => listNavigationTargets("MERCHANT_OPS", t, f),
      resolvePage: (id, p) => resolveNavigationTarget("MERCHANT_OPS", t, id, p) };
    default: return null;
  }
}
