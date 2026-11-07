/**
 * GET /api/platform/merchant-ops/merchants/[id]  (PB-9 — a merchant's identity record)
 *
 * One canonical merchant: aliases, related transactions (no amounts, no
 * descriptors, no tenant identity), classification mix and identity history,
 * as the MerchantDetailResponse (lib/platform/merchant/records-types.ts).
 * READ-ONLY inspection.
 *
 * AUTHORIZATION: requirePlatformAccess("MERCHANT_OPS", "READ") first. Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getMerchantIdentityDetail } from "@/lib/platform/merchant/records";
import type { MerchantDetailResponse } from "@/lib/platform/merchant/records-types";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const [, err] = await requirePlatformAccess("MERCHANT_OPS", "READ");
  if (err) return err;
  const { id } = await ctx.params;
  if (!/^c[a-z0-9]{20,32}$/.test(id)) return NextResponse.json({ error: "Unknown merchant" }, { status: 404, headers: NO_STORE });
  const body = await getMerchantIdentityDetail(id);
  if (!body) return NextResponse.json({ error: "Unknown merchant" }, { status: 404, headers: NO_STORE });
  return NextResponse.json(body satisfies MerchantDetailResponse, { headers: NO_STORE });
}
