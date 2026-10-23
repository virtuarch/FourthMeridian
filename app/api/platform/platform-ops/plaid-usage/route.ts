/**
 * GET /api/platform/platform-ops/plaid-usage  (PLATFORM OPS OBSERVABILITY)
 *
 * Plaid usage (Item × product × billing cycle) and its estimated cost from the
 * invoice-derived rate card, usage and cost kept apart. Gated PLATFORM_OPS READ.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getPlaidUsage } from "@/lib/platform/plaid/usage";

export const runtime = "nodejs";

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json(await getPlaidUsage());
}
