/**
 * lib/account-deletion/purge.ts  (OPS-2 S7c)
 *
 * The irreversible account-deletion purge orchestrator. Executes the pipeline
 * in the order ratified by the S5 decision record
 * (OPS2_S5_DELETION_INVENTORY.md §4) for a single user whose grace window has
 * elapsed. Called only by jobs/process-deletions.ts (the Vercel-cron job).
 *
 * Order (each step reuses an existing primitive / precedent):
 *   1. revoke sessions                    — revokeAllUserSessions (S1/S4)
 *   2. revoke provider connections        — disconnectPlaidItemIfOrphaned pattern
 *      (Plaid first; every item is orphaned by definition at full deletion —
 *      lib/plaid/disconnect.ts). Best-effort, logged, NEVER blocks the purge.
 *   3. revoke SALs the user added         — status REVOKED (account-DELETE route)
 *   4. canonical AccountConnection resolve — re-elect on SPACE-owned accounts (S5 §4c)
 *   5. delete USER-owned FinancialAccounts — explicit (ownerUserId SetNull ≠ cascade, S5 §4b)
 *   6. delete PERSONAL Space              — db.space.delete cascade (permanent-delete route)
 *   7. write ACCOUNT_DELETED audit         — audit-before-delete; survives anonymized (S5 §5)
 *   8. delete User                        — final cascade (S5 §1)
 *
 * External side-effects (Plaid itemRemove) run OUTSIDE any transaction (KD-4
 * rule). DB steps run sequentially and idempotently; a mid-purge failure leaves
 * the User row intact so the next daily cron run resumes cleanly — no retry
 * framework, the cron IS the retry.
 *
 * NO new schema. NO ownership transfer. NO queue/worker. Provider revocation is
 * Plaid-only today (MANUAL/WALLET Connections have nothing to revoke upstream).
 */

import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { revokeAllUserSessions } from "@/lib/sessions";
import { sendEmail } from "@/lib/email/send";
import { AuditAction } from "@/lib/audit-actions";
import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { ShareStatus, PlaidItemStatus, SpaceMemberRole, SpaceMemberStatus } from "@prisma/client";

export interface PurgeResult {
  userId:          string;
  purged:          boolean;
  skipped?:        "already-deleted" | "not-due";
  providerRevoked: number;
  providerFailed:  number;
  deletedAccounts: number;
  personalSpaces:  number;
}

export async function purgeUser(userId: string): Promise<PurgeResult> {
  const base: PurgeResult = {
    userId, purged: false, providerRevoked: 0, providerFailed: 0,
    deletedAccounts: 0, personalSpaces: 0,
  };

  // Load the minimal snapshot we need (email for the final notice + audit hash).
  const user = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, email: true, deletionScheduledAt: true },
  });
  if (!user) return { ...base, skipped: "already-deleted" };

  // Safety re-check: only purge accounts that are genuinely due. Guards the
  // cancel-vs-purge race — a cancellation clears deletionScheduledAt (S7a),
  // so a user cancelled between the cron's selection and here is skipped.
  if (!user.deletionScheduledAt || user.deletionScheduledAt > new Date()) {
    return { ...base, skipped: "not-due" };
  }

  const now = new Date();

  // ── 1. Revoke all sessions (idempotent) ────────────────────────────────────
  await revokeAllUserSessions(userId);

  // ── 2. Provider revocation — Plaid first, best-effort, OUTSIDE any tx ───────
  // At full-account deletion every PlaidItem is orphaned by definition, so we
  // apply lib/plaid/disconnect.ts's core (decrypt → itemRemove → mark REVOKED)
  // to each ACTIVE item directly. A failure is logged and counted, never fatal.
  const items = await db.plaidItem.findMany({
    where:  { userId, status: PlaidItemStatus.ACTIVE },
    select: { id: true, encryptedToken: true },
  });
  for (const item of items) {
    try {
      const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
      await plaidClient.itemRemove({ access_token: accessToken });
      base.providerRevoked++;
    } catch (err) {
      base.providerFailed++;
      console.error(`[purge] Plaid itemRemove failed for item ${item.id} (non-fatal):`, err);
    }
    // Mark REVOKED regardless — keeps state honest so a resumed run does not
    // re-attempt itemRemove on an already-removed item (the ACTIVE filter above).
    try {
      await db.plaidItem.update({ where: { id: item.id }, data: { status: PlaidItemStatus.REVOKED } });
    } catch { /* row will be cascade-deleted at step 8 regardless */ }
  }
  // MANUAL / WALLET Connections have nothing to revoke upstream (S5) — no-op.

  // ── 3. Revoke SALs the user added, in surviving Spaces ─────────────────────
  // status REVOKED (SAL doctrine); the S5 FK flip nulls addedByUserId harmlessly
  // when the User row is deleted. USER-owned accounts' SALs are removed outright
  // by their FinancialAccount delete in step 5.
  await db.spaceAccountLink.updateMany({
    where: { addedByUserId: userId, status: ShareStatus.ACTIVE },
    data:  { status: ShareStatus.REVOKED, revokedAt: now, revokedByUserId: userId },
  });

  // ── 4. Canonical AccountConnection resolution (SPACE-owned accounts) ────────
  // Where the user's connection is the authoritative (isCanonical) source for a
  // surviving SPACE-owned account, re-elect another live connection, else mark
  // the account stale. The account survives; the user's connection is cascade-
  // deleted at step 8. (S5 §4c.)
  const canonicalConns = await db.accountConnection.findMany({
    where: {
      connectedByUserId: userId,
      deletedAt:         null,
      isCanonical:       true,
      financialAccount:  { ownerType: "SPACE", deletedAt: null },
    },
    select: { id: true, financialAccountId: true },
  });
  for (const conn of canonicalConns) {
    const replacement = await db.accountConnection.findFirst({
      where:  { financialAccountId: conn.financialAccountId, deletedAt: null, connectedByUserId: { not: userId } },
      select: { id: true },
    });
    if (replacement) {
      await db.accountConnection.update({ where: { id: replacement.id }, data: { isCanonical: true } });
      await db.accountConnection.update({ where: { id: conn.id }, data: { isCanonical: false, deletedAt: now } });
    } else {
      await db.financialAccount.update({ where: { id: conn.financialAccountId }, data: { syncStatus: "stale" } });
      await db.accountConnection.update({ where: { id: conn.id }, data: { deletedAt: now } });
    }
  }

  // ── 5. Delete USER-owned FinancialAccounts (explicit — SetNull ≠ cascade) ──
  // Also covers any account owned by the user's PERSONAL Space, so step 6's
  // Space delete leaves no ownerless "ghost" account (S5 §4b). Deleting a
  // FinancialAccount cascades its transactions, holdings, connections,
  // debtProfile, provider identities, SALs, goal contributions and imports.
  // role: OWNER, status: ACTIVE — this purge runs for a user whose OWN account
  // is being permanently deleted; without this filter, ANY personal-type Space
  // this user was ever added to (even as a long-removed VIEWER, or — pre the
  // personal-space hardening fix — a still-active non-owner member) would
  // match and be deleted at step 6 below, destroying a Space that may belong
  // to someone else entirely. PERSONAL Spaces are enforced single-owner at
  // every mutation entry point now, so this should be a no-op in practice —
  // but this step is destructive and irreversible, so it gets the filter
  // regardless of what the invariant elsewhere promises.
  const personalSpaces = await db.space.findMany({
    where:  { type: "PERSONAL", members: { some: { userId, role: SpaceMemberRole.OWNER, status: SpaceMemberStatus.ACTIVE } } },
    select: { id: true },
  });
  const personalSpaceIds = personalSpaces.map((s) => s.id);

  const deleted = await db.financialAccount.deleteMany({
    where: { OR: [{ ownerUserId: userId }, { ownerSpaceId: { in: personalSpaceIds } }] },
  });
  base.deletedAccounts = deleted.count;

  // ── 6. Delete the PERSONAL Space (existing cascade) ────────────────────────
  // Cascades SpaceMember, SpaceInvite, AiAgent, AiAdvice, legacy Account,
  // SpaceGoal (+contributions/check-ins), SpaceDashboardSection, SpaceSnapshot,
  // ImportMappingProfile. Same cascade the permanent-delete route relies on.
  for (const s of personalSpaces) {
    await db.space.delete({ where: { id: s.id } });
  }
  base.personalSpaces = personalSpaces.length;

  // ── 7. ACCOUNT_DELETED audit (written BEFORE the delete) ───────────────────
  // userId is set now; the user delete below SetNulls it, so the row survives
  // anonymized (S5 §5). Email is stored only as a one-way hash — the raw
  // address must not persist on an anonymized row.
  const emailHash = createHash("sha256").update(user.email.toLowerCase()).digest("hex");
  await db.auditLog.create({
    data: {
      userId,
      action:   AuditAction.ACCOUNT_DELETED,
      metadata: {
        emailHash,
        deletedAccounts: base.deletedAccounts,
        personalSpaces:  base.personalSpaces,
        providerRevoked: base.providerRevoked,
        providerFailed:  base.providerFailed,
      },
    },
  });

  // Final notice — reuse the security-alert template. Sent BEFORE the User row
  // (and its email) is gone. NON-THROWING: delivery failure never blocks.
  const emailResult = await sendEmail("security-alert", user.email, {
    title:   "Your account has been deleted",
    message:
      `Your Fourth Meridian account and all associated data have been ` +
      `permanently deleted. This action cannot be undone. If you did not ` +
      `expect this, contact support.`,
  });
  if (emailResult.status === "error") {
    console.error("[purge] deletion-complete security-alert email failed to send:", emailResult.error);
  }

  // ── 8. Delete the User (final cascade) ─────────────────────────────────────
  await db.user.delete({ where: { id: userId } });

  base.purged = true;
  return base;
}
