/**
 * lib/platform/growth/invitation-issue.ts  (PR B · ONE issuance mechanism)
 *
 * THE ONLY CODE THAT MINTS A BETA INVITATION. The queue's Approve, the Resend
 * (reissue) action and the operator's direct invite are thin route wrappers
 * over `issueBetaInvitation`; Extend is `extendBetaInvitation`. Before this,
 * each route repeated the token mint, its own TTL constant (they disagreed), the
 * URL build, the send and the audit, with different concurrency guarantees
 * (audit §3.8, E-1..E-4, E-6, E-17).
 *
 * ── ORDER, AND WHY ────────────────────────────────────────────────────────────
 *   1. VALIDITY   the operator's override (refused outside 1–30) or the
 *                 `beta_invitation_validity_days` setting. `issuedAt` is read
 *                 from the clock ONCE; `expiresAt = issuedAt + days × 24 h`
 *                 (UTC epoch arithmetic). The email states exactly these two.
 *   2. PLAN       the pure rules in invitation-issue.core.ts, over the row and
 *                 whether the address already has an account.
 *   3. ONE TRANSACTION — the row write is CONDITIONAL (approve: status IN
 *                 (PENDING, DENIED); reissue: status APPROVED AND the token hash
 *                 observed; create: the unique email), and the issuance audit row
 *                 (validityDays, expiresAt, emailHash — never the token) commits
 *                 with it or not at all. The loser of a race writes nothing and
 *                 is told so; it never mints, never emails.
 *   4. EMAIL      after commit, from the trusted env base (never a Host header),
 *                 with PR #157's origin copy. Non-throwing: a failed hand-off is
 *                 recorded, the invitation stands and can be resent.
 *   5. OUTCOME    the hand-off result is appended as BETA_INVITATION_EMAIL_OUTCOME
 *                 { betaRequestId, emailHash, emailStatus } — the shape the
 *                 Growth list and Customer detail read. The audit log stays
 *                 append-only: the issuance row is never edited after commit.
 *
 * ⚠️ THE RAW TOKEN exists only in this function's memory and in the URL handed
 * to the email. It is never returned, logged, audited or stored (only its
 * SHA-256, the password-reset pattern).
 *
 * The client is a PARAMETER: authority follows the caller (RLS-13).
 */

import "server-only";
import crypto from "crypto";
import { BetaAccessRequestStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { hashResetToken } from "@/lib/password-reset-token";
import { sendEmail } from "@/lib/email/send";
import { buildBetaInviteUrl } from "@/lib/email/beta-invite-url";
import type { BetaInviteOrigin } from "@/lib/email/templates/beta-invite";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import { auditEmailHash, recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import { readInvitationPolicy } from "./invitation-policy";
import {
  expiryFor, normaliseInviteEmail, parseValidityDays, planApprove, planDirect, planExtend, planReissue, refusal,
  type InviteRowFacts, type IssueKind, type IssuePlan, type IssueRefusal,
} from "./invitation-issue.core";

export type IssueClient = Pick<
  PrismaClient,
  "$transaction" | "betaAccessRequest" | "betaAccessRequestEvent" | "user" | "auditLog" | "platformSetting"
>;

export type EmailStatus = "sent" | "captured" | "skipped" | "error";

export interface IssueInput {
  client: IssueClient;
  actor: OperatorActionInput["actor"];
  kind: IssueKind;
  /** approve / reissue: the BetaAccessRequest id. */
  requestId?: string;
  /** direct: the invitee address (normalised here). */
  email?: unknown;
  /** The operator's per-invitation override; absent ⇒ the setting. Validated 1–30. */
  validityDays?: unknown;
  /**
   * reissue: the `invitedAt` (ISO) the operator's screen showed. When given, the
   * rotation is also conditional on it, so a SEQUENTIAL double-click (the second
   * request read after the first committed) sends one email, not two.
   */
  expectedInvitedAt?: unknown;
  reason?: OperatorReason;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Test seam — the ONE clock read. */
  now?: Date;
}

export type IssueResult =
  | {
      ok: true; outcome: "issued";
      requestId: string;
      /** What was actually done to the row (direct resolves to one of these). */
      performed: "approve" | "reissue" | "create";
      validityDays: number;
      issuedAt: Date;
      expiresAt: Date;
      emailStatus: EmailStatus;
    }
  | { ok: true; outcome: "alreadyApproved"; requestId: string }
  | { ok: true; outcome: "alreadyReissued"; requestId: string }
  | ({ ok: false } & IssueRefusal);

const ROW_SELECT = { id: true, email: true, status: true, inviteTokenHash: true, inviteExpiresAt: true, invitedAt: true } as const;

const refuse = (r: IssueRefusal): IssueResult => ({ ok: false, ...r });

async function loadRow(client: IssueClient, where: { id: string } | { email: string }): Promise<InviteRowFacts | null> {
  const row = await client.betaAccessRequest.findUnique({ where, select: ROW_SELECT });
  return row ? { ...row, status: row.status as InviteRowFacts["status"] } : null;
}

async function accountExists(client: IssueClient, email: string): Promise<boolean> {
  return (await client.user.findUnique({ where: { email }, select: { id: true } })) != null;
}

/**
 * Which copy a REISSUED email uses (PR #157, unchanged): "direct" only on positive
 * evidence that the row came from an operator's direct invite with no request
 * behind it — a BETA_INVITATION_CREATED row, no BETA_ACCESS_APPROVED row, and no
 * recorded form submission. Anything else is "request", the historical copy.
 */
async function inviteOrigin(client: IssueClient, id: string, email: string): Promise<BetaInviteOrigin> {
  const byRequest = (action: string) => ({ action, metadata: { path: ["betaRequestId"], equals: id } });
  const [created, approved, submissions] = await Promise.all([
    client.auditLog.findFirst({ where: byRequest(AuditAction.BETA_INVITATION_CREATED), select: { id: true } }),
    client.auditLog.findFirst({ where: byRequest(AuditAction.BETA_ACCESS_APPROVED), select: { id: true } }),
    client.betaAccessRequestEvent.count({ where: { email } }),
  ]);
  return created && !approved && submissions === 0 ? "direct" : "request";
}

export async function issueBetaInvitation(input: IssueInput): Promise<IssueResult> {
  const { client } = input;
  const now = input.now ?? new Date(); // issuedAt — read ONCE

  // 1. Validity: the override, bounded server-side, or the one policy.
  let validityDays: number;
  let validitySource: "override" | "setting";
  if (input.validityDays !== undefined && input.validityDays !== null) {
    const p = parseValidityDays(input.validityDays);
    if (!p.ok) return refuse(refusal("INVALID_VALIDITY", p.reason));
    validityDays = p.days;
    validitySource = "override";
  } else {
    validityDays = (await readInvitationPolicy(client)).validityDays;
    validitySource = "setting";
  }
  const expiresAt = expiryFor(now, validityDays);

  // 2. Plan.
  let plan: IssuePlan;
  let email: string;
  if (input.kind === "direct") {
    const e = normaliseInviteEmail(input.email);
    if (!e) return refuse(refusal("INVALID_EMAIL"));
    email = e;
    plan = planDirect(await loadRow(client, { email }), await accountExists(client, email), now);
  } else {
    const row = input.requestId ? await loadRow(client, { id: input.requestId }) : null;
    email = row?.email ?? "";
    const hasAccount = row ? await accountExists(client, row.email) : false;
    plan = input.kind === "approve" ? planApprove(row, hasAccount) : planReissue(row, hasAccount);
  }
  if (plan.action === "refuse") return refuse(plan.refusal);
  if (plan.action === "alreadyApproved") return { ok: true, outcome: "alreadyApproved", requestId: plan.row.id };

  // The operator's observed issue time (reissue only): already moved ⇒ someone
  // (or the first click) reissued since the screen was drawn — nothing to do.
  let expectedInvitedAt: Date | null | undefined;
  if (plan.action === "reissue" && input.kind === "reissue" && input.expectedInvitedAt !== undefined) {
    if (input.expectedInvitedAt === null) expectedInvitedAt = null;
    else if (typeof input.expectedInvitedAt === "string" && Number.isFinite(Date.parse(input.expectedInvitedAt))) {
      expectedInvitedAt = new Date(input.expectedInvitedAt);
    } else {
      return refuse(refusal("CONFLICT", "expectedInvitedAt must be the ISO instant the invitation showed, or null."));
    }
    const seen = plan.row.invitedAt?.getTime() ?? null;
    if (seen !== (expectedInvitedAt?.getTime() ?? null)) return { ok: true, outcome: "alreadyReissued", requestId: plan.row.id };
  }

  // 3. Mint + the conditional write + its audit, in one transaction.
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(rawToken);
  const issued = { inviteTokenHash: tokenHash, inviteExpiresAt: expiresAt, invitedAt: now };
  const action: AuditActionType =
    plan.action === "approve" ? AuditAction.BETA_ACCESS_APPROVED
    : plan.action === "reissue" ? AuditAction.BETA_INVITATION_RESENT
    : AuditAction.BETA_INVITATION_CREATED;

  const audit = (tx: Prisma.TransactionClient, id: string, before: InviteRowFacts | null) =>
    recordOperatorAction(tx, {
      actor: input.actor,
      action,
      target: { kind: "BETA_REQUEST", id },
      ...(input.reason ? { reason: input.reason } : {}),
      change: {
        before: before ? { status: before.status, inviteExpiresAt: before.inviteExpiresAt?.toISOString() ?? null } : null,
        after:  { status: BetaAccessRequestStatus.APPROVED, inviteExpiresAt: expiresAt.toISOString() },
      },
      result: "SUCCESS",
      // Never the token, never the address: the hash of the email only.
      detail: {
        betaRequestId: id, emailHash: auditEmailHash(email), kind: input.kind,
        validityDays, validitySource, issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
        // Legacy key the direct-invite audit always carried.
        expiresDays: validityDays,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

  const { requestId, won } = await client.$transaction(async (tx) => {
    if (plan.action === "create") {
      // ON CONFLICT (email) DO NOTHING: a concurrent create for the same
      // address makes this count 0 — never a raised P2002, which in Postgres
      // would abort the transaction. The id is minted here so the audit can
      // name the row without a second read.
      const id = crypto.randomUUID();
      const { count } = await tx.betaAccessRequest.createMany({
        data: [{ id, email, status: BetaAccessRequestStatus.APPROVED, ...issued, decidedAt: now, decidedById: input.actor.userId }],
        skipDuplicates: true,
      });
      if (count !== 1) return { requestId: id, won: false };
      await audit(tx, id, null);
      return { requestId: id, won: true };
    }
    const row = plan.row;
    const { count } = plan.action === "approve"
      ? await tx.betaAccessRequest.updateMany({
          where: { id: row.id, status: { in: [BetaAccessRequestStatus.PENDING, BetaAccessRequestStatus.DENIED] } },
          data:  { status: BetaAccessRequestStatus.APPROVED, ...issued, decidedAt: now, decidedById: input.actor.userId },
        })
      : await tx.betaAccessRequest.updateMany({
          // Optimistic on the hash observed: a concurrent reissue (or a revoke,
          // which nulls it and flips DENIED) makes this match nothing.
          where: {
            id: row.id, status: BetaAccessRequestStatus.APPROVED, inviteTokenHash: plan.expectedHash,
            ...(expectedInvitedAt !== undefined ? { invitedAt: expectedInvitedAt } : {}),
          },
          data:  issued,
        });
    if (count !== 1) return { requestId: row.id, won: false };
    await audit(tx, row.id, row);
    return { requestId: row.id, won: true };
  });

  if (!won) {
    // Lost the race: say what the winner left behind; nothing was minted or sent.
    if (plan.action === "create") {
      // A concurrent create for the same address won the unique email.
      const again = planDirect(await loadRow(client, { email }), false, now);
      return refuse(again.action === "refuse" ? again.refusal : refusal("CONFLICT"));
    }
    const after = await loadRow(client, { id: requestId });
    if (plan.action === "approve") {
      if (after?.status === BetaAccessRequestStatus.APPROVED) return { ok: true, outcome: "alreadyApproved", requestId };
      return refuse(after?.status === BetaAccessRequestStatus.REDEEMED ? refusal("REDEEMED") : refusal("CONFLICT"));
    }
    if (after?.status === BetaAccessRequestStatus.APPROVED) return { ok: true, outcome: "alreadyReissued", requestId };
    return refuse(refusal("NOT_APPROVED"));
  }

  // 4. Email, after commit.
  const origin: BetaInviteOrigin =
    plan.action === "create" ? "direct"
    : plan.action === "approve" ? "request"
    : await inviteOrigin(client, requestId, email);
  const inviteUrl = buildBetaInviteUrl(env.NEXT_PUBLIC_APP_URL, rawToken);
  const emailResult = await sendEmail("beta-invite", email, { inviteUrl, issuedAt: now, expiresAt, origin });
  if (emailResult.status === "error") {
    console.error(`[beta-invite:${plan.action}] invite email failed to send:`, emailResult.error);
  }

  // 5. The hand-off outcome, appended. A failure here must not answer 500: the
  // invitation committed and the email left, and a retry would send a second one.
  try {
    await recordOperatorAction(client, {
      actor: input.actor,
      action: AuditAction.BETA_INVITATION_EMAIL_OUTCOME,
      target: { kind: "BETA_REQUEST", id: requestId },
      result: emailResult.status === "error" ? "FAILURE" : "SUCCESS",
      detail: { betaRequestId: requestId, emailHash: auditEmailHash(email), emailStatus: emailResult.status, issuance: action },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (err) {
    console.error(`[beta-invite:${plan.action}] email outcome not recorded:`, err instanceof Error ? err.name : "error");
  }

  return {
    ok: true, outcome: "issued", requestId, performed: plan.action,
    validityDays, issuedAt: now, expiresAt, emailStatus: emailResult.status,
  };
}

// ── Extend: move the expiry, KEEP the token, send nothing ─────────────────────

export interface ExtendInput {
  client: Pick<PrismaClient, "$transaction" | "betaAccessRequest" | "auditLog">;
  actor: OperatorActionInput["actor"];
  requestId: string;
  validityDays: unknown;
  reason: OperatorReason;
  ipAddress?: string | null;
  userAgent?: string | null;
  now?: Date;
}

export type ExtendResult =
  | { ok: true; requestId: string; validityDays: number; previousExpiresAt: Date | null; expiresAt: Date }
  | ({ ok: false } & IssueRefusal);

export async function extendBetaInvitation(input: ExtendInput): Promise<ExtendResult> {
  const { client } = input;
  const now = input.now ?? new Date();
  const p = parseValidityDays(input.validityDays);
  if (!p.ok) return { ok: false, ...refusal("INVALID_VALIDITY", p.reason) };
  const expiresAt = expiryFor(now, p.days);

  const row = await client.betaAccessRequest.findUnique({ where: { id: input.requestId }, select: ROW_SELECT });
  const plan = planExtend(row ? { ...row, status: row.status as InviteRowFacts["status"] } : null);
  if (plan.action === "refuse") return { ok: false, ...plan.refusal };
  const facts = plan.row;

  const won = await client.$transaction(async (tx) => {
    const { count } = await tx.betaAccessRequest.updateMany({
      // Conditional on what was read: still APPROVED, same token, same expiry.
      where: {
        id: facts.id, status: BetaAccessRequestStatus.APPROVED,
        inviteTokenHash: facts.inviteTokenHash, inviteExpiresAt: facts.inviteExpiresAt,
      },
      data: { inviteExpiresAt: expiresAt },
    });
    if (count !== 1) return false;
    await recordOperatorAction(tx, {
      actor: input.actor,
      action: AuditAction.BETA_INVITATION_EXTENDED,
      target: { kind: "BETA_REQUEST", id: facts.id },
      reason: input.reason,
      change: {
        before: { inviteExpiresAt: facts.inviteExpiresAt?.toISOString() ?? null },
        after:  { inviteExpiresAt: expiresAt.toISOString() },
      },
      result: "SUCCESS",
      detail: { betaRequestId: facts.id, emailHash: auditEmailHash(facts.email), validityDays: p.days, tokenRotated: false },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    return true;
  });
  if (!won) return { ok: false, ...refusal("CONFLICT") };
  return { ok: true, requestId: facts.id, validityDays: p.days, previousExpiresAt: facts.inviteExpiresAt, expiresAt };
}
