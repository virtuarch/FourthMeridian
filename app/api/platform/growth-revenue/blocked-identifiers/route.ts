/**
 * GET /api/platform/growth-revenue/blocked-identifiers  (owner P2-1)
 *
 * The hashed beta blocklist, newest first (≤ 200): id, an 8-hex HMAC prefix, key
 * version, status, created / expires, the confirming reason code, the source
 * request id and whether that request still exists (it is deleted after 180
 * days; the block outlives it by design), and the removal fields. NEVER an
 * address — the server does not have one — and never the full HMAC.
 *
 *   ?status=ACTIVE | REMOVED | ALL (default ALL)
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ"). Removing or
 * correcting a block needs fresh CONTROL (…/[id]/remove, …/[id]/expiry).
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { listIdentifierBlocks } from "@/lib/platform/growth/beta-blocklist";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest) {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;
  const raw = (req.nextUrl.searchParams.get("status") ?? "ALL").toUpperCase();
  if (raw !== "ACTIVE" && raw !== "REMOVED" && raw !== "ALL") {
    return NextResponse.json({ error: "status must be ACTIVE, REMOVED or ALL." }, { status: 400, headers: NO_STORE });
  }
  const result = await listIdentifierBlocks({ status: raw });
  return NextResponse.json(result, { headers: NO_STORE });
}
