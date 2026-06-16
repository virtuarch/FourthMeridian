/**
 * lib/accounts/reconcile.ts
 *
 * Centralised "automatic duplicate reconciliation" for FinancialAccount rows.
 *
 * Goal: a user should never end up with two visible rows for the same
 * imported account, and never see a duplicate / 409-conflict message. This
 * module finds an existing account by provider identity and, when an
 * archived row collides with an already-active one, folds the archived
 * row's history (transactions, goal contributions, debt profile, workspace
 * shares) into the active "canonical" row instead of creating or restoring
 * a second visible record.
 *
 * Today the only provider identities are Plaid (plaidAccountId — globally
 * @unique at the DB level already) and crypto wallets (walletAddress —
 * unique per owner only, no DB constraint). Both are expressed through
 * ProviderIdentity so a future provider can plug in without changing
 * callers — see app/api/plaid/exchange-token/route.ts and
 * app/api/accounts/wallet/route.ts for the two current call sites, plus the
 * restore routes in app/api/accounts/[id]/restore and
 * app/api/accounts/manual/[id]/restore.
 *
 * NEVER hard-deletes a FinancialAccount row. The losing/archived row keeps
 * its deletedAt as-is after its history is migrated — audit logs,
 * AccountConnection rows, and the row itself are preserved. Only its
 * *visible* duplication (a second active account) is resolved.
 *
 * FINGERPRINT FALLBACK
 * ---------------------
 * plaidAccountId is not actually permanent in every case — Plaid can
 * reissue a new account_id for the same real-world account on reconnect
 * (observed directly: two FinancialAccount rows for the same Robinhood
 * account, same institutionId/mask/officialName/type, different
 * plaidAccountId). When an exact provider-identity match fails, callers
 * should fall back to findArchivedAccountByFingerprint /
 * findActiveAccountByFingerprint, which match on fields that don't change
 * across a reissued id: institutionId, mask, type, and officialName-or-
 * plaidName. Deliberately conservative — returns a match only when exactly
 * one candidate fits; zero or multiple candidates return null so the
 * caller falls back to creating a new row rather than guessing.
 */

import { db } from "@/lib/db";
import { AccountType, ShareStatus } from "@prisma/client";

export type ProviderIdentity =
  | { kind: "plaid"; plaidAccountId: string }
  | { kind: "wallet"; ownerUserId: string; walletAddress: string };

/** Extracts the provider identity from a FinancialAccount row, if it has one. */
export function providerIdentityOf(fa: {
  plaidAccountId: string | null;
  walletAddress?:  string | null;
  ownerUserId:     string | null;
}): ProviderIdentity | null {
  if (fa.plaidAccountId) return { kind: "plaid", plaidAccountId: fa.plaidAccountId };
  if (fa.walletAddress && fa.ownerUserId) {
    return { kind: "wallet", ownerUserId: fa.ownerUserId, walletAddress: fa.walletAddress };
  }
  return null;
}

/**
 * Finds an existing ACTIVE FinancialAccount sharing the given provider
 * identity, excluding `excludeId` (typically the row we're about to
 * restore/reconnect).
 */
export async function findActiveAccountByIdentity(identity: ProviderIdentity, excludeId?: string) {
  const where =
    identity.kind === "plaid"
      ? { plaidAccountId: identity.plaidAccountId }
      : { ownerUserId: identity.ownerUserId, walletAddress: identity.walletAddress };

  return db.financialAccount.findFirst({
    where: { ...where, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
}

export type AccountFingerprint = {
  ownerUserId:   string | null;
  institutionId: string | null;
  mask:          string | null;
  officialName?: string | null;
  plaidName?:    string | null;
  type:          AccountType;
};

async function findAccountByFingerprint(fp: AccountFingerprint, deletedAt: null | { not: null }) {
  // institutionId + mask are required — without both, matching is too loose
  // to trust automatically.
  if (!fp.institutionId || !fp.mask) return null;

  const nameOr = [
    ...(fp.officialName ? [{ officialName: fp.officialName }] : []),
    ...(fp.plaidName    ? [{ plaidName: fp.plaidName }]       : []),
  ];
  if (nameOr.length === 0) return null;

  const candidates = await db.financialAccount.findMany({
    where: {
      ...(fp.ownerUserId ? { ownerUserId: fp.ownerUserId } : {}),
      institutionId: fp.institutionId,
      mask:          fp.mask,
      type:          fp.type,
      deletedAt,
      OR: nameOr,
    },
  });

  // Conservative: only act when exactly one candidate matches. Zero or
  // multiple matches return null so the caller creates a new row / restores
  // normally instead of guessing which account is the "real" match.
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Fallback for Plaid reconnect when plaidAccountId has no exact match:
 * finds a soft-deleted account that is almost certainly the same real-world
 * account under a reissued plaidAccountId.
 */
export async function findArchivedAccountByFingerprint(fp: AccountFingerprint) {
  return findAccountByFingerprint(fp, { not: null });
}

/**
 * Fallback for restore when no exact provider-identity match is active:
 * finds an active account that is almost certainly the same real-world
 * account as the archived row being restored.
 */
export async function findActiveAccountByFingerprint(fp: AccountFingerprint) {
  return findAccountByFingerprint(fp, null);
}

/**
 * Folds `loserId`'s history into `winnerId` and leaves `loserId` archived
 * (its deletedAt is never cleared, and it is never hard-deleted). Call this
 * instead of restoring/reactivating `loserId` when a canonical active
 * account already exists for the same provider identity.
 *
 *  - Transactions: re-pointed to winner. Safe to bulk re-point — Transaction's
 *    only uniqueness (plaidTransactionId) is per-row, not per-account.
 *  - GoalContributions: re-pointed to winner, skipping any that would
 *    collide with the (goalId, financialAccountId) unique constraint
 *    because winner already tracks that goal — the loser's row is left in
 *    place, inert, rather than erroring.
 *  - DebtProfile: moved to winner only if winner doesn't already have one
 *    (it's a strict 1:1) — otherwise left on the archived loser, inert.
 *  - WorkspaceAccountShare: every workspace the loser was shared into gets
 *    an ACTIVE share pointing at the winner instead, so the user keeps
 *    seeing the account wherever they previously added it.
 */
export async function mergeArchivedDuplicateIntoCanonical(loserId: string, winnerId: string) {
  if (loserId === winnerId) return;

  await db.transaction.updateMany({
    where: { financialAccountId: loserId },
    data:  { financialAccountId: winnerId },
  });

  const loserContributions = await db.goalContribution.findMany({
    where:  { financialAccountId: loserId },
    select: { id: true, goalId: true },
  });
  for (const c of loserContributions) {
    const collision = await db.goalContribution.findUnique({
      where: { goalId_financialAccountId: { goalId: c.goalId, financialAccountId: winnerId } },
    });
    if (!collision) {
      await db.goalContribution.update({ where: { id: c.id }, data: { financialAccountId: winnerId } });
    }
    // else: winner already has a contribution row for this goal — leave the
    // loser's row where it is. It's on an archived account, so it's inert.
  }

  const winnerDebtProfile = await db.debtProfile.findUnique({ where: { financialAccountId: winnerId } });
  if (!winnerDebtProfile) {
    await db.debtProfile.updateMany({
      where: { financialAccountId: loserId },
      data:  { financialAccountId: winnerId },
    });
  }

  const loserShares = await db.workspaceAccountShare.findMany({ where: { financialAccountId: loserId } });
  for (const s of loserShares) {
    await db.workspaceAccountShare.upsert({
      where:  { workspaceId_financialAccountId: { workspaceId: s.workspaceId, financialAccountId: winnerId } },
      update: { status: ShareStatus.ACTIVE, revokedAt: null, revokedByUserId: null },
      create: {
        workspaceId:         s.workspaceId,
        financialAccountId:  winnerId,
        addedByUserId:       s.addedByUserId,
        visibilityLevel:     s.visibilityLevel,
        status:              ShareStatus.ACTIVE,
      },
    });
  }
}
