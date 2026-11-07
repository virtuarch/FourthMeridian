/**
 * GET /api/platform/platform-ops/removed-connections  (PB-5)
 *   ?owner=<6 chars of an ownerRef>&provider=PLAID|WALLET&outcome=<RemovedOutcome>&page=1&pageSize=25
 *
 * The "Removed" list beside connection diagnostics: one row per removed Plaid
 * item or wallet connection — source, account count, opaque owner reference,
 * removed at, removed by (operator / customer / provider / system), and the
 * Plaid outcome read off the SAME verdicts the Provider cleanup widget counts.
 * Server-side filtered and paged; `totals` and `cleanup` are over the whole
 * population so the two surfaces can be reconciled at a glance.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"), as every other
 * Platform Ops read. Customer IDENTITY is not here: the UI resolves owner labels
 * through /api/platform/customer-success/connection-owners (CUSTOMER_SUCCESS
 * READ, owner decision D4) — the connection-health table's pattern. Retrying an
 * owed cleanup is the existing POST /api/platform/platform-ops/provider-cleanup.
 *
 * `viewer.canRemove` is DESCRIPTIVE (it only decides whether the Remove button
 * renders): true exactly when access came from the SYSTEM_ADMIN role
 * (auth.grant === null). The remove route re-checks with requireFreshSystemAdmin.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getRemovedConnectionsPage } from "@/lib/platform/connections/removed-connections";
import { parseRemovedConnectionsQuery, type RemovedConnectionsPage } from "@/lib/platform/connections/removed-connections.core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RemovedConnectionsResponse = RemovedConnectionsPage & {
  checkedAt: string;
  viewer: { canRemove: boolean };
};

export async function GET(req: Request): Promise<Response> {
  const [auth, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const parsed = parseRemovedConnectionsQuery(new URL(req.url).searchParams);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const page = await getRemovedConnectionsPage(parsed.query);
  return NextResponse.json({
    ...page,
    checkedAt: new Date().toISOString(),
    viewer: { canRemove: auth.grant === null },
  } satisfies RemovedConnectionsResponse);
}
