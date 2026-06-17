import { getServerSession } from "next-auth";
import { authOptions }      from "@/lib/auth";
import { db }               from "@/lib/db";
import { redirect }         from "next/navigation";
import {
  ArchiveBinClient,
  type ArchivedAsset,
  type ArchivedWorkspace,
  type TrashedWorkspace,
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
        workspaceShares: {
          select: {
            workspace: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { deletedAt: "desc" },
    }),

    // Archived (not yet trashed) workspaces the user is still an active
    // member of. Shown to any member; restore/trash actions are gated to
    // OWNER in the client.
    db.workspaceMember.findMany({
      where: { userId, status: "ACTIVE", workspace: { archivedAt: { not: null }, deletedAt: null } },
      select: {
        role:      true,
        workspace: { select: { id: true, name: true, type: true, category: true, archivedAt: true } },
      },
      orderBy: { workspace: { archivedAt: "desc" } },
    }),

    // Trashed workspaces the user is still an active member of.
    db.workspaceMember.findMany({
      where: { userId, status: "ACTIVE", workspace: { deletedAt: { not: null } } },
      select: {
        role:      true,
        workspace: { select: { id: true, name: true, type: true, category: true, deletedAt: true } },
      },
      orderBy: { workspace: { deletedAt: "desc" } },
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
    workspaces: a.workspaceShares.map((s) => ({
      id:   s.workspace.id,
      name: s.workspace.name,
    })),
  }));

  const archivedWorkspaces: ArchivedWorkspace[] = archivedMemberships.map((m) => ({
    id:         m.workspace.id,
    name:       m.workspace.name,
    type:       m.workspace.type,
    category:   m.workspace.category,
    archivedAt: m.workspace.archivedAt!.toISOString(),
    myRole:     m.role,
  }));

  const trashedWorkspaces: TrashedWorkspace[] = trashedMemberships.map((m) => ({
    id:        m.workspace.id,
    name:      m.workspace.name,
    type:      m.workspace.type,
    category:  m.workspace.category,
    deletedAt: m.workspace.deletedAt!.toISOString(),
    myRole:    m.role,
  }));

  return (
    <ArchiveBinClient
      assets={assets}
      archivedWorkspaces={archivedWorkspaces}
      trashedWorkspaces={trashedWorkspaces}
    />
  );
}
