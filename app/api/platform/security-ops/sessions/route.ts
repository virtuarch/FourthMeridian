/**
 * GET /api/platform/security-ops/sessions
 *
 * PO1.1 — active-session activity for the `sec_sessions` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ").
 *
 * No site-wide active-session route exists today — the only session route is
 * the per-user, DELETE-capable admin one
 * (/api/admin/security/users/[userId]/sessions), which is out of scope and NOT
 * reused. This is a fresh READ over LIVE UserSessions (liveSessionWhere — not
 * revoked, within the SEC-010 idle/absolute lifetime, account not locked out;
 * the same rule the auth path enforces), scaled to a
 * card: a live count, distinct-user count, and a short most-recently-active
 * list showing only parsed device/browser + time — never IP, user-agent string,
 * userId, or email.
 *
 * P12a: the recent list lives in lib/platform/security/sessions.ts (pure move);
 * the counts stay on countLiveSessions (live-sessions@1). Both readers get ONE
 * clock from this route.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { countLiveSessions } from "@/lib/platform/security/live-sessions";
import { listRecentLiveSessions, type PlatformSessionsResponse } from "@/lib/platform/security/sessions";

export const runtime = "nodejs";

export type { PlatformSessionRow, PlatformSessionsResponse } from "@/lib/platform/security/sessions";

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  const now = new Date();
  const [counts, recent] = await Promise.all([
    // live-sessions@1 — the shared reader (lib/platform/security/live-sessions.ts), same rule and clock as the list below.
    countLiveSessions(db, now),
    listRecentLiveSessions(db, now),
  ]);

  return NextResponse.json({
    totalActive: counts.sessions,
    distinctUsers: counts.distinctUsers,
    recent,
  } satisfies PlatformSessionsResponse);
}
