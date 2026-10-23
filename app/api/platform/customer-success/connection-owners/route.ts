/**
 * GET /api/platform/customer-success/connection-owners?ids=PLAID:<id>,WALLET:<id>,…
 *   (UX-P1 — owner decision D4)
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), first.
 * Identity-resolving by owner ruling: Customer Success is the area whose grant
 * means authority to know which customer a connection belongs to. A PLATFORM_OPS
 * operator without that grant receives the adapter's 403 and the calling
 * surface renders no owner column.
 *
 * This is the SECOND of the two-route design (investigation §7): the fleet row
 * stays on /platform-ops/connection-health with no identity; this route takes
 * the ids that projection already handed out and answers with a display LABEL
 * per connection (username → name → opaque), never an email, never a user id.
 *
 * Bounded: ≤ 50 `source:id` pairs; 400 on a malformed request. GET so the
 * surface can read it through the house keyed-fetch hook.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getConnectionOwners, parseConnectionRefs, type ConnectionOwnersResult } from "@/lib/platform/customer/connection-owners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ConnectionOwnersResponse = ConnectionOwnersResult;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;

  const url = new URL(req.url);
  const raw = url.searchParams.get("ids") ?? "";
  const pairs = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const parsed = parseConnectionRefs(pairs);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = await getConnectionOwners(parsed.refs);
  return NextResponse.json(result satisfies ConnectionOwnersResponse);
}
