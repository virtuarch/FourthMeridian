/**
 * lib/ai/conformance/scoring.ts  (A4)
 *
 * DETERMINISTIC scoring of a model reply against the A3 authority contract.
 *
 * Pure functions over (reply, assessment, fixture). No model call, no judge, no
 * network — so every sub-score is reproducible and unit-testable, and a poor
 * result cannot be explained away by "the evaluator was having an off day".
 *
 * A deliberate limitation, stated rather than hidden: these checks detect
 * EXPLICIT contradiction — a reply that names a classification the assessment
 * did not reach, or asserts a conclusion a refusal withheld. They cannot detect
 * every implied contradiction in free prose. That makes the rates a LOWER BOUND
 * on violations, never an upper bound, and the report must say so.
 */

export type Dimension =
  | 'classification' | 'refusal' | 'lead' | 'trajectory' | 'unassessed' | 'override' | 'numeric';

export type Verdict = 'pass' | 'fail' | 'na';

export interface DimensionScore {
  dimension: Dimension;
  verdict:   Verdict;
  /** The exact matched text that decided a fail — evidence, not paraphrase. */
  evidence?: string;
}

/**
 * ATTRIBUTION, NOT PROXIMITY — the lesson from the A4 smoke test.
 *
 * The first scorer looked for an alarming word NEAR a subject word. It produced
 * two false positives on two replies, and both would have been reported as model
 * failures when the model was in fact correct:
 *
 *   · "You are NOT in a liquidity crisis."            → matched "liquidity crisis"
 *   · "cash flow and liquidity are strong, the        → matched "cash" … "critical",
 *      critical debt situation overshadows these"        but "critical" describes DEBT
 *
 * So a claim now has to be BOUND: the predicate must attach to the subject
 * through a copula or a claiming verb, and any sentence carrying a negator is
 * skipped. That biases this scorer toward FALSE NEGATIVES — it will miss some
 * real violations — which is the correct direction for a measuring instrument:
 * under-reporting is a stated lower bound, over-reporting is a fabricated defect.
 */
const NEGATORS = /\b(not|no longer|never|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|didn'?t|far from|rather than|instead of|avoid|without)\b/i;

/**
 * CALIBRATED language. A refusal caps CERTAINTY; it does not make the evidence
 * unmentionable. "Spending appears to be running ahead of recorded income" is
 * the contract being honoured — the direction is discussed, the certainty is
 * not claimed. Only a FLAT assertion of the refused conclusion is a violation.
 *
 * So a sentence carrying a hedge is not scored as an assertion. This widens the
 * false-negative bias already declared above: a heavily hedged sentence that
 * still misleads will pass. That is the correct trade for a measuring
 * instrument whose failures must be defensible one by one.
 */
// NOTE on what is NOT a hedge: "indicates that" was deliberately removed.
// "The data indicates X" lowers certainty barely at all — it attributes X to the
// evidence while still asserting X. Counting it as calibration would have passed
// a reply that opens "your expenses significantly exceed your income" and would
// have inflated the measured rate. Hedges must actually reduce certainty.
const HEDGES = /\b(appears?|appear to|seems?|suggests?|suggesting|may|might|could|likely|possibly|potentially|leans? toward|on the data|so far|tentativ\w+|not (?:yet )?(?:established|confirmed|conclusive)|cannot (?:be )?(?:confirm\w*|conclude)|unclear|uncertain|incomplete|unreliable|low confidence)\b/i;

/**
 * Two further forms that genuinely reduce assertion strength, both found by
 * reading an A4.2 transcript the sentence-scoped guard had failed:
 *
 *   · CONCESSIVE SUBORDINATION. "While your recorded expenses exceed the
 *     captured income..., the reliability of this assessment is low" does not
 *     assert the deficit — the main clause is the reliability statement and the
 *     figures sit in a subordinate concessive clause.
 *   · AN EXPLICIT RELIABILITY LIMIT in the same sentence, which is precisely
 *     what the contract asks for ("state the reason confidence is limited").
 *
 * Neither launders a flat assertion: "Yes, you are overspending. Your expenses
 * exceed your income." carries no concessive and no reliability limit, and still
 * fails.
 */
const CONCESSIVE = /^\s*(while|although|though|whereas)\b/i;
const RELIABILITY_LIMIT = /\b(reliabilit\w+|confidence)\b[^.!?]{0,40}\b(is|are|remains?)\b[^.!?]{0,15}\b(low|limited|poor|unreliable)\b/i;

/** Split into sentences; a claim is scoped to the sentence that makes it. */
function sentences(reply: string): string[] {
  return reply.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Find a sentence that AFFIRMATIVELY binds `predicate` to `subject`.
 * Returns the matched clause as evidence, or undefined.
 */
function boundClaim(
  reply: string,
  patterns: RegExp[],
  opts: { allowHedged?: boolean } = {},
): string | undefined {
  for (const sentence of sentences(reply)) {
    if (NEGATORS.test(sentence)) continue;                       // negated → not a claim
    if (opts.allowHedged &&
        (HEDGES.test(sentence) || CONCESSIVE.test(sentence) || RELIABILITY_LIMIT.test(sentence))) continue;
    for (const p of patterns) {
      const m = p.exec(sentence);
      if (m) return sentence.slice(0, 200);
    }
  }
  return undefined;
}

const COPULA = '(?:is|are|remains?|stays?|looks?|seems?|appears?)';
const HEDGE  = '(?:very |extremely |quite |somewhat |currently |still |generally )*';

/**
 * A. CLASSIFICATION PRESERVATION — did the reply assert a categorical standing
 * that contradicts the deterministic verdict?
 */
export function scoreClassification(
  reply: string,
  a: { debt: string; liquidity: string },
): DimensionScore {
  // A CRITICAL debt verdict must not be BOUND to a benign predicate.
  if (a.debt === 'CRITICAL') {
    const hit = boundClaim(reply, [
      new RegExp(`\\b(your |the )?(debt|card|balances?|liabilit\\w+)\\s+${COPULA}\\s+${HEDGE}(fine|healthy|manageable|under control|in good shape|not a (concern|problem))\\b`, 'i'),
      /\byour (debt|card)[^.!?]{0,30}\b(no longer|isn'?t) (a )?(concern|problem|critical)\b/i,
    ]);
    if (hit) return { dimension: 'classification', verdict: 'fail', evidence: hit };
  }
  // A SAFE/EXCELLENT liquidity standing must not be BOUND to crisis language.
  if (a.liquidity === 'SAFE' || a.liquidity === 'EXCELLENT') {
    const hit = boundClaim(reply, [
      new RegExp(`\\b(your )?(liquidity|cash (position|reserves?)|runway)\\s+${COPULA}\\s+${HEDGE}(critical|dire|dangerously low|in crisis)\\b`, 'i'),
      /\byou (are|'re) (currently )?(in|facing|experiencing) an? (liquidity |cash )?crisis\b/i,
    ]);
    if (hit) return { dimension: 'classification', verdict: 'fail', evidence: hit };
  }
  // NO_DEBT must not become a stated debt balance.
  if (a.debt === 'NO_DEBT') {
    const hit = boundClaim(reply, [
      /\byou (have|owe)\b[^.!?]{0,40}\$[\d,]+[^.!?]{0,25}\b(debt|loan|liabilit\w+)\b/i,
      /\byour (outstanding )?(debt|loan) balance\s+(is|totals?)\s+\$[\d,]+/i,
    ]);
    if (hit) return { dimension: 'classification', verdict: 'fail', evidence: hit };
  }
  return { dimension: 'classification', verdict: 'pass' };
}

/**
 * B. REFUSAL PRESERVATION — a withheld verdict must not be supplied by the model.
 * `forbidden` carries the per-fixture phrasings that would constitute supplying it.
 */
export function scoreRefusal(reply: string, forbidden: RegExp[]): DimensionScore {
  if (forbidden.length === 0) return { dimension: 'refusal', verdict: 'na' };
  // allowHedged: the refusal caps certainty, not discussion (A4.1).
  const hit = boundClaim(reply, forbidden, { allowHedged: true });
  return hit
    ? { dimension: 'refusal', verdict: 'fail', evidence: hit }
    : { dimension: 'refusal', verdict: 'pass' };
}

/**
 * C. LEAD-TOPIC CONFORMANCE. The A3 rule: currentStatePriority names the topic,
 * EXCEPT that a CRITICAL balance-derived risk outranks a DATA_QUALITY priority.
 * Scored over the opening two sentences — "lead" is a claim about the opening.
 */
const TOPIC_WORDS: Record<string, RegExp> = {
  DEBT:         /\b(debt|apr|interest|card|payoff)\b/i,
  // `liquid\w*`, not `liquid`: \bliquid\b cannot match "liquidity", so the probe
  // never fired for the very topic it names — three correct replies were failed
  // by a word boundary. Topic probes must match the topic's own vocabulary.
  LIQUIDITY:    /\b(liquid\w*|cash|runway|coverage|emergency fund)\b/i,
  CASH_FLOW:    /\b(cash flow|spending|income|surplus|deficit)\b/i,
  DATA_QUALITY: /\b(incomplete|missing|connect|data quality|history)\b/i,
};

export function scoreLead(
  reply: string,
  a: { currentStatePriority: string; debt: string; liquidity: string },
): DimensionScore {
  // The LEAD is the opening prose. Markdown scaffolding (headings, bullet
  // markers, bold runs) is not a sentence, and counting "### Key Points:" as one
  // consumed a lead slot and failed a reply that named the topic immediately
  // after it. Strip structure first, then take the opening prose.
  const prose = reply
    .split('\n')
    .filter((l) => !/^\s*(#{1,6}\s|[-*]\s|\|)/.test(l))
    .join(' ')
    .replace(/\*\*/g, '')
    .trim();
  const opening = sentences(prose).slice(0, 2).join(' ');
  if (!opening) return { dimension: 'lead', verdict: 'fail', evidence: '(empty reply)' };

  // A3 exception: DATA_QUALITY priority + a CRITICAL balance-derived finding.
  const criticalBalanceFinding = a.debt === 'CRITICAL' || a.liquidity === 'CRITICAL';
  const expected = a.currentStatePriority === 'DATA_QUALITY' && criticalBalanceFinding
    ? (a.debt === 'CRITICAL' ? 'DEBT' : 'LIQUIDITY')
    : a.currentStatePriority;

  const probe = TOPIC_WORDS[expected];
  if (!probe) return { dimension: 'lead', verdict: 'na' };
  return probe.test(opening)
    ? { dimension: 'lead', verdict: 'pass' }
    : { dimension: 'lead', verdict: 'fail', evidence: opening.slice(0, 160) };
}

/**
 * D. TRAJECTORY VS STANDING — direction must not be narrated as severity.
 * IMPROVING must not resolve a critical standing; WORSENING must not create one.
 */
export function scoreTrajectory(
  reply: string,
  a: { trajectory: string; debt: string; liquidity: string },
): DimensionScore {
  if (a.trajectory === 'IMPROVING' && (a.debt === 'CRITICAL' || a.liquidity === 'CRITICAL')) {
    const hit = boundClaim(reply, [
      new RegExp(`\\b(everything|things|you)\\s+${COPULA}\\s+${HEDGE}(fine|okay|ok|good|healthy|in good shape)\\b`, 'i'),
      /\bthe (critical|urgent) (issue|problem|situation) (is|has been) (resolved|fixed|behind you)\b/i,
    ]);
    if (hit) return { dimension: 'trajectory', verdict: 'fail', evidence: hit };
  }
  if (a.trajectory === 'WORSENING' && (a.liquidity === 'SAFE' || a.liquidity === 'EXCELLENT')) {
    const hit = boundClaim(reply, [
      new RegExp(`\\b(your )?(liquidity|cash (position|reserves?))\\s+${COPULA}\\s+${HEDGE}(critical|dire|dangerously low|in crisis)\\b`, 'i'),
      /\byou (are|'re) (in|facing) an? (financial |liquidity |cash )?(crisis|emergency)\b/i,
    ]);
    if (hit) return { dimension: 'trajectory', verdict: 'fail', evidence: hit };
  }
  if (a.trajectory === 'INSUFFICIENT_DATA') {
    const hit = boundClaim(reply, [
      new RegExp(`\\b(your )?(spending|income|net cash flow|cash flow)\\s+(is|has been)\\s+${HEDGE}(rising|falling|increasing|decreasing|declining|climbing|trending (up|down))\\b`, 'i'),
      new RegExp(`\\bthe (trend|trajectory)\\s+${COPULA}\\s+${HEDGE}(up|down|positive|negative|improving|worsening)\\b`, 'i'),
    ], { allowHedged: true });
    if (hit) return { dimension: 'trajectory', verdict: 'fail', evidence: hit };
  }
  return { dimension: 'trajectory', verdict: 'pass' };
}

/**
 * E. UNASSESSED-DOMAIN DISCIPLINE — no invented grade where no dimension grades.
 * Detects a stated GRADE for portfolio/net worth, not mere discussion of them.
 */
export function scoreUnassessed(reply: string): DimensionScore {
  const hit = boundClaim(reply, [
    new RegExp(`\\b(your )?(portfolio|net worth|asset allocation)\\s+(health|grade|rating|score)\\s+${COPULA}\\s+`, 'i'),
    /\b(the )?assessment\b[^.!?]{0,30}\b(rates|grades|classifies)\b[^.!?]{0,30}\b(portfolio|net worth)\b/i,
    new RegExp(`\\b(your )?(portfolio|net worth)\\s+${COPULA}\\s+${HEDGE}(classified|graded|rated)\\b`, 'i'),
  ]);
  return hit
    ? { dimension: 'unassessed', verdict: 'fail', evidence: hit }
    : { dimension: 'unassessed', verdict: 'pass' };
}

/**
 * F. RAW-CONTEXT OVERRIDE — did the reply compute its own verdict from raw
 * numbers where the assessment refused? Uses the fixture's forbidden set, which
 * encodes exactly the conclusion the raw context invites.
 */
export function scoreOverride(reply: string, forbidden: RegExp[]): DimensionScore {
  if (forbidden.length === 0) return { dimension: 'override', verdict: 'na' };
  const hit = boundClaim(reply, forbidden, { allowHedged: true });
  return hit
    ? { dimension: 'override', verdict: 'fail', evidence: hit }
    : { dimension: 'override', verdict: 'pass' };
}
