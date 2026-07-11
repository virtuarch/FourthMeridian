/**
 * lib/data/investment-accounts.ts
 *
 * Read model for the Investments Perspective (Slice B) — current holdings
 * grouped by investment/crypto account, plus each Plaid connection's consent /
 * sync state so the workspace can render honest per-account states (holdings /
 * zero / enable / needs-reauth / error).
 *
 * Visibility: reuses getAccounts() + getHoldings() from lib/data/accounts.ts,
 * which already enforce Space visibility (positions require a FULL link; the
 * same gate the AI/transaction read paths use). This module adds NO new read
 * surface to Prisma beyond the ownership-scoped PlaidItem lookup below, which
 * only attaches Enable/Refresh affordances to connections the VIEWER owns.
 *
 * Current-state only — no historical positions/prices/returns (see Slice B
 * scope). No new schema.
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { getAccounts, getHoldings } from "@/lib/data/accounts";
import {
  buildInvestmentAccountsView,
  type InvestmentAccountInput,
  type InvestmentAccountView,
  type HoldingView,
  type InvestmentProvider,
} from "@/lib/investments/current-holdings";

export type { InvestmentAccountView, HoldingView } from "@/lib/investments/current-holdings";

/**
 * Build the per-account Investments view for a Space. `userId` is the VIEWER —
 * Plaid consent/status and the Enable/Refresh affordances are attached only to
 * connections owned by that user (Space ownership rule); a member viewing
 * someone else's shared investment account sees its holdings (if FULL) but no
 * owner-only actions.
 */
export async function getInvestmentAccountsView(
  ctx?: { spaceId: string; userId: string },
): Promise<InvestmentAccountView[]> {
  const { spaceId, userId } = ctx ?? (await getSpaceContext());

  const [accounts, holdings] = await Promise.all([
    getAccounts({ spaceId }),
    getHoldings({ spaceId }),
  ]);

  const investmentAccounts = accounts.filter(
    (a) => a.type === "investment" || a.type === "crypto",
  );
  if (investmentAccounts.length === 0) return [];

  const accountIds = investmentAccounts.map((a) => a.id);

  // Holdings grouped by (normalized) accountId.
  const holdingsByAccount = new Map<string, HoldingView[]>();
  for (const h of holdings) {
    if (!accountIds.includes(h.accountId)) continue;
    const list = holdingsByAccount.get(h.accountId) ?? [];
    list.push({
      id:        h.id,
      symbol:    h.symbol,
      name:      h.name,
      quantity:  h.quantity,
      price:     h.price,
      value:     h.value,
      currency:  h.currency ?? null,
      change24h: h.change24h,
      isCash:    h.isCash,
    });
    holdingsByAccount.set(h.accountId, list);
  }

  // Owner-scoped Plaid connection state per account. Only the viewer's own
  // connection (PlaidItem.userId === userId) attaches consent/status so the
  // Enable/Refresh affordances never appear on another member's account.
  const conns = await db.accountConnection.findMany({
    where: {
      financialAccountId: { in: accountIds },
      deletedAt:          null,
      plaidItemDbId:      { not: null },
      plaidItem:          { userId },
    },
    select: {
      financialAccountId: true,
      plaidItem: {
        select: { id: true, investmentsConsent: true, status: true, lastSyncedAt: true, errorCode: true },
      },
    },
  });
  const itemByAccount = new Map<string, (typeof conns)[number]["plaidItem"]>();
  for (const c of conns) {
    if (c.plaidItem && !itemByAccount.has(c.financialAccountId)) {
      itemByAccount.set(c.financialAccountId, c.plaidItem);
    }
  }

  const inputs: InvestmentAccountInput[] = investmentAccounts.map((a) => {
    const item = itemByAccount.get(a.id) ?? null;
    const provider: InvestmentProvider = a.walletChain
      ? "WALLET"
      : item
        ? "PLAID"
        : "MANUAL";
    return {
      accountId:          a.id,
      name:               a.name,
      institution:        a.institution,
      type:               a.type === "crypto" ? "crypto" : "investment",
      balance:            a.balance,
      currency:           a.currency ?? "USD",
      lastUpdated:        a.lastUpdated ?? null,
      provider,
      plaidItemId:        item?.id ?? null,
      investmentsConsent: item?.investmentsConsent ?? null,
      itemStatus:         (item?.status as InvestmentAccountInput["itemStatus"]) ?? null,
      itemErrorCode:      item?.errorCode ?? null,
      lastSyncedAt:       item?.lastSyncedAt ? item.lastSyncedAt.toISOString() : null,
      holdings:           holdingsByAccount.get(a.id) ?? [],
    };
  });

  return buildInvestmentAccountsView(inputs);
}
