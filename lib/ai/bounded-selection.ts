/**
 * lib/ai/bounded-selection.ts
 *
 * CF-1 — A BOUNDED LIST CARRIES ITS DENOMINATOR, OR IT IS NOT EVIDENCE.
 *
 * Pure: no DB, no framework, no domain knowledge. Bounded selection is not a
 * merchant concept or a holdings concept — it is what happens whenever a
 * producer ranks a population and keeps the front of it.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * CF-0 measured it on the real Space:
 *
 *     174 distinct spend merchants in the window
 *      → 25   MERCHANT_ROLLUP_LIMIT               (cap hit)
 *      → 8    context-serializer slice(0, 8)
 *      → 164  withheld, disclosed nowhere
 *
 * The prompt then told the model to answer "who did I spend the most with / top
 * merchants" from those rows, and it did: "Your top merchants based on spending
 * in the analysis window are:", unqualified. Every figure was correct. The
 * superlative was not, and no amount of care by the model could have caught it
 * — the context contained nothing that distinguished "the top 8" from "the 8 we
 * chose to send".
 *
 * ── Why the producer, and not the serializer ────────────────────────────────
 * The eligible population exists exactly once: inside the function that ranked
 * it. One line later it is gone. A serializer handed the survivors can only
 * measure the survivors, so `items.length` is the one number guaranteed to be
 * wrong — and it is the number a reasonable person would reach for.
 *
 * So the denominator travels WITH the selection, from whoever performed it.
 *
 * ── Why `complete` is derived ───────────────────────────────────────────────
 * A stored `truncated: boolean` beside `returnedCount` and `totalCount` is a
 * third fact that can disagree with the other two, and the disagreement is
 * silent. Derived from counts it cannot drift, and there is no state to forget
 * to update when a second selector narrows the list further downstream.
 *
 * ── Composition ─────────────────────────────────────────────────────────────
 * Two selectors in series (a 25-row rollup, then an 8-row render) must disclose
 * "8 of 174", never "8 of 25". The intermediate cap is an implementation detail
 * of how we got here; the claim the user hears is about the population. That is
 * why `describeBounds` takes the rendered count and the ORIGINAL total as
 * separate arguments rather than reading them off one object.
 */

/**
 * A ranked population, and how much of it a caller kept.
 *
 * `totalCount` is the ELIGIBLE POPULATION before the limit — the denominator any
 * claim about "the top N" is implicitly making. `limit` is recorded for
 * diagnosis; nothing should branch on it.
 */
export interface BoundedSelection<T> {
  items:       readonly T[];
  /** How many were kept. Always `items.length`; named so callers read intent. */
  returnedCount: number;
  /** How many were ELIGIBLE. Never derived from `items`. */
  totalCount:  number;
  /** The cap applied. Diagnostic only. */
  limit:       number;
}

/**
 * Rank-and-keep, preserving the denominator.
 *
 * `all` must already be in the order the caller wants — this applies the bound
 * and nothing else, so ordering stays the producer's decision and CF-1 changes
 * no ranking anywhere.
 */
export function boundedSelection<T>(all: readonly T[], limit: number): BoundedSelection<T> {
  const items = all.slice(0, limit);
  return { items, returnedCount: items.length, totalCount: all.length, limit };
}

/**
 * Did the caller receive the whole eligible population?
 *
 * `>=` rather than `===` deliberately: a population of exactly `limit` rows is
 * COMPLETE, and treating it as truncated would hedge every list that happens to
 * fit — which trains a reader to ignore the hedge on the lists that do not.
 */
export function isComplete<T>(sel: BoundedSelection<T>): boolean {
  return sel.returnedCount >= sel.totalCount;
}

/**
 * How a bounded list is stated to the model.
 *
 * Takes the RENDERED count and the ORIGINAL total as separate arguments so a
 * second, later narrowing composes correctly: the serializer knows how many
 * rows it printed, the producer knows how many existed, and neither has to
 * trust the other's array.
 *
 * Deliberately contains no ranking words. "Top" is the claim under scrutiny;
 * this states the evidence, and the doctrine line beside it decides what may be
 * concluded from it.
 */
export function describeBounds(renderedCount: number, totalCount: number): string {
  return renderedCount >= totalCount
    ? `all ${totalCount}`
    : `${renderedCount} of ${totalCount}`;
}
