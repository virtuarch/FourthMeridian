/**
 * GET /api/platform/platform-ops/db-authority  (RLS-PREP-B)
 *
 * The deployed process's answer to "which database roles am I actually running
 * as?" — the question lib/db/strict-mode.ts can only check the SPELLING of at
 * boot. See lib/platform/db-authority.ts for what is probed and why it is a
 * route rather than a script.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("PLATFORM_OPS", "READ") — an
 * operator read like every other Platform Ops widget, with the live-revocation
 * re-check because this reports privilege posture. 401 without a session, 403
 * without the grant. NOT public, and deliberately not folded into /api/health,
 * which is unauthenticated and polled.
 *
 * RESPONSE: role names, booleans and counts. Never a connection string, a
 * password, a host name, a project reference or an environment value.
 *
 * STATUS: 200 when every role is bound and verified, 503 when it is not — so a
 * cutover check can be a status code, and a deployment that is NOT isolated
 * cannot be mistaken for one by a reader who only looked at the first line.
 * The body is the same either way.
 *
 * The only identity the tenant-channel probe ever binds is the calling
 * operator's own user id, read from the authenticated session.
 */

import { NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getDbAuthorityReport, type DbAuthorityReport } from "@/lib/platform/db-authority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PlatformDbAuthorityResponse = DbAuthorityReport;

export async function GET() {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const report = await getDbAuthorityReport(auth.user.id);
  return NextResponse.json(report satisfies PlatformDbAuthorityResponse, {
    status: report.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
