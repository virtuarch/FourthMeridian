/**
 * lib/data/transactions.ts
 *
 * Server-only transaction queries.
 *
 * Transactions reach a space via two paths (see Transaction model comment
 * in prisma/schema.prisma):
 *  - legacy rows: account.spaceId (the old Account model)
 *  - Plaid-synced rows: financialAccount.workspaceShares (the canonical
 *    FinancialAccount + WorkspaceAccountShare model)
 * Every query below matches both so newly-synced Plaid transactions show up
 * alongside legacy/manual ones. `accountId` on the returned objects is
 * normalized to whichever FK is actually set, since callers (e.g. AccountModal)
 * match transactions to an account by this single id field.
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { Transaction, InvestmentTransaction } from "@/types";
import { ShareStatus } from "@prisma/client";

const BANKING_CATEGORIES = [
  "Income","Transfer","Groceries","Dining","Shopping","Travel",
  "Subscriptions","Utilities","Interest","Payment","Other",
];

/** Banking transactions only (excludes investment activity), newest first. */
export async function getTransactions(ctx?: { spaceId: string }): Promise<Transaction[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { spaceId } },
        // WorkspaceAccountShare keeps its own pre-Phase-1 field name (workspaceId).
        // deletedAt: null guards against an archived account's transactions
        // surfacing in a shared Space if its share were ever left ACTIVE —
        // same defensive filter getAccounts()/getHoldings() already apply.
        { financialAccount: { deletedAt: null, workspaceShares: { some: { workspaceId: spaceId, status: ShareStatus.ACTIVE } } } },
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
export async function getDebtTransactions(ctx?: { spaceId: string }): Promise<Transaction[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { spaceId, type: "debt" } },
        // WorkspaceAccountShare keeps its own pre-Phase-1 field name (workspaceId).
        // deletedAt: null — see getTransactions() above for rationale.
        { financialAccount: { type: "debt", deletedAt: null, workspaceShares: { some: { workspaceId: spaceId, status: ShareStatus.ACTIVE } } } },
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
  const { spaceId } = await getSpaceContext();

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { spaceId } },
        // WorkspaceAccountShare keeps its own pre-Phase-1 field name (workspaceId).
        // deletedAt: null — see getTransactions() above for rationale.
        { financialAccount: { deletedAt: null, workspaceShares: { some: { workspaceId: spaceId, status: ShareStatus.ACTIVE } } } },
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
