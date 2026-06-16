import { getServerSession } from "next-auth";
import { authOptions }      from "@/lib/auth";
import { db }               from "@/lib/db";
import { redirect }         from "next/navigation";
import { ArchivedAssetsClient, type ArchivedAsset } from "@/components/dashboard/ArchivedAssetsClient";

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

  // All of the current user's soft-deleted accounts — Plaid, manual, and
  // wallet alike — not just manual assets. Restore/delete actions in
  // ArchivedAssetsClient branch per-row based on `source`.
  const accounts = await db.financialAccount.findMany({
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
  });

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

  return <ArchivedAssetsClient assets={assets} />;
}
