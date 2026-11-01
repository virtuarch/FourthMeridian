/**
 * /api/platform/security-ops/abuse-evidence/[id]  (owner P2-1 · §7)
 *
 *   GET     open ONE sealed payload. EVERY read is audited
 *           (BETA_ABUSE_EVIDENCE_ACCESSED) before the payload is opened.
 *   DELETE  delete it before its retainUntil. Body: { reason: { code, note? } }
 *           (REQUIRED); audited BETA_ABUSE_EVIDENCE_DELETED.
 * There is no edit verb. Otherwise retention deletes it once retainUntil passes.
 *
 * AUTHORIZATION: requireFreshSystemAdmin() on both verbs. Rate limited.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshSystemAdmin } from "@/lib/session";
import { getClientIp } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { parseRequiredReason } from "@/lib/platform/growth/invitation-http";
import { deleteAbuseEvidence, readAbuseEvidence } from "@/lib/platform/growth/beta-abuse-evidence";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [user, err] = await requireFreshSystemAdmin();
  if (err) return err;
  const limited = await limitByUser(user.id, "abuse-evidence-read", { limit: 30, windowSec: 60 });
  if (limited) return limited;
  const { id } = await ctx.params;
  const r = await readAbuseEvidence({
    id, actor: { userId: user.id, via: "SYSTEM_ADMIN", area: "SECURITY_OPS" },
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status, headers: NO_STORE });
  return NextResponse.json({ evidence: r.evidence, payload: r.payload }, { headers: NO_STORE });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [user, err] = await requireFreshSystemAdmin();
  if (err) return err;
  const limited = await limitByUser(user.id, "abuse-evidence-write", { limit: 10, windowSec: 60 });
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const reason = parseRequiredReason(body?.reason);
  if (!reason.ok) return reason.response;
  const { id } = await ctx.params;
  const r = await deleteAbuseEvidence({
    id, reason: reason.reason, actor: { userId: user.id, via: "SYSTEM_ADMIN", area: "SECURITY_OPS" },
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status, headers: NO_STORE });
  return NextResponse.json({ success: true, id: r.id }, { headers: NO_STORE });
}
