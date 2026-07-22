/**
 * lib/plaid/account-type.ts
 *
 * PROV-2 — the ONE owner of Plaid's `type`/`subtype` → `AccountType` mapping.
 *
 * Moved verbatim from lib/plaid/exchangeToken.ts (where it was exported) to end
 * the byte-identical private copy that had drifted into lib/plaid/refresh.ts.
 * Both hot paths, and any future Plaid consumer, import it from here. This is
 * Plaid's provider taxonomy specifically — not a provider-neutral abstraction
 * (there is no second bank aggregator to generalize from; see CCPAY-2G). A
 * different provider that needs the same shape writes its own mapping.
 */

import { AccountType } from "@prisma/client";

export function mapAccountType(type: string, subtype: string | null | undefined): AccountType {
  switch (type) {
    case "depository":
      return subtype === "savings" || subtype === "money market" || subtype === "cd"
        ? AccountType.savings
        : AccountType.checking;
    case "investment":
      return subtype === "crypto exchange"
        ? AccountType.crypto
        : AccountType.investment;
    case "credit":
    case "loan":
      return AccountType.debt;
    default:
      return AccountType.other;
  }
}
