/**
 * POST /api/platform/growth-revenue/blocked-identifiers/[id]/remove  (owner P2-1)
 *
 * Remove ONE block (the correction path once its source request is gone after
 * 180 days; while it exists, a newer LEGITIMATE / UNREVIEWED verdict on it is the
 * ordinary clear). Writes status REMOVED (kept 90 days for the audit trail, then
 * deleted by retention) and audits BETA_IDENTIFIER_UNBLOCKED.
 *
 *   Body: { reason: { code, note? } }   — reason REQUIRED.
 *   404  the block does not exist (never existed, or retention deleted it — a
 *        removal can never resurrect it); 409 already removed / changed.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "CONTROL") —
 * WRITE (which approves and denies) cannot lift a block. Rate limited.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { parseRequiredReason } from "@/lib/platform/growth/invitation-http";
import { removeIdentifierBlock } from "@/lib/platform/growth/beta-blocklist";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "growth-blocklist-control", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const reason = parseRequiredReason(body?.reason);
  if (!reason.ok) return reason.response;
  const { id } = await ctx.params;

  const r = await removeIdentifierBlock({
    blockId: id, reason: reason.reason, actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status, headers: NO_STORE });
  return NextResponse.json({ success: true, block: { id: r.blockId, status: r.status } }, { headers: NO_STORE });
}
