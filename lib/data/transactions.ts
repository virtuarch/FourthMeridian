/**
 * lib/data/transactions.ts
 *
 * Server-only transaction queries.
 * Filters by workspaceId via the account relation (account.workspaceId).
 */

import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { Transaction, InvestmentTransaction } from "@/types";

const BANKING_CATEGORIES = [
  "Income","Transfer","Groceries","Dining","Shopping","Travel",
  "Subscriptions","Utilities","Interest","Payment","Other",
];

/** Banking transactions only (excludes investment activity), newest first. */
export async function getTransactions(): Promise<Transaction[]> {
  const { workspaceId } = await getWorkspaceContext();

  const rows = await db.transaction.findMany({
    where: {
      account:  { workspaceId },
      category: { in: BANKING_CATEGORIES as never[] },
    },
    orderBy: { date: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    id:          r.id,
    accountId:   r.accountId,
    date:        r.date.toISOString().split("T")[0],
    merchant:    r.merchant,
    description: r.description ?? undefined,
    category:    r.category as Transaction["category"],
    amount:      r.amount,
    pending:     r.pending,
  }));
}

/** Transactions for debt accounts only (credit card activity), newest first. */
export async function getDebtTransactions(): Promise<Transaction[]> {
  const { workspaceId } = await getWorkspaceContext();

  const rows = await db.transaction.findMany({
    where: {
      account:  { workspaceId, type: "debt" },
      category: { in: BANKING_CATEGORIES as never[] },
    },
    orderBy: { date: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    id:          r.id,
    accountId:   r.accountId,
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
      account:  { workspaceId },
      category: { in: ["Buy","Sell","Dividend","Split","Fee"] as never[] },
    },
    orderBy: { date: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    id:          r.id,
    accountId:   r.accountId,
    date:        r.date.toISOString().split("T")[0],
    ticker:      r.merchant,
    description: r.description ?? "",
    category:    r.category as InvestmentTransaction["category"],
    amount:      r.amount,
  }));
}
