/**
 * lib/ai/forecast/pay-dates.ts
 *
 * FORECAST-16 — A CAPABILITY, ANSWERED AS ITSELF.
 *
 * ── The gap ─────────────────────────────────────────────────────────────────
 * FORECAST-7 licenses NEXT_PAY_DATES from cadence and activity alone, with no
 * amount and no spending baseline — it is the one forward-looking question a
 * facts-only Space can always answer. A cash forecast on the same Space refuses
 * ("needs current-normal discretionary spending"), and that refusal is a correct
 * answer to a DIFFERENT question. So pay dates are resolved on their own path.
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
 *
 * ⚠️ IT NO LONGER READS ENGLISH, AND IT NO LONGER WRITES PROMPT LINES. Until the
 * AI conversation reset this file also held `detectPayDateAsk` (six regexes
 * deciding whether a sentence was a pay-date question) and `renderPayDates` (the
 * prompt block). Both went with the conversation layer. What is left takes an
 * explicit ask and an explicit window and returns licensed dates.
 */

import { addMonths } from '@/lib/perspectives/time-range';
import { isCadence } from '@/lib/forecast/cadence';
import { expectedOccurrencesBetween } from '@/lib/forecast/stream-activity';
import type { ResolvedIncomeStream } from './streams';

/** What the user asked for. Null when this is not a pay-date question. */
export const PayDateAsk = {
  /** "When is my next paycheck?" — one occurrence. */
  NEXT_ONE: 'NEXT_ONE',
  /** "What are my upcoming pay dates?" — a bounded set. */
  UPCOMING: 'UPCOMING',
} as const;

export type PayDateAskKind = typeof PayDateAsk[keyof typeof PayDateAsk];

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
  streams: readonly ResolvedIncomeStream[], asOfISO: string,
  /**
   * What was asked, and over what window.
   *
   * ⚠️ BOTH ARE THE CALLER'S, NOT THIS MODULE'S. `stated` is a window the user
   * named; absent, the occurrence cap below applies instead of a time bound,
   * because five occurrences is a couple of months of fortnightly pay and most
   * of a year of quarterly, and a fixed number of months is neither.
   */
  opts: { ask?: PayDateAskKind; stated?: { toISO: string; statedAs: string } } = {},
): PayDateResult {
  const ask = opts.ask ?? PayDateAsk.UPCOMING;
  const stated = opts.stated ?? null;
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
