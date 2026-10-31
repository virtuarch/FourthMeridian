/**
 * POST /api/platform/growth-revenue/requests/bulk-approve  (PR C)
 *
 * Approve up to one page (100) of beta requests in one operator action. A thin
 * wrapper over lib/platform/growth/bulk-approve.ts, which calls THE issuance
 * mechanism (issueBetaInvitation, kind "approve") once per request.
 *
 *   body {
 *     requestIds: string[]   1..100 (refused above, never truncated); deduped
 *     batchKey:   string     a UUID the client mints once per review session
 *     dryRun?:    boolean    true ⇒ per-id eligibility + summary, nothing written
 *     validityDays?: number  1–30 per-batch override; absent ⇒ the configured setting
 *     reason?:    { code, note? }  optional, as single approve
 *   }
 *
 * The client is never authoritative: eligibility, expiry and status are decided
 * here, from the rows as they are when the request runs. A retry or a double
 * submit of the same batch issues nothing twice (per-row conditional writes).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE") — the
 * same gate as single approve, for the dry run too (it is the preview of a
 * mutation, and only a WRITE holder can act on it).
 */

import { NextRequest, NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { bulkApproveBetaRequests } from "@/lib/platform/growth/bulk-approve";
import { parseBulkApproveBody } from "@/lib/platform/growth/bulk-approve.core";
import { parseOptionalReason } from "@/lib/platform/growth/invitation-http";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const parsed = parseBulkApproveBody(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const reason = parseOptionalReason(parsed.body.reason);
  if (!reason.ok) return reason.response;

  const result = await bulkApproveBetaRequests({
    client: systemDb,
    actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    body: parsed.body,
    reason: reason.reason,
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  return NextResponse.json(result);
}
