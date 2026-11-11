/**
 * GET /api/platform/customer-success/incidents/[id]/customer-update  (Incident customer update, PR-C1)
 *
 * The drawer's read model for an operator-approved customer update (owner yes;
 * S2 ruling 09gg (c)): the fixed template, the DETERMINISTIC draft paragraph for
 * the incident's remedy class (no AI) with its hash, the draft's lint result,
 * the dedupe state (an update already sent for this episode? a reconnect-request
 * notice in the last 24 h, with its outcome and time), `blockedBy`, and
 * `sendEnabled` — false while INCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED is not
 * "true", so the drawer hides the send control.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"); the incident
 * is read through the intelligence module with the token minted from THIS guard
 * result. Rate-limited per operator. Never the customer id beyond what the CS
 * incident detail already shows (`recipient.attributed` is a boolean).
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { limitByUser } from "@/lib/rate-limit";
import { customerUpdateReadModel } from "@/lib/platform/incidents/customer-update/service";
import { productionCustomerUpdateDeps } from "@/lib/platform/incidents/customer-update/deps";
import { customerUpdateJson } from "@/lib/platform/incidents/customer-update/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const limited = await limitByUser(auth.user.id, "cs-incident-customer-update-read", { limit: 60, windowSec: 60 });
  if (limited) return limited;
  const token = incidentAudienceFor(auth);
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const { id } = await ctx.params;
  return customerUpdateJson(await customerUpdateReadModel(token, id, productionCustomerUpdateDeps));
}
