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
 * registry's guard-provenance pin); the scope rule and the binder are the ONE
 * shared implementation in lib/platform/intelligence/ai/authz/scope.ts (P1b,
 * also used by the ask route), where every retrieveMetric /
 * listNavigationTargets / resolveNavigationTarget call passes a STRING-LITERAL
 * surface (the metric and navigation registries' pins) — the surface is never
 * taken from the request or the row without the guard.
 *
 * P4b (design v2 §8.3) — multi-area conversation TURNS: `conversationHeldAccess(rows)` widens the
 * conversation's own access (the gate above, unchanged) to every OTHER area in the operator's
 * directory rows, each through `heldAreaAccess` — ITS OWN fresh guard
 * (requireFreshPlatformAccess(area, "READ", { probe: true }), as the ask route guards its other
 * areas: a refusal is left out of the binding, not recorded as an OBS-009 denial), the same scope
 * rule and the same binder, tokens minted from that guard. Composition and the lost-area rule are
 * PURE in lib/platform/intelligence/ai/conversations/multi-area.ts. The directory rows never grant.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { buildMemoryReaders } from "@/lib/platform/intelligence/ai/memory/readers.server";
import { metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { bindArea, scopeFromGuard } from "@/lib/platform/intelligence/ai/authz/scope";
import type { AreaAccess } from "@/lib/platform/intelligence/ai/conversations/handlers";
import { widenConversationAccess } from "@/lib/platform/intelligence/ai/conversations/multi-area";
import { platformAiAreasFor } from "@/lib/platform/intelligence/ai/core";
import { platformAiRenderRecheck } from "@/lib/platform/intelligence/ai/authz/record-render.server";
import { recordTextRenderer } from "@/lib/platform/intelligence/ai/authz/record-render";
import { platformAiRenderAudit } from "@/lib/platform/intelligence/ai/authz/audit";

/**
 * B11 turn integration: the access for ONE area from THIS function's own guard
 * result — link re-resolution AND the turn's binding (v0's bindingFor shape:
 * every accessor call takes a STRING-LITERAL surface per case; tokens minted here
 * from `auth`, never taken from the request or the row).
 */
// P4b: the B1(a) prerequisite holds — every stored turn records the areas it read (areasRead
// provenance, P4 `{k:"a"}` evidence refs; pack-tool areas added by the turn runner), so a TURN may
// bind more than this area (conversationHeldAccess below). This function stays the conversation's
// OWN-area gate (step 6): one fresh guard, refused ⇒ the ONE 404.
export async function conversationAreaAccess(area: PlatformArea, operatorId: string): Promise<AreaAccess | null> {
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err) return null;
  // P1b (I-7): the ONE scope rule (authz/scope.ts) — a real grant (never break-glass) for
  // exactly this area, held by this operator; anything else is the same null ⇒ 404.
  const scope = scopeFromGuard(auth, area, operatorId);
  if (!scope) return null;
  // The tokens are minted HERE, from the guard result destructured above (the metric registry's
  // and audience.test.ts provenance pins); scope.ts binds them with a literal surface per area.
  const incidentToken = incidentAudienceFor(auth);
  const binding = bindArea(scope, { metricToken: metricAccessFor(auth), incidentToken });
  if (!binding) return null;
  // Platform AI memory (design v2 §2): the authorized readers come from THIS fresh guard result.
  // P2: the route-issued scope travels with the binding — the turn boundary rechecks exactly it, per tool call.
  // P4: stored record segments render at READ time for this operator (authz/record-render.ts: a fresh
  // probe check per record area per render, revalidate, T2 only with a fresh CS tier + the audit row).
  return {
    resolvePage: binding.resolvePage, binding, area, scope, memoryReaders: buildMemoryReaders(incidentToken, area, binding),
    // P5: T2 only after the PLATFORM_AI_RECORD_VIEWED row (authz/audit.ts, fail closed ⇒ masked).
    renderRecords: recordTextRenderer({ operatorId, mode: "history", recheck: platformAiRenderRecheck, audit: platformAiRenderAudit() }),
  };
}

/**
 * P4b — ONE other held area for a conversation TURN, from ITS OWN fresh guard (probe: a refused area is
 * simply not bound; the turn boundary's per-call recheck stays non-probe). No memory readers, no
 * renderer: those stay with the conversation's own area. null on any refusal.
 */
async function heldAreaAccess(area: PlatformArea, operatorId: string): Promise<AreaAccess | null> {
  const [held, heldErr] = await requireFreshPlatformAccess(area, "READ", { probe: true });
  if (heldErr) return null;
  const scope = scopeFromGuard(held, area, operatorId);
  if (!scope) return null;
  const binding = bindArea(scope, { metricToken: metricAccessFor(held), incidentToken: incidentAudienceFor(held) });
  if (!binding) return null;
  return { resolvePage: binding.resolvePage, binding, area, scope };
}

/**
 * P4b — the handlers' `heldAccess`: the conversation's own access widened to every other area in
 * THESE directory rows (loadPlatformDirectory, read by the route), each behind its own fresh guard.
 */
export function conversationHeldAccess(rows: readonly { area: string }[]): (own: AreaAccess, operatorId: string) => Promise<AreaAccess> {
  const areas = platformAiAreasFor(rows);
  return (own, operatorId) => widenConversationAccess(own, areas, (a) => heldAreaAccess(a, operatorId));
}
