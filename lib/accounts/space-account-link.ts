/**
 * lib/accounts/space-account-link.ts
 *
 * D3 Step 3 — dual-write helpers. Every WorkspaceAccountShare mutation site
 * calls into this module to mirror the same change onto SpaceAccountLink,
 * best-effort and non-fatal. See docs/initiatives/d3/D3_STEP3_DUAL_WRITE_REVIEW.md for the
 * full design rationale.
 *
 * SpaceAccountLink is now the PRIMARY read path for the AI assemblers, the
 * data layer, and most account routes (see the D3 Step 4 read-cutover
 * reports), AND the SOLE runtime write target for account↔space visibility.
 * [UPDATED KD-4 Phase 1] The WorkspaceAccountShare (WAS) dual-write has been
 * retired from every runtime path — WAS is written only by prisma/seed.ts now.
 * The "dual-write" naming in this module is historical; these helpers no
 * longer mirror anything. Full WAS model retirement remains scheduled for
 * v2.5. See docs/investigations/KD4_ATOMIC_SPACE_ACCOUNT_LINK_WRITES_INVESTIGATION.md
 * §1 for the grounding.
 *
 * Rules (docs/initiatives/d3/D3_STEP3_DUAL_WRITE_REVIEW.md §2, amended by
 * docs/initiatives/d3/D3_STEP3_HOME_SEMANTICS_CORRECTION.md):
 *   Rule 1 — `kind` is always recomputed dynamically here, never passed in
 *            and never copied from another row.
 *   Rule 2 — every write is an idempotent upsert keyed on
 *            (spaceId, financialAccountId).
 *   Rule 3 — every other field mirrors the corresponding WorkspaceAccountShare
 *            write verbatim.
 *   Rule 4 — [SUPERSEDED, see docs/initiatives/d3/D3_STEP3_HOME_SEMANTICS_CORRECTION.md §5]
 *            Previously: account-creation paths whose primary share write
 *            may target a non-personal space must separately call
 *            ensureHomeLink() to backfill a HOME link at the creator's
 *            personal Space. This synthesized visibility into Personal that
 *            no real share ever granted, and is no longer correct now that
 *            HOME means "canonical owning Space" rather than "the creator's
 *            personal Space." computeLinkKind() below now assigns HOME to
 *            whichever space an account's first link was written at —
 *            Personal, Business, Household, or otherwise — so no separate
 *            backfill call is needed. ensureHomeLink() is no longer called
 *            anywhere; see its own doc comment.
 *   Rule 5 — [REMOVED — D3 Rule 5 removal, ahead of B3 write cutover]
 *            Previously: best-effort, non-fatal — write functions caught
 *            errors and logged via console.warn without throwing. Removed
 *            so that SpaceAccountLink failures surface to the caller now
 *            that SAL is the primary write target.
 *   Rule 7 — [UPDATED KD-4 Phase 1] Each write helper accepts an optional
 *            transaction client (DbClient, above), defaulting to the `db`
 *            singleton. Callers that need atomicity across several tables wrap
 *            their DB-only write group in db.$transaction(async (tx) => …) and
 *            pass `tx` into these helpers. External side-effects (Plaid
 *            itemRemove, snapshot regen) and mirror writes stay OUTSIDE the
 *            transaction. The route/merge wrapping itself is KD-4 Phase 2/3 —
 *            this module only provides the threading seam. (The prior wording,
 *            "no db.$transaction anywhere in this codebase," is obsolete:
 *            transactions are used in auth/imports/totp/etc., and are being
 *            introduced here by KD-4.)
 */

import { db } from "@/lib/db";
import { Prisma, SpaceAccountLinkKind, ShareStatus, VisibilityLevel } from "@prisma/client";

/**
 * A Prisma client handle that is either the module-level singleton `db` or an
 * interactive-transaction client (`tx`) from `db.$transaction(async (tx) => …)`.
 *
 * KD-4 Phase 1 — every write helper below accepts one of these (defaulting to
 * `db`) so a caller can thread its own transaction through, without any
 * existing call site having to change. Wrapping DB-only write groups in a
 * transaction, and threading `tx` into these helpers, is what makes the
 * multi-table SpaceAccountLink write sequences atomic (see
 * docs/investigations/KD4_ATOMIC_SPACE_ACCOUNT_LINK_WRITES_CHECKLIST.md).
 * Exported so lib/accounts/reconcile.ts (Phase 2) can reuse the same type.
 */
export type DbClient = Prisma.TransactionClient | typeof db;

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
export async function resolveAccountCreatorUserId(
  financialAccountId: string,
  client: DbClient = db,
): Promise<string | null> {
  const fa = await client.financialAccount.findUnique({
    where:  { id: financialAccountId },
    select: { createdByUserId: true, ownerUserId: true },
  });
  if (!fa) return null;
  return fa.createdByUserId ?? fa.ownerUserId ?? null;
}

/**
 * Computes whether the link at (spaceId, financialAccountId) should be HOME
 * or SHARED.
 *
 * D3 Step 3 HOME Semantics Correction (docs/initiatives/d3/D3_STEP3_HOME_SEMANTICS_CORRECTION.md
 * §5A) — HOME means the account's canonical owning Space, not "the creator's
 * personal Space." There is no Personal special-casing here:
 *
 *   1. If no SpaceAccountLink row exists yet for this financialAccountId at
 *      all, this is the first link ever written for the account — it
 *      becomes HOME, whatever Space it's being written at (Personal,
 *      Business, Household, Property, ...).
 *   2. Otherwise, if a HOME link already exists for this account and it's
 *      at this same spaceId, reassert HOME (idempotent — a re-upsert of the
 *      existing HOME row, e.g. a status/visibility update, must not flip
 *      it to SHARED).
 *   3. Otherwise, this is an additional space gaining visibility into an
 *      account that already has its HOME elsewhere — SHARED.
 *
 * Never throws on its own — any DB error propagates to the caller.
 */
export async function computeLinkKind(
  spaceId: string,
  financialAccountId: string,
  client: DbClient = db,
): Promise<SpaceAccountLinkKind> {
  const existingLinkCount = await client.spaceAccountLink.count({
    where: { financialAccountId },
  });
  if (existingLinkCount === 0) {
    return SpaceAccountLinkKind.HOME;
  }

  const existingHome = await client.spaceAccountLink.findFirst({
    where:  { financialAccountId, kind: SpaceAccountLinkKind.HOME },
    select: { spaceId: true },
  });
  if (existingHome && existingHome.spaceId === spaceId) {
    return SpaceAccountLinkKind.HOME;
  }

  return SpaceAccountLinkKind.SHARED;
}

export interface SpaceAccountLinkWriteFields {
  addedByUserId:    string;
  visibilityLevel:  VisibilityLevel;
  status:           ShareStatus;
  revokedAt?:       Date | null;
  revokedByUserId?: string | null;
}

/**
 * Upsert of a single SpaceAccountLink row. `create` and `update` are passed
 * separately (rather than one shared object) so each call site can mirror its
 * WorkspaceAccountShare write exactly — some sites reassert addedByUserId on
 * update, most don't (see review doc §1 field-mapping table).
 *
 * Throws on failure — callers are responsible for error handling.
 */
export async function dualWriteSpaceAccountLink(params: {
  spaceId:            string;
  financialAccountId: string;
  creatorUserId?:     string | null;
  create:             SpaceAccountLinkWriteFields;
  update:             Partial<SpaceAccountLinkWriteFields>;
  // KD-4 Phase 1 — optional transaction client. When a caller wraps a
  // multi-table write group in db.$transaction, it passes `tx` here so the
  // kind read and the upsert run inside that same transaction. Defaults to
  // the `db` singleton, so every existing call site is unchanged.
  client?:            DbClient;
}): Promise<void> {
  const client = params.client ?? db;
  // params.creatorUserId is accepted for call-site backward compatibility
  // (every existing dual-write call site still passes it) but is no longer
  // used to compute kind — see computeLinkKind()'s doc comment.
  const kind = await computeLinkKind(params.spaceId, params.financialAccountId, client);
  await client.spaceAccountLink.upsert({
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
  creatorUserId?: string | null,
  client?: DbClient
): Promise<void> {
  await dualWriteSpaceAccountLink({
    spaceId:            share.workspaceId,
    financialAccountId: share.financialAccountId,
    creatorUserId,
    client,
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
  creatorUserId?: string | null,
  client?: DbClient
): Promise<void> {
  for (const share of shares) {
    await dualWriteFromShare(share, creatorUserId, client);
  }
}

/**
 * UNUSED as of D3 Step 3 HOME Semantics Correction
 * (docs/initiatives/d3/D3_STEP3_HOME_SEMANTICS_CORRECTION.md §5B). No call sites remain —
 * removed from app/api/plaid/exchange-token/route.ts and
 * app/api/accounts/wallet/route.ts.
 *
 * Previously: HOME synthesis for account-creation paths whose primary
 * WorkspaceAccountShare write may target a non-personal Space (Plaid
 * exchange-token and wallet create both resolve `spaceId` via
 * getSpaceContext(), which can be any Space the user is currently active
 * in, not necessarily personal) — backfilled a HOME link at the creator's
 * personal Space so the account wouldn't end up with zero HOME links.
 *
 * That backfill is no longer needed: computeLinkKind() now assigns HOME to
 * whichever Space an account's first link is written at, so the *primary*
 * dual-write at account creation already produces the correct HOME link
 * (at the actually-active Space, Personal or otherwise) without a second,
 * synthesized row at Personal. Calling this function today would
 * reintroduce exactly the product-wrong synthesized-personal-HOME rows the
 * correction was meant to remove — do not reconnect it without revisiting
 * that decision.
 *
 * Left in place (not deleted) for fast rollback and as a reference for the
 * "previous" pattern. Best-effort, non-fatal — see Rule 5.
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
 * Hard-delete of every SpaceAccountLink row for an account — mirrors a
 * WorkspaceAccountShare.deleteMany at a permanent-delete call site
 * (see app/api/accounts/manual/[id]/permanent/route.ts).
 *
 * Throws on failure — callers are responsible for error handling.
 */
export async function dualDeleteSpaceAccountLinks(
  financialAccountId: string,
  client: DbClient = db,
): Promise<void> {
  await client.spaceAccountLink.deleteMany({ where: { financialAccountId } });
}
