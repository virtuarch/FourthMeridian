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
import { requireFreshPlatformAccess, type PlatformAuth } from "@/lib/platform/authorize";
import { buildMemoryReaders } from "@/lib/platform/intelligence/ai/memory/readers.server";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import { describeMetric, listMetrics, metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { retrieveMetric, type RetrievalContext } from "@/lib/platform/intelligence/metrics/retrieve";
import { listNavigationTargets, resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import type { AreaAccess } from "@/lib/platform/intelligence/ai/conversations/handlers";

/**
 * B11 turn integration: the access for ONE area from THIS function's own guard
 * result — link re-resolution AND the turn's binding (v0's bindingFor shape:
 * every accessor call takes a STRING-LITERAL surface per case; tokens minted here
 * from `auth`, never taken from the request or the row).
 */
// TODO(B1(a) provenance areasRead before multi-area conversations): conversations stay SINGLE-AREA
// (S2 #483 B1 option (b), interim). Only the stateless v0 ask route composes every held area
// (composePlatformAiBindings). A stored turn must first record which areas it read (areasRead
// provenance) before a conversation may bind more than its own area.
export async function conversationAreaAccess(area: PlatformArea, operatorId: string): Promise<AreaAccess | null> {
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err || !auth.grant || auth.grant.area !== area || auth.user.id !== operatorId) return null;
  // The incident token is minted HERE, from the guard result destructured above (audience.test.ts provenance pin).
  const incidentToken = incidentAudienceFor(auth);
  const bound = bindArea(auth, incidentToken);
  if (!bound) return null;
  // Platform AI memory (design v2 §2): the authorized readers come from THIS fresh guard result.
  return { ...bound, area, memoryReaders: buildMemoryReaders(incidentToken, area, bound.binding) };
}

function bindArea(auth: PlatformAuth, incidentToken: ReturnType<typeof incidentAudienceFor>): Pick<AreaAccess, "resolvePage" | "binding"> | null {
  if (!auth.grant) return null;
  const t = metricAccessFor(auth);
  if (!t) return null;
  const ctx: RetrievalContext = { metricToken: t, incidentToken };
  const common = (label: string) => ({ surfaceLabel: label, describeMetric: (id: string) => describeMetric(t, id) });
  switch (auth.grant.area) {
    case "PLATFORM_OPS": {
      const resolvePage = (id: string, p?: Readonly<Record<string, string>>) => resolveNavigationTarget("PLATFORM_OPS", t, id, p);
      return { resolvePage, binding: { ...common(PLATFORM_AREAS.PLATFORM_OPS.label),
        listMetrics: (f) => listMetrics(t, { ...f, area: "PLATFORM_OPS" }),
        readMetric: (id, p) => retrieveMetric("PLATFORM_OPS", ctx, id, p),
        listPages: (f) => listNavigationTargets("PLATFORM_OPS", t, f), resolvePage } };
    }
    case "SECURITY_OPS": {
      const resolvePage = (id: string, p?: Readonly<Record<string, string>>) => resolveNavigationTarget("SECURITY_OPS", t, id, p);
      return { resolvePage, binding: { ...common(PLATFORM_AREAS.SECURITY_OPS.label),
        listMetrics: (f) => listMetrics(t, { ...f, area: "SECURITY_OPS" }),
        readMetric: (id, p) => retrieveMetric("SECURITY_OPS", ctx, id, p),
        listPages: (f) => listNavigationTargets("SECURITY_OPS", t, f), resolvePage } };
    }
    case "GROWTH_REVENUE": {
      const resolvePage = (id: string, p?: Readonly<Record<string, string>>) => resolveNavigationTarget("GROWTH_REVENUE", t, id, p);
      return { resolvePage, binding: { ...common(PLATFORM_AREAS.GROWTH_REVENUE.label),
        listMetrics: (f) => listMetrics(t, { ...f, area: "GROWTH_REVENUE" }),
        readMetric: (id, p) => retrieveMetric("GROWTH_REVENUE", ctx, id, p),
        listPages: (f) => listNavigationTargets("GROWTH_REVENUE", t, f), resolvePage } };
    }
    case "CUSTOMER_SUCCESS": {
      const resolvePage = (id: string, p?: Readonly<Record<string, string>>) => resolveNavigationTarget("CUSTOMER_SUCCESS", t, id, p);
      return { resolvePage, binding: { ...common(PLATFORM_AREAS.CUSTOMER_SUCCESS.label),
        listMetrics: (f) => listMetrics(t, { ...f, area: "CUSTOMER_SUCCESS" }),
        readMetric: (id, p) => retrieveMetric("CUSTOMER_SUCCESS", ctx, id, p),
        listPages: (f) => listNavigationTargets("CUSTOMER_SUCCESS", t, f), resolvePage } };
    }
    case "MERCHANT_OPS": {
      const resolvePage = (id: string, p?: Readonly<Record<string, string>>) => resolveNavigationTarget("MERCHANT_OPS", t, id, p);
      return { resolvePage, binding: { ...common(PLATFORM_AREAS.MERCHANT_OPS.label),
        listMetrics: (f) => listMetrics(t, { ...f, area: "MERCHANT_OPS" }),
        readMetric: (id, p) => retrieveMetric("MERCHANT_OPS", ctx, id, p),
        listPages: (f) => listNavigationTargets("MERCHANT_OPS", t, f), resolvePage } };
    }
    default: return null;
  }
}
