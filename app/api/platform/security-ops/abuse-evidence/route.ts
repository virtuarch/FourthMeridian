/**
 * GET /api/platform/security-ops/abuse-evidence  (owner P2-1 · §7)
 *
 * Preserved beta abuse evidence — METADATA ONLY (id, source request id, capture
 * time / operator / reason, retainUntil). The sealed payload never leaves the
 * table here; opening one is GET …/abuse-evidence/[id], audited on every read.
 *
 * AUTHORIZATION: requireFreshSystemAdmin().
 */

import { NextResponse } from "next/server";
import { requireFreshSystemAdmin } from "@/lib/session";
import { listAbuseEvidence } from "@/lib/platform/growth/beta-abuse-evidence";

export const runtime = "nodejs";

export async function GET() {
  const [, err] = await requireFreshSystemAdmin();
  if (err) return err;
  return NextResponse.json(await listAbuseEvidence(), { headers: { "Cache-Control": "no-store" } });
}
