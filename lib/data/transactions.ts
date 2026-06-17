/**
 * lib/data/transactions.ts
 *
 * Server-only transaction queries.
 *
 * Transactions reach a workspace via two paths (see Transaction model comment
 * in prisma/schema.prisma):
 *  - legacy rows: account.workspaceId (the old Account model)
 *  - Plaid-synced rows: financialAccount.workspaceShares (the canonical
 *    FinancialAccount + WorkspaceAccountShare model)
 * Every query below matches both so newly-synced Plaid transactions show up
 * alongside legacy/manual ones. `accountId` on the returned objects is
 * normalized to whichever FK is actually set, since callers (e.g. AccountModal)
 * match transactions to an account by this single id field.
 */

import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { Transaction, InvestmentTransaction } from "@/types";
import { ShareStatus } from "@prisma/client";

const BANKING_CATEGORIES = [
  "Income","Transfer","Groceries","Dining","Shopping","Travel",
  "Subscriptions","Utilities","Interest","Payment","Other",
];

/** Banking transactions only (excludes investment activity), newest first. */
export async function getTransactions(): Promise<Transaction[]> {
  const { workspaceId } = await getWorkspaceContext();

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { workspaceId } },
        { financialAccount: { workspaceShares: { some: { workspaceId, status: ShareStatus.ACTIVE } } } },
      ],
      category: { in: BANKING_CATEGORIES as never[] },
    },
    orderBy: { date: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    id:          r.id,
    accountId:   r.accountId ?? r.financialAccountId,
    date:        r.date.toISOString().split("T")[0],
    merchant:    r.merchant,
    description: r.description ?? undefined,
    category:    r.category as Transaction["category"],
    amount:      r.amount,
    pending:     r.pending,
  }));
}

/** Transactions for debt accounts only (credit card activity), newest first. */
export async function getDebtTransactions(ctx?: { workspaceId: string }): Promise<Transaction[]> {
  const { workspaceId } = ctx ?? (await getWorkspaceContext());

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { workspaceId, type: "debt" } },
        { financialAccount: { type: "debt", workspaceShares: { some: { workspaceId, status: ShareStatus.ACTIVE } } } },
      ],
      category: { in: BANKING_CATEGORIES as never[] },
    },
    orderBy: { date: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    id:          r.id,
    accountId:   r.accountId ?? r.financialAccountId,
    date:        r.date.toISOString().split("T")[0],
    merchant:    r.merchant,
    description: r.description ?? undefined,
    category:    r.category as Transaction["category"],
    amount:      r.amount,
    pending:     r.pending,
  }));
}

/** Investment transactions (Buy/Sell/Dividend/Split/Fee), newest first. */
export async function getInvestmentTransactions(): Promise<InvestmentTransaction[]> {
  const { workspaceId } = await getWorkspaceContext();

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { workspaceId } },
        { financialAccount: { workspaceShares: { some: { workspaceId, status: ShareStatus.ACTIVE } } } },
      ],
      category: { in: ["Buy","Sell","Dividend","Split","Fee"] as never[] },
    },
    orderBy: { date: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    id:          r.id,
    accountId:   r.accountId ?? r.financialAccountId,
    date:        r.date.toISOString().split("T")[0],
    ticker:      r.merchant,
    description: r.description ?? "",
    category:    r.category as InvestmentTransaction["category"],
    amount:      r.amount,
  }));
}
