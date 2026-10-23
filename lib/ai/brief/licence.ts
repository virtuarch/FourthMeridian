/**
 * lib/ai/brief/licence.ts
 *
 * EVERY FIGURE IN A BRIEF MUST BE ONE CODE ALREADY COMPUTED.
 *
 * ⚠️ A LICENCE, NOT A PARSER. It finds the tokens in prose that state an amount —
 * anything with a currency mark or a K/M suffix, anything with a percent, any
 * number with thousands grouping or decimals, and bare integers of 1,000 or more
 * that are not years — and asks whether the evidence package holds a value that
 * the token is a faithful rounding of. It does not read sentences, infer what a
 * figure refers to, or recompute anything.
 *
 * ⚠️ WHAT IT DELIBERATELY IGNORES. Bare integers under 1,000 ("2 cards",
 * "7 days", "3 weeks") and bare years (1900–2100) are counts and dates, not
 * money. ISO dates and clock times are removed before scanning. Digits inside a
 * word ("401(k)", "Q3", "1st") never match.
 *
 * ⚠️ ROUNDING IS HONOURED, INVENTION IS NOT. A token is compared at the precision
 * it was WRITTEN at — "$18.9K" within a hundred dollars, "$620.14" within a cent,
 * "$8,000" within a thousand — but never looser than 3% of the licensed value. So
 * "$8,000" is a fair rounding of 7,960.22 and an invention against 7,600. Either
 * rounding direction is honoured: the first live goldens wrote "$4,812" for
 * 4,812.66, a truncation, and a half-unit tolerance refused it as if invented. Signs
 * are ignored: prose says "down $2,000" for a change of −2,000. Arithmetic the
 * package did not do ("$1,200 more than last week") has no licensed value and
 * fails — deliberately: a difference nobody computed is exactly the figure this
 * exists to stop.
 */

import { extractFigures, type FigureKind, type ProseFigure } from '@/lib/ai/figures';

// ⚠️ THE FIGURE READER LIVES IN `lib/ai/figures.ts` (shared with durable memory's
// provenance gate). Re-exported so every existing import of it from here holds.
export { extractFigures };
export type { FigureKind, ProseFigure };

export interface Licence {
  /** Absolute values of every finite number in the package. */
  numbers: number[];
  /** Absolute values of every percentage field (`pct`, `…Pct`). */
  percents: number[];
}

const PERCENT_KEY = /(^pct$|Pct$)/;

/** Every figure the package licenses. Strings are never mined for numbers. */
export function licenceFromPackage(pkg: unknown): Licence {
  const numbers: number[] = [];
  const percents: number[] = [];
  const walk = (value: unknown, key: string | null) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return;
      numbers.push(Math.abs(value));
      if (key && PERCENT_KEY.test(key)) percents.push(Math.abs(value));
      return;
    }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, key)); return; }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(pkg, null);
  return { numbers, percents };
}

const EPS = 1e-9;

export function isLicensed(figure: ProseFigure, licence: Licence): boolean {
  if (figure.kind === 'PERCENT') {
    // Strictly within one written unit: 10.3 may be "10%" or "11%", never "12%".
    return licence.percents.some((p) => Math.abs(figure.value - p) < Math.min(figure.unit, 1) + EPS);
  }
  return licence.numbers.some((v) => {
    const tol = Math.min(figure.unit, Math.max(1, 0.03 * v));
    return Math.abs(figure.value - v) < tol + EPS;
  });
}

/** The figures in `prose` that nothing in the package licenses. */
export function unlicensedFigures(prose: string, licence: Licence): ProseFigure[] {
  return extractFigures(prose).filter((f) => !isLicensed(f, licence));
}
