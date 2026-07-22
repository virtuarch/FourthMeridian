/**
 * components/dashboard/rebuild-range.ts
 *
 * PURE range logic for the wealth-history "Rebuild history" control (REG-3/REG-4).
 * No React, no DB — fixture-testable.
 *
 * REG-3 (scope contract): a SpaceSnapshot is a Space-level aggregate — you cannot
 * rebuild "just one account's slice" (snapshot-amendment.ts §2; the recompute in
 * regenerateWealthHistory is deliberately Space-wide). So the "From" floor must be
 * the SPACE-WIDE earliest reconstructable date (the minimum earliest-transaction
 * across the Space's accounts), NOT the single selected account's — otherwise the
 * UI forbids dates the Space-wide server would honor. One range authority, matching
 * the one scope authority. The account picker records WHICH account motivated the
 * rebuild; it never narrows the range.
 *
 * REG-4 (depth + sync awareness): the picker MINIMUM is the earliest AVAILABLE date
 * (`earliest`) — the same MIN(non-deleted Transaction.date) authority the server
 * floors at — so the UI can never claim history the server can't rebuild, and the
 * user can always drag "From" all the way back to the full history. The initial
 * DEFAULT (`defaultFrom`), however, is a practical `windowFrom` (To − 30 days),
 * clamped so it never predates `earliest` — opening the dialog on a sensible recent
 * window instead of defaulting the action to a huge full-history rebuild. When NO
 * account has any synced transaction yet, deep history may still be importing after
 * a recent connect — surfaced honestly (historyPending).
 */

/** The single field this module needs off each account row. */
export interface RebuildRangeAccount {
  /** YYYY-MM-DD earliest non-deleted transaction; null when none synced. */
  earliestTxDate?: string | null;
}

export interface RebuildRange {
  /**
   * Space-wide earliest reconstructable date — MIN(earliestTxDate) across accounts,
   * or null when no account has any synced transaction. The single "From" floor.
   */
  earliest: string | null;
  /**
   * The INITIAL "From" the dialog opens on: the practical `windowFrom` (To − 30
   * days), clamped so it never predates `earliest` (a shallow-history account
   * defaults to its own earliest date, not a window before its data). NOT the
   * picker minimum — the user can still drag From back to `earliest`.
   */
  defaultFrom: string;
  /**
   * True when NO account has a synced transaction yet — deep history may still be
   * importing after a recent connection. The UI surfaces this instead of implying
   * the shallow/absent window is the complete history.
   */
  historyPending: boolean;
}

/**
 * Resolve the Space-wide rebuild range from the Space's account rows. Pure and
 * total. YYYY-MM-DD strings sort lexicographically == chronologically, so a string
 * min is a date min.
 */
export function resolveRebuildRange(
  accounts: readonly RebuildRangeAccount[],
  windowFrom: string,
): RebuildRange {
  const dates = accounts
    .map((a) => a.earliestTxDate)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  const earliest = dates.length ? dates.reduce((m, d) => (d < m ? d : m)) : null;
  // Default to the practical 30-day window (windowFrom), but never before the
  // earliest available data — a shallow-history account clamps up to its own
  // earliest. (String compare == chronological compare on YYYY-MM-DD.)
  const defaultFrom = earliest && earliest > windowFrom ? earliest : windowFrom;
  return {
    earliest,
    defaultFrom,
    historyPending: dates.length === 0,
  };
}
