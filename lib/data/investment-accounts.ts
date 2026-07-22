/**
 * lib/data/investment-accounts.ts
 *
 * Read model for the Investments Perspective (Slice B) — current holdings
 * grouped by investment/crypto account, plus each Plaid connection's consent /
 * sync state so the workspace can render honest per-account states (holdings /
 * zero / enable / needs-reauth / error).
 *
 * Visibility: reuses getAccounts() from lib/data/accounts.ts and the canonical
 * position-presence signal countCurrentPositionsByAccount() (getCurrentPositions),
 * both of which enforce Space visibility (positions require a FULL link; the same
 * gate the AI/transaction read paths use). P2-5: Connections no longer reads the
 * general legacy `Holding` model — it needs only per-account position PRESENCE
 * (count), not holding contents, so it derives that from the ONE canonical
 * authority instead of the retiring read model. This module adds NO new Prisma
 * read surface beyond the ownership-scoped PlaidItem lookup below, which only
 * attaches Enable/Refresh affordances to connections the VIEWER owns.
 *
 * Current-state only — no historical positions/prices/returns (see Slice B
 * scope). No new schema.
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { getAccounts } from "@/lib/data/accounts";
import { countCurrentPositionsByAccount } from "@/lib/investments/current-positions";
import {
  buildInvestmentAccountsView,
  type InvestmentAccountInput,
  type InvestmentAccountView,
  type InvestmentProvider,
} from "@/lib/investments/current-holdings";

export type { InvestmentAccountView } from "@/lib/investments/current-holdings";

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

  // Canonical non-cash position count per account (getCurrentPositions, FULL-gated
  // inside the seam) — the position-PRESENCE signal, not holding contents.
  const [accounts, positionCountByAccount] = await Promise.all([
    getAccounts({ spaceId }),
    countCurrentPositionsByAccount({ spaceId }),
  ]);

  const investmentAccounts = accounts.filter(
    (a) => a.type === "investment" || a.type === "crypto",
  );
  if (investmentAccounts.length === 0) return [];

  const accountIds = investmentAccounts.map((a) => a.id);

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
      positionCount:      positionCountByAccount[a.id] ?? 0,
    };
  });

  return buildInvestmentAccountsView(inputs);
}
