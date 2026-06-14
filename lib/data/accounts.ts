/**
 * lib/data/accounts.ts
 *
 * Server-only. All functions query Prisma and return plain serialisable objects
 * (no Date instances) so they can be passed safely from Server → Client components.
 *
 * getAccounts() now queries via WorkspaceAccountShare → FinancialAccount.
 * getHoldings() still queries the legacy Account → Holding path until Holding
 * FKs are migrated to AccountConnection in a future milestone.
 */

import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { Account, Holding } from "@/types";
import { ShareStatus } from "@prisma/client";

/** All accounts visible to the current workspace, via WorkspaceAccountShare. */
export async function getAccounts(): Promise<Account[]> {
  const { workspaceId } = await getWorkspaceContext();

  const shares = await db.workspaceAccountShare.findMany({
    where: {
      workspaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    include: { financialAccount: true },
    orderBy: [
      { financialAccount: { type: "asc" } },
      { financialAccount: { name: "asc" } },
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return shares.map(({ financialAccount: r }: any) => ({
    id:            r.id,
    name:          r.name,
    type:          r.type as Account["type"],
    institution:   r.institution,
    balance:       r.balance,
    currency:      r.currency,
    lastUpdated:   r.lastUpdated.toISOString(),
    creditLimit:    r.creditLimit    ?? undefined,
    debtSubtype:    r.debtSubtype    ?? undefined,
    interestRate:   r.interestRate   ?? undefined,
    minimumPayment: r.minimumPayment ?? undefined,
    walletAddress:  r.walletAddress  ?? undefined,
    walletChain:   r.walletChain   as Account["walletChain"] ?? undefined,
    nativeBalance: r.nativeBalance ?? undefined,
    syncStatus:    r.syncStatus    as Account["syncStatus"]  ?? undefined,
  }));
}

/**
 * All holdings across all investment accounts.
 * Still queries via the legacy Account → Holding path until Holding FKs are
 * moved to AccountConnection in a future milestone.
 */
export async function getHoldings(): Promise<Holding[]> {
  const { workspaceId } = await getWorkspaceContext();

  const rows = await db.holding.findMany({
    where: { account: { workspaceId } },
    orderBy: { value: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    id:        r.id,
    accountId: r.accountId,
    symbol:    r.symbol,
    name:      r.name,
    quantity:  r.quantity,
    price:     r.price,
    value:     r.value,
    change24h: r.change24h,
    isCash:    r.isCash,
  }));
}

/**
 * Latest credit score for the current user.
 * CreditScore is user-owned (not workspace-owned) since it is personal identity data.
 */
export async function getFicoData(): Promise<{ score: number | null; updatedAt: string | null }> {
  const { userId } = await getWorkspaceContext();

  const row = await db.creditScore.findFirst({
    where:   { userId },
    orderBy: { recordedAt: "desc" },
    select:  { score: true, recordedAt: true },
  });

  return {
    score:     row?.score      ?? null,
    updatedAt: row?.recordedAt?.toISOString() ?? null,
  };
}

/** @deprecated use getFicoData instead */
export async function getFicoScore(): Promise<number | null> {
  return (await getFicoData()).score;
}
