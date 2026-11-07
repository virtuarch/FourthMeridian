/**
 * POST /api/platform/platform-ops/incidents/[id]/resolve  (PB-1 S6 — manual OPERATOR_RESOLVED)
 *
 * Body: { resolutionReasonCode, reason: { code, note } } — BOTH required:
 *   resolutionReasonCode  one of OPERATOR_RESOLUTION_REASON_CODES (codes.ts) — stored on the row
 *   reason.code / .note   the audit envelope's reason; the note is REQUIRED here,
 *                         ≤ 280 chars, scrubbed, and lives only in the AuditLog row
 *
 *   200  { ok: true, changed: true, fromState, toState: "RESOLVED" }
 *   400  { error }                         malformed body / reason / note / code
 *   403  { error }                         no incident tier
 *   404  { error, code: NOT_FOUND }
 *   409  { error, code, state? }           not offered for this state · ALREADY_RESOLVED · CONFLICT
 *
 * REOPEN BEHAVIOUR: if the subject is still failing, the NEXT failure opens a
 * new episode linked by previousIncidentId (shown as REOPENED). This row is
 * never reopened (B9-rollback constraint (b)).
 *
 * AUTHORIZATION / AUDIT: as acknowledge — fresh PLATFORM_OPS WRITE, the #352
 * limiter, token-first through the module (Ops tier), and ONE transaction in
 * lifecycle.ts applyOperatorTransition (CAS, typed OPERATOR_RESOLVED_V1
 * evidence, operator STATE_CHANGED event, SYNC_INCIDENT_RESOLVED audit).
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
  const limited = await limitPlatformMutation(auth.user.id, "incident-resolve");
  if (limited) return limited;
  const { id } = await ctx.params;
  return runIncidentOperatorAction({
    action: "resolve", incidentId: id, body: await req.json().catch(() => null),
    token: atOpsTier(incidentAudienceFor(auth)),
    actor: operatorActorFrom(auth, "PLATFORM_OPS"),
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
}
