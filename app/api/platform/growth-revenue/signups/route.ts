/**
 * GET /api/platform/growth-revenue/signups
 *
 * PO1.3 — signup & activation summary for the `growth_signups` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ").
 *
 * Built from scratch over User.createdAt / User.emailVerifiedAt / UserSession —
 * no existing admin route aggregates this. Aggregate counts only (no per-user
 * PII). SIGNUPS & ACTIVATION ONLY: there is no billing/subscription table in
 * the schema, so there is no revenue data source and this route deliberately
 * returns no revenue figure — matching the honest placeholder label it replaces.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";

export const runtime = "nodejs";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlatformSignupsResponse {
  totalUsers:    number;
  signups7:      number; // users created in the last 7 days
  signups30:     number; // users created in the last 30 days
  verified:      number; // users with emailVerifiedAt set
  activatedEver: number; // distinct users with ≥1 UserSession ever (signed in at least once)
  active7:       number; // distinct users with a session active in the last 7 days
}

export async function GET() {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;

  const now    = Date.now();
  const week   = new Date(now - 7 * DAY_MS);
  const month  = new Date(now - 30 * DAY_MS);

  const [totalUsers, signups7, signups30, verified, activatedEver, active7] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { createdAt: { gte: week } } }),
    db.user.count({ where: { createdAt: { gte: month } } }),
    db.user.count({ where: { emailVerifiedAt: { not: null } } }),
    db.userSession.groupBy({ by: ["userId"] }),
    db.userSession.groupBy({ by: ["userId"], where: { lastActiveAt: { gte: week } } }),
  ]);

  return NextResponse.json({
    totalUsers,
    signups7,
    signups30,
    verified,
    activatedEver: activatedEver.length,
    active7:       active7.length,
  } satisfies PlatformSignupsResponse);
}
