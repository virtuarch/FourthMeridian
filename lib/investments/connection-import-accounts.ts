/**
 * lib/investments/connection-import-accounts.ts
 *
 * A7-6 — resolve the investment FinancialAccounts that belong to a connection,
 * by STABLE id (never by institution display name). The connection id is a
 * PlaidItem.id; the join is AccountConnection.plaidItemDbId → PlaidItem, gated to
 * the requesting user (authorization). Returns masked-safe display fields for the
 * import target picker.
 */

import { AccountType, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
// v2.6-TRUTH-10 — the ONE account-identity authority. This module used to
// re-implement the resolution order inline; a fifth copy of a rule is a fifth
// place for it to drift, which is exactly how the admin drawer once shipped a
// version that omitted `plaidName`.
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";

export interface ImportableConnectionAccount {
  id:          string;
  /** The canonical display identity — `accountDisplayName`, never a local order. */
  name:        string;
  type:        string;
  mask:        string | null;
  institution: string;
}

const INVESTMENT_TYPES: AccountType[] = [AccountType.investment, AccountType.crypto];

/**
 * Investment/crypto accounts for a connection (PlaidItem.id) owned by `userId`.
 * Empty when the connection isn't the user's, has no investment accounts, or the
 * id is unknown — the caller treats an empty list as "import not available here".
 */
export async function getImportableAccountsForConnection(args: {
  connectionId: string;
  userId:       string;
  client?:      PrismaClient;
}): Promise<ImportableConnectionAccount[]> {
  const client = args.client ?? db;
  const links = await client.accountConnection.findMany({
    where: {
      plaidItemDbId:    args.connectionId,
      plaidItem:        { userId: args.userId },
      financialAccount: { deletedAt: null, type: { in: INVESTMENT_TYPES } },
    },
    select: {
      financialAccount: {
        select: { id: true, ...ACCOUNT_NAME_SELECT, type: true, mask: true, institution: true },
      },
    },
  });

  const byId = new Map<string, ImportableConnectionAccount>();
  for (const l of links) {
    const a = l.financialAccount;
    if (!a || byId.has(a.id)) continue;
    byId.set(a.id, {
      id:          a.id,
      name:        accountDisplayName(a),
      type:        a.type,
      mask:        a.mask,
      institution: a.institution,
    });
  }
  return [...byId.values()].sort((x, y) => x.name.localeCompare(y.name));
}
