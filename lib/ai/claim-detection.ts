/**
 * lib/ai/claim-detection.ts  (A5)
 *
 * Shared, PURE primitives for deciding whether a piece of model prose ASSERTS a
 * claim — as opposed to negating it, hedging it, conceding it, or quoting it.
 *
 * WHY THIS IS ITS OWN MODULE. These primitives were developed and hardened in
 * the A4 conformance scorer, where three separate false positives were found by
 * reading transcripts rather than trusting a number: negation blindness ("you
 * are NOT in a liquidity crisis"), proximity mistaken for attribution ("cash ...
 * critical" where critical described debt), and a word boundary that stopped
 * \bliquid\b matching "liquidity". A fourth followed in A4.2 (concessive
 * subordination). Runtime enforcement must not re-derive that vocabulary from
 * scratch and re-learn the same four lessons in production.
 *
 * DEPENDENCY DIRECTION. Runtime owns these; the OPERATIONAL conformance scorer
 * imports them. Never the reverse — production code must not depend on an
 * evaluation harness.
 *
 * BIASED AGAINST FALSE POSITIVES, deliberately and asymmetrically. In the
 * scorer, a false positive fabricates a defect in a working system. At runtime
 * it corrupts a correct answer to a real user. Both are worse than a missed
 * detection, so every ambiguity resolves toward "not an assertion".
 *
 * No I/O, no clock, no randomness, no `server-only` — importable from anywhere
 * and unit-testable without a database or a model.
 */

/** Explicit negation anywhere in the sentence ⇒ not an assertion of the claim. */
export const NEGATORS =
  /\b(not|no longer|never|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|didn'?t|cannot|can'?t|far from|rather than|instead of|avoid|without)\b/i;

/**
 * Calibrated language. A refusal caps CERTAINTY; it does not forbid discussing
 * the evidence. "Spending appears to be running ahead of recorded income" is the
 * contract being honoured, not broken.
 *
 * NOT included, deliberately: "indicates that". "The data indicates X" lowers
 * certainty barely at all — it attributes X to the evidence while still
 * asserting X — and counting it as calibration would let a flat claim through.
 */
export const HEDGES =
  /\b(appears?|appear to|seems?|suggests?|suggesting|may|might|could|likely|possibly|potentially|leans? toward|on the data|so far|tentativ\w+|not (?:yet )?(?:established|confirmed|conclusive)|cannot (?:be )?(?:confirm\w*|conclude)|unclear|uncertain|incomplete|unreliable|low confidence)\b/i;

/**
 * Concessive subordination: "While your recorded expenses exceed the captured
 * income ..., the reliability of this assessment is low". The main clause is the
 * reliability statement; the figures sit in a subordinate clause. Found in a real
 * A4.2 transcript that the sentence-scoped guard had wrongly failed.
 */
export const CONCESSIVE = /^\s*(while|although|though|whereas)\b/i;

/** An explicit reliability/confidence limit in the same sentence — what the contract asks for. */
export const RELIABILITY_LIMIT =
  /\b(reliabilit\w+|confidence)\b[^.!?]{0,40}\b(is|are|remains?)\b[^.!?]{0,15}\b(low|limited|poor|unreliable)\b/i;

/** Sentence split that also breaks on newlines, so list items are separate claims. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Strip markdown scaffolding and any line that is quoting the user, so a
 * forbidden phrase the USER wrote can never be scored as the model asserting it.
 */
export function proseOf(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(#{1,6}\s|\|)/.test(l))
    .filter((l) => !/^\s*>/.test(l))                 // blockquote = quoted, not asserted
    .join('\n')
    .replace(/\*\*/g, '');
}

/** Text inside quotation marks is being quoted, not asserted. */
function stripQuoted(sentence: string): string {
  return sentence.replace(/[""][^""]*[""]|"[^"]*"/g, ' ');
}

export interface ClaimOptions {
  /** Treat hedged / concessive / reliability-limited sentences as non-assertions. */
  allowHedged?: boolean;
}

/**
 * Find a sentence that AFFIRMATIVELY asserts one of `patterns`.
 * Returns the sentence as evidence, or undefined.
 *
 * Every filter here removes a way of being wrong, in the order they were learned:
 * markdown/blockquote (quoted text), quotation marks (quoted text), negation,
 * and — when allowHedged — calibration.
 */
export function assertedClaim(
  text: string,
  patterns: RegExp[],
  opts: ClaimOptions = {},
): string | undefined {
  if (patterns.length === 0) return undefined;
  for (const raw of sentences(proseOf(text))) {
    const sentence = stripQuoted(raw);
    if (!sentence.trim()) continue;
    if (NEGATORS.test(sentence)) continue;
    if (opts.allowHedged &&
        (HEDGES.test(sentence) || CONCESSIVE.test(raw) || RELIABILITY_LIMIT.test(sentence))) continue;
    for (const p of patterns) {
      if (p.test(sentence)) return raw.slice(0, 200);
    }
  }
  return undefined;
}
