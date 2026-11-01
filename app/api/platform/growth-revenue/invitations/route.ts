/**
 * POST /api/platform/growth-revenue/invitations  (PO-3C · direct operator invite · PR B)
 *
 * Operator-initiated invite to an address. A thin wrapper over THE issuance
 * mechanism (lib/platform/growth/invitation-issue.ts, kind "direct"):
 *   - no row            → create it APPROVED (BETA_INVITATION_CREATED);
 *   - PENDING           → the approve path (BETA_ACCESS_APPROVED);
 *   - APPROVED, expired → the reissue path (BETA_INVITATION_RESENT);
 *   - DENIED / revoked, REDEEMED, a LIVE invitation, or an address that already
 *     has an account → 409 with a code (DENIED / REDEEMED / LIVE_INVITE /
 *     ACCOUNT_EXISTS). No unconditional upsert, no silent status flip.
 *   - Expiry: body `expiresDays` (or `validityDays`), 1–30 — refused outside, no
 *     longer clamped — or the configured invitation validity when absent.
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

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const body = (await req.json().catch(() => ({}))) as {
    email?: unknown; expiresDays?: unknown; validityDays?: unknown; reason?: unknown;
  };
  const reason = parseOptionalReason(body.reason);
  if (!reason.ok) return reason.response;

  const result = await issueBetaInvitation({
    client: db,
    actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    kind: "direct",
    email: body.email,
    validityDays: body.validityDays ?? body.expiresDays,
    reason: reason.reason,
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  return issueResultResponse(result);
}
