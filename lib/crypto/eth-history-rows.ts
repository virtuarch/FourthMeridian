/**
 * lib/crypto/eth-history-rows.ts
 *
 * THE ONE DERIVATION of Ethereum's daily quantity rows — shared by the full and
 * the incremental reconstruction, so the two cannot disagree about what a day's
 * quantity is.
 *
 * Pure: no database, no network. The replay is THE engine
 * (`replayQuantityTimeline`); nothing here re-decides a quantity.
 *
 * ⚠️ NATIVE ETH ONLY. The emptiness proof these rows rest on is about the
 * native balance of a plain EOA (nonce + code + balance). ERC-20 balances can be
 * debited by an approved spender without the owner's nonce moving, so nothing in
 * this module, or the incremental path built on it, says anything about tokens.
 */

import {
  movementsToQuantityEvents, toEventStreamCompleteness,
  type ChainCoverage, type ChainMovement,
} from "./chain-movement";
import { derivedRowsFromTimeline } from "./wallet-reconstruction";
import { ETH_NATIVE } from "./native-asset";
import {
  replayQuantityTimeline, type QuantityAnchor, type QuantityTimeline,
} from "@/lib/investments/quantity-replay.core";

/** Source stamped on every row this reconstruction owns. */
export const ETH_RECONSTRUCTION_SOURCE = "eth-reconstruction";

/**
 * The version of the ETH history ALGORITHM, stamped on every DERIVED row
 * (`PositionObservation.reconstructionVersion`). Bumped BY HAND when what a
 * reconstruction would write for the same chain evidence changes. An incremental
 * refresh relies on stored rows only when every one of them carries this value;
 * otherwise it falls back to one full rebuild, which re-stamps them.
 *
 * 1 — the first versioned rows (incremental reconstruction introduced).
 */
export const ETH_RECONSTRUCTION_VERSION = 1;

export type EthHistoryMode = "FULL" | "INCREMENTAL" | "NO_CHANGE";

export interface EthDerivedRow { dateISO: string; quantity: number; basis: string }

/**
 * Canonical equality of two stored ETH quantities. The comparison that matters
 * — reconciliation — is exact in wei elsewhere; this only decides whether two
 * FLOATS written at the storage boundary describe the same holding, allowing for
 * float64's own representation error at the magnitude involved.
 */
export function sameQuantity(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-15, 1e-12 * Math.max(Math.abs(a), Math.abs(b)));
}

/** Replay native ETH movements into a timeline and its daily rows, for [windowFromISO, windowToISO]. */
export function replayEthHistory(args: {
  accountId: string;
  instrumentId: string;
  anchor: QuantityAnchor;
  movements: readonly ChainMovement[];
  coverage: ChainCoverage;
  windowFromISO: string;
  windowToISO: string;
}): { timeline: QuantityTimeline; rows: EthDerivedRow[] } {
  const events = movementsToQuantityEvents(args.movements, {
    accountId: args.accountId, instrumentId: args.instrumentId, decimals: ETH_NATIVE.decimals,
  });
  const timeline = replayQuantityTimeline({
    instrumentId: args.instrumentId, accountId: args.accountId, anchors: [args.anchor], events,
    windowFromISO: args.windowFromISO,
    windowToISO:   args.windowToISO,
    eventStream:   toEventStreamCompleteness(args.coverage),
    // One wei is below float resolution at this magnitude, so the tolerance is
    // the smallest value that is meaningful rather than the smallest unit.
    tolerance:     1e-12,
  });
  const rows = derivedRowsFromTimeline(timeline)
    .filter((r) => r.dateISO >= args.windowFromISO && r.dateISO <= args.windowToISO);
  return { timeline, rows };
}

/**
 * The earliest date on which `next` states a different holding than `existing`
 * — a row added, removed, or with a different quantity. Null when they agree
 * everywhere. This is the reconstruction's IMPACT: what downstream wealth history
 * must re-read from.
 */
export function earliestRowDifference(
  existing: readonly { dateISO: string; quantity: number }[],
  next: readonly { dateISO: string; quantity: number }[],
): string | null {
  const before = new Map(existing.map((r) => [r.dateISO, r.quantity]));
  const after = new Map(next.map((r) => [r.dateISO, r.quantity]));
  let earliest: string | null = null;
  const note = (d: string) => { if (earliest === null || d < earliest) earliest = d; };
  for (const [d, q] of after) {
    const b = before.get(d);
    if (b === undefined || !sameQuantity(b, q)) note(d);
  }
  for (const d of before.keys()) if (!after.has(d)) note(d);
  return earliest;
}
