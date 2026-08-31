/**
 * lib/ai/forecast/pay-dates.ts
 *
 * FORECAST-16 — A CAPABILITY, ANSWERED AS ITSELF.
 *
 * ── The gap ─────────────────────────────────────────────────────────────────
 * FORECAST-7 licensed NEXT_PAY_DATES from cadence and activity alone, with no
 * amount and no spending baseline — it is the one forward-looking question the
 * real Space could always answer. FORECAST-15 measured that no phrasing reaches
 * it: "when do my paychecks land over the next 3 months?" resolves UNKNOWN, so
 * no forecast is assembled and the licensed dates never render.
 *
 * ── Why not just route it to FORECAST ───────────────────────────────────────
 * A one-line alternation in `FORECAST_PHRASE_RE` would make it reachable, and
 * would be the wrong repair. The question would then assemble a whole cash
 * forecast — an operating state, a policy, an engine run — and the section it
 * rendered would lead with `Ending cash: REFUSED — needs current-normal
 * discretionary spending`. A refusal is the correct answer to "what will my
 * cash be"; it is a non-sequitur in front of "when is payday", and the user
 * would reasonably read it as the system failing to answer them.
 *
 * ── The minimum authority path, measured ────────────────────────────────────
 * A pay date needs a cadence and a licence to project it. That is all:
 *
 *   loadForecastIncomeStreams  → cadence (FORECAST-1) + activity (FORECAST-2)
 *   expectedOccurrencesBetween → the dates
 *
 * NOT the operating state, NOT ForecastPolicy, NOT `forecastCash`, NOT the
 * accounts domain, NOT a spending baseline, NOT an income amount. The engine is
 * never constructed. This module computes no date of its own — it calls
 * FORECAST-2's generator, which refuses on any stream that is not licensed to
 * continue, and it would have nothing to fall back on if it wanted to.
 */

import { addMonths } from '@/lib/perspectives/time-range';
import { isCadence } from '@/lib/forecast/cadence';
import { expectedOccurrencesBetween } from '@/lib/forecast/stream-activity';
import type { ResolvedIncomeStream } from './streams';
import { resolveForecastHorizon } from './horizon';

/** What the user asked for. Null when this is not a pay-date question. */
export const PayDateAsk = {
  /** "When is my next paycheck?" — one occurrence. */
  NEXT_ONE: 'NEXT_ONE',
  /** "What are my upcoming pay dates?" — a bounded set. */
  UPCOMING: 'UPCOMING',
} as const;

export type PayDateAskKind = typeof PayDateAsk[keyof typeof PayDateAsk];

/**
 * Future pay-date intent, and nothing adjacent to it.
 *
 * ⚠️ NARROW ON PURPOSE, AND THE EXCLUSIONS ARE THE HARD PART. "How much was my
 * paycheck", "why was my paycheck lower", "show my income" and "what was my
 * last paycheck" all name a paycheck and none of them asks when one arrives.
 * The rule is a WHEN question about a FUTURE occurrence: a temporal
 * interrogative or an explicit forward frame, plus a payday noun, minus any
 * past-tense or amount framing.
 */
const PAY_NOUN_RE =
  /\b(?:pay ?checks?|pay ?days?|pay dates?|paid|deposits?)\b|\b(?:next|my)\s+check\b/i;
const WHEN_RE =
  /\b(?:when|what date|which day|how soon|what time)\b/i;
/** Past or amount framing — never this capability. */
/**
 * ⚠️ A PAY NOUN PLUS A FORWARD WORD IS NOT ENOUGH — MEASURED. That rule fired on
 * "Assume my paycheck is net … forecast my cash for the next 3 months", which
 * mentions a paycheck and says "next" and is plainly a cash-forecast request.
 * Four acceptance scenarios lost their forecast section to it.
 *
 * The question must either ASK WHEN, or name the SCHEDULE itself ("pay dates",
 * "paydays") — "paycheck" alone never qualifies. And anything that asks for a
 * forecast, a balance or cash is not this capability, whatever nouns it uses.
 */
/** The schedule named directly. "paycheck" is deliberately absent. */
const PAY_SCHEDULE_NOUN_RE = /\b(?:pay ?dates?|pay ?days?)\b/i;
/** A cash-forecast request, whatever pay nouns it happens to contain. */
const CASH_REQUEST_RE = /\b(?:forecast|project(?:ion|ed|ing)?|cash|balance|runway|spend|spending|budget)\b/i;
const NOT_PAY_DATE_RE =
  /\b(?:was|were|last (?:pay ?check|pay ?day|month)|how much|how many dollars|amount|lower|higher|bigger|smaller|why|total|average|earn|make|income (?:is|was|of))\b/i;
/** Plural framing — "dates", "few", or an explicit period. */
const PLURAL_RE =
  /\b(?:dates|days|paychecks|checks|deposits|few|all|every|list|schedule|remaining|rest of)\b/i;

export function detectPayDateAsk(question: string): PayDateAskKind | null {
  if (NOT_PAY_DATE_RE.test(question) || CASH_REQUEST_RE.test(question)) return null;
  if (!PAY_NOUN_RE.test(question)) return null;
  if (!WHEN_RE.test(question) && !PAY_SCHEDULE_NOUN_RE.test(question)) return null;
  return PLURAL_RE.test(question) ? PayDateAsk.UPCOMING : PayDateAsk.NEXT_ONE;
}

/**
 * How far "upcoming" reaches when the user names no period.
 *
 * ⚠️ NOT THE CASH-FORECAST DEFAULT. Three months of a biweekly payroll is seven
 * dates, which is a schedule rather than an answer to "what are my upcoming pay
 * dates". The cap is on OCCURRENCES, not on time, because that is what makes it
 * natural across cadences: five is a couple of months of fortnightly pay and
 * most of a year of quarterly. A stated period always wins over the cap.
 */
const DEFAULT_UPCOMING_COUNT = 5;
/** Safety bound when counting occurrences rather than naming an end date. */
const MAX_LOOKAHEAD_MONTHS = 12;

/** The first sentence of an authority's reason. Never a paraphrase. */
const firstSentence = (t: string) => {
  const m = /^[^.]*\./.exec(t.trim());
  return (m ? m[0] : t.trim()).replace(/\s+/g, ' ');
};

export interface StreamPayDates {
  sourceKey: string;
  label: string;
  /** ⚠️ From FORECAST-2's generator. Empty when the stream may not project. */
  dates: string[];
  cadence: string | null;
  /** Why a licensed-looking stream produced nothing. */
  reason: string;
}

export interface PayDateResult {
  ask: PayDateAskKind;
  fromISO: string;
  /** The bound actually used, and whether the user named it. */
  toISO: string;
  horizonStatedAs: string | null;
  streams: StreamPayDates[];
  /** True when no stream licensed a single date. */
  empty: boolean;
}

/**
 * Resolve the licensed pay dates.
 *
 * ⚠️ EVERY DATE COMES FROM `expectedOccurrencesBetween`, which consults
 * FORECAST-2's `mayGenerateExpectedOccurrences` before producing one. A SILENT,
 * ENDED or UNKNOWN stream yields an empty array however good its cadence — the
 * dormant Abacus payroll has a clean semimonthly schedule and contributes
 * nothing, which is the whole point of the licence.
 */
export function resolvePayDates(
  streams: readonly ResolvedIncomeStream[], asOfISO: string, question: string,
): PayDateResult {
  const ask = detectPayDateAsk(question) ?? PayDateAsk.UPCOMING;
  const stated = resolveForecastHorizon(question, asOfISO);
  const toISO = stated?.toISO ?? addMonths(asOfISO, MAX_LOOKAHEAD_MONTHS);

  const cap = stated ? Infinity : ask === PayDateAsk.NEXT_ONE ? 1 : DEFAULT_UPCOMING_COUNT;

  const out: StreamPayDates[] = streams.map((s) => {
    const all = expectedOccurrencesBetween(s.activity, s.cadence, asOfISO, toISO);
    return {
      sourceKey: s.sourceKey, label: s.label,
      dates: ask === PayDateAsk.NEXT_ONE ? all.slice(0, 1) : all.slice(0, cap),
      cadence: isCadence(s.cadence) ? s.cadence.kind : null,
      // ⚠️ THE AUTHORITY'S FIRST SENTENCE, NOT ITS PARAGRAPH. FORECAST-2's
      // reason is written for a forecast block that can afford it; here it was
      // three quarters of the answer to "when is my next paycheck". The first
      // sentence carries the fact — "the schedule is intact; continuation is
      // not established" — and the elaboration is dropped rather than reworded,
      // so nothing is paraphrased into a claim the authority did not make.
      reason: all.length > 0 ? firstSentence(s.activity.reason)
        : `${s.activity.state} — ${firstSentence(s.activity.reason)}`,
    };
  });

  return {
    ask, fromISO: asOfISO, toISO,
    horizonStatedAs: stated?.statedAs ?? null,
    streams: out,
    empty: out.every((s) => s.dates.length === 0),
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "September 11" — a date a person reads, from a date the authority licensed. */
const pretty = (iso: string) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/**
 * The capability's own block. Compact by construction.
 *
 * ⚠️ IT RENDERS THE CAPABILITY AND NOTHING ELSE. No opening cash, no spending
 * baseline, no obligations, no investments, and above all no `Ending cash:
 * REFUSED` — that refusal is true and is an answer to a different question.
 *
 * ⚠️ AND IT DOES NOT PROMISE. A licensed occurrence is a schedule the evidence
 * supports, not a guarantee that money will arrive; the wording says expected
 * and says what it rests on.
 */
export function renderPayDates(r: PayDateResult): string[] {
  const lines = ['=== EXPECTED PAY DATES ==='];
  const withDates = r.streams.filter((s) => s.dates.length > 0);

  if (withDates.length === 0) {
    lines.push('No upcoming pay dates can be established from available evidence.');
    for (const s of r.streams) lines.push(`  - ${s.reason}`);
    lines.push('Do not infer or estimate pay dates. Say they cannot be established and why.',
      '=== END EXPECTED PAY DATES ===', '');
    return lines;
  }

  lines.push(r.horizonStatedAs
    ? `Window: ${r.fromISO}..${r.toISO} (${r.horizonStatedAs}).`
    : r.ask === PayDateAsk.NEXT_ONE
      ? 'The next expected occurrence only.'
      : `The next ${DEFAULT_UPCOMING_COUNT} expected occurrences (no period was named).`);

  for (const s of withDates) {
    // ⚠️ PER STREAM, NEVER MERGED. Two employers on different schedules are two
    // answers; a single sorted list would lose which paycheck is which.
    lines.push(`  ${s.label}${s.cadence ? ` (${s.cadence.toLowerCase()})` : ''}: `
      + s.dates.map(pretty).join(', ')
      + ` — ISO ${s.dates.join(', ')}`);
  }
  for (const s of r.streams.filter((x) => x.dates.length === 0)) {
    lines.push(`  ${s.label}: no expected dates (${s.reason})`);
  }
  lines.push('Expected occurrences from the observed pay schedule — not guarantees, and they '
    + 'carry no amount. Do not add, shift or invent dates, and do not say what any payment '
    + 'will be worth.',
  '=== END EXPECTED PAY DATES ===', '');
  return lines;
}
