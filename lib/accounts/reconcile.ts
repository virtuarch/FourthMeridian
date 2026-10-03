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
 *
 * ── RLS-ACC-S5 — THE AUTHORITY IS THE CALLER'S, WITH TWO NAMED EXCEPTIONS ──
 * Every function here takes its client as a parameter. The reads take it
 * REQUIRED AND LEADING, so the compiler enumerates their call sites and each one
 * states the authority it executes under instead of inheriting one from this
 * module. Three parameter types are used and they are not interchangeable:
 *
 *   ReadClient    the pure lookups (findActiveAccountByIdentity,
 *                 resolvePlaidAccountByExternalId, findCandidatesByFingerprint).
 *                 Prisma's ITXClientDenyList strips the transaction opener from
 *                 this type, so a read leaf is STRUCTURALLY incapable of opening
 *                 a phase of its own.
 *   PrismaClient  closeOutAccountConnections / pickCanonicalAndMerge /
 *                 resolveAccountByFingerprint. A ROOT client, and required to be
 *                 one BY THE COMPILER: these interleave a provider HTTP call
 *                 (closeOutAccountConnections → disconnectPlaidItemIfOrphaned →
 *                 Plaid itemRemove) BETWEEN their transactions. Handed a phase
 *                 client they would put that round trip inside somebody else's
 *                 open transaction, which withTenantDb's contract forbids. A
 *                 Prisma.TransactionClient has no `$transaction`, so it is not
 *                 assignable here and the mistake does not compile.
 *   DbClient      the merge, and only the merge. It must accept both, because
 *                 its `"$transaction" in client` capability test (RLS-7) is what
 *                 lets a caller that already holds a phase reuse it.
 *
 * ── THE EXCEPTION, MEASURED RATHER THAN ASSUMED ──────────────────────────────
 * `resolveAccountByFingerprint` and `mergeArchivedDuplicateIntoCanonical` KEEP a
 * trailing `= db` default, and the reason is one statement in one policy.
 *
 * The merge is tenant work and every statement in it succeeds on a real `fm_app`
 * role EXCEPT the last. `DuplicateAccountCandidate.fm_app_ins` is
 * `fm_account_visible("accountAId") AND fm_account_visible("accountBId")`.
 * RLS-D1 gave the THIRTEEN account-subtree tables an `ownerUserId = me` arm;
 * that sweep enumerated the tables keyed on a column named `financialAccountId`,
 * and this table's FK columns are named `accountAId`/`accountBId`. A merge's
 * loser is an ARCHIVED, link-revoked account BY CONSTRUCTION, so the predicate is
 * false for it and the audit row cannot be written by the tenant who performed
 * the fold. Replayed statement by statement as the owner on a live fm_app
 * connection: guard OK, 2 of 2 transactions moved, 1 of 1 DebtProfile moved,
 * 1 of 1 link re-pointed, then 42501 — and the whole fold rolls back.
 *
 * ⚠️ AND REQUIRING THE PARAMETER ANYWAY WOULD BE A REGRESSION, NOT A STEP. Both
 * restore routes were taken OFF the migration principal by RLS-C-S7 and are
 * pinned there by lib/accounts/links-everywhere.test.ts. A required parameter
 * they could only satisfy with `db` would re-import it into both, GROW the
 * authority ratchet, and leave that pin green and false. There is no authority
 * those two routes may hold that can complete the fold.
 *
 * So the default survives on EXACTLY TWO call sites — the two restore routes —
 * and reconcile.test.ts asserts that it is exactly two and names them, so the
 * number can only go down. The two callers that already hold `db` (exchangeToken
 * and the wallet route, both on the ratchet for their own reasons) now pass it
 * EXPLICITLY. Acceptance cases 86 and 87 hold the measurement on a real role:
 * the fold runs END TO END on an `fm_app` phase when the loser is still linked,
 * and is refused at exactly this one statement when it is not. Case 87 is the
 * case that flips when the policy gains its owner arm.
 */

import { db } from "@/lib/db";
import { AccountType, ShareStatus, DuplicateDetectionSource, DuplicateStatus, ProviderType, type PrismaClient } from "@prisma/client";
import { dualWriteSpaceAccountLink, resolveAccountCreatorUserId, type DbClient } from "@/lib/accounts/space-account-link";
import type { ReadClient } from "@/lib/db/tenant-context";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { assertAccountReparentingAuthorized } from "@/lib/accounts/account-reparenting";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";

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
 *
 * ⚠️ RLS-ACC-S5 — THE CLIENT IS A ROOT CLIENT AND THE TYPE SAYS SO. This
 * function reaches `disconnectPlaidItemIfOrphaned`, which calls Plaid's
 * `itemRemove` over HTTP. A provider call must never run inside an open
 * transaction, and `Prisma.TransactionClient` is not assignable to
 * `PrismaClient`, so a caller holding a phase cannot pass it here.
 */
async function closeOutAccountConnections(client: PrismaClient, financialAccountId: string): Promise<void> {
  const liveConnections = await client.accountConnection.findMany({
    where:  { financialAccountId, deletedAt: null },
    select: { id: true, plaidItemDbId: true },
  });
  if (liveConnections.length === 0) return;

  await client.accountConnection.updateMany({
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
 *
 * ── RLS-ACC-S5 — THE CLIENT IS REQUIRED AND LEADING ─────────────────────────
 * This lookup is reached from genuinely different caller classes, which is the
 * textbook case for the parameter: both restore routes supply a TENANT phase
 * (they have already proved `fa.ownerUserId === user.id`, so the account they
 * are asking about is their own).
 *
 * ⚠️ WHAT A TENANT CLIENT CHANGES, MEASURED. The PLAID branch's
 * `ProviderAccountIdentity` lookup is keyed on `externalAccountId` alone — a
 * GLOBAL key. Under `fm_app` that read narrows to the subtree the caller can
 * reach, so a provider identity held by ANOTHER owner's account is simply not
 * found (measured: 1 row visible for the caller's own archived account, 0 for a
 * foreign owner's active one). That is a BEHAVIOUR CHANGE and it is the right
 * one: on the migration principal the foreign row WAS found, and the fold that
 * followed could only ever end in `ReparentingRefusedError/CROSS_OWNER` — a 500
 * on a restore the user was entitled to. The caller's own archived account stays
 * visible because of RLS-D1's owner arm; before D1 it did not, which is the
 * third of this conversion's four deferral reasons.
 */
export async function findActiveAccountByIdentity(client: ReadClient, identity: ProviderIdentity, excludeId?: string) {
  if (identity.kind === "plaid") {
    // D2 Step 1D — findFirst, not findUnique: ProviderAccountIdentity's
    // unique key now includes financialAccountId (multiple FinancialAccounts
    // may share one externalAccountId), so (provider, externalAccountId)
    // alone is no longer a named unique key. PLAID's real uniqueness is
    // still guaranteed independently by FinancialAccount.plaidAccountId
    // @unique, so this is a type-shape change only, not a behavior change.
    const plaidIdentity = await client.providerAccountIdentity.findFirst({
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
    const fallback = await client.financialAccount.findFirst({
      where: { plaidAccountId: identity.plaidAccountId, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (fallback) {
      console.warn(
        `[plaid][D2-3D] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fallback.id} externalAccountId=${identity.plaidAccountId}. Coverage gap; investigate before removing fallback.`
      );
    }
    return fallback;
  }

  return client.financialAccount.findFirst({
    where: {
      ownerUserId:   identity.ownerUserId,
      walletAddress: identity.walletAddress,
      deletedAt:     null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

/**
 * PROV-2 — the canonical identity→legacy resolver for the Plaid HOT PATHS
 * (exchangeToken create, refresh update-only, and both holdings loops). It
 * replaces four byte-identical inline copies. Resolves a Plaid external account
 * id to its FinancialAccount, primarily via ProviderAccountIdentity, falling
 * back to the legacy `plaidAccountId` column when no identity row exists yet.
 *
 * Returns the row INCLUDING soft-deleted, on purpose: the caller owns the
 * `deletedAt` decision. exchangeToken RESTORES a soft-deleted match (updates it
 * with `deletedAt: null`); refresh SKIPS it (`if (!fa || fa.deletedAt) continue`).
 * That is why this is NOT `findActiveAccountByIdentity` above — that helper
 * filters `deletedAt` for its restore-route callers, which must never touch an
 * archived row. Two different operations over the same lookup; folding them would
 * break one side. (Both share the D2 read-cutover posture: PAI first, legacy
 * fallback, warn so coverage gaps are visible before the fallback is removed.)
 *
 * ── Warn-gating: the PROV-2 canonical decision ──────────────────────────────
 * The coverage-gap warning fires ONLY when the legacy fallback hits an ACTIVE
 * account. This resolves a documented drift: exchange warned UNCONDITIONALLY
 * (tags D2-3C / D2-3F) — firing on every restore-on-reconnect of a
 * previously-removed account — while refresh warned only on active accounts
 * (D2-3E), reasoning that "an archived account hitting the legacy fallback is
 * expected, not a coverage gap worth investigating." The refresh gating is the
 * considered behavior and is adopted here: a soft-deleted fallback hit is
 * expected (the account is archived; its identity row may have been cleaned up
 * or predate the PAI dual-write), so warning on it is noise that trains
 * operators to ignore the signal. Adopting it changes ONLY console output on the
 * exchange path (one fewer warning per restored account) — never data or flow.
 * The consolidated tag `[D2-3G]` supersedes D2-3C/3E/3F.
 */
export async function resolvePlaidAccountByExternalId(client: ReadClient, externalAccountId: string) {
  const identity = await client.providerAccountIdentity.findFirst({
    where:   { provider: ProviderType.PLAID, externalAccountId },
    include: { financialAccount: true },
  });
  if (identity?.financialAccount) return identity.financialAccount;

  const legacy = await client.financialAccount.findUnique({ where: { plaidAccountId: externalAccountId } });
  if (legacy && legacy.deletedAt === null) {
    console.warn(
      `[plaid][D2-3G] ProviderAccountIdentity miss, legacy plaidAccountId hit — ` +
      `financialAccountId=${legacy.id} externalAccountId=${externalAccountId}. ` +
      `Coverage gap; investigate before removing fallback. (consolidates D2-3C/3E/3F)`,
    );
  }
  return legacy;
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
  client: ReadClient,
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

  return client.financialAccount.findMany({
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
  client: PrismaClient,
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
    const count = await client.transaction.count({ where: { financialAccountId: c.id, deletedAt: null } });
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
    await client.$transaction(async (tx) => {
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
    await closeOutAccountConnections(client, c.id);
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
  spaceId?: string | null,
  // ⚠️ RLS-ACC-S5 — THE DEFAULT SURVIVES HERE AND IN THE MERGE, AND NOWHERE
  // ELSE IN THIS MODULE. See the file header: this path ends in a
  // `DuplicateAccountCandidate` INSERT that `fm_app` cannot make about an
  // archived loser, so a tenant client aborts the whole fold on 42501. The
  // type is `PrismaClient` and not `DbClient`, which is a second, independent
  // constraint: `closeOutAccountConnections` calls Plaid's `itemRemove`
  // BETWEEN this function's transactions, so a phase client here would put a
  // provider round trip inside somebody else's open transaction. A
  // `Prisma.TransactionClient` has no `$transaction` and so does not compile.
  client: PrismaClient = db,
): Promise<FingerprintResolution | null> {
  const [activeCandidates, archivedCandidates] = await Promise.all([
    findCandidatesByFingerprint(client, fp, null, excludeId),
    findCandidatesByFingerprint(client, fp, { not: null }, excludeId),
  ]);

  if (activeCandidates.length > 0) {
    const canonical = await pickCanonicalAndMerge(client, activeCandidates, spaceId);
    for (const a of archivedCandidates) {
      await mergeArchivedDuplicateIntoCanonical(a.id, canonical!.id, DuplicateDetectionSource.FINGERPRINT_MATCH, spaceId, client);
      // Lifecycle fix (Step A) — second gap, found on a full read of this
      // file while implementing the fix above: this loop folds already-
      // archived siblings into the canonical directly, without ever going
      // through pickCanonicalAndMerge's loop. Same reasoning applies — `a`
      // may still be carrying a live connection from before this fix existed.
      await closeOutAccountConnections(client, a.id);
    }
    return {
      canonical:              canonical!,
      matchedActive:          true,
      activeCandidateCount:   activeCandidates.length,
      archivedCandidateCount: archivedCandidates.length,
    };
  }

  if (archivedCandidates.length > 0) {
    const canonical = await pickCanonicalAndMerge(client, archivedCandidates, spaceId);
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
 *  - GoalContributions: NOT re-pointed (W2 — Goals retired). Zero rows exist
 *    anywhere; if a stray row ever pointed at the loser it would cascade away
 *    with the loser account (GoalContribution→FinancialAccount is onDelete:
 *    Cascade) — the concept is retired, so preserving it across a merge would
 *    be resurrecting deleted product surface, not protecting user data.
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
  // ⚠️ RLS-ACC-S5 — THE DEFAULT STAYS, AND THE REASON IS NO LONGER THE ONE S7
  // GAVE. S7 said requiring it "moves the argument, not the authority — the
  // module keeps its `db` import either way, so the authority ratchet does not
  // move one file". Three of its four premises have since been retired by
  // measurement (see the file header), and that one WAS true and is now the
  // least of it. The real blocker was found by running the merge, statement by
  // statement, as the owner on a live `fm_app` role:
  //
  //   guard OK · 2 of 2 transactions moved · 1 of 1 DebtProfile moved ·
  //   1 of 1 link re-pointed · then `DuplicateAccountCandidate.upsert` → 42501.
  //
  // `DuplicateAccountCandidate.fm_app_ins` is `fm_account_visible("accountAId")
  // AND fm_account_visible("accountBId")`. RLS-D1 gave the THIRTEEN
  // account-subtree tables an `ownerUserId = me` arm; that sweep enumerated the
  // tables keyed on a column named `financialAccountId`, and this table's FK
  // columns are `accountAId`/`accountBId`. A merge's loser is an ARCHIVED,
  // link-revoked account BY CONSTRUCTION, so the predicate is false for it and
  // the audit row — the only durable record that the fold happened — cannot be
  // written by the tenant who performed it. The refusal arrives as
  // PrismaClientUnknownRequestError with `code` UNDEFINED, so no `P2002`-shaped
  // handler would catch it either. Acceptance cases 86 and 87 hold both halves:
  // the fold DOES run end to end on a real fm_app phase when the loser is still
  // linked, and is refused at exactly this one statement when it is not.
  //
  // ⚠️ AND REQUIRING IT ANYWAY WOULD MAKE THINGS WORSE, WHICH IS WHY THIS IS A
  // BLOCKER AND NOT A PREFERENCE. Both restore routes were taken OFF the
  // migration principal by S7 and are pinned there by
  // lib/accounts/links-everywhere.test.ts. A required parameter they can only
  // satisfy with `db` would re-import it into both, GROW the authority ratchet,
  // and turn that pin into a statement that is green and false. There is no
  // authority those routes may hold that can complete the fold. So the default
  // is kept, deliberately, on exactly TWO call sites — and the test file asserts
  // that it is exactly two and names them, so the number can only go down.
  // exchangeToken and the wallet route, which hold `db` already, now pass it
  // explicitly instead of inheriting it.
  //
  // The `"$transaction" in client` capability test below is the RLS-7 fix and
  // must not be reverted to a `=== db` reference comparison.
  client: DbClient = db,
) {
  if (loserId === winnerId) return;

  // KD-4 Phase 2 — the entire re-point / debt-move / link-re-point / audit
  // group below must commit or roll back together. (W2 — the contribution-move
  // member of this group was deleted with the Goals retirement.) When
  // called with a client that can begin one we open our own interactive
  // transaction and re-enter with the tx client. When a caller already passes
  // a tx (e.g. pickCanonicalAndMerge, which bundles the loser-archive into the
  // same transaction), we reuse it — Prisma forbids nested interactive
  // transactions, so we must never open a second one here. External
  // side-effects (closeOutAccountConnections / Plaid itemRemove) live in the
  // callers and stay OUTSIDE this transaction.
  // ⚠️ RLS-7 — ASK WHAT THE CLIENT *IS*, NOT WHETHER IT IS ONE PARTICULAR
  // OBJECT. This was `client === db`, a reference comparison against the
  // module-global client. That is correct for exactly two inputs — the default,
  // and a Prisma.TransactionClient — and silently wrong for a third that now
  // exists: a role client. `tenantDb`/`systemDb` are PrismaClients, so they can
  // open a transaction, but they are DIFFERENT OBJECTS, so `=== db` was false
  // and this function would have skipped the transaction entirely and run the
  // re-point, the debt move and the link re-point as separate autocommitted
  // statements — losing the atomicity the comment above exists to guarantee,
  // during a merge that re-points every transaction the loser account owns.
  //
  // The real question is a capability: can this client begin a transaction?
  // Prisma.TransactionClient cannot (ITXClientDenyList excludes $transaction),
  // every PrismaClient can. That test is true for any client we are handed,
  // including ones that do not exist yet.
  if ("$transaction" in client) {
    await (client as PrismaClient).$transaction(async (tx) => {
      await mergeArchivedDuplicateIntoCanonical(loserId, winnerId, source, spaceId, tx);
    });
    return;
  }
  const tx = client;

  // ── RLS-ACC-FK — THE AUTHORITY QUESTION, ASKED BEFORE ANY ROW MOVES ────────
  //
  // Everything below re-points financial detail from one account to another. The
  // measured defect this guard closes is that NOTHING established the two
  // accounts belong to the same owner — not here, and not in the database:
  // `Transaction.fm_app_upd` is `fm_account_visible("financialAccountId")` on
  // both arms, so a shared Space makes a cross-owner move a LEGAL write. Six of
  // another owner's transactions moved under a real `fm_app` role, at both
  // visibility tiers, in both directions.
  //
  // ⚠️ IT ASKS `tx`, NOT `db`, AND THAT IS NOT COSMETIC. A probe on a wider
  // authority than the write answers about rows the writer cannot see — the rule
  // `lib/db/conditional-write.ts` states for its visibility thunk. Passing the
  // phase client through is also what makes this module's eventual client
  // conversion an edit to the CALLERS rather than to the guard: today `tx`
  // descends from the migration principal, so the ownership comparison is
  // mechanical while the SCOPE half degenerates to "exists"; the day a tenant
  // client arrives here, the same line starts enforcing scope too, unchanged.
  //
  // It also closes the `ownerUserId`-null hole in ONE place. Two paths reach
  // here with a null-owner account possible: `findCandidatesByFingerprint`
  // DROPS its `ownerUserId` predicate entirely when the fingerprint's owner is
  // null (a global, cross-owner candidate sweep), and `ownerUser` is
  // `onDelete: SetNull`. A null owner now REFUSES rather than comparing equal to
  // another null.
  await assertAccountReparentingAuthorized(
    tx,
    { table: "FinancialAccount", fkField: "financialAccountId", operation: "updateMany" },
    loserId,
    winnerId,
  );

  // Re-points ALL of the loser's transactions, including any soft-deleted by
  // an import rollback (Transaction.deletedAt) — intentionally NOT filtered
  // to deletedAt: null. A soft-deleted row must move with the rest of the
  // account's history, or it would be orphaned on the archived loser account
  // and could resurface incorrectly if that loser is ever individually
  // restored. This is the one Transaction call site the D2 Step 4D-R audit
  // identified as needing to keep ignoring deletedAt — see
  // docs/initiatives/d2/investigations/D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md §5.
  //
  // ── RLS-ACC-FK (clauses 7 and 8) — PROVE THE WHOLE POPULATION ─────────────
  // The observation in front of this write is the GUARD, not an optimisation.
  // A bulk re-point whose count fell short has left rows on an account the rest
  // of this merge has already treated as emptied, and a shortfall reports
  // health: `updateMany` just returns a smaller, plausible number. 1-of-6 looks
  // exactly like success. Under the migration principal the two can only
  // disagree through concurrent modification, which is why a disagreement is an
  // alarm rather than a business outcome — and the day this module runs on a
  // scoped client, the same two statements start telling a policy refusal from a
  // complete write with no further change.
  const loserTxCount = await tx.transaction.count({ where: { financialAccountId: loserId } });
  const movedTx = await tx.transaction.updateMany({
    where: { financialAccountId: loserId },
    data:  { financialAccountId: winnerId },
  });
  assertEveryObservedRowWasWritten(
    { table: "Transaction", operation: "update", scope: "one archived duplicate's transactions" },
    loserTxCount, movedTx.count,
  );

  // W2 — the GoalContribution re-point block was DELETED with the Goals
  // retirement (see the doc bullet above): contributions now cascade with the
  // merged-away account if any ever existed (0 rows do).

  const winnerDebtProfile = await tx.debtProfile.findUnique({ where: { financialAccountId: winnerId } });
  if (!winnerDebtProfile) {
    // Same clause-7/8 reasoning as the transaction re-point. DebtProfile is a
    // strict 1:1 so the population is 0 or 1, which is precisely the size at
    // which a shortfall is easiest to mistake for "there was nothing to move":
    // the APR and minimum-payment facts are USER-ENTERED and exist nowhere else,
    // so a silently unmoved profile strands the only copy on a soft-deleted row.
    const loserDebtCount = await tx.debtProfile.count({ where: { financialAccountId: loserId } });
    const movedDebt = await tx.debtProfile.updateMany({
      where: { financialAccountId: loserId },
      data:  { financialAccountId: winnerId },
    });
    assertEveryObservedRowWasWritten(
      { table: "DebtProfile", operation: "update", scope: "one archived duplicate's debt profile" },
      loserDebtCount, movedDebt.count,
    );
  }

  // D3 Stage B2 — loser-share re-pointing migrated from WorkspaceAccountShare
  // to SpaceAccountLink. SpaceAccountLink is now the read and write target for
  // this merge path; WorkspaceAccountShare is no longer touched here.
  // `kind` is still recomputed per dualWriteSpaceAccountLink's Rule 1
  // (computeLinkKind), so the winner's first re-pointed link correctly becomes
  // HOME if it had none before the merge. Reads and writes here run on `tx`.
  const winnerCreatorUserId = await resolveAccountCreatorUserId(tx, winnerId);

  const loserLinks = await tx.spaceAccountLink.findMany({
    where:  { financialAccountId: loserId },
    select: { spaceId: true, addedByUserId: true, visibilityLevel: true },
  });
  for (const l of loserLinks) {
    await dualWriteSpaceAccountLink(tx, {
      spaceId:            l.spaceId,
      financialAccountId: winnerId,
      creatorUserId:      winnerCreatorUserId,
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

  // ⚠️ RLS-ACC-S5 — THE ONE STATEMENT IN THIS FUNCTION A TENANT CLIENT CANNOT
  // EXECUTE, AND THE REASON IS A POLICY, NOT A BUG HERE.
  // `DuplicateAccountCandidate.fm_app_ins` is
  // `fm_account_visible("accountAId") AND fm_account_visible("accountBId")`.
  // RLS-D1 gave the THIRTEEN account-subtree tables an `ownerUserId = me` arm;
  // they are the ones keyed on a column literally named `financialAccountId`,
  // and this table's two FK columns are not. A merge's loser is an ARCHIVED,
  // link-revoked account BY CONSTRUCTION, so the function is false for it and
  // the INSERT is refused with 42501 — which Prisma surfaces as
  // PrismaClientUnknownRequestError with `code` UNDEFINED, so no `P2002`-shaped
  // handler would catch it. Measured on a live fm_app role: every preceding
  // statement wrote its full population, this one aborted, the fold rolled back.
  //
  // It is NOT routed around here. Writing the row on a wider authority would
  // make the audit trail the one part of the fold that escapes the policy, and
  // skipping it would make a merge that happened indistinguishable from one that
  // did not. So the four callers pass `db` explicitly and say why, and
  // acceptance cases 86-87 hold the measurement until the policy is widened.
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
