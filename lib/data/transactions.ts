/**
 * lib/data/transactions.ts
 *
 * Server-only transaction queries.
 *
 * Transactions reach a space via two paths (see Transaction model comment
 * in prisma/schema.prisma):
 *  - legacy rows: account.spaceId (the old Account model)
 *  - Plaid-synced rows: financialAccount.spaceAccountLinks (D3 Step 4C read
 *    cutover — see docs/initiatives/d3/D3_STEP4C_CORE_DASHBOARD_REVIEW.md; replaces the prior
 *    financialAccount.workspaceShares query). Visibility is status: ACTIVE on
 *    the link; `kind` (HOME vs SHARED) is not filtered on — both confer
 *    visibility. This is the identical link/status shape lib/data/accounts.ts
 *    now uses, so accounts, holdings, and transactions cannot disagree on
 *    what's visible.
 * Every query below matches both so newly-synced Plaid transactions show up
 * alongside legacy/manual ones. `accountId` on the returned objects is
 * normalized to whichever FK is actually set, since callers (e.g. AccountModal)
 * match transactions to an account by this single id field.
 *
 * D2 Step 4D-R: every query below also filters Transaction.deletedAt: null,
 * excluding rows soft-deleted by an import rollback. This is the row's own
 * soft-delete and is independent of (ANDed with) the financialAccount.deletedAt
 * account-level guard above — both must hold for a transaction to be visible.
 * See docs/initiatives/d2/investigations/D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md.
 *
 * KD-15 (2026-07-02): the SpaceAccountLink path additionally requires a
 * visibilityLevel that grants transaction-level detail
 * (TRANSACTION_DETAIL_VISIBILITY, lib/ai/visibility.ts — currently FULL only).
 * This is the UI counterpart to KD-1, which fixed the AI-context queries in
 * lib/ai/assemblers/transactions.ts. Both paths import the SAME predicate so a
 * BALANCE_ONLY / SUMMARY_ONLY shared account can never leak its transaction
 * rows — the account still contributes a balance total via lib/account-privacy.ts
 * (the accounts path), but its rows, merchants, and amounts never reach these UI
 * lists. The legacy Account path (account.spaceId) is the Space's own accounts
 * and is FULL by definition, so it is left unfiltered. Fails closed: absence of
 * a transaction-detail grant excludes the rows, never leaks them.
 * KD-15 is tracked in STATUS.md (known defects register).
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { Transaction, InvestmentTransaction } from "@/types";
import { ShareStatus } from "@prisma/client";

import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";

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
        // deletedAt: null guards against an archived account's transactions
        // surfacing in a shared Space if its link were ever left ACTIVE —
        // same defensive filter getAccounts()/getHoldings() already apply.
        // visibilityLevel (KD-15): only links granting transaction detail
        // (FULL) contribute rows; BALANCE_ONLY / SUMMARY_ONLY are excluded.
        { financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } } } },
      ],
      // Transaction.deletedAt: null — D2 Step 4D-R: excludes rows soft-deleted
      // by an import rollback. See module header above for rationale.
      deletedAt: null,
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
        // deletedAt: null + visibilityLevel (KD-15) — see getTransactions() above.
        { financialAccount: { type: "debt", deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } } } },
      ],
      // Transaction.deletedAt: null — D2 Step 4D-R, see getTransactions() above.
      deletedAt: null,
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
        // deletedAt: null + visibilityLevel (KD-15) — see getTransactions() above.
        { financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } } } },
      ],
      // Transaction.deletedAt: null — D2 Step 4D-R, see getTransactions() above.
      deletedAt: null,
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
