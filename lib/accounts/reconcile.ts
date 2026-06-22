/**
 * lib/accounts/reconcile.ts
 *
 * Centralised "automatic duplicate reconciliation" for FinancialAccount rows.
 *
 * Goal: a user should never end up with two visible rows for the same
 * imported account, and never see a duplicate / 409-conflict message. This
 * module finds an existing account by provider identity and, when an
 * archived row collides with an already-active one, folds the archived
 * row's history (transactions, goal contributions, debt profile, space
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
 * reissue a new account_id for the same real-world account on every
 * reconnect (observed directly: three FinancialAccount rows for the same
 * Robinhood account over time, same institution/mask/officialName/type,
 * three different plaidAccountId values). When an exact provider-identity
 * match fails, callers fall back to resolveAccountByFingerprint, which
 * matches on fields that don't change across a reissued id: institutionId
 * OR institution, mask, type, and officialName OR plaidName OR name — all
 * compared case-insensitively and trimmed.
 *
 * Unlike a single exact-match lookup, this fallback must tolerate *more
 * than one* stale archived row matching the same fingerprint (every past
 * relink leaves one behind), and the rare case where more than one row is
 * simultaneously active. It picks a single canonical row (most linked
 * transaction history, tie-broken by oldest createdAt), folds every other
 * matching row's history into it, and returns that one row — so repeated
 * relinks converge on a single canonical account no matter how many stale
 * rows accumulated before the fix landed.
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
  ownerUserId:    string | null;
  institutionId?: string | null;
  institution?:   string | null;
  mask:           string | null;
  officialName?:  string | null;
  plaidName?:     string | null;
  name?:          string | null;
  type:           AccountType;
};

type FingerprintCandidate = {
  id:             string;
  createdAt:      Date;
  deletedAt:      Date | null;
  plaidAccountId: string | null;
};

const CANDIDATE_SELECT = { id: true, createdAt: true, deletedAt: true, plaidAccountId: true } as const;

function cleanStr(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length ? t : null;
}

/**
 * Finds all FinancialAccount rows matching a fingerprint (institutionId-or-
 * institution + mask + type + officialName-or-plaidName-or-name, all
 * case-insensitive/trimmed). Requires mask, at least one institution field,
 * and at least one name field — without those this would match too loosely.
 * Returns every match (zero, one, or many) rather than enforcing uniqueness
 * itself; callers decide how to reduce multiple matches to one canonical row.
 */
async function findCandidatesByFingerprint(
  fp: AccountFingerprint,
  deletedAt: null | { not: null },
  excludeId?: string
): Promise<FingerprintCandidate[]> {
  const mask = cleanStr(fp.mask);
  if (!mask) return [];

  const institutionOr = [
    ...(cleanStr(fp.institutionId) ? [{ institutionId: { equals: cleanStr(fp.institutionId)!, mode: "insensitive" as const } }] : []),
    ...(cleanStr(fp.institution)   ? [{ institution:   { equals: cleanStr(fp.institution)!,   mode: "insensitive" as const } }] : []),
  ];
  if (institutionOr.length === 0) return [];

  const nameOr = [
    ...(cleanStr(fp.officialName) ? [{ officialName: { equals: cleanStr(fp.officialName)!, mode: "insensitive" as const } }] : []),
    ...(cleanStr(fp.plaidName)    ? [{ plaidName:     { equals: cleanStr(fp.plaidName)!,    mode: "insensitive" as const } }] : []),
    ...(cleanStr(fp.name)         ? [{ name:          { equals: cleanStr(fp.name)!,         mode: "insensitive" as const } }] : []),
  ];
  if (nameOr.length === 0) return [];

  return db.financialAccount.findMany({
    where: {
      ...(fp.ownerUserId ? { ownerUserId: fp.ownerUserId } : {}),
      type: fp.type,
      deletedAt,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      mask: { equals: mask, mode: "insensitive" },
      AND: [{ OR: institutionOr }, { OR: nameOr }],
    },
    select: CANDIDATE_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Reduces a list of fingerprint-matched rows to one canonical row: the one
 * with the most linked transaction history, tie-broken by oldest createdAt
 * (candidates arrive pre-sorted oldest-first, so the first row encountered
 * at the max count wins ties). Every other row's history is folded into the
 * winner via mergeArchivedDuplicateIntoCanonical. If a losing row happens to
 * still be active (deletedAt null) — possible if more than one row was
 * simultaneously active under different plaidAccountIds — it is archived
 * after its history is migrated so it stops appearing as a second visible
 * account. No row is ever hard-deleted.
 */
async function pickCanonicalAndMerge(candidates: FingerprintCandidate[]): Promise<FingerprintCandidate | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let canonical = candidates[0];
  let canonicalCount = -1;
  const counts = new Map<string, number>();

  for (const c of candidates) {
    const count = await db.transaction.count({ where: { financialAccountId: c.id } });
    counts.set(c.id, count);
    if (count > canonicalCount) {
      canonical = c;
      canonicalCount = count;
    }
  }

  for (const c of candidates) {
    if (c.id === canonical.id) continue;
    await mergeArchivedDuplicateIntoCanonical(c.id, canonical.id);
    if (!c.deletedAt) {
      // Was active under a different plaidAccountId — its history now lives
      // on the canonical row, so archive it to remove the duplicate from view.
      await db.financialAccount.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    }
  }

  return canonical;
}

export type FingerprintResolution = {
  canonical:              FingerprintCandidate;
  matchedActive:          boolean;
  activeCandidateCount:   number;
  archivedCandidateCount: number;
};

/**
 * Resolves a fingerprint to a single canonical account across however many
 * stale archived rows and/or simultaneously-active rows currently match it.
 *
 *  - If any active row matches, it (or the most-historical active match, if
 *    several do) is canonical — every archived match is folded into it.
 *  - Otherwise, if archived rows match, the most-historical one is canonical
 *    — every other archived match is folded into it.
 *  - If nothing matches, returns null and the caller should create a new row.
 */
export async function resolveAccountByFingerprint(
  fp: AccountFingerprint,
  excludeId?: string
): Promise<FingerprintResolution | null> {
  const [activeCandidates, archivedCandidates] = await Promise.all([
    findCandidatesByFingerprint(fp, null, excludeId),
    findCandidatesByFingerprint(fp, { not: null }, excludeId),
  ]);

  if (activeCandidates.length > 0) {
    const canonical = await pickCanonicalAndMerge(activeCandidates);
    for (const a of archivedCandidates) {
      await mergeArchivedDuplicateIntoCanonical(a.id, canonical!.id);
    }
    return {
      canonical:              canonical!,
      matchedActive:          true,
      activeCandidateCount:   activeCandidates.length,
      archivedCandidateCount: archivedCandidates.length,
    };
  }

  if (archivedCandidates.length > 0) {
    const canonical = await pickCanonicalAndMerge(archivedCandidates);
    return {
      canonical:              canonical!,
      matchedActive:          false,
      activeCandidateCount:   0,
      archivedCandidateCount: archivedCandidates.length,
    };
  }

  return null;
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
 *  - WorkspaceAccountShare: every space the loser was shared into gets
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
      // WorkspaceAccountShare keeps its own pre-Phase-1 field/key names.
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
