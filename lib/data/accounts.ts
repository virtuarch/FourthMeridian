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

/**
 * All accounts visible to the current workspace, via WorkspaceAccountShare.
 *
 * Pass `ctx` when the caller has already resolved workspace context for this
 * request (e.g. the dashboard page resolves it once and fans it out to all
 * its data helpers) to avoid a redundant getWorkspaceContext() call. Falls
 * back to resolving it internally (now cached per-request via React's
 * cache()) when called standalone, so existing callers keep working.
 */
export async function getAccounts(ctx?: { workspaceId: string }): Promise<Account[]> {
  const { workspaceId } = ctx ?? (await getWorkspaceContext());

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
export async function getHoldings(ctx?: { workspaceId: string }): Promise<Holding[]> {
  const { workspaceId } = ctx ?? (await getWorkspaceContext());

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
export async function getFicoData(ctx?: { userId: string }): Promise<{ score: number | null; updatedAt: string | null }> {
  const { userId } = ctx ?? (await getWorkspaceContext());

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
