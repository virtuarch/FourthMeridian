/**
 * lib/ai/brief/share-consistency.ts
 *
 * A PART, ITS WHOLE AND THE SHARE BETWEEN THEM MUST AGREE.
 *
 * ⚠️ THE DEFECT (S2 finding O-2, live in Production). A Brief observation said a
 * holding was "about 57% of that slice (around $12,985 out of $12,985.14)". Every
 * token passed the licence: 57 is the package's `topWeightPct`, and both amounts
 * are faithful roundings of `populationValue`. The SENTENCE was false — the part
 * it named was the whole. The licence asks "did code compute this figure?", never
 * "does this figure mean what the sentence says it means?", and a share is the one
 * place where code can check the second question with arithmetic alone.
 *
 * ⚠️ WHAT IT READS. Within one sentence, an amount pair written as part and whole
 * ("$A out of $B", "$A of your $B", "$A of about $B") with at least one money
 * token, and the percentages TIED to that pair: a share percentage ("N% of …")
 * anywhere in the sentence, or a percentage written right beside the pair
 * ("57% ($A of $B)", "$A of $B, or 57%"). A percentage that only states a change
 * ("rose 5% this week") is not tied and never judged. A pair with no tied
 * percentage is not judged either: there is nothing for it to disagree with.
 *
 * ⚠️ WHAT FAILS. Every tied percentage disagrees with A/B by more than
 * SHARE_TOLERANCE_PP percentage points, after honouring the precision each
 * amount was WRITTEN at (the licence's rule: "$13K" may stand for 12,985); or the
 * part could be the whole (A ≥ B within its rounding) while the share says it is
 * less than 100%. It returns codes only — never an amount, a symbol or a sentence
 * — so a caller may log what it returns.
 *
 * ⚠️ IT NEVER REPAIRS. Code cannot know which of the three figures the model
 * meant; the caller drops the observation (or refuses the headline), as for every
 * other narration failure. Pure: no I/O, no clock.
 */

import { extractFigures, type ProseFigure } from '@/lib/ai/figures';

/** Absolute percentage points a stated share may differ from A/B (beyond written rounding). */
export const SHARE_TOLERANCE_PP = 2;

export type ShareProblemCode =
  /** The part, within its written rounding, is not below the whole, yet the share is under 100%. */
  | 'PART_NOT_BELOW_WHOLE'
  /** A/B disagrees with every percentage tied to the pair by more than the tolerance. */
  | 'SHARE_MISMATCH';

const AMOUNT = String.raw`(?:US\$|\$|USD\s?)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:k|K|m|M|bn|B|thousand|million|billion)(?![\w]))?`;
const NOT_PERCENT = String.raw`(?!\s?%|\s?percent\b|[\w]|[.,]\d)`;
const DET = String.raw`(?:(?:your|the|a|an|its|their|that|this|a\s+total\s+of|total)\s+)?`;
const HEDGE = String.raw`(?:(?:about|around|roughly|approximately|nearly|almost|some|just\s+under|just\s+over)\s+)?`;
const PAIR = new RegExp(
  String.raw`(?<![\w.,$])(${AMOUNT})${NOT_PERCENT}\s+(?:out\s+of|of)\s+${DET}${HEDGE}(${AMOUNT})${NOT_PERCENT}`, 'gi');
const PERCENT = /(?<![\w.,])(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi;

/** Text allowed between a percentage and the pair it sits beside. */
const BESIDE_BEFORE = /^[\s(:,—–-]*(?:(?:about|around|roughly|approximately|nearly|or)\s*)*[\s(]*$/i;
const BESIDE_AFTER = /^[\s),—–-]*(?:(?:or|that is|which is|about|around|roughly|approximately|nearly)\s*)*[\s(]*$/i;

const EPS = 1e-9;

/** A sentence per element. A decimal point is never followed by whitespace, so it never splits. */
const sentencesOf = (text: string) => text.split(/(?<=[.!?;])\s+/);

const amountOf = (token: string): ProseFigure | null => {
  const f = extractFigures(token);
  return f.length === 1 && f[0].kind !== 'PERCENT' ? f[0] : null;
};

/** The written-precision slack of an amount: its unit, never looser than 3% of it (the licence's rule). */
const slack = (f: ProseFigure) => Math.min(f.unit, 0.03 * Math.abs(f.value));

/** One problem per inconsistent pair, in order of appearance. Codes only. */
export function inconsistentShares(text: string): ShareProblemCode[] {
  const out: ShareProblemCode[] = [];
  for (const sentence of sentencesOf(text)) {
    const percents = [...sentence.matchAll(PERCENT)].map((m) => ({
      value: Number(m[1]), start: m.index!, end: m.index! + m[0].length,
      share: /^\s+of\b/i.test(sentence.slice(m.index! + m[0].length)),
    }));
    if (percents.length === 0) continue;

    for (const m of sentence.matchAll(PAIR)) {
      const part = amountOf(m[1]);
      const whole = amountOf(m[2]);
      if (!part || !whole || (part.kind !== 'MONEY' && whole.kind !== 'MONEY')) continue;
      if (whole.value <= 0) continue;
      const start = m.index!;
      const end = start + m[0].length;
      const tied = percents.filter((p) => p.share
        || (p.end <= start && BESIDE_BEFORE.test(sentence.slice(p.end, start)))
        || (p.start >= end && BESIDE_AFTER.test(sentence.slice(end, p.start))));
      if (tied.length === 0) continue;

      const a = Math.abs(part.value), b = Math.abs(whole.value);
      const sa = slack(part), sb = slack(whole);
      const lo = (100 * Math.max(a - sa, 0)) / (b + sb);
      const hi = b - sb > 0 ? (100 * (a + sa)) / (b - sb) : Infinity;

      if (a + sa >= b && tied.every((p) => p.value < 100 - SHARE_TOLERANCE_PP)) {
        out.push('PART_NOT_BELOW_WHOLE');
        continue;
      }
      const agrees = tied.some((p) => p.value >= lo - SHARE_TOLERANCE_PP - EPS && p.value <= hi + SHARE_TOLERANCE_PP + EPS);
      if (!agrees) out.push('SHARE_MISMATCH');
    }
  }
  return out;
}
