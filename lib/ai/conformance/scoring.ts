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

import { assertedClaim, sentences, proseOf } from '@/lib/ai/claim-detection';

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
 * A5 — the detection primitives now live in lib/ai/claim-detection.ts, owned by
 * runtime and imported here. They were developed in this scorer (four false
 * positives found by reading transcripts: negation, proximity-vs-attribution, a
 * word boundary, and concessive subordination); runtime enforcement must not
 * re-derive that vocabulary and re-learn the same four lessons in production.
 */
function boundClaim(reply: string, patterns: RegExp[], opts: { allowHedged?: boolean } = {}): string | undefined {
  return assertedClaim(reply, patterns, opts);
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
  const prose = proseOf(reply).split('\n').filter((l) => !/^\s*[-*]\s/.test(l)).join(' ').trim();
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
