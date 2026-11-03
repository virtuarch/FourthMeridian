/**
 * GET /api/platform/customer-success/customers  (P1 — customer spine, list)
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"). Identity-
 * resolving by owner ruling (2026-10-07): Customer Success is the area whose
 * grant means authority to support an identifiable customer.
 *
 * RATE LIMIT (PRIV-ref): 60 / min per operator; a search that is an opaque
 * reference (`user #3fa9c21b`) also spends a 20 / min bucket (it digests up to
 * REF_SEARCH_SCAN_CAP ids server-side). No audit row — a read, like the list.
 *
 * Query: ?search=<email|name prefix | opaque reference>&limit=<1..200>&attention=<reconnect|incident|policy|unassigned|stalled|any>
 *
 * PB-4 — `attention` narrows the list to the active customers who need help for
 * that reason (or any reason): the SAME fold the overview counts with, so the
 * dashboard's "Who needs help, and why" rows link here. An unknown value is a 400.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { listCustomers, opaqueRefSearchToken, type CustomerList } from "@/lib/platform/customer/customers";
import { limitByUser } from "@/lib/rate-limit";
import { parseAttentionFilter } from "@/lib/platform/customer/attention-keys";

export const runtime = "nodejs";

export type CustomerListResponse = CustomerList;

export async function GET(req: Request): Promise<Response> {
  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  // PRIV-ref — a modest per-operator limit (the list had none); a pasted reference digests up to
  // REF_SEARCH_SCAN_CAP ids, so reference lookups have their own tighter bucket.
  const listLimited = await limitByUser(auth.user.id, "cs-customers-list", { limit: 60, windowSec: 60 });
  if (listLimited) return listLimited;
  const url = new URL(req.url);
  if (opaqueRefSearchToken(url.searchParams.get("search") ?? "")) {
    const refLimited = await limitByUser(auth.user.id, "cs-customers-ref-lookup", { limit: 20, windowSec: 60 });
    if (refLimited) return refLimited;
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  const attention = parseAttentionFilter(url.searchParams.get("attention"));
  if (attention === undefined) {
    return NextResponse.json({ error: "attention must be reconnect, incident, policy, unassigned, stalled or any" }, { status: 400 });
  }
  const list = await listCustomers({ search: url.searchParams.get("search") ?? "", limit: Number.isFinite(limitRaw) ? limitRaw : 50, attention });
  return NextResponse.json(list satisfies CustomerListResponse);
}
