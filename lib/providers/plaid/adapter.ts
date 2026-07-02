/**
 * lib/providers/plaid/adapter.ts
 *
 * D2-5 — minimal sync-provider seam. Pure re-export, zero logic. Not yet
 * referenced by any route; routes continue importing refreshPlaidItem /
 * syncTransactionsForItem directly until a separate wiring step explicitly
 * adopts this. Exists so a second sync provider has an obvious pattern to
 * follow instead of ad hoc functions in lib/plaid/*.
 *
 * Deliberately not typed against a shared ProviderAdapter interface — see
 * docs/initiatives/d2/ D2 Step 5B investigation for why a generic adapter
 * framework is out of scope until a second sync provider exists.
 */

import { refreshPlaidItem } from "@/lib/plaid/refresh";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { ProviderType } from "@prisma/client";

export const plaidAdapter = {
  provider: ProviderType.PLAID,
  refreshItem: refreshPlaidItem,
  syncTransactions: syncTransactionsForItem,
};
