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
 * reused. This is a fresh READ over UserSession (revokedAt = null), scaled to a
 * card: a live count, distinct-user count, and a short most-recently-active
 * list showing only parsed device/browser + time — never IP, user-agent string,
 * userId, or email.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { parseUserAgent } from "@/lib/ua-parser";

export const runtime = "nodejs";

const RECENT_LIMIT = 8;

export interface PlatformSessionRow {
  id:      string;
  device:  string; // parsed — e.g. "Desktop" / "Mobile"
  browser: string; // parsed — e.g. "Chrome"
  os:      string; // parsed — e.g. "macOS"
  at:      string; // ISO lastActiveAt
}

export interface PlatformSessionsResponse {
  totalActive:   number;
  distinctUsers: number;
  recent:        PlatformSessionRow[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  const [totalActive, distinctUsers, recent] = await Promise.all([
    db.userSession.count({ where: { revokedAt: null } }),
    db.userSession.groupBy({ by: ["userId"], where: { revokedAt: null } }),
    db.userSession.findMany({
      where:   { revokedAt: null },
      orderBy: { lastActiveAt: "desc" },
      take:    RECENT_LIMIT,
      select:  { id: true, userAgent: true, lastActiveAt: true },
    }),
  ]);

  const rows: PlatformSessionRow[] = recent.map((s) => {
    const p = parseUserAgent(s.userAgent ?? "");
    return { id: s.id, device: p.device, browser: p.browser, os: p.os, at: s.lastActiveAt.toISOString() };
  });

  return NextResponse.json({
    totalActive,
    distinctUsers: distinctUsers.length,
    recent: rows,
  } satisfies PlatformSessionsResponse);
}
