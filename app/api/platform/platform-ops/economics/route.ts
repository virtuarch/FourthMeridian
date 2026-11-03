/**
 * GET /api/platform/platform-ops/economics  (Platform Economics — Overview)
 *
 * The EconomicsSnapshot: operating cost this cycle and its AI / providers /
 * infrastructure split, cost per active customer (PB-10 engagement), the
 * 7 / 30 / 90-day AI cost trend, and revenue / margin as UNAVAILABLE (no billing
 * source). Every figure carries status, coverage, freshness, basis and a drill
 * reference (lib/platform/economics/snapshot-core.ts). Estimates, never a bill.
 *
 * Read-only, fm_system, identity-free.
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getEconomicsSnapshot } from "@/lib/platform/economics/snapshot";
import type { EconomicsSnapshot } from "@/lib/platform/economics/snapshot-core";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const body = await getEconomicsSnapshot(Date.now());
  return NextResponse.json(body satisfies EconomicsSnapshot, { headers: { "Cache-Control": "no-store" } });
}
