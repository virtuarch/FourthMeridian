/**
 * GET /api/platform/merchant-ops/records?kind=merchants|unlinked|merged|dismissed
 *     &window=30|90 &q= &sort= &page= &filter=<identity class, unlinked only>
 * (PB-9 — Merchant Identity KPIs drill into their records)
 *
 * One page of the records behind a Merchant Identity KPI, as the
 * MerchantRecordsResponse (lib/platform/merchant/records-types.ts). The total
 * is computed by the SAME count function the overview KPI uses
 * (lib/platform/merchant/records.ts), so the table and the figure agree.
 * READ-ONLY inspection: the merge / dismiss / reconsider mutations keep their
 * own fresh-WRITE routes under /api/merchant-ops.
 *
 * AUTHORIZATION: requirePlatformAccess("MERCHANT_OPS", "READ") first. Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { parseRecordsQuery } from "@/lib/platform/merchant/records-core";
import { listMerchantIdentityRecords } from "@/lib/platform/merchant/records";
import type { MerchantRecordsResponse } from "@/lib/platform/merchant/records-types";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("MERCHANT_OPS", "READ");
  if (err) return err;
  const parsed = parseRecordsQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const body = await listMerchantIdentityRecords(parsed.query);
  return NextResponse.json(body satisfies MerchantRecordsResponse, { headers: { "Cache-Control": "no-store" } });
}
