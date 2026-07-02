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
import { AccountType, ShareStatus, DuplicateDetectionSource, DuplicateStatus, ProviderType } from "@prisma/client";
import { dualWriteSpaceAccountLink, resolveAccountCreatorUserId, type DbClient } from "@/lib/accounts/space-account-link";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";

/**
 * Lifecycle fix — docs/bugfixes/BUGFIX_PLAID_REFRESH_ORPHANED_PLAID_ITEMS.md,
 * Step A.
 *
 * Closes out a FinancialAccount's live AccountConnection rows once it has
 * been folded into a canonical duplicate by mergeArchivedDuplicateIntoCanonical
 * and is staying archived for good (mergeArchivedDuplicateIntoCanonical
 * itself never touches AccountConnection or PlaidItem — confirmed by
 * reading its full body — so every call site that archives a "loser" must
 * do this separately).
 *
 * Without this, a duplicate-merged account keeps a live AccountConnection
 * pointing at a still-ACTIVE PlaidItem indefinitely: lib/plaid/refresh.ts
 * has no deletedAt filter on FinancialAccount before calling Plaid, so an
 * orphaned PlaidItem like this gets refreshed forever and only ever
 * produces a "[plaid][D2-3E] ProviderAccountIdentity miss, legacy
 * plaidAccountId hit" warning instead of ever being skipped or revoked.
 * This was confirmed directly against two real accounts
 * (cmqqllcj6002inlk20bmuvval, cmqqllcmk002qnlk237wc3nce) — both archived,
 * both still carrying a plaidAccountId, both with no ProviderAccountIdentity
 * row, both still producing the warning on every refresh.
 *
 * Mirrors the existing pattern in app/api/accounts/[id]/route.ts's DELETE
 * handler: soft-delete the account's live connections, then disconnect any
 * PlaidItem that has zero live connections left as a result. Safe to call
 * on an account with no live connections (manual accounts, WALLET accounts,
 * or one already closed out) — it's then a no-op. Called unconditionally on
 * every losing candidate below, not just newly-archived ones — a candidate
 * that arrived already archived can still be carrying a live connection if
 * it was archived before this fix existed, which is exactly the bug above.
 */
async function closeOutAccountConnections(financialAccountId: string): Promise<void> {
  const liveConnections = await db.accountConnection.findMany({
    where:  { financialAccountId, deletedAt: null },
    select: { id: true, plaidItemDbId: true },
  });
  if (liveConnections.length === 0) return;

  await db.accountConnection.updateMany({
    where: { financialAccountId, deletedAt: null },
    data:  { deletedAt: new Date() },
  });

  const plaidItemDbIds = [...new Set(
    liveConnections.map((c) => c.plaidItemDbId).filter((id): id is string => !!id)
  )];
  for (const plaidItemDbId of plaidItemDbIds) {
    await disconnectPlaidItemIfOrphaned(plaidItemDbId);
  }
}

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
 *
 * D2 Step 3D — the PLAID branch resolves primarily via
 * ProviderAccountIdentity (provider=PLAID, externalAccountId=
 * identity.plaidAccountId) rather than FinancialAccount.plaidAccountId
 * directly, with a fallback to the legacy lookup if no identity row exists
 * yet. Fallback-first, not a hard replacement — mirrors Step 3C's
 * exchange-token cutover. See
 * docs/initiatives/d2/investigations/D2_STEP3A_PROVIDER_ACCOUNT_IDENTITY_READ_CUTOVER_INVESTIGATION.md
 * §B (Risk 1: coverage gaps) and §C (Step 3D). A fallback hit is logged so
 * coverage gaps are visible before the fallback is ever removed (Step 3G).
 * The WALLET branch is unchanged by this step.
 */
export async function findActiveAccountByIdentity(identity: ProviderIdentity, excludeId?: string) {
  if (identity.kind === "plaid") {
    // D2 Step 1D — findFirst, not findUnique: ProviderAccountIdentity's
    // unique key now includes financialAccountId (multiple FinancialAccounts
    // may share one externalAccountId), so (provider, externalAccountId)
    // alone is no longer a named unique key. PLAID's real uniqueness is
    // still guaranteed independently by FinancialAccount.plaidAccountId
    // @unique, so this is a type-shape change only, not a behavior change.
    const plaidIdentity = await db.providerAccountIdentity.findFirst({
      where: { provider: ProviderType.PLAID, externalAccountId: identity.plaidAccountId },
      include: { financialAccount: true },
    });

    if (plaidIdentity) {
      // plaidAccountId is globally unique at the DB level, so the linked
      // FinancialAccount is the same row the legacy lookup below would have
      // found — apply the same "active, not excluded" predicate to it
      // in-memory instead of a second query.
      const fa = plaidIdentity.financialAccount;
      const isExcluded = excludeId ? fa.id === excludeId : false;
      return fa.deletedAt === null && !isExcluded ? fa : null;
    }

    // No identity row — coverage gap. Fall back to the legacy lookup.
    const fallback = await db.financialAccount.findFirst({
      where: { plaidAccountId: identity.plaidAccountId, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (fallback) {
      console.warn(
        `[plaid][D2-3D] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fallback.id} externalAccountId=${identity.plaidAccountId}. Coverage gap; investigate before removing fallback.`
      );
    }
    return fallback;
  }

  return db.financialAccount.findFirst({
    where: {
      ownerUserId:   identity.ownerUserId,
      walletAddress: identity.walletAddress,
      deletedAt:     null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
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
 *
 * Every merge performed here is tagged DuplicateDetectionSource.
 * SIBLING_CONSOLIDATION — collapsing this candidate list to one row is the
 * same operation regardless of how the caller assembled the list (provider-
 * identity lookup or fingerprint match), so it gets its own source value
 * rather than inheriting the caller's.
 */
async function pickCanonicalAndMerge(
  candidates: FingerprintCandidate[],
  spaceId?: string | null
): Promise<FingerprintCandidate | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let canonical = candidates[0];
  let canonicalCount = -1;
  const counts = new Map<string, number>();

  for (const c of candidates) {
    // deletedAt: null — D2 Step 4D-R: a row soft-deleted by an import
    // rollback must not count as "history" when deciding which duplicate-
    // account candidate is canonical. See
    // docs/initiatives/d2/investigations/D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md §2.
    const count = await db.transaction.count({ where: { financialAccountId: c.id, deletedAt: null } });
    counts.set(c.id, count);
    if (count > canonicalCount) {
      canonical = c;
      canonicalCount = count;
    }
  }

  for (const c of candidates) {
    if (c.id === canonical.id) continue;
    // KD-4 Phase 2 — the merge and the active-loser archive must commit
    // together. Without one transaction, a failure between them could leave
    // the loser's history moved to the canonical row while the loser stays
    // active — a visible, empty duplicate (exactly the state this merge
    // exists to prevent). The merge reuses this tx rather than opening its own.
    await db.$transaction(async (tx) => {
      await mergeArchivedDuplicateIntoCanonical(c.id, canonical.id, DuplicateDetectionSource.SIBLING_CONSOLIDATION, spaceId, tx);
      if (!c.deletedAt) {
        // Was active under a different plaidAccountId — its history now lives
        // on the canonical row, so archive it to remove the duplicate from view.
        await tx.financialAccount.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
      }
    });
    // Lifecycle fix (Step A) — close out `c`'s own connections now that it's
    // being folded away as a loser, whether it was archived just above or
    // arrived already archived. See closeOutAccountConnections' doc comment.
    // External Plaid itemRemove — MUST stay OUTSIDE the transaction; runs
    // post-commit.
    await closeOutAccountConnections(c.id);
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
 *
 * `spaceId` is optional and only used to tag any DuplicateAccountCandidate
 * rows written by the archived→active fold below (DuplicateDetectionSource.
 * FINGERPRINT_MATCH) and by sibling consolidation; pass it when the caller
 * has a space in scope (e.g. the Plaid import route), omit it otherwise.
 */
export async function resolveAccountByFingerprint(
  fp: AccountFingerprint,
  excludeId?: string,
  spaceId?: string | null
): Promise<FingerprintResolution | null> {
  const [activeCandidates, archivedCandidates] = await Promise.all([
    findCandidatesByFingerprint(fp, null, excludeId),
    findCandidatesByFingerprint(fp, { not: null }, excludeId),
  ]);

  if (activeCandidates.length > 0) {
    const canonical = await pickCanonicalAndMerge(activeCandidates, spaceId);
    for (const a of archivedCandidates) {
      await mergeArchivedDuplicateIntoCanonical(a.id, canonical!.id, DuplicateDetectionSource.FINGERPRINT_MATCH, spaceId);
      // Lifecycle fix (Step A) — second gap, found on a full read of this
      // file while implementing the fix above: this loop folds already-
      // archived siblings into the canonical directly, without ever going
      // through pickCanonicalAndMerge's loop. Same reasoning applies — `a`
      // may still be carrying a live connection from before this fix existed.
      await closeOutAccountConnections(a.id);
    }
    return {
      canonical:              canonical!,
      matchedActive:          true,
      activeCandidateCount:   activeCandidates.length,
      archivedCandidateCount: archivedCandidates.length,
    };
  }

  if (archivedCandidates.length > 0) {
    const canonical = await pickCanonicalAndMerge(archivedCandidates, spaceId);
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
 *  - DuplicateAccountCandidate: an audit row is upserted on the
 *    (accountAId=winnerId, accountBId=loserId) unique key — winner/loser map
 *    directly to accountA/accountB by convention (see schema comment). First
 *    merge of a given pair creates the row (status CONFIRMED_DUPLICATE,
 *    detectionSource = `source`, detectedAt/resolvedAt = now, no
 *    resolvedByUserId — no human reviewed this); a later re-merge of the same
 *    pair (e.g. a second restore attempt on an already-merged loser) just
 *    bumps detectedAt rather than erroring on the unique constraint or
 *    inserting a second row. `spaceId` is optional — null when the caller
 *    has no space in scope (see schema comment on the field).
 */
export async function mergeArchivedDuplicateIntoCanonical(
  loserId: string,
  winnerId: string,
  source: DuplicateDetectionSource,
  spaceId?: string | null,
  client: DbClient = db,
) {
  if (loserId === winnerId) return;

  // KD-4 Phase 2 — the entire re-point / contribution-move / debt-move /
  // link-re-point / audit group below must commit or roll back together. When
  // called at the top level (client === db) we open our own interactive
  // transaction and re-enter with the tx client. When a caller already passes
  // a tx (e.g. pickCanonicalAndMerge, which bundles the loser-archive into the
  // same transaction), we reuse it — Prisma forbids nested interactive
  // transactions, so we must never open a second one here. External
  // side-effects (closeOutAccountConnections / Plaid itemRemove) live in the
  // callers and stay OUTSIDE this transaction.
  if (client === db) {
    await db.$transaction(async (tx) => {
      await mergeArchivedDuplicateIntoCanonical(loserId, winnerId, source, spaceId, tx);
    });
    return;
  }
  const tx = client;

  // Re-points ALL of the loser's transactions, including any soft-deleted by
  // an import rollback (Transaction.deletedAt) — intentionally NOT filtered
  // to deletedAt: null. A soft-deleted row must move with the rest of the
  // account's history, or it would be orphaned on the archived loser account
  // and could resurface incorrectly if that loser is ever individually
  // restored. This is the one Transaction call site the D2 Step 4D-R audit
  // identified as needing to keep ignoring deletedAt — see
  // docs/initiatives/d2/investigations/D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md §5.
  await tx.transaction.updateMany({
    where: { financialAccountId: loserId },
    data:  { financialAccountId: winnerId },
  });

  const loserContributions = await tx.goalContribution.findMany({
    where:  { financialAccountId: loserId },
    select: { id: true, goalId: true },
  });
  for (const c of loserContributions) {
    const collision = await tx.goalContribution.findUnique({
      where: { goalId_financialAccountId: { goalId: c.goalId, financialAccountId: winnerId } },
    });
    if (!collision) {
      await tx.goalContribution.update({ where: { id: c.id }, data: { financialAccountId: winnerId } });
    }
    // else: winner already has a contribution row for this goal — leave the
    // loser's row where it is. It's on an archived account, so it's inert.
  }

  const winnerDebtProfile = await tx.debtProfile.findUnique({ where: { financialAccountId: winnerId } });
  if (!winnerDebtProfile) {
    await tx.debtProfile.updateMany({
      where: { financialAccountId: loserId },
      data:  { financialAccountId: winnerId },
    });
  }

  // D3 Stage B2 — loser-share re-pointing migrated from WorkspaceAccountShare
  // to SpaceAccountLink. SpaceAccountLink is now the read and write target for
  // this merge path; WorkspaceAccountShare is no longer touched here.
  // `kind` is still recomputed per dualWriteSpaceAccountLink's Rule 1
  // (computeLinkKind), so the winner's first re-pointed link correctly becomes
  // HOME if it had none before the merge. Reads and writes here run on `tx`.
  const winnerCreatorUserId = await resolveAccountCreatorUserId(winnerId, tx);

  const loserLinks = await tx.spaceAccountLink.findMany({
    where:  { financialAccountId: loserId },
    select: { spaceId: true, addedByUserId: true, visibilityLevel: true },
  });
  for (const l of loserLinks) {
    await dualWriteSpaceAccountLink({
      spaceId:            l.spaceId,
      financialAccountId: winnerId,
      creatorUserId:      winnerCreatorUserId,
      client:             tx,
      create: {
        addedByUserId:   l.addedByUserId,
        visibilityLevel: l.visibilityLevel,
        status:          ShareStatus.ACTIVE,
      },
      update: {
        status:          ShareStatus.ACTIVE,
        revokedAt:       null,
        revokedByUserId: null,
      },
    });
  }

  const now = new Date();
  await tx.duplicateAccountCandidate.upsert({
    where: { accountAId_accountBId: { accountAId: winnerId, accountBId: loserId } },
    update: { detectedAt: now },
    create: {
      accountAId:       winnerId,
      accountBId:       loserId,
      status:           DuplicateStatus.CONFIRMED_DUPLICATE,
      detectionSource:  source,
      detectedAt:       now,
      resolvedAt:       now,
      resolvedByUserId: null,
      spaceId:          spaceId ?? null,
    },
  });
}
