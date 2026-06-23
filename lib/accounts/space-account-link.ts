/**
 * lib/accounts/space-account-link.ts
 *
 * D3 Step 3 — dual-write helpers. Every WorkspaceAccountShare mutation site
 * calls into this module to mirror the same change onto SpaceAccountLink,
 * best-effort and non-fatal. See docs/D3_STEP3_DUAL_WRITE_REVIEW.md for the
 * full design rationale.
 *
 * WorkspaceAccountShare remains the only table any read path consults.
 * SpaceAccountLink is written here purely so it stays a live, accurate
 * mirror ahead of a future read-cutover step — nothing reads it yet.
 *
 * Rules (docs/D3_STEP3_DUAL_WRITE_REVIEW.md §2):
 *   Rule 1 — `kind` is always recomputed dynamically here, never passed in
 *            and never copied from another row.
 *   Rule 2 — every write is an idempotent upsert keyed on
 *            (spaceId, financialAccountId).
 *   Rule 3 — every other field mirrors the corresponding WorkspaceAccountShare
 *            write verbatim.
 *   Rule 4 — account-creation paths whose primary share write may target a
 *            non-personal space must separately call ensureHomeLink() so the
 *            account still ends up with exactly one HOME link.
 *   Rule 5 — best-effort, non-fatal: every exported write function catches
 *            its own errors and logs via console.warn; none of them throw.
 *   Rule 7 — no db.$transaction (see review doc §4 — none used anywhere in
 *            this codebase today).
 */

import { db } from "@/lib/db";
import { SpaceAccountLinkKind, ShareStatus, VisibilityLevel } from "@prisma/client";

/**
 * Resolve a user's personal Space — same lookup used by
 * scripts/backfill-space-account-link.ts (ACTIVE membership in a
 * non-archived, non-deleted, type=PERSONAL Space). Duplicated here
 * deliberately so this module has no dependency on the backfill script.
 */
export async function resolvePersonalSpaceId(userId: string): Promise<string | null> {
  const membership = await db.spaceMember.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      space: { type: "PERSONAL", archivedAt: null, deletedAt: null },
    },
    select: { spaceId: true },
    orderBy: { joinedAt: "asc" },
  });
  return membership?.spaceId ?? null;
}

/**
 * Resolve a FinancialAccount's creator per the D3 Step 2 convention:
 * createdByUserId ?? ownerUserId.
 */
export async function resolveAccountCreatorUserId(financialAccountId: string): Promise<string | null> {
  const fa = await db.financialAccount.findUnique({
    where:  { id: financialAccountId },
    select: { createdByUserId: true, ownerUserId: true },
  });
  if (!fa) return null;
  return fa.createdByUserId ?? fa.ownerUserId ?? null;
}

/**
 * Computes whether the link at (spaceId, financialAccountId) should be HOME
 * or SHARED — HOME iff spaceId is the account creator's own personal Space.
 * Never throws: an unresolvable creator or personal Space just means the
 * link can't be HOME, so it falls back to SHARED rather than blocking the
 * dual-write (mirrors how the Step 2 backfill still wrote SHARED links for
 * accounts it couldn't resolve a HOME link for).
 *
 * Pass `knownCreatorUserId` when the caller already has it (e.g. a route
 * that just created the FinancialAccount with createdByUserId: userId) to
 * skip a redundant FinancialAccount lookup.
 */
export async function computeLinkKind(
  spaceId: string,
  financialAccountId: string,
  knownCreatorUserId?: string | null
): Promise<SpaceAccountLinkKind> {
  const creatorUserId = knownCreatorUserId !== undefined
    ? knownCreatorUserId
    : await resolveAccountCreatorUserId(financialAccountId);
  if (!creatorUserId) return SpaceAccountLinkKind.SHARED;

  const personalSpaceId = await resolvePersonalSpaceId(creatorUserId);
  if (!personalSpaceId) return SpaceAccountLinkKind.SHARED;

  return spaceId === personalSpaceId ? SpaceAccountLinkKind.HOME : SpaceAccountLinkKind.SHARED;
}

export interface SpaceAccountLinkWriteFields {
  addedByUserId:    string;
  visibilityLevel:  VisibilityLevel;
  status:           ShareStatus;
  revokedAt?:       Date | null;
  revokedByUserId?: string | null;
}

/**
 * Best-effort, non-fatal upsert of a single SpaceAccountLink row. `create`
 * and `update` are passed separately (rather than one shared object) so
 * each call site can mirror its WorkspaceAccountShare write exactly — some
 * sites reassert addedByUserId on update, most don't (see review doc §1
 * field-mapping table).
 *
 * Never throws — logs via console.warn and returns on any failure (Rule 5).
 */
export async function dualWriteSpaceAccountLink(params: {
  spaceId:            string;
  financialAccountId: string;
  creatorUserId?:     string | null;
  create:             SpaceAccountLinkWriteFields;
  update:             Partial<SpaceAccountLinkWriteFields>;
}): Promise<void> {
  try {
    const kind = await computeLinkKind(params.spaceId, params.financialAccountId, params.creatorUserId);
    await db.spaceAccountLink.upsert({
      where: {
        spaceId_financialAccountId: {
          spaceId:            params.spaceId,
          financialAccountId: params.financialAccountId,
        },
      },
      create: {
        spaceId:            params.spaceId,
        financialAccountId: params.financialAccountId,
        kind,
        ...params.create,
      },
      update: {
        kind,
        ...params.update,
      },
    });
  } catch (err) {
    console.warn(
      `[dualWriteSpaceAccountLink] best-effort write failed (space=${params.spaceId}, account=${params.financialAccountId}) — non-fatal:`,
      err
    );
  }
}

/**
 * Mirrors a WorkspaceAccountShare row wholesale onto SpaceAccountLink — the
 * common case for revoke/restore mutations that already have the full share
 * row in hand (e.g. fetched before an updateMany, or returned from a
 * findMany). `kind` is still recomputed per Rule 1, never copied.
 */
export async function dualWriteFromShare(
  share: {
    workspaceId:        string;
    financialAccountId: string;
    addedByUserId:      string;
    visibilityLevel:    VisibilityLevel;
    status:             ShareStatus;
    revokedAt:           Date | null;
    revokedByUserId:     string | null;
  },
  creatorUserId?: string | null
): Promise<void> {
  await dualWriteSpaceAccountLink({
    spaceId:            share.workspaceId,
    financialAccountId: share.financialAccountId,
    creatorUserId,
    create: {
      addedByUserId:   share.addedByUserId,
      visibilityLevel: share.visibilityLevel,
      status:          share.status,
      revokedAt:       share.revokedAt,
      revokedByUserId: share.revokedByUserId,
    },
    update: {
      addedByUserId:   share.addedByUserId,
      visibilityLevel: share.visibilityLevel,
      status:          share.status,
      revokedAt:       share.revokedAt,
      revokedByUserId: share.revokedByUserId,
    },
  });
}

/**
 * Convenience loop over dualWriteFromShare — used by routes that bulk
 * revoke/restore several WorkspaceAccountShare rows at once via updateMany.
 */
export async function dualWriteFromShares(
  shares: Array<{
    workspaceId:        string;
    financialAccountId: string;
    addedByUserId:      string;
    visibilityLevel:    VisibilityLevel;
    status:             ShareStatus;
    revokedAt:           Date | null;
    revokedByUserId:     string | null;
  }>,
  creatorUserId?: string | null
): Promise<void> {
  for (const share of shares) {
    await dualWriteFromShare(share, creatorUserId);
  }
}

/**
 * Rule 4 — HOME synthesis for account-creation paths whose primary
 * WorkspaceAccountShare write may target a non-personal Space (Plaid
 * exchange-token and wallet create both resolve `spaceId` via
 * getSpaceContext(), which can be any Space the user is currently active
 * in, not necessarily personal). Without this, such an account could end
 * up with zero HOME link.
 *
 * No-ops (writes nothing) if:
 *   - the creator has no resolvable ACTIVE PERSONAL Space, or
 *   - personalSpaceId === excludeSpaceId (the primary dual-write at that
 *     same pair already covers it).
 *
 * Best-effort, non-fatal — see Rule 5.
 */
export async function ensureHomeLink(params: {
  financialAccountId: string;
  creatorUserId:       string;
  excludeSpaceId?:     string;
}): Promise<void> {
  try {
    const personalSpaceId = await resolvePersonalSpaceId(params.creatorUserId);
    if (!personalSpaceId) {
      console.warn(
        `[ensureHomeLink] no resolvable ACTIVE PERSONAL space for creator ${params.creatorUserId}, account ${params.financialAccountId} — skipping HOME synthesis`
      );
      return;
    }
    if (personalSpaceId === params.excludeSpaceId) return;

    await db.spaceAccountLink.upsert({
      where: {
        spaceId_financialAccountId: {
          spaceId:            personalSpaceId,
          financialAccountId: params.financialAccountId,
        },
      },
      create: {
        spaceId:            personalSpaceId,
        financialAccountId: params.financialAccountId,
        kind:               SpaceAccountLinkKind.HOME,
        addedByUserId:      params.creatorUserId,
        visibilityLevel:    VisibilityLevel.FULL,
        status:             ShareStatus.ACTIVE,
      },
      // Defensive only — every current call site invokes this once, at
      // creation, so this branch should not normally be hit. If it ever is,
      // just reassert kind=HOME rather than overwriting status/visibility
      // fields this function did not originate.
      update: {
        kind: SpaceAccountLinkKind.HOME,
      },
    });
  } catch (err) {
    console.warn(
      `[ensureHomeLink] best-effort HOME synthesis failed for account ${params.financialAccountId} (non-fatal):`,
      err
    );
  }
}

/**
 * Best-effort, non-fatal hard-delete of every SpaceAccountLink row for an
 * account — mirrors a WorkspaceAccountShare.deleteMany at a permanent-delete
 * call site (see app/api/accounts/manual/[id]/permanent/route.ts).
 */
export async function dualDeleteSpaceAccountLinks(financialAccountId: string): Promise<void> {
  try {
    await db.spaceAccountLink.deleteMany({ where: { financialAccountId } });
  } catch (err) {
    console.warn(
      `[dualDeleteSpaceAccountLinks] best-effort delete failed for account ${financialAccountId} (non-fatal):`,
      err
    );
  }
}
