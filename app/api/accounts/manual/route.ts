/**
 * POST /api/accounts/manual
 *
 * Creates a manually-entered asset account (property, vehicle, equipment, etc.).
 * Unlike Plaid accounts, balance is user-supplied and never synced automatically.
 *
 * Creates:
 *   FinancialAccount     — type=other, syncStatus='manual', balance=user-provided
 *   AccountConnection    — manual connection row (no PlaidItem, no walletAddress)
 *   WorkspaceAccountShare — always shares into the user's PERSONAL space
 *                           + any additional space IDs passed in `spaceIds`
 *
 * Body: {
 *   name:          string             // display name, e.g. "Austin Home"
 *   balance:       number             // current estimated value
 *   currency?:     string             // ISO 4217, default "USD"
 *   assetKind?:    string             // "real_estate" | "vehicle" | "equipment" | "other"
 *   purchasePrice?: number            // for gain/loss in asset widgets
 *   purchaseDate?:  string            // ISO date string, e.g. "2020-04-15"
 *   notes?:         string            // free-text display note
 *   spaceIds?:  string[]          // additional (non-personal) spaces to share into
 * }
 *
 * Returns: { accountId: string }
 */

import { NextRequest, NextResponse }        from "next/server";
import { db }                               from "@/lib/db";
import { getSpaceContext }              from "@/lib/space";
import { AccountType, AccountOwnerType, ShareStatus, VisibilityLevel, SpaceMemberStatus } from "@prisma/client";
import { requireUser }                      from "@/lib/session";
import { withApiHandler }                   from "@/lib/api";
import { dualWriteSpaceAccountLink }        from "@/lib/accounts/space-account-link";
import { regenerateSnapshotsForAccounts }   from "@/lib/snapshots/regenerate";

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const body = await req.json() as {
    name?:          string;
    balance?:       number;
    currency?:      string;
    assetKind?:     string;
    purchasePrice?: number;
    purchaseDate?:  string;
    notes?:         string;
    spaceIds?:  string[];
  };

  const {
    name,
    balance,
    currency     = "USD",
    assetKind    = "other",
    purchasePrice,
    purchaseDate,
    notes,
    spaceIds = [],
  } = body;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!name?.trim())           return NextResponse.json({ error: "Asset name is required."   }, { status: 400 });
  if (balance === undefined || balance === null)
                               return NextResponse.json({ error: "Current value is required." }, { status: 400 });
  if (typeof balance !== "number" || isNaN(balance) || balance < 0)
                               return NextResponse.json({ error: "Value must be a non-negative number." }, { status: 400 });

  const VALID_KINDS = ["real_estate", "vehicle", "equipment", "other"];
  if (!VALID_KINDS.includes(assetKind))
                               return NextResponse.json({ error: `Invalid assetKind. Use: ${VALID_KINDS.join(", ")}` }, { status: 400 });

  // ── Get user's personal space ──────────────────────────────────────────
  const ctx = await getSpaceContext();
  const personalSpaceId = ctx.space.type === "PERSONAL"
    ? ctx.spaceId
    : (await db.spaceMember.findFirst({
        where: { userId, status: SpaceMemberStatus.ACTIVE, space: { type: "PERSONAL" } },
        select: { spaceId: true },
      }))?.spaceId;

  if (!personalSpaceId) {
    return NextResponse.json({ error: "Personal Space not found." }, { status: 500 });
  }

  // ── Validate additional space IDs (must be member of each) ────────────
  const additionalIds = [...new Set(spaceIds.filter((id) => id !== personalSpaceId))];
  if (additionalIds.length > 0) {
    const memberships = await db.spaceMember.findMany({
      where: {
        userId,
        status:      SpaceMemberStatus.ACTIVE,
        spaceId: { in: additionalIds },
      },
      select: { spaceId: true },
    });
    const validIds = new Set(memberships.map((m) => m.spaceId));
    const invalid  = additionalIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      return NextResponse.json({ error: "Not a member of one or more requested Spaces." }, { status: 403 });
    }
  }

  // ── Create FinancialAccount ────────────────────────────────────────────────
  const fa = await db.financialAccount.create({
    data: {
      ownerType:   AccountOwnerType.USER,
      ownerUserId: userId,
      createdByUserId: userId, // D11 — human-accountable creator
      name:        name.trim(),
      type:        AccountType.other,
      institution: "Manual Entry",
      balance,
      currency:    currency.toUpperCase(),
      syncStatus:  "manual",
      lastUpdated: new Date(),
    },
  });

  // ── Create AccountConnection (no PlaidItem, no walletAddress) ─────────────
  await db.accountConnection.create({
    data: {
      financialAccountId: fa.id,
      connectedByUserId:  userId,
      syncStatus:         "manual",
      isCanonical:        true,
    },
  });

  // ── Share into personal space + any additional spaces ─────────────
  const shareTargets = [personalSpaceId, ...additionalIds];
  await Promise.all(shareTargets.map((wsId) =>
    db.workspaceAccountShare.upsert({
      // WorkspaceAccountShare keeps its own pre-Phase-1 field/key names.
      where:  { workspaceId_financialAccountId: { workspaceId: wsId, financialAccountId: fa.id } },
      create: {
        workspaceId:        wsId,
        financialAccountId: fa.id,
        addedByUserId:      userId,
        visibilityLevel:    VisibilityLevel.FULL,
        status:             ShareStatus.ACTIVE,
      },
      update: {
        status:          ShareStatus.ACTIVE,
        visibilityLevel: VisibilityLevel.FULL,
        revokedAt:       null,
        revokedByUserId: null,
      },
    })
  ));

  // ── D3 Stabilization — mirror onto SpaceAccountLink (best-effort,
  //    non-fatal). Sequential, NOT Promise.all: computeLinkKind() inside
  //    dualWriteSpaceAccountLink() decides HOME vs SHARED by counting
  //    existing links for this financialAccountId, with no transaction or
  //    lock. Run concurrently, every call in this batch could read
  //    count === 0 before any of them commit, so more than one target could
  //    independently decide HOME. Awaiting each write before starting the
  //    next removes the race: shareTargets[0] (always personalSpaceId)
  //    commits first and becomes HOME; every subsequent target then sees
  //    that committed HOME row and correctly becomes SHARED. See
  //    docs/initiatives/d3/D3_STEP4C_REGRESSION_ROOT_CAUSE.md ("Secondary finding") and
  //    docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md.
  for (const wsId of shareTargets) {
    await dualWriteSpaceAccountLink({
      spaceId:            wsId,
      financialAccountId: fa.id,
      creatorUserId:       userId,
      create: {
        addedByUserId:    userId,
        visibilityLevel:  VisibilityLevel.FULL,
        status:           ShareStatus.ACTIVE,
      },
      update: {
        status:           ShareStatus.ACTIVE,
        visibilityLevel:  VisibilityLevel.FULL,
        revokedAt:        null,
        revokedByUserId:  null,
      },
    });
  }

  // Regenerate SpaceSnapshot for every space this asset was just shared into
  // — same best-effort/non-fatal pattern as the existing archive/restore/
  // share/revoke snapshot fixes (see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md).
  try {
    await regenerateSnapshotsForAccounts([fa.id]);
  } catch (snapshotErr) {
    console.warn(`[POST /api/accounts/manual] snapshot regen failed for account ${fa.id} (non-fatal):`, snapshotErr);
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      userId,
      spaceId: personalSpaceId,
      action:      "MANUAL_ASSET_ADD",
      metadata: {
        name:           fa.name,
        balance,
        currency:       fa.currency,
        assetKind,
        purchasePrice,
        purchaseDate,
        sharedSpaces: shareTargets,
      },
    },
  });

  return NextResponse.json({
    accountId:    fa.id,
    name:         fa.name,
    balance:      fa.balance,
    currency:     fa.currency,
    assetKind,
    purchasePrice,
    purchaseDate,
    notes,
  }, { status: 201 });
}, "POST /api/accounts/manual");
