/**
 * POST /api/platform/growth-revenue/requests/[id]/preserve-evidence  (owner P2-1 · §7)
 *
 * Preserve the earliest verified suspicious application as sealed evidence,
 * separately from the 180-day waitlist (lib/platform/growth/beta-abuse-evidence.ts).
 * The request must be DENIED with a latest verdict of SUSPICIOUS; one evidence
 * row per request. Audited BETA_ABUSE_EVIDENCE_PRESERVED { evidenceId,
 * sourceRequestId, retainUntil } — never the payload.
 *
 *   Body: { reason: { code, note? }, retainUntil: ISO (≤ 3 years), note? }
 *
 * AUTHORIZATION: requireFreshSystemAdmin() — evidence is SYSTEM_ADMIN-only
 * (no platform grant reaches it). Rate limited.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshSystemAdmin } from "@/lib/session";
import { getClientIp } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { OperatorActionValidationError } from "@/lib/audit";
import { parseRequiredReason } from "@/lib/platform/growth/invitation-http";
import { captureAbuseEvidence } from "@/lib/platform/growth/beta-abuse-evidence";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [user, err] = await requireFreshSystemAdmin();
  if (err) return err;
  const limited = await limitByUser(user.id, "abuse-evidence-write", { limit: 10, windowSec: 60 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const reason = parseRequiredReason(body?.reason);
  if (!reason.ok) return reason.response;
  if (body?.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return NextResponse.json({ error: "Note must be a string." }, { status: 400, headers: NO_STORE });
  }
  const { id } = await ctx.params;

  try {
    const r = await captureAbuseEvidence({
      requestId: id, reason: reason.reason, retainUntil: body?.retainUntil,
      note: typeof body?.note === "string" ? body.note : null,
      actor: { userId: user.id, via: "SYSTEM_ADMIN", area: "SECURITY_OPS" },
      ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
    });
    if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status, headers: NO_STORE });
    return NextResponse.json({ success: true, evidence: r.evidence }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof OperatorActionValidationError) return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE });
    throw e;
  }
}
