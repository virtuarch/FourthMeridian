/**
 * lib/forecast/_num.ts
 *
 * V26-REASONING Slice 0 — the two numeric helpers this subsystem kept
 * reimplementing, with the one behavioural disagreement between the copies
 * resolved deliberately.
 *
 * ⚠️ `median` HAD THREE COPIES AND THEY DID NOT AGREE ON EMPTY. `cadence.ts`
 * returned 0 for an empty array; `periodic-amount.ts` and `spending-baseline.ts`
 * returned NaN. Zero is the dangerous answer — "the median gap between zero
 * observed pay dates is 0 days" is a sentence this codebase must never be able
 * to produce, and NaN is the one that propagates until somebody handles it. The
 * unified version REFUSES: an empty sample has no median, and the caller must
 * say what it means. `cadence.ts`'s guard is preserved at its own call site,
 * where the emptiness has a meaning.
 *
 * ⚠️ `money` ROUNDS, AND IT IS THE ONLY THING HERE THAT DOES. `engine.ts`'s D-4
 * note is the doctrine: full f64 precision end to end, one `toFixed` at the
 * display edge. This is that edge.
 */

/** The default reporting currency of the forecast subsystem. */
export const CURRENCY = 'USD';

/**
 * A figure at the display edge. `null` renders as the word, never as `0.00` —
 * an unknown amount that prints as zero is the failure this subsystem is built
 * around.
 */
export const money = (n: number | null, currency: string = CURRENCY): string =>
  n === null ? 'unknown' : `${currency} ${n.toFixed(2)}`;

/** The median of a non-empty sample. Throws on empty; see the header. */
export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) {
    throw new Error('median: empty sample has no median — the caller must decide what emptiness means');
  }
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
