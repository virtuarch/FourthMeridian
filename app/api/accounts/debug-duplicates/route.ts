/**
 * GET /api/accounts/debug-duplicates
 *
 * TEMPORARY, READ-ONLY diagnostic route — created to inspect the two visible
 * "Robinhood Individual" accounts reported by the user and determine whether
 * they are true duplicates (same plaidAccountId) or distinct accounts that
 * happen to share a display name. No writes happen here. Delete this file
 * once the investigation is complete — it is not part of the account
 * lifecycle feature set and should not ship.
 *
 * Scope: returns FinancialAccount rows the calling session user can see —
 * either because they own it (ownerUserId match) OR because it's shared
 * into a workspace they're an active member of (matches what the dashboard
 * actually renders via lib/data/accounts.ts getAccounts()). Filters by
 * whether name/displayName/officialName/plaidName/institution/the linked
 * PlaidItem's institutionName contains the `q` query param
 * (case-insensitive), default "robinhood". Returns every field needed to
 * judge true-duplicate-ness per the user's checklist: id, plaidAccountId,
 * institution, name variants, type/subtype, mask, balance, owner, connections,
 * workspace shares, and history counts (transactions, goal contributions,
 * debt profile presence).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  const q = req.nextUrl.searchParams.get("q")?.trim() || "robinhood";

  const memberships = await db.workspaceMember.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    select: { workspaceId: true },
  });
  const workspaceIds = memberships.map((m) => m.workspaceId);

  const accounts = await db.financialAccount.findMany({
    where: {
      AND: [
        {
          OR: [
            { ownerUserId: user.id },
            { workspaceShares: { some: { workspaceId: { in: workspaceIds } } } },
          ],
        },
        {
          OR: [
            { name:         { contains: q, mode: "insensitive" } },
            { displayName:  { contains: q, mode: "insensitive" } },
            { officialName: { contains: q, mode: "insensitive" } },
            { plaidName:    { contains: q, mode: "insensitive" } },
            { institution:  { contains: q, mode: "insensitive" } },
            { connections: { some: { plaidItem: { institutionName: { contains: q, mode: "insensitive" } } } } },
          ],
        },
      ],
    },
    include: {
      ownerUser: { select: { id: true, username: true, email: true } },
      connections: {
        select: {
          id: true,
          connectedByUserId: true,
          plaidItemDbId: true,
          syncStatus: true,
          isCanonical: true,
          lastSyncedAt: true,
          deletedAt: true,
          plaidItem: { select: { id: true, institutionId: true, institutionName: true, status: true } },
        },
      },
      workspaceShares: {
        select: { id: true, workspaceId: true, status: true, revokedAt: true, visibilityLevel: true, addedByUserId: true },
      },
      debtProfile: { select: { id: true } },
      _count: { select: { transactions: true, goalContributions: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const result = accounts.map((a) => ({
    id:              a.id,
    ownerUserId:     a.ownerUserId,
    owner:           a.ownerUser ? { id: a.ownerUser.id, username: a.ownerUser.username, email: a.ownerUser.email } : null,
    plaidAccountId:  a.plaidAccountId,
    institution:     a.institution,
    institutionId:   a.institutionId,
    name:            a.name,
    displayName:     a.displayName,
    officialName:    a.officialName,
    plaidName:       a.plaidName,
    type:            a.type,
    debtSubtype:     a.debtSubtype,
    mask:            a.mask,
    balance:         a.balance,
    currency:        a.currency,
    syncStatus:       a.syncStatus,
    walletAddress:   a.walletAddress,
    deletedAt:       a.deletedAt,
    createdAt:       a.createdAt,
    updatedAt:       a.updatedAt,
    lastUpdated:     a.lastUpdated,
    connections:     a.connections,
    workspaceShares: a.workspaceShares,
    hasDebtProfile:  !!a.debtProfile,
    transactionCount:       a._count.transactions,
    goalContributionCount:  a._count.goalContributions,
  }));

  return NextResponse.json({ query: q, count: result.length, accounts: result });
}
