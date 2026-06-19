/**
 * POST /api/accounts/manual
 *
 * Creates a manually-entered asset account (property, vehicle, equipment, etc.).
 * Unlike Plaid accounts, balance is user-supplied and never synced automatically.
 *
 * Creates:
 *   FinancialAccount     — type=other, syncStatus='manual', balance=user-provided
 *   AccountConnection    — manual connection row (no PlaidItem, no walletAddress)
 *   WorkspaceAccountShare — always shares into the user's PERSONAL workspace
 *                           + any additional workspace IDs passed in `workspaceIds`
 *
 * Body: {
 *   name:          string             // display name, e.g. "Austin Home"
 *   balance:       number             // current estimated value
 *   currency?:     string             // ISO 4217, default "USD"
 *   assetKind?:    string             // "real_estate" | "vehicle" | "equipment" | "other"
 *   purchasePrice?: number            // for gain/loss in asset widgets
 *   purchaseDate?:  string            // ISO date string, e.g. "2020-04-15"
 *   notes?:         string            // free-text display note
 *   workspaceIds?:  string[]          // additional (non-personal) workspaces to share into
 * }
 *
 * Returns: { accountId: string }
 */

import { NextRequest, NextResponse }        from "next/server";
import { db }                               from "@/lib/db";
import { getWorkspaceContext }              from "@/lib/workspace";
import { AccountType, AccountOwnerType, ShareStatus, VisibilityLevel, WorkspaceMemberStatus } from "@prisma/client";
import { requireUser }                      from "@/lib/session";
import { withApiHandler }                   from "@/lib/api";

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
    workspaceIds?:  string[];
  };

  const {
    name,
    balance,
    currency     = "USD",
    assetKind    = "other",
    purchasePrice,
    purchaseDate,
    notes,
    workspaceIds = [],
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

  // ── Get user's personal workspace ──────────────────────────────────────────
  const ctx = await getWorkspaceContext();
  const personalWorkspaceId = ctx.workspace.type === "PERSONAL"
    ? ctx.workspaceId
    : (await db.workspaceMember.findFirst({
        where: { userId, status: WorkspaceMemberStatus.ACTIVE, workspace: { type: "PERSONAL" } },
        select: { workspaceId: true },
      }))?.workspaceId;

  if (!personalWorkspaceId) {
    return NextResponse.json({ error: "Personal Space not found." }, { status: 500 });
  }

  // ── Validate additional workspace IDs (must be member of each) ────────────
  const additionalIds = [...new Set(workspaceIds.filter((id) => id !== personalWorkspaceId))];
  if (additionalIds.length > 0) {
    const memberships = await db.workspaceMember.findMany({
      where: {
        userId,
        status:      WorkspaceMemberStatus.ACTIVE,
        workspaceId: { in: additionalIds },
      },
      select: { workspaceId: true },
    });
    const validIds = new Set(memberships.map((m) => m.workspaceId));
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

  // ── Share into personal workspace + any additional workspaces ─────────────
  const shareTargets = [personalWorkspaceId, ...additionalIds];
  await Promise.all(shareTargets.map((wsId) =>
    db.workspaceAccountShare.upsert({
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

  // ── Audit log ─────────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      userId,
      workspaceId: personalWorkspaceId,
      action:      "MANUAL_ASSET_ADD",
      metadata: {
        name:           fa.name,
        balance,
        currency:       fa.currency,
        assetKind,
        purchasePrice,
        purchaseDate,
        sharedWorkspaces: shareTargets,
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
