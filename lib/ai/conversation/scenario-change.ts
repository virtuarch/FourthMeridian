/**
 * lib/ai/conversation/scenario-change.ts
 *
 * HOW FAR A SCENARIO POSITION IS FROM WHERE IT OPENED. PURE.
 *
 * ⚠️ THE FAILURE THIS CLOSES WAS A MODEL SUBTRACTING TWO TOOL FIGURES. Asked
 * "what does that look like by next June", the assistant said "about $65k
 * higher" in 4 of 8 runs — 101,975 − 36,791, the projected net worth less the
 * opening one, composed in prose because the payload stated both levels and
 * never the difference. Both operands were the ledger's; the subtraction was
 * not anybody's. It is now a field, and the field carries its operands.
 *
 * ⚠️ A DIFFERENCE BETWEEN TWO POSITIONS, NOT "A SCENARIO'S GAIN". The function
 * takes any two positions with the same four lines. Today it is called with the
 * ledger's opening and a checkpoint; the same call measures a scenario against
 * a no-assumption baseline at one date the day a caller can produce that
 * baseline (`positionChange(baselineAtHorizon, scenarioAtHorizon)`). Nothing in
 * it knows which question was asked.
 *
 * ⚠️ `debt` KEEPS ITS OWN DIRECTION — the house convention `observedChange`
 * set for the past (lib/data/snapshot-window.ts). Debt going from 4,000 to 1,000
 * is `abs: -3000`. That it IMPROVED net worth by 3,000 is a true sentence and is
 * the reader's to write; re-signing it here would make one field mean two
 * things depending on who read it. `netWorth` already contains the effect.
 *
 * ⚠️ IT MEASURES AND DOES NOT ATTRIBUTE. Investments rising is contributions
 * plus growth; the checkpoint's own `movements` block says which, and this does
 * not repeat it.
 *
 * ⚠️ `pct` IS NULL ON A BASE OF NOTHING, never Infinity and never a number with
 * six digits: M1's rule (lib/ai/measures/measure.ts `compare`), with the one
 * shared tolerance. A debt that opens at 2.8e-14 has no percentage change.
 *
 * It lives beside the ledger rather than inside it for the same reason the
 * crossing search does: the ledger imports nothing, and this needs the
 * repository's money tolerance.
 */

import { MONEY_EPSILON } from '@/lib/data/snapshot-window';
import type { LedgerCheckpoint, LedgerOpening } from './scenario-ledger';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The four lines a scenario position states. `otherAssets` is held flat by the ledger and is not a line here. */
export const CHANGE_LINES = ['liquid', 'investments', 'debt', 'netWorth'] as const;
export type ChangeLine = typeof CHANGE_LINES[number];

/** A dated position. A line the spine could not produce is null and yields no change. */
export interface ScenarioPosition {
  date: string;
  liquid: number | null;
  investments: number | null;
  debt: number | null;
  netWorth: number | null;
}

/** One line's movement, with the operands it was computed from. */
export interface LineChange {
  from: number;
  to: number;
  /** to − from, in the line's own direction. Never re-signed. */
  abs: number;
  /** abs / |from| × 100, two places. Null when `from` is under half a cent. */
  pct: number | null;
}

export type PositionChange = {
  between: { from: string; to: string };
  meaning: string;
} & Partial<Record<ChangeLine, LineChange>>;

const CHANGE_MEANING =
  'This position minus the opening one, line by line, in the line\'s own direction: `debt` '
  + 'positive = MORE owed, negative = less; `netWorth` already contains the debt effect. Quote '
  + '`abs` for "how much higher/lower" — never subtract the levels yourself. `pct` null = the '
  + 'opening figure was zero. A movement, not a cause: `movements` says what drove it.';

/** to − from for one line, at currency precision. Null when either side is not a number. */
export function lineChange(from: number | null | undefined, to: number | null | undefined): LineChange | null {
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const abs = round2(to - from);
  return { from, to, abs,
    pct: Math.abs(from) < MONEY_EPSILON ? null : round2((abs / Math.abs(from)) * 100) };
}

/**
 * The change between two positions, line by line.
 *
 * Null when the dates are the same — one position is not a change, and a block of
 * zeros would read as "nothing moved", which is a measurement nobody made (the
 * rule `observedChange` applies to the past). Lines with a null side are omitted.
 */
export function positionChange(from: ScenarioPosition, to: ScenarioPosition): PositionChange | null {
  if (from.date === to.date) return null;
  const out: Partial<Record<ChangeLine, LineChange>> = {};
  for (const line of CHANGE_LINES) {
    const c = lineChange(from[line], to[line]);
    if (c) out[line] = c;
  }
  if (Object.keys(out).length === 0) return null;
  return { between: { from: from.date, to: to.date }, ...out, meaning: CHANGE_MEANING };
}

/**
 * The compact form a TABLE ROW carries: `abs` per line and nothing else.
 *
 * ⚠️ A ROW IS ~1 KB AND THERE CAN BE EIGHTY OF THEM. The operands are already in
 * the payload — the row's own lines and `opening` — so a row repeats neither
 * them nor the explanation; the full block (operands, pct, meaning) is stated
 * once, for the horizon, under the result's `changeSinceOpening`. Same
 * arithmetic, same function, fewer bytes.
 */
export function compactChange(from: ScenarioPosition, to: ScenarioPosition):
  Partial<Record<ChangeLine, number>> | null {
  const full = positionChange(from, to);
  if (!full) return null;
  const out: Partial<Record<ChangeLine, number>> = {};
  for (const line of CHANGE_LINES) if (full[line]) out[line] = full[line]!.abs;
  return out;
}

/** The ledger's opening, as a position. */
export const openingPosition = (o: LedgerOpening & { netWorth: number }): ScenarioPosition => ({
  date: o.asOfISO, liquid: o.liquid, investments: o.investments, debt: o.debt, netWorth: o.netWorth });

/** A ledger checkpoint, as a position. */
export const checkpointPosition = (c: LedgerCheckpoint): ScenarioPosition => ({
  date: c.date, liquid: c.liquid?.amount ?? null, investments: c.investments.amount,
  debt: c.debt.amount, netWorth: c.netWorth?.amount ?? null });
