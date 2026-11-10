/**
 * GET /api/platform/security-ops/auth-posture
 *
 * PO1.1 — authentication posture summary for the `sec_auth_posture` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ") — NOT the
 * requireSystemAdmin gate on /api/admin/security/users. It reuses that route's
 * aggregate SHAPE (per-user totpEnabled / forcePasswordReset /
 * recoveryCodesRemaining / activeSessionCount) but rolls it up into a small
 * summary card — no per-user table, so no per-user PII crosses the boundary.
 *
 * P12a: the read lives in lib/platform/security/auth-posture.ts (pure move;
 * live sessions via liveSessionWhere at this request's clock); this route is
 * gate → reader → JSON.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { readAuthPosture, type PlatformAuthPosture } from "@/lib/platform/security/auth-posture";

export const runtime = "nodejs";

export type { PlatformAuthPosture } from "@/lib/platform/security/auth-posture";

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  return NextResponse.json((await readAuthPosture(db, new Date())) satisfies PlatformAuthPosture);
}
