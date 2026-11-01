/**
 * GET /api/platform/customer-success/customers  (P1 — customer spine, list)
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"). Identity-
 * resolving by owner ruling (2026-10-07): Customer Success is the area whose
 * grant means authority to support an identifiable customer.
 *
 * Query: ?search=<email|name prefix>&limit=<1..200>&attention=<reconnect|incident|policy|stalled|any>
 *
 * PB-4 — `attention` narrows the list to the active customers who need help for
 * that reason (or any reason): the SAME fold the overview counts with, so the
 * dashboard's "Who needs help, and why" rows link here. An unknown value is a 400.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { listCustomers, type CustomerList } from "@/lib/platform/customer/customers";
import { parseAttentionFilter } from "@/lib/platform/customer/attention-core";

export const runtime = "nodejs";

export type CustomerListResponse = CustomerList;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  const attention = parseAttentionFilter(url.searchParams.get("attention"));
  if (attention === undefined) {
    return NextResponse.json({ error: "attention must be reconnect, incident, policy, stalled or any" }, { status: 400 });
  }
  const list = await listCustomers({ search: url.searchParams.get("search") ?? "", limit: Number.isFinite(limitRaw) ? limitRaw : 50, attention });
  return NextResponse.json(list satisfies CustomerListResponse);
}
