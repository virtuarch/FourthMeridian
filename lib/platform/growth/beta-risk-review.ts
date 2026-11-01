/**
 * lib/platform/growth/beta-risk-review.ts  (Beta-request risk — operator verdicts)
 *
 * The WRITE and the history READ behind
 * app/api/platform/growth-revenue/requests/[id]/risk-review, on fm_system.
 *
 * APPEND-ONLY. A verdict is one new BetaAccessRequestReview row plus its
 * operator-action audit row (BETA_REQUEST_RISK_REVIEWED, reason-required),
 * written in ONE transaction so neither can commit without the other. The
 * request itself (status, decision fields, invite token) and the heuristic
 * evidence are never touched — this module holds no update or delete.
 *
 * SERIALISED. The transaction first takes a row lock on the request
 * (`SELECT … FOR UPDATE` on BetaAccessRequest — fm_system holds UPDATE there,
 * which FOR UPDATE requires), so two concurrent verdicts on one request run
 * one after the other and each audit row's `before` is the verdict that was
 * really current. The lock changes no data.
 *
 * BLOCKED IDENTIFIERS (owner P2-1, 2026-11-01). Inside the same transaction and
 * under the same row lock:
 *   · SUSPICIOUS on a DENIED request blocks its canonical mailbox (one ACTIVE
 *     block, upserted — beta-blocklist.ts); on a PENDING request it blocks
 *     nothing (only an operator-confirmed suspicious DENIAL does);
 *   · LEGITIMATE or UNREVIEWED removes every ACTIVE block this request caused
 *     (removal reason = this verdict's), audited BETA_IDENTIFIER_UNBLOCKED.
 * In Production with no usable key a SUSPICIOUS verdict on a DENIED request
 * cannot record its block, so the verdict rolls back (BlocklistUnavailableError).
 * Those writes are the blocklist's own table; the request row is still never
 * written here.
 *
 * LIFECYCLE. Review rows cascade with their request (FK ON DELETE CASCADE): the
 * account-deletion purge (lib/account-deletion/purge.ts, by e-mail) and the
 * retention job (jobs/data-retention.ts — DENIED, PENDING and unredeemed
 * APPROVED requests untouched for 180 days; REDEEMED kept) erase a request's
 * verdicts with it, BY DESIGN. Accountability survives in the
 * BETA_REQUEST_RISK_REVIEWED AuditLog rows, which reference the request by id
 * only and are not purged with it.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { assertOperatorNoteSafe, recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import { operatorLabels, type BetaRiskDb } from "./beta-risk";
import { removeBlocksForSourceRequest, upsertIdentifierBlock, lockMailbox } from "./beta-blocklist";
import type { EnvSource } from "./beta-blocklist-core";
import {
  BETA_RISK_REVIEW_STATUSES,
  type BetaRiskReviewHistoryResponse, type BetaRiskReviewStatusValue,
} from "./beta-risk-types";

/** Newest-first history rows returned per request. */
export const BETA_RISK_REVIEW_HISTORY_CAP = 50;

export function isBetaRiskReviewStatus(v: unknown): v is BetaRiskReviewStatusValue {
  return typeof v === "string" && (BETA_RISK_REVIEW_STATUSES as readonly string[]).includes(v);
}

export interface RecordBetaRiskReviewInput {
  requestId: string;
  status: BetaRiskReviewStatusValue;
  reason: OperatorReason;
  /** Optional review note — scrubbed like an operator reason note. */
  note?: string | null;
  actor: OperatorActionInput["actor"];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type RecordBetaRiskReviewResult =
  | {
      ok: true;
      review: { id: string; status: BetaRiskReviewStatusValue; at: string };
      /** What this verdict did to the hashed blocklist. */
      blocklist: { blocked: "created" | "alreadyBlocked" | null; removed: number };
    }
  | { ok: false; code: "NOT_FOUND" };

/**
 * Append one verdict + its audit row in one transaction. Throws
 * OperatorActionValidationError for an unsafe note (before any write).
 */
export async function recordBetaRiskReview(
  input: RecordBetaRiskReviewInput,
  deps: { client?: BetaRiskDb; env?: EnvSource; now?: Date } = {},
): Promise<RecordBetaRiskReviewResult> {
  const client = deps.client ?? systemDb;
  const note = typeof input.note === "string" && input.note.trim() !== "" ? assertOperatorNoteSafe(input.note) : null;

  return client.$transaction(async (tx) => {
    // LOCK ORDER (beta-blocklist.ts lockMailbox): the mailbox advisory lock FIRST — the
    // email is read unlocked (it never changes) — THEN the row lock, where concurrent
    // verdicts on the same request serialise.
    const pre = await tx.betaAccessRequest.findUnique({ where: { id: input.requestId }, select: { email: true } });
    if (!pre) return { ok: false, code: "NOT_FOUND" } as const;
    await lockMailbox(tx, pre.email);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BetaAccessRequest" WHERE "id" = ${input.requestId} FOR UPDATE`;
    if (locked.length === 0) return { ok: false, code: "NOT_FOUND" } as const;
    const request = await tx.betaAccessRequest.findUnique({ where: { id: input.requestId }, select: { email: true, status: true } });
    if (!request) return { ok: false, code: "NOT_FOUND" } as const;

    const previous = await tx.betaAccessRequestReview.findFirst({
      where: { requestId: input.requestId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { status: true },
    });

    const row = await tx.betaAccessRequestReview.create({
      data: {
        requestId: input.requestId,
        status: input.status,
        reasonCode: input.reason.code,
        note,
        operatorId: input.actor.userId,
      },
      select: { id: true, status: true, createdAt: true },
    });

    await recordOperatorAction(tx, {
      actor: input.actor,
      action: AuditAction.BETA_REQUEST_RISK_REVIEWED,
      target: { kind: "BETA_REQUEST", id: input.requestId },
      reason: input.reason,
      result: "SUCCESS",
      change: { before: { reviewStatus: previous?.status ?? null }, after: { reviewStatus: input.status } },
      detail: { betaRequestId: input.requestId, reviewId: row.id },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    // The blocklist (header): block on a SUSPICIOUS denial; a clearing verdict removes this request's blocks.
    const attribution = { actor: input.actor, ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null };
    let blocked: "created" | "alreadyBlocked" | null = null;
    let removed = 0;
    if (input.status === "SUSPICIOUS" && request.status === "DENIED") {
      // The verdict just appended IS the latest: block with its reason code.
      const b = await upsertIdentifierBlock(tx, {
        ...attribution, sourceRequestId: input.requestId, email: request.email, reasonCode: input.reason.code,
        ...(deps.env ? { env: deps.env } : {}), ...(deps.now ? { now: deps.now } : {}),
      });
      blocked = b.outcome !== "skipped" ? b.outcome : null;
    } else if (input.status === "SUSPICIOUS") {
      // PENDING / APPROVED + SUSPICIOUS blocks nothing: only a suspicious DENIAL does.
    } else {
      removed = (await removeBlocksForSourceRequest(tx, {
        ...attribution, sourceRequestId: input.requestId, reason: input.reason, ...(deps.now ? { now: deps.now } : {}),
      })).removed.length;
    }

    return {
      ok: true,
      review: { id: row.id, status: row.status as BetaRiskReviewStatusValue, at: row.createdAt.toISOString() },
      blocklist: { blocked, removed },
    } as const;
  });
}

/** A request's verdict history, newest first, or null when the request does not exist. */
export async function loadBetaRiskReviewHistory(
  requestId: string,
  deps: { client?: BetaRiskDb } = {},
): Promise<BetaRiskReviewHistoryResponse | null> {
  const client = deps.client ?? systemDb;
  const request = await client.betaAccessRequest.findUnique({ where: { id: requestId }, select: { id: true } });
  if (!request) return null;
  const rows = await client.betaAccessRequestReview.findMany({
    where: { requestId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: BETA_RISK_REVIEW_HISTORY_CAP + 1,
    select: { id: true, status: true, reasonCode: true, note: true, createdAt: true, operatorId: true },
  });
  const capped = rows.length > BETA_RISK_REVIEW_HISTORY_CAP;
  const kept = rows.slice(0, BETA_RISK_REVIEW_HISTORY_CAP);
  const labels = await operatorLabels(client, kept.map((r) => r.operatorId));
  return {
    requestId,
    capped,
    reviews: kept.filter((r) => isBetaRiskReviewStatus(r.status)).map((r) => ({
      id: r.id,
      status: r.status as BetaRiskReviewStatusValue,
      reasonCode: r.reasonCode,
      note: r.note,
      at: r.createdAt.toISOString(),
      by: r.operatorId ? labels.get(r.operatorId) ?? null : null,
    })),
  };
}
