import { getServerSession } from "next-auth";
import { authOptions }      from "@/lib/auth";
import { db }               from "@/lib/db";
import { redirect }         from "next/navigation";
import {
  ArchiveBinClient,
  type ArchivedAsset,
  type ArchivedSpace,
  type TrashedSpace,
} from "@/components/dashboard/ArchivedAssetsClient";

// Derive a display source from the fields that already distinguish how a
// FinancialAccount was created — no schema change needed. Self-custody
// wallets always have walletAddress set (see app/api/accounts/wallet/route.ts);
// manual assets are syncStatus="manual" (see app/api/accounts/manual/route.ts);
// everything else came in through Plaid (syncStatus="synced"/"pending"/"error").
function deriveSource(a: { syncStatus: string | null; walletAddress: string | null }): ArchivedAsset["source"] {
  if (a.walletAddress) return "wallet";
  if (a.syncStatus === "manual") return "manual";
  return "plaid";
}

export default async function ArchivedAssetsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;

  // Three independent lists feeding the three tabs — run concurrently.
  const [accounts, archivedMemberships, trashedMemberships] = await Promise.all([
    // All of the current user's soft-deleted accounts — Plaid, manual, and
    // wallet alike — not just manual assets. Restore/delete actions in
    // ArchiveBinClient branch per-row based on `source`.
    db.financialAccount.findMany({
      where: {
        ownerUserId: userId,
        deletedAt:   { not: null },
      },
      select: {
        id:            true,
        name:          true,
        balance:       true,
        currency:      true,
        deletedAt:     true,
        type:          true,
        syncStatus:    true,
        walletAddress: true,
        institution:   true,
        // D3 Step 4E read cutover — replaces the prior workspaceShares
        // (WorkspaceAccountShare) include. SpaceAccountLink is kept in sync
        // with it by the D3 Step 3 dual-write
        // (lib/accounts/space-account-link.ts), so this read returns the
        // same set of spaces either way. No status filter, matching the
        // prior workspaceShares behavior (active and revoked links both
        // surface here). Response shape (spaces: {id, name}[]) is unchanged
        // — see docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md.
        spaceAccountLinks: {
          select: {
            space: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { deletedAt: "desc" },
    }),

    // Archived (not yet trashed) spaces the user is still an active
    // member of. Shown to any member; restore/trash actions are gated to
    // OWNER in the client.
    db.spaceMember.findMany({
      where: { userId, status: "ACTIVE", space: { archivedAt: { not: null }, deletedAt: null } },
      select: {
        role:      true,
        space: { select: { id: true, name: true, type: true, category: true, archivedAt: true } },
      },
      orderBy: { space: { archivedAt: "desc" } },
    }),

    // Trashed spaces the user is still an active member of.
    db.spaceMember.findMany({
      where: { userId, status: "ACTIVE", space: { deletedAt: { not: null } } },
      select: {
        role:      true,
        space: { select: { id: true, name: true, type: true, category: true, deletedAt: true } },
      },
      orderBy: { space: { deletedAt: "desc" } },
    }),
  ]);

  const assets: ArchivedAsset[] = accounts.map((a) => ({
    id:          a.id,
    name:        a.name,
    balance:     a.balance,
    currency:    a.currency,
    deletedAt:   a.deletedAt!.toISOString(),
    institution: a.institution,
    source:      deriveSource(a),
    spaces: a.spaceAccountLinks.map((l) => ({
      id:   l.space.id,
      name: l.space.name,
    })),
  }));

  const archivedSpaces: ArchivedSpace[] = archivedMemberships.map((m) => ({
    id:         m.space.id,
    name:       m.space.name,
    type:       m.space.type,
    category:   m.space.category,
    archivedAt: m.space.archivedAt!.toISOString(),
    myRole:     m.role,
  }));

  const trashedSpaces: TrashedSpace[] = trashedMemberships.map((m) => ({
    id:        m.space.id,
    name:      m.space.name,
    type:      m.space.type,
    category:  m.space.category,
    deletedAt: m.space.deletedAt!.toISOString(),
    myRole:    m.role,
  }));

  return (
    <ArchiveBinClient
      assets={assets}
      archivedSpaces={archivedSpaces}
      trashedSpaces={trashedSpaces}
    />
  );
}
