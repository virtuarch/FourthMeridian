/**
 * POST /api/platform/growth-revenue/blocked-identifiers/backfill  (owner P2-1 · §10)
 *
 * Catch-up for suspected-abuse denials decided BEFORE the blocklist shipped
 * (B4/5): scans DENIED requests whose latest verdict is SUSPICIOUS and that have
 * no ACTIVE block, and blocks them — each in its own transaction under its row
 * lock (the deny path's rule). DRY RUN BY DEFAULT: counts only, nothing written.
 * Executing (`dryRun: false`) audits one BETA_IDENTIFIER_BLOCKED per block plus
 * ONE counts-only BETA_IDENTIFIER_BACKFILL row. Idempotent.
 *
 * RUN IT ONCE right after B9 ships, within 180 days of those denials: until then
 * the #204 suspected-abuse lock still protects the rows; after retention deletes
 * them there is nothing left to backfill from.
 *
 *   Body: { reason: { code, note? }, dryRun?: boolean (default true) }
 *   409 BLOCKLIST_UNAVAILABLE when no usable key is configured.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "CONTROL"). Rate limited.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { parseRequiredReason } from "@/lib/platform/growth/invitation-http";
import { backfillIdentifierBlocks } from "@/lib/platform/growth/beta-blocklist";

export const runtime = "nodejs";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "growth-blocklist-backfill", { limit: 5, windowSec: 60 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return NextResponse.json({ error: "dryRun must be a boolean." }, { status: 400, headers: NO_STORE });
  }
  const reason = parseRequiredReason(body?.reason);
  if (!reason.ok) return reason.response;

  const r = await backfillIdentifierBlocks({
    dryRun: body?.dryRun !== false, reason: reason.reason, actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: 409, headers: NO_STORE });
  return NextResponse.json(r, { headers: NO_STORE });
}
