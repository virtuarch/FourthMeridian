/**
 * lib/reasoning/figures/magnitude.ts
 *
 * V26-REASONING BLOCKER PASS — ONE GRAMMAR FOR "HOW BIG IS THIS NUMBER".
 *
 * ── The defect this exists to make unrepeatable ─────────────────────────────
 * Four separate parsers in this codebase read a magnitude suffix, and every one
 * of them wrote `([kKmM])?` with no right-hand boundary. So the `m` that begins
 * the NEXT WORD was consumed as the suffix:
 *
 *     "I spend $5,000 monthly."   ->  5,000  x m  ->  $5,000,000,000
 *     "I pay $1,200 mortgage"     ->  1,200  x m  ->  $1,200,000,000
 *
 * A million-fold corruption, in two of the most ordinary sentences a person can
 * type, reachable with no adversarial intent. And it came with a second injury:
 * because the pattern had already eaten the `m`, the rate detector looked at
 * `"onthly."` and found no per-month marker — so the figure was ALSO downgraded
 * from `CURRENCY_PER_MONTH` to `CURRENCY`, losing the one axis that structurally
 * holds.
 *
 * ⚠️ AND IT WAS FIXED IN THE WRONG DIRECTION ONCE ALREADY. The comment above the
 * broken pattern read: "THE MAGNITUDE SUFFIX IS PART OF THE NUMBER. Omitting it
 * is a silent thousand-fold error, and it was found twice in one slice." That
 * was true — `$5K` really had been read as `$5` — and the repair reached for
 * `[kKmM]?` without asking what stops it. The lesson is not "be greedier"; it is
 * that a magnitude suffix is a TOKEN WITH TWO EDGES, and this file owns both.
 *
 * ⚠️ NOT A `$5,000`-SPECIFIC FIX, AND NOT A PHRASE LIST. There is no `monthly`
 * exception and no `mortgage` exception here. The rule is positional: a letter
 * is a magnitude suffix only when NO LETTER FOLLOWS IT. `monthly`, `mortgage`,
 * `mo`, `min`, `k9` and every word anybody invents next are all excluded by the
 * same clause, because none of them is a lone letter.
 *
 * ── The grammar ────────────────────────────────────────────────────────────
 *     LETTER FORM   $2m, $6K, $7.5k    — a lone k/m, no letter after it
 *     WORD FORM     $50 million        — the whole word, on its own boundary
 *
 * Nothing else scales. `$5,000 monthly` is five thousand dollars a month, and
 * `$1,200 mortgage` is twelve hundred dollars.
 */

/**
 * The suffix, as a regex SOURCE fragment with exactly one capture group.
 *
 * ⚠️ `(?![A-Za-z])` IS THE WHOLE FIX and it is the reason this is shared source
 * rather than four hand-copied patterns. A fifth parser written next year gets
 * the boundary for free, or it does not compile against `scaleOf`.
 *
 * The word form requires whitespace before it, so `$2million` (no space) reads
 * as the letter form and lands on the same value by a different route.
 */
export const MAGNITUDE_SRC = '(?:\\s*(k|m)(?![A-Za-z])|\\s+(thousand|million|billion)\\b)?';

/** How many capture groups `MAGNITUDE_SRC` contributes. */
export const MAGNITUDE_GROUPS = 2;

/**
 * The multiplier a captured suffix denotes.
 *
 * Takes both capture groups because the letter form and the word form are
 * different alternatives of one optional group; at most one is ever defined.
 */
export function scaleOf(letter: string | undefined, word: string | undefined): number {
  const l = (letter ?? '').toLowerCase();
  if (l === 'k') return 1_000;
  if (l === 'm') return 1_000_000;
  switch ((word ?? '').toLowerCase()) {
    case 'thousand': return 1_000;
    case 'million':  return 1_000_000;
    case 'billion':  return 1_000_000_000;
    default:         return 1;
  }
}

/**
 * How many characters of `text` after `at` the suffix consumed.
 *
 * ⚠️ THE RATE MARKER IS READ FROM AFTER THE SUFFIX, NOT AFTER THE DIGITS. This
 * is the second half of the same defect: with the `m` of `monthly` eaten, the
 * rate window began mid-word and `CURRENCY_PER_MONTH` was lost. A caller that
 * needs to look at what follows the amount must skip exactly what the suffix
 * took, and this is the only honest way to know that.
 */
export function magnitudeLength(letter: string | undefined, word: string | undefined,
  text: string, at: number): number {
  const token = letter ?? word;
  if (!token) return 0;
  const idx = text.toLowerCase().indexOf(token.toLowerCase(), at);
  return idx < 0 ? 0 : idx + token.length - at;
}

/**
 * A standalone matcher, for callers parsing ONE rendered figure rather than
 * sweeping prose.
 *
 * Anchored at the end because a claim's `statedAs` is the whole token: `"$2m"`
 * scales, `"$2 million in the Fidelity account"` is not a rendering this layer
 * produces and is not scaled by guesswork.
 */
const TRAILING_MAGNITUDE_RE =
  new RegExp(`(?:\\s*(k|m)|\\s+(thousand|million|billion))\\s*$`, 'i');

/** The multiplier a rendered amount's trailing suffix denotes, or 1. */
export function trailingScale(rendered: string): number {
  const m = TRAILING_MAGNITUDE_RE.exec(rendered);
  return m ? scaleOf(m[1], m[2]) : 1;
}
