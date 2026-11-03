/**
 * lib/export/accounts.ts  (FM-AUDIT-022)
 *
 * PURE projection of a read-layer account into the export DTO. No DB, no clock
 * (lib/export/accounts.test.ts).
 *
 * An export is a USER-HELD RECORD: it outlives the UI that would otherwise
 * qualify a figure. A wallet with no value (NO_PRICE / NO_OBSERVATION, per
 * `resolveWalletBalance`) reaches this layer as `balance: 0` flagged
 * `valuationUnknown` — a structural 0 that every total EXCLUDES. Written into a
 * file as `0` / `0.00`, that structural zero becomes a false statement of value.
 *
 * So an unvalued account is RETAINED with `balance: null` and
 * `valuationStatus: "not_yet_valued"` — never 0 — exactly the holdings
 * doctrine (lib/export/holdings.ts: an unvalued position keeps its row with a
 * BLANK value). Every valued account passes through byte-identical: no
 * `valuationStatus` key is added to it.
 */

import type { Account } from "@/types";
import type { ExportAccount } from "@/lib/export/types";

/** The one status an export emits for an account it cannot value. */
export const NOT_YET_VALUED = "not_yet_valued" as const;

/** Read-layer account (+ Space tag) → export account. */
export function toExportAccount(account: Account, spaceId: string, spaceName: string): ExportAccount {
  if (account.valuationUnknown !== true) return { ...account, spaceId, spaceName };
  // The structural-0 flag is replaced by the export's own vocabulary: one field
  // says why `balance` is null, so a reader never has to combine two.
  const { valuationUnknown: _flag, ...rest } = account;
  return { ...rest, balance: null, valuationStatus: NOT_YET_VALUED, spaceId, spaceName };
}

/** How many exported accounts carry no value (for the manifest note). */
export function countUnvaluedExportAccounts(rows: readonly ExportAccount[]): number {
  return rows.filter((r) => r.valuationStatus === NOT_YET_VALUED).length;
}
