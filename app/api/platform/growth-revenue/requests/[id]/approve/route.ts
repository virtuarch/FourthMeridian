/**
 * POST /api/platform/growth-revenue/requests/[id]/approve  (Wave 1 S3 · PR B)
 *
 * Approve a beta-access request = mint a single-use invite + email it, in one
 * step. A thin wrapper over THE issuance mechanism
 * (lib/platform/growth/invitation-issue.ts, kind "approve"):
 *   - IDEMPOTENT: only the request that moves PENDING/DENIED → APPROVED mints and
 *     e-mails; a repeat or concurrent second click returns 200
 *     { alreadyApproved: true } and sends nothing (I4).
 *   - REDEEMED ⇒ 409; an address that already has an account ⇒ 409
 *     ACCOUNT_EXISTS (E-6: such an invite could never be redeemed).
 *   - Expiry: the optional body `{ validityDays }` (1–30) or the configured
 *     invitation validity (Growth setting, default 7 days).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE") — the
 * fresh (live-revocation-checked) variant, required for every platform mutation
 * (lib/platform/authorize.ts:131).
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
  const body = (await req.json().catch(() => ({}))) as { validityDays?: unknown; reason?: unknown };
  const reason = parseOptionalReason(body.reason);
  if (!reason.ok) return reason.response;

  const result = await issueBetaInvitation({
    client: db,
    actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    kind: "approve",
    requestId: id,
    validityDays: body.validityDays,
    reason: reason.reason,
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  return issueResultResponse(result);
}
