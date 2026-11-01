/**
 * POST /api/platform/growth-revenue/blocked-identifiers/lookup  (owner P2-1)
 *
 * "Is this address blocked, and by which block?" — so an operator can check a
 * specific person's appeal without the server ever storing the address. The
 * address is used ONLY to compute the HMACs (every configured key version); it
 * is neither logged nor audited (the BETA_IDENTIFIER_LOOKUP row stores its
 * auditEmailHash and the answer, as elsewhere).
 *
 *   Body: { email, reason: { code, note? } }   — reason REQUIRED.
 *   409 BLOCKLIST_UNAVAILABLE when no usable key is configured (it cannot answer).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "CONTROL"). Rate limited.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { parseRequiredReason } from "@/lib/platform/growth/invitation-http";
import { normaliseInviteEmail } from "@/lib/platform/growth/invitation-issue.core";
import { operatorLookupIdentifier } from "@/lib/platform/growth/beta-blocklist";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "growth-blocklist-lookup", { limit: 20, windowSec: 60 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const email = normaliseInviteEmail(body?.email);
  if (!email) return NextResponse.json({ error: "A valid email is required." }, { status: 400, headers: NO_STORE });
  const reason = parseRequiredReason(body?.reason);
  if (!reason.ok) return reason.response;

  const r = await operatorLookupIdentifier({
    email, reason: reason.reason, actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: 409, headers: NO_STORE });
  return NextResponse.json(r.blocked ? { blocked: true, block: r.block } : { blocked: false }, { headers: NO_STORE });
}
