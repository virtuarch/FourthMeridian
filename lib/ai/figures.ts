/**
 * lib/ai/figures.ts
 *
 * THE TOKENS IN PROSE THAT STATE AN AMOUNT — one reader, shared.
 *
 * ⚠️ HOISTED, BYTE-FOR-BYTE, FROM `lib/ai/brief/licence.ts`, which re-exports it.
 * The Brief's licence asks "is every figure in this prose one code computed?";
 * durable memory asks the mirror question, "is this figure one the USER stated,
 * or one WE produced?". Both need the same definition of what a figure in prose
 * is, at the same written precision — two tokenisers would be two answers to
 * "did they say $5k". Pure: no imports, no I/O, no clock.
 *
 * ⚠️ WHAT IT DELIBERATELY IGNORES. Bare integers under 1,000 ("2 cards",
 * "7 days") and bare years (1900–2100) are counts and dates, not money. ISO
 * dates and clock times are removed before scanning. Digits inside a word
 * ("401(k)", "Q3", "1st") never match.
 */

export type FigureKind = 'MONEY' | 'PERCENT' | 'NUMBER';

export interface ProseFigure {
  text:  string;
  kind:  FigureKind;
  value: number;
  /** The unit the token was written at — the width of its implied rounding. */
  unit: number;
}

const MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

// currency? · digits (grouped or plain) · decimals? · suffix? · percent?
const FIGURE =
  /(?<![\w.,])(US\$|\$|USD\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(k|K|m|M|bn|B|thousand|million|billion)(?![\w]))?(\s?%|\s?percent\b)?(?![\w]|[.,]\d)/g;

/** The tokens in `prose` that state an amount. */
export function extractFigures(prose: string): ProseFigure[] {
  const text = prose
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');

  const out: ProseFigure[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const [whole, currency, digits, decimals, suffix, percent] = m;
    const intPart = digits.replace(/,/g, '');
    const decimalPlaces = decimals ? decimals.length - 1 : 0;
    const grouped = digits.includes(',');
    const mult = suffix ? MULTIPLIER[suffix.toLowerCase()] ?? 1 : 1;
    const base = Number(`${intPart}${decimals ?? ''}`);
    if (!Number.isFinite(base)) continue;

    // The unit the token was written at: its decimals, else its trailing zeros.
    const trailingZeros = decimalPlaces === 0
      ? Math.min((intPart.match(/0+$/)?.[0].length ?? 0), Math.max(intPart.length - 1, 0)) : 0;
    const unit = (decimalPlaces > 0 ? 10 ** -decimalPlaces : 10 ** trailingZeros) * mult;

    if (percent) {
      out.push({ text: whole.trim(), kind: 'PERCENT', value: base,
        unit: decimalPlaces > 0 ? 10 ** -decimalPlaces : 1 });
      continue;
    }
    if (currency || suffix) {
      out.push({ text: whole.trim(), kind: 'MONEY', value: base * mult, unit });
      continue;
    }
    if (grouped || decimalPlaces > 0) {
      out.push({ text: whole.trim(), kind: 'NUMBER', value: base, unit });
      continue;
    }
    // A bare integer: a year or a count is not a financial figure.
    if (base >= 1900 && base <= 2100) continue;
    if (base < 1000) continue;
    out.push({ text: whole.trim(), kind: 'NUMBER', value: base, unit });
  }
  return out;
}
