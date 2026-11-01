/**
 * POST /api/platform/growth-revenue/requests/[id]/deny  (Wave 1 S3 · owner P2-1)
 *
 * Deny a beta-access request = status flip + audit. NO email: silent denial is
 * the norm for beta queues (source plan §7.4), and the public access-request
 * response never discloses status anyway, so a courtesy email would be the only
 * thing that could leak a decision.
 *
 * Denying also revokes any outstanding invite (nulls the token/expiry) so a
 * previously-approved-then-denied request can no longer be redeemed.
 *
 * ONE TRANSACTION (owner P2-1, docs/plans/BETA-BLOCKED-IDENTIFIER-DESIGN-2026-11-01.md §3):
 *   1. `SELECT … FOR UPDATE` on the request — the same row lock the risk-review
 *      writer and a DENIED approval take, so a deny and a verdict serialise;
 *   2. the status update;
 *   3. when the request's LATEST operator verdict is SUSPICIOUS, the hashed
 *      blocked-identifier upsert (lib/platform/growth/beta-blocklist.ts) — exactly
 *      one ACTIVE block, whichever of deny / verdict commits second creates it;
 *   4. the BETA_ACCESS_DENIED audit row.
 * In Production with no usable blocklist key, a deny that WOULD block cannot
 * record its block, so the whole transaction rolls back: 409 BLOCKLIST_UNAVAILABLE,
 * nothing changed. A deny that would not block is unaffected.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE").
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { auditEmailHash, recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { BetaAccessRequestStatus } from "@prisma/client";
import { BlocklistUnavailableError, blockIfConfirmedSuspicious, lockMailbox } from "@/lib/platform/growth/beta-blocklist";

export const runtime = "nodejs";

type Outcome =
  | { kind: "notFound" }
  | { kind: "redeemed" }
  | { kind: "denied"; identifierBlocked: boolean };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const { id } = await ctx.params;
  const actor = operatorActorFrom(auth, "GROWTH_REVENUE");
  const ipAddress = getClientIp(req);
  const userAgent = req.headers.get("user-agent");

  let outcome: Outcome;
  try {
    outcome = await db.$transaction(async (tx): Promise<Outcome> => {
      // LOCK ORDER (lib/platform/growth/beta-blocklist.ts lockMailbox): the mailbox advisory
      // lock FIRST — read the email unlocked (it never changes) — THEN the row lock.
      const pre = await tx.betaAccessRequest.findUnique({ where: { id }, select: { email: true } });
      if (!pre) return { kind: "notFound" };
      await lockMailbox(tx, pre.email);
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BetaAccessRequest" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) return { kind: "notFound" };
      const request = await tx.betaAccessRequest.findUnique({ where: { id }, select: { id: true, email: true, status: true } });
      if (!request) return { kind: "notFound" };
      // A redeemed invite already produced an account — denying it is meaningless.
      if (request.status === BetaAccessRequestStatus.REDEEMED) return { kind: "redeemed" };

      const now = new Date();
      await tx.betaAccessRequest.update({
        where: { id },
        data: {
          status:          BetaAccessRequestStatus.DENIED,
          decidedAt:       now,
          decidedById:     auth.user.id,
          inviteTokenHash: null, // revoke any outstanding invite
          inviteExpiresAt: null,
        },
      });

      // Operator-confirmed only: DENIED + latest verdict SUSPICIOUS ⇒ block (or the existing block stands).
      const block = await blockIfConfirmedSuspicious(tx, {
        sourceRequestId: id, email: request.email, requestStatus: BetaAccessRequestStatus.DENIED,
        actor, now, ipAddress, userAgent,
      });

      // SEC-PLAT-2 — through the operator-action envelope (actor, target, result);
      // the legacy metadata keys ride in `detail` so existing readers keep working.
      await recordOperatorAction(tx, {
        actor,
        action: AuditAction.BETA_ACCESS_DENIED,
        target: { kind: "BETA_REQUEST", id },
        result: "SUCCESS",
        detail: {
          betaRequestId: id, emailHash: auditEmailHash(request.email),
          ...(block && block.outcome !== "skipped" ? { blockId: block.blockId } : {}),
        },
        ipAddress,
        userAgent,
      });
      return { kind: "denied", identifierBlocked: !!block && block.outcome !== "skipped" };
    });
  } catch (e) {
    if (e instanceof BlocklistUnavailableError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    }
    throw e;
  }

  if (outcome.kind === "notFound") return NextResponse.json({ error: "Request not found." }, { status: 404 });
  if (outcome.kind === "redeemed") return NextResponse.json({ error: "This request has already been redeemed." }, { status: 409 });
  return NextResponse.json({ success: true, identifierBlocked: outcome.identifierBlocked });
}
