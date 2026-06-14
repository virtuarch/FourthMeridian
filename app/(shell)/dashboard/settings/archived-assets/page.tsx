import { getServerSession } from "next-auth";
import { authOptions }      from "@/lib/auth";
import { db }               from "@/lib/db";
import { redirect }         from "next/navigation";
import { ArchivedAssetsClient, type ArchivedAsset } from "@/components/dashboard/ArchivedAssetsClient";

export default async function ArchivedAssetsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;

  const accounts = await db.financialAccount.findMany({
    where: {
      ownerUserId: userId,
      type:        "other",
      syncStatus:  "manual",
      deletedAt:   { not: null },
    },
    select: {
      id:        true,
      name:      true,
      balance:   true,
      currency:  true,
      deletedAt: true,
      workspaceShares: {
        select: {
          workspace: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { deletedAt: "desc" },
  });

  const assets: ArchivedAsset[] = accounts.map((a) => ({
    id:        a.id,
    name:      a.name,
    balance:   a.balance,
    currency:  a.currency,
    deletedAt: a.deletedAt!.toISOString(),
    workspaces: a.workspaceShares.map((s) => ({
      id:   s.workspace.id,
      name: s.workspace.name,
    })),
  }));

  return <ArchivedAssetsClient assets={assets} />;
}
