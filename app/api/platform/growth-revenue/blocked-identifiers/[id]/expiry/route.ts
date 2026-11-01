/**
 * POST /api/platform/growth-revenue/blocked-identifiers/[id]/expiry  (owner P2-1)
 *
 * Correct ONE active block's expiry. The new `expiresAt` must lie between now
 * + 1 day and the block's createdAt + BLOCKLIST_MAX_DAYS (3 years) — refused,
 * never clamped. Audits BETA_IDENTIFIER_BLOCK_CORRECTED with before/after.
 *
 *   Body: { expiresAt: ISO, reason: { code, note? } }   — reason REQUIRED.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "CONTROL"). Rate limited.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { parseRequiredReason } from "@/lib/platform/growth/invitation-http";
import { correctIdentifierBlockExpiry } from "@/lib/platform/growth/beta-blocklist";

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

  const r = await correctIdentifierBlockExpiry({
    blockId: id, expiresAt: body?.expiresAt, reason: reason.reason, actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status, headers: NO_STORE });
  return NextResponse.json({ success: true, block: { id: r.blockId, status: r.status, expiresAt: r.expiresAt } }, { headers: NO_STORE });
}
