/**
 * POST /api/platform/platform-ops/incidents/[id]/acknowledge  (PB-1 S6 — operator takes ownership)
 *
 * Body: { reason: { code, note? } } — reason REQUIRED (S2 ruling); the note is
 * ≤ 280 chars and scrubbed (assertOperatorNoteSafe) and lives ONLY in the
 * AuditLog row, never on the incident.
 *
 *   200  { ok: true, changed: true, fromState, toState }   acknowledged
 *   200  { ok: true, changed: false, toState }             already acknowledged — idempotent, nothing written
 *   400  { error }                                         malformed body / reason
 *   403  { error }                                         no incident tier
 *   404  { error, code: NOT_FOUND }
 *   409  { error, code, state? }                           not offered for this state · CONFLICT (moved since read)
 *
 * AUTHORIZATION: fresh (live revocation) PLATFORM_OPS WRITE (S2 ruling), the
 * #352 per-operator mutation limiter, then TOKEN-FIRST through the incident
 * intelligence module: the verdict's `availableActions` (the one rule) decides
 * whether acknowledge is offered, at the identity-free Ops tier. The write is
 * lib/platform/incidents/lifecycle.ts applyOperatorTransition: CAS + the
 * operator event + recordOperatorAction (SYNC_INCIDENT_ACKNOWLEDGED) in ONE
 * transaction. lifecycleState stays NULL (B9-rollback constraint (a)).
 * Customer Success has no such route: CS incident surfaces are read-only.
 */

import { NextRequest } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { incidentAudienceFor, atOpsTier } from "@/lib/platform/incidents/intelligence/audience";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { runIncidentOperatorAction } from "@/lib/platform/incidents/operator-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "WRITE");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const limited = await limitPlatformMutation(auth.user.id, "incident-acknowledge");
  if (limited) return limited;
  const { id } = await ctx.params;
  return runIncidentOperatorAction({
    action: "acknowledge", incidentId: id, body: await req.json().catch(() => null),
    token: atOpsTier(incidentAudienceFor(auth)),
    actor: operatorActorFrom(auth, "PLATFORM_OPS"),
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
}
