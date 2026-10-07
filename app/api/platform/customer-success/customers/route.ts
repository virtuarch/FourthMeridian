/**
 * GET /api/platform/customer-success/customers  (P1 — customer spine, list)
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"). Identity-
 * resolving by owner ruling (2026-10-07): Customer Success is the area whose
 * grant means authority to support an identifiable customer.
 *
 * Query: ?search=<email|name prefix>&limit=<1..200>
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { listCustomers, type CustomerList } from "@/lib/platform/customer/customers";

export const runtime = "nodejs";

export type CustomerListResponse = CustomerList;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  const list = await listCustomers({ search: url.searchParams.get("search") ?? "", limit: Number.isFinite(limitRaw) ? limitRaw : 50 });
  return NextResponse.json(list satisfies CustomerListResponse);
}
