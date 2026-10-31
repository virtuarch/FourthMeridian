/**
 * POST /api/platform/growth-revenue/requests/[id]/resend  (PO-3B · B1-C · PR B)
 *
 * Resend = REISSUE the invitation for an already-APPROVED beta request: rotate
 * the single-use token and re-email it. A thin wrapper over THE issuance
 * mechanism (lib/platform/growth/invitation-issue.ts, kind "reissue"):
 *   - APPROVED only (409 otherwise — including a row revoked meanwhile).
 *   - The rotation is conditional on the token hash observed (and, when the body
 *     carries it, the `expectedInvitedAt` the operator's screen showed), so two
 *     concurrent resends — or a double-click processed back to back — produce
 *     ONE new link and ONE email; the loser answers 200 { alreadyReissued: true }
 *     and sends nothing.
 *   - Expiry: the optional body `{ validityDays }` (1–30) or the configured
 *     invitation validity — no longer forced to 14 days.
 *   - The email copy follows the row's origin (PR #157).
 *
 * Audited as BETA_INVITATION_RESENT (approve is for a first decision).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE").
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { issueBetaInvitation } from "@/lib/platform/growth/invitation-issue";
import { issueResultResponse, parseOptionalReason } from "@/lib/platform/growth/invitation-http";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { validityDays?: unknown; reason?: unknown; expectedInvitedAt?: unknown };
  const reason = parseOptionalReason(body.reason);
  if (!reason.ok) return reason.response;

  const result = await issueBetaInvitation({
    client: db,
    actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    kind: "reissue",
    requestId: id,
    validityDays: body.validityDays,
    expectedInvitedAt: body.expectedInvitedAt,
    reason: reason.reason,
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  return issueResultResponse(result);
}
