/**
 * GET /api/platform/customer-success/recently-joined  (PB-7 — "Recently joined (14 d)")
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ") — the
 * Customers list's own gate. Identity-resolving by owner ruling (2026-10-07):
 * the rows NAME customers, which is exactly why they are served here and not
 * through the counts-only overview DTO. Opening a row reads the AUDITED profile
 * route (customers/[userId], which records CUSTOMER_PROFILE_VIEWED).
 *
 * Query: ?days=<1..90> (default 14).
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { listRecentlyJoined } from "@/lib/platform/customer/recently-joined";
import type { RecentlyJoined } from "@/lib/platform/customer/recently-joined-core";

export const runtime = "nodejs";

export type RecentlyJoinedResponse = RecentlyJoined;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  const daysRaw = Number(new URL(req.url).searchParams.get("days") ?? 14);
  const body = await listRecentlyJoined({ days: Number.isFinite(daysRaw) ? daysRaw : 14 });
  return NextResponse.json(body satisfies RecentlyJoinedResponse, { headers: { "Cache-Control": "no-store" } });
}
