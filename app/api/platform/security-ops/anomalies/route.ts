/**
 * GET /api/platform/security-ops/anomalies
 *
 * Wave 3 ⑧ — Security Ops anomaly widget read. Two things over the same data
 * the inline detector writes/uses:
 *   - `trips`: recent SECURITY_ANOMALY_DETECTED audit rows (the detector's own
 *     trip history — type, count, when), most recent first.
 *   - `summary`: a live pulse — LOGIN_FAILED volume over the detector's primary
 *     window, and the trip count over the last 24h.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ") — the same
 * granted, non-SYSTEM_ADMIN platform staff gate the other Security Ops widgets
 * use (never requireSystemAdmin).
 *
 * P12a: the read lives in lib/platform/security/anomalies.ts (pure move); this
 * route is gate → reader → JSON.
 *
 * PII (BETA V2): the detector's `metadata.key` is NOT coarse — it carries the raw
 * login identifier (email or username) or a full IP. The reader projects it
 * through lib/platform/security/anomalies-core.ts into a key KIND plus an opaque
 * digest, so the raw key never leaves this process; no email, IP or user-agent
 * is returned. `summary.failedLoginsWindow` is COUNT(LOGIN_FAILED) platform-wide
 * over the identifier window — every reason, every account — which the surface
 * labels as exactly that, not as the detector's per-account measure.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { readSecurityAnomalies, type AnomaliesResponse } from "@/lib/platform/security/anomalies";

export const runtime = "nodejs";

export type { AnomalyTrip, AnomaliesResponse } from "@/lib/platform/security/anomalies";

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  return NextResponse.json((await readSecurityAnomalies(db, Date.now())) satisfies AnomaliesResponse);
}
