/**
 * lib/crypto/quantity-carry.core.ts
 *
 * V26-CRYPTO-QTY-1 — MAY A WALLET'S CURRENT QUANTITY BE CARRIED TO ANOTHER DATE?
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── The one question ─────────────────────────────────────────────────────────
 * Historical crypto valuation is `native quantity × that day's price`. The price
 * is dated evidence; the QUANTITY was, until now, simply the account's current
 * `nativeBalance` carried to every date with nothing asked of it.
 *
 * For the wallet that motivated this slice that carry happens to be correct: its
 * last quantity-changing transaction is 2023-09-26, so every date in the priced
 * window (2025-08-03 → 2026-08-02) sits inside one event-free interval, and the
 * replay reconciles exactly against two independent observations. But the code
 * never ASKED whether an event intervened — it was right by coincidence of this
 * wallet's data, and the day the user next moves BTC every historical date would
 * silently be restated at the new balance.
 *
 * This module makes the reason explicit and checkable.
 *
 * ── The invariant ────────────────────────────────────────────────────────────
 * A crypto account's observed/native quantity may be carried to a target date
 * only when NO quantity-changing wallet transaction lies between that date and
 * the date the quantity was observed.
 *
 * ── Interval convention (deliberately stated, and tested on the boundaries) ───
 * An event BLOCKS the carry iff it falls strictly after the EARLIER of the two
 * dates and on-or-before the LATER:
 *
 *     blocks  ⟺  min(target, anchor) < eventDate <= max(target, anchor)
 *
 * Direction-agnostic, because a carry is equally a claim backward and forward.
 *
 * Why half-open at the earlier end: a snapshot's quantity is END-OF-DAY, so a
 * transaction ON the target date is already inside that day's closing quantity
 * and does not invalidate it. Carrying backward from anchor A to target T asserts
 *
 *     qty_eod(T) = qty_eod(A) − Σ deltas in (T, A]
 *
 * and the constant carry is exactly the claim that the sum is empty. A
 * transaction dated T contributes to qty_eod(T) and is not in (T, A], so it must
 * not block. A transaction dated A IS in (T, A] and must block: the observation
 * on A already includes it, so the quantity before it differed.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * Not a replay: it never computes an earlier quantity, never sums a delta, and
 * never converts a fiat amount. It answers one yes/no question and refuses
 * wherever the constant would be a guess. When it refuses, the caller must leave
 * the component UNVALUED — never substitute a carried fiat balance.
 *
 * A licensed quantity stays ESTIMATED provenance. It is a constant-quantity
 * assumption that survived a check, not a quantity reconstructed from
 * transactions.
 *
 * The price provider's window is NOT evidence here. How far back prices reach
 * says nothing about what was held; the two are intersected by the caller, never
 * conflated.
 */

/** Every reason a carry may be refused. Reported, never silent. */
export type CarryRefusal =
  /** The quantity has no observation date to be carried FROM. */
  | "NO_ANCHOR"
  /** A quantity-changing wallet transaction lies inside the interval. */
  | "QUANTITY_EVENT_IN_INTERVAL"
  /**
   * V26-S1-BTC — the movement ledger cannot account for the wallet's own
   * balance, so `eventDatesISO` is not a trustworthy statement of when quantity
   * changed. Checked FIRST, because every other answer this module can give is
   * derived from that list: "no event blocks the interval" is worthless when the
   * list is known to be short. The live wallet imported 25 of 28 confirmed
   * transactions and this module happily licensed carries across the gap.
   * See ledger-completeness.core.ts.
   */
  | "LEDGER_INCOMPLETE";

export interface ConstantQuantityCarryInput {
  /** The date being valued (YYYY-MM-DD). */
  targetISO: string;
  /**
   * The date the carried quantity was OBSERVED (YYYY-MM-DD), or null when the
   * quantity has no observation date at all — which refuses the carry outright.
   */
  anchorISO: string | null;
  /**
   * Dates of QUANTITY-CHANGING wallet transactions, already scoped and filtered
   * by the binding: this wallet only, BTC-denominated, POSTED, not deleted,
   * with a signed native amount. Order is irrelevant; duplicates are harmless.
   *
   * Passing dates rather than rows keeps this module free of any schema type,
   * and makes the filtering predicates a documented responsibility of the
   * binding (see licenseWalletQuantityCarry's caller) rather than a hidden one.
   */
  eventDatesISO: readonly string[];
  /**
   * V26-S1-BTC — does the movement ledger that produced `eventDatesISO` account
   * for the wallet's observed balance? Resolved by the binding through
   * `reconcileWalletLedger`; see the LEDGER_INCOMPLETE refusal above.
   *
   * OPTIONAL and defaulting to `true` (licensed) so a caller that has not yet
   * adopted the check behaves exactly as before. That default is deliberate and
   * is the one place this module accepts silence as permission: making it
   * default to `false` would refuse every historical crypto date for every
   * caller the moment this field landed, which is a behaviour change disguised
   * as a safety default. The bindings that CAN answer it must, and do.
   */
  ledgerComplete?: boolean;
}

export type CarryDecision =
  | { licensed: true }
  | { licensed: false; reason: CarryRefusal; blockingDateISO?: string };

/**
 * Does `eventISO` fall inside the interval spanned by the target and anchor,
 * under the half-open convention documented in the module header?
 */
export function blocksCarry(eventISO: string, targetISO: string, anchorISO: string): boolean {
  const lo = targetISO < anchorISO ? targetISO : anchorISO;
  const hi = targetISO < anchorISO ? anchorISO : targetISO;
  return eventISO > lo && eventISO <= hi;
}

/**
 * May the constant quantity be carried from `anchorISO` to `targetISO`?
 *
 * Total and deterministic. The earliest blocking event is reported so a refusal
 * can be explained rather than merely counted.
 */
export function licenseConstantQuantityCarry(
  input: ConstantQuantityCarryInput,
): CarryDecision {
  const { targetISO, anchorISO, eventDatesISO } = input;

  // Checked before anything else: every judgement below reads `eventDatesISO`,
  // and a list that provably fails to explain the wallet's balance cannot
  // support "nothing intervened here".
  if (input.ledgerComplete === false) return { licensed: false, reason: "LEDGER_INCOMPLETE" };

  if (anchorISO === null) return { licensed: false, reason: "NO_ANCHOR" };

  let earliestBlocking: string | null = null;
  for (const eventISO of eventDatesISO) {
    if (!blocksCarry(eventISO, targetISO, anchorISO)) continue;
    if (earliestBlocking === null || eventISO < earliestBlocking) earliestBlocking = eventISO;
  }

  if (earliestBlocking !== null) {
    return {
      licensed: false,
      reason: "QUANTITY_EVENT_IN_INTERVAL",
      blockingDateISO: earliestBlocking,
    };
  }

  return { licensed: true };
}
