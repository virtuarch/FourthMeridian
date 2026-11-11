/**
 * GET /api/platform/customer-success/incidents/[id]/deliveries  (Incident customer update, PR-C1)
 *
 * The delivery-ledger rows of this incident's customer update(s): channel,
 * status, reason / error CODE, attempt, mode and times — codes and status only,
 * never a recipient, title, body or provider text — plus whether an update for
 * this episode was sent. Read from CommsDelivery by the incident's own subject
 * and window first (the existing recipient index), then by incidentId.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"); the incident
 * is read through the intelligence module with the token minted from THIS guard
 * result. Rate-limited per operator.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { limitByUser } from "@/lib/rate-limit";
import { incidentDeliveries } from "@/lib/platform/incidents/customer-update/service";
import { productionCustomerUpdateDeps } from "@/lib/platform/incidents/customer-update/deps";
import { customerUpdateJson } from "@/lib/platform/incidents/customer-update/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const limited = await limitByUser(auth.user.id, "cs-incident-deliveries-read", { limit: 60, windowSec: 60 });
  if (limited) return limited;
  const token = incidentAudienceFor(auth);
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const { id } = await ctx.params;
  return customerUpdateJson(await incidentDeliveries(token, id, productionCustomerUpdateDeps));
}
