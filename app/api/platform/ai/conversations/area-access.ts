/**
 * app/api/platform/ai/conversations/area-access.ts  (§3.1 step 6 — the conversation's OWN area, FRESH)
 *
 * Not a route (no route.ts). Every list, read, replay and delete re-checks a
 * FRESH grant for the area the conversation was created under:
 * requireFreshPlatformAccess(area, "READ") — the grant, operator 2FA when
 * enforced, the live session-revocation re-check — for THIS operator. ANY
 * refusal (no grant, revoked, insufficient, 2FA, a different session user,
 * break-glass with no grant) returns null, which the handlers turn into the
 * SAME 404 as not-found. No break-glass: a null grant is a refusal here.
 *
 * The token is minted from THIS function's own guard result (the metric
 * registry's guard-provenance pin), and every resolveNavigationTarget call
 * passes a STRING-LITERAL surface (the navigation registry's pin) — the
 * surface is never taken from the request or the row without the guard.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";
import type { AreaAccess } from "@/lib/platform/intelligence/ai/conversations/handlers";

export async function conversationAreaAccess(area: PlatformArea, operatorId: string): Promise<AreaAccess | null> {
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err || !auth.grant || auth.grant.area !== area || auth.user.id !== operatorId) return null;
  const t = metricAccessFor(auth);
  if (!t) return null;
  switch (auth.grant.area) {
    case "PLATFORM_OPS": return { resolvePage: (id, p) => resolveNavigationTarget("PLATFORM_OPS", t, id, p) };
    case "SECURITY_OPS": return { resolvePage: (id, p) => resolveNavigationTarget("SECURITY_OPS", t, id, p) };
    case "GROWTH_REVENUE": return { resolvePage: (id, p) => resolveNavigationTarget("GROWTH_REVENUE", t, id, p) };
    case "CUSTOMER_SUCCESS": return { resolvePage: (id, p) => resolveNavigationTarget("CUSTOMER_SUCCESS", t, id, p) };
    case "MERCHANT_OPS": return { resolvePage: (id, p) => resolveNavigationTarget("MERCHANT_OPS", t, id, p) };
    default: return null;
  }
}
