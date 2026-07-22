/**
 * lib/export/select.ts  (OPS-2 S6)
 *
 * PURE selection/shaping helpers for the personal-data export. No DB, no I/O,
 * no request scope — so they are unit-testable in isolation (lib/export/select.test.ts)
 * and carry ZERO visibility logic of their own. The export's privacy guarantees
 * come entirely from the existing read layer (lib/data/*, lib/ai/visibility.ts);
 * these helpers only reshape rows that layer already redacted.
 *
 * The one privacy-adjacent rule here is a positive filter, not a new predicate:
 * `FULL` is the single visibility value the export includes for shared accounts
 * (approved decision D3). It reuses the exact enum value the data layer's
 * grantsAccountDetail()/TRANSACTION_DETAIL_VISIBILITY already gate on — it does
 * not re-derive who may see what.
 */

import type { VisibilityLevel } from "@prisma/client";

/**
 * KD-7 precedent — the 5,000-row transaction cap the AI assembler already
 * applies (lib/ai/assemblers/transactions.ts). The export mirrors it (approved
 * decision D6): the newest 5,000 banking transactions are exported and
 * `truncated: true` is stamped in the manifest when the cap is hit.
 */
export const EXPORT_TRANSACTION_CAP = 5000;

/**
 * Approved decision D3 — for accounts the user does NOT own, the export
 * includes ONLY those linked to a Space at FULL visibility. BALANCE_ONLY /
 * SUMMARY_ONLY / PRIVATE shares are another member's partial exposure and are
 * excluded. Owned accounts always carry a FULL HOME link in their owning
 * Space, so this same filter keeps them.
 */
export function isFullVisibility(level: VisibilityLevel | string): boolean {
  return level === "FULL";
}

/** Stable dedup by `id`, keeping first occurrence (input order preserved). */
export function dedupById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * Sort newest-first by ISO `date` then apply the transaction cap (D6). Returns
 * the kept rows plus whether the cap truncated the set — the manifest's
 * `truncated` flag.
 */
export function capTransactions<T extends { date: string }>(
  rows: T[],
  cap: number = EXPORT_TRANSACTION_CAP,
): { rows: T[]; truncated: boolean } {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (sorted.length > cap) return { rows: sorted.slice(0, cap), truncated: true };
  return { rows: sorted, truncated: false };
}

/**
 * Approved decision D4 — a goal's contributions are kept only when their
 * account is visible to the user at FULL in the goal's Space. A contribution
 * pointing at an account the user can't see at FULL would leak another
 * member's account id, so it is dropped.
 */
export function filterVisibleContributions<C extends { financialAccountId: string }>(
  contributions: C[],
  fullVisibleAccountIds: Set<string>,
): C[] {
  return contributions.filter((c) => fullVisibleAccountIds.has(c.financialAccountId));
}
