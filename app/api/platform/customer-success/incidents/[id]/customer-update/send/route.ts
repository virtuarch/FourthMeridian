/**
 * POST /api/platform/customer-success/incidents/[id]/customer-update/send  (Incident customer update, PR-C1)
 *
 * Approve and send ONE operator-approved customer update for an incident (owner
 * yes; S2 ruling 09gg (c)). Body: { paragraph, reason: { code, note? },
 * expectedDraftHash? } — nothing else; the recipient is the incident's own
 * attributed subject, resolved server-side, never taken from the client.
 *
 * ORDER (lib/platform/incidents/customer-update/service.ts customerUpdateSend):
 * flag ⇒ body ⇒ incident ⇒ lint ⇒ dedupe ⇒ audit INCIDENT_CUSTOMER_UPDATE_APPROVED
 * (reason required, BEFORE the send) ⇒ createNotification(INCIDENT_CUSTOMER_UPDATE),
 * in-app only, its ledger rows carrying the incident id.
 *
 *   200  { ok, outcome: "sent" | "not_delivered_preference", approvalRecorded, sent }
 *   404  NOT_AVAILABLE — INCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED is not "true" (nothing is read or created)
 *   400  VALIDATION · 403 · 404 NOT_FOUND · 422 LINT_FAILED
 *   409  NOT_ELIGIBLE · NO_RECIPIENT · DRAFT_CHANGED · ALREADY_SENT · REAUTH_NOTICE_RECENT { reauthNotice }
 *   500  AUDIT_FAILED / read failure (nothing sent) · 502 SEND_FAILED (approval recorded, nothing sent)
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE") — READ
 * and Platform Ops are refused by the guard; the incident token must be the CS
 * tier. Per-operator mutation limiter. Every refusal after the guard is recorded
 * (recordControlRefusal, codes only — never the paragraph or the note).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getRequestMeta } from "@/lib/api";
import { customerUpdateSend } from "@/lib/platform/incidents/customer-update/service";
import { productionCustomerUpdateDeps } from "@/lib/platform/incidents/customer-update/deps";
import { customerUpdateMutationResponse } from "@/lib/platform/incidents/customer-update/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const limited = await limitPlatformMutation(auth.user.id, "cs-incident-customer-update-send");
  if (limited) return limited;
  const token = incidentAudienceFor(auth);
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Not authorized to message customers about incidents." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const { id } = await ctx.params;
  const meta = getRequestMeta(req);
  const result = await customerUpdateSend(token, id, await req.json().catch(() => null), {
    actor: operatorActorFrom(auth, "CUSTOMER_SUCCESS"), ipAddress: meta.ip, userAgent: meta.userAgent,
  }, productionCustomerUpdateDeps);
  return customerUpdateMutationResponse(result, auth, "send", id, { ipAddress: meta.ip, userAgent: meta.userAgent });
}
