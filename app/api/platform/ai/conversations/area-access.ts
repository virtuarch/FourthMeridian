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
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { buildMemoryReaders } from "@/lib/platform/intelligence/ai/memory/readers.server";
import { metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { bindArea, scopeFromGuard } from "@/lib/platform/intelligence/ai/authz/scope";
import type { AreaAccess } from "@/lib/platform/intelligence/ai/conversations/handlers";
import { platformAiRenderRecheck } from "@/lib/platform/intelligence/ai/authz/record-render.server";
import { recordTextRenderer } from "@/lib/platform/intelligence/ai/authz/record-render";

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
    renderRecords: recordTextRenderer({ operatorId, mode: "history", recheck: platformAiRenderRecheck }),
  };
}
