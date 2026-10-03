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
 * ── THE MERGE'S DEFAULT IS GONE (RLS-ACC-S6), AND WHAT REMOVED IT WAS A POLICY ─
 * S5 kept a trailing `= db` on `mergeArchivedDuplicateIntoCanonical` for ONE
 * measured reason: the fold's last statement.
 * `DuplicateAccountCandidate.fm_app_ins` was
 * `fm_account_visible("accountAId") AND fm_account_visible("accountBId")`, and a
 * merge's loser is an ARCHIVED, link-revoked account BY CONSTRUCTION, so the
 * conjunction was unsatisfiable for the very shape every production fold has.
 * Replayed statement by statement as the OWNER on a live fm_app connection:
 * guard OK, 2 of 2 transactions moved, 1 of 1 DebtProfile moved, 1 of 1 link
 * re-pointed, then 42501 — and the whole fold rolled back. (The refusal arrives
 * as PrismaClientUnknownRequestError with `code` UNDEFINED, so no `P2002`-shaped
 * handler would have caught it either.)
 *
 * 20261003000100 closes it, as the REMAINDER of RLS-D1's already-approved
 * theorem rather than as a new one: each half of that conjunction is now
 * `(an ACTIVE link into a visible Space) OR (I own the account)`. D1 missed this
 * table because its sweep enumerated by the column name `financialAccountId` and
 * these FK columns are `accountAId`/`accountBId`;
 * scripts/audit-account-reparenting.ts now refuses any FK pair that is neither
 * predicated nor classified, so that cannot recur.
 *
 * So the merge's client is REQUIRED. Both restore routes name it by running the
 * fold inside a `withTenantDb` phase — which is what S5 said would be the only
 * line that had to change — and neither imports `db` to do it. Acceptance case
 * 86 proved the fold already ran end to end on `fm_app` for a LIVE loser; case
 * 87 is the ARCHIVED one, and it is the case that flipped.
 *
 * ── THE ONE DEFAULT THAT SURVIVES, FOR A REASON THAT IS NOT A POLICY ─────────
 * `resolveAccountByFingerprint` KEEPS its `= db`, and the blocker is now
 * STRUCTURAL rather than a refusal that could be widened away:
 *
 *   · Its client is typed `PrismaClient` — a ROOT authority — because it
 *     interleaves a provider HTTP call (closeOutAccountConnections →
 *     disconnectPlaidItemIfOrphaned → Plaid itemRemove) BETWEEN its own
 *     transactions, for every archived sibling it folds.
 *   · A TENANT authority is only ever a transaction client. The identity the
 *     policies read is bound with `set_config(…, is_local := true)`, so it
 *     cannot outlive a transaction (lib/db/tenant-context.ts), and
 *     lib/db/write-phase.ts states the consequence in terms: "`PrismaClient`
 *     here means a ROOT authority: `db` today, `systemDb` for a job, never a
 *     tenant one".
 *
 * Those two facts cannot both hold for one client, so there is no tenant client
 * of ANY shape this parameter can accept — and naming `db` at its one defaulting
 * call site would re-import the migration principal into a restore route that
 * RLS-C-S7 took off it, which lib/accounts/links-everywhere.test.ts pins
 * against. Removing it needs the provider round trip LIFTED OUT of this
 * function so the fold itself becomes phase-shaped; that is a separate slice
 * about transaction boundaries, not about authority, and it is the one thing
 * keeping this module on the authority ratchet. reconcile.test.ts asserts the
 * set of default-reliant call sites is EXACTLY ONE and names it, so the number
 * can only go down.
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
  // ⚠️ RLS-ACC-S6 — THE LAST DEFAULT IN THIS MODULE, AND THE REASON IS NO
  // LONGER THE POLICY. 20261003000100 gave `DuplicateAccountCandidate` the owner
  // arm, so the fold itself now completes on a real `fm_app` phase and the
  // merge's own default is GONE. What keeps this one is the TYPE, and the type
  // is load-bearing: `closeOutAccountConnections` calls Plaid's `itemRemove`
  // BETWEEN this function's transactions — once per archived sibling — so this
  // must be a ROOT client, and a `Prisma.TransactionClient` has no
  // `$transaction` and does not compile here.
  //
  // A tenant authority, however, is ONLY ever a transaction client: the identity
  // the policies read is transaction-local by construction (lib/db/tenant-
  // context.ts), and lib/db/write-phase.ts says so outright — "`PrismaClient`
  // here means a ROOT authority … never a tenant one". So no tenant client of
  // any shape can satisfy this parameter, and the one call site that relies on
  // the default (app/api/accounts/[id]/restore/route.ts) may not name `db`
  // either: RLS-C-S7 took that route OFF the migration principal and
  // lib/accounts/links-everywhere.test.ts pins it there.
  //
  // Removing this default therefore requires LIFTING THE PROVIDER ROUND TRIP
  // OUT of the fold, so the whole operation becomes phase-shaped. That is a
  // transaction-boundary change, not an authority one, and it is the single
  // remaining reason this module imports `db` at all.
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
  // ⚠️ REQUIRED IN ARITY, AND DELIBERATELY ACCEPTS `undefined`. A required
  // parameter cannot follow an optional one, and `client` below is now required
  // — so this is `string | null | undefined` rather than `spaceId?`. Every
  // existing five-argument call site is unaffected; a three-argument one no
  // longer compiles, which is the point.
  spaceId: string | null | undefined,
  // ⚠️ RLS-ACC-S6 — THE DEFAULT IS GONE. EVERY CALLER NOW NAMES ITS AUTHORITY.
  //
  // S5 kept `= db` here for one measured reason, and it was a real one: the
  // fold's last statement. `DuplicateAccountCandidate.fm_app_ins` was
  // `fm_account_visible("accountAId") AND fm_account_visible("accountBId")`, and
  // a merge's loser is an ARCHIVED, link-revoked account BY CONSTRUCTION, so the
  // conjunction could not be satisfied for the shape every production fold has.
  // Replayed statement by statement as the OWNER on a live `fm_app` role:
  //
  //   guard OK · 2 of 2 transactions moved · 1 of 1 DebtProfile moved ·
  //   1 of 1 link re-pointed · then `DuplicateAccountCandidate.upsert` → 42501.
  //
  // 20261003000100 gives each half of that conjunction the owner arm RLS-D1
  // already gave the thirteen `financialAccountId`-keyed subtree tables —
  // `(visible OR owned)` — which is the REMAINDER of D1's theorem, not a new
  // one. D1 could not see this table because its sweep enumerated by that column
  // name; scripts/audit-account-reparenting.ts now refuses any FK pair that is
  // neither predicated by a named policy migration nor explicitly classified.
  //
  // So the two restore routes supply a `withTenantDb` phase instead of
  // inheriting an ambient authority, and NEITHER imports `db` to do it — which
  // is what S5 predicted would be the only line that had to change. Acceptance
  // case 86 holds the live-loser fold on fm_app; case 87 holds the archived one,
  // and it is the case that flipped.
  //
  // The `"$transaction" in client` capability test below is the RLS-7 fix and
  // must not be reverted to a `=== db` reference comparison.
  client: DbClient,
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

  // ⚠️ THE STATEMENT THAT USED TO BE THE ONE A TENANT CLIENT COULD NOT EXECUTE.
  // It was never routed around — writing this row on a wider authority would
  // have made the audit trail the one part of the fold that escapes the policy,
  // and skipping it would make a merge that happened indistinguishable from one
  // that did not. So it stayed on `tx` and the CALLERS carried an ambient
  // authority instead, visibly, with the refusal measured on a real role.
  //
  // 20261003000100 removed the refusal rather than the statement:
  // `DuplicateAccountCandidate`'s three fm_app policies are now
  // `(visible(accountAId) OR owned(accountAId)) AND (visible(accountBId) OR
  // owned(accountBId))`, the §17 conjunction preserved and each half given the
  // arm its own account's root policy already had. An archived loser the caller
  // OWNS satisfies the second arm; one they do not own satisfies neither, so a
  // cross-owner pair is still invisible and still unwritable (proved on the role
  // both ways, acceptance case 87).
  //
  // This statement therefore runs on whatever authority the caller named, like
  // every other statement in the fold, and the whole thing commits or rolls back
  // together.
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
