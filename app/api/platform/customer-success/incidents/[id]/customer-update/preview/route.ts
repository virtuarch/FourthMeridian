/**
 * POST /api/platform/customer-success/incidents/[id]/customer-update/preview  (Incident customer update, PR-C1)
 *
 * Body: { paragraph }. Lints the paragraph (S2 ruling 09gg (c)) and, when it
 * passes, renders the FULL message exactly as the customer would receive it —
 * the fixed template around the paragraph — with the paragraph's hash. NEVER
 * sends, never audits an approval, never writes a notification.
 *
 *   200  { message: { title, body, href }, lint, paragraphHash, edited, sendEnabled }
 *   400  VALIDATION · 403 · 404 NOT_FOUND · 422 LINT_FAILED { lint } (codes only)
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE") — the
 * composer step of an approval; the per-operator mutation limiter; refusals are
 * recorded (recordControlRefusal, codes only).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { getRequestMeta } from "@/lib/api";
import { customerUpdatePreview } from "@/lib/platform/incidents/customer-update/service";
import { productionCustomerUpdateDeps } from "@/lib/platform/incidents/customer-update/deps";
import { customerUpdateMutationResponse } from "@/lib/platform/incidents/customer-update/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const limited = await limitPlatformMutation(auth.user.id, "cs-incident-customer-update-preview");
  if (limited) return limited;
  const token = incidentAudienceFor(auth);
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Not authorized to message customers about incidents." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const { id } = await ctx.params;
  const meta = getRequestMeta(req);
  const result = await customerUpdatePreview(token, id, await req.json().catch(() => null), productionCustomerUpdateDeps);
  return customerUpdateMutationResponse(result, auth, "preview", id, { ipAddress: meta.ip, userAgent: meta.userAgent });
}
