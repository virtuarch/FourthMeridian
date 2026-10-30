/**
 * GET /api/platform/growth-revenue/acquisition?window=30|90  (Platform Spaces 2.0 — Growth)
 *
 * The Growth dashboard's acquisition facts — beta requests and registrations per
 * UTC day, the waitlist's current state, acquisition sources, sign-ins and AI
 * chat turns by weekday × hour, and registration-week cohorts (retention and
 * onboarding) — as the AcquisitionResponse (lib/platform/growth/acquisition-types.ts).
 * A pure projection over the ledgers (lib/platform/growth/acquisition). Read-only
 * and identity-free: no email, user id, name or Space name is in the body.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ") first, like
 * every Growth read. Never cached: the figures move with the ledgers.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getAcquisition } from "@/lib/platform/growth/acquisition";
import type { AcquisitionResponse } from "@/lib/platform/growth/acquisition-types";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;
  const raw = new URL(req.url).searchParams.get("window");
  if (raw !== null && raw !== "30" && raw !== "90") {
    return NextResponse.json({ error: "window must be 30 or 90" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const body = await getAcquisition(raw === "30" ? 30 : 90);
  return NextResponse.json(body satisfies AcquisitionResponse, { headers: { "Cache-Control": "no-store" } });
}
