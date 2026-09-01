/**
 * lib/ai/forecast/horizon.ts
 *
 * FORECAST-10 — WHEN "THE NEXT THREE MONTHS" BECOMES TWO DATES.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * CF-4 owns the conversation's temporal scope, and everything it resolves is a
 * RETRIEVAL WINDOW: an interval in the past, bounding evidence that exists. A
 * forecast horizon is the opposite object — a forward interval bounding a
 * question about evidence that does not exist yet — and CF-4 has no
 * representation for one. Measured at 714d099: nothing in
 * `conversation-scope.ts` or `temporal-scope.ts` matches a future phrase, and
 * "next 3 months" resolves to UNRESOLVED.
 *
 * So this is a separate resolver, and deliberately a small one. It shares the
 * repository's calendar arithmetic (`lib/perspectives/time-range.ts`, extended
 * with `addMonths` for exactly this) rather than approximating a month, and it
 * never touches the retrieval window — a forecast question can inherit a past
 * scope for its historical half and still have its own forward bound.
 *
 * ⚠️ THE PARSER LIVES HERE, NOT IN lib/forecast. FORECAST-8's `ForecastHorizon`
 * takes two ISO dates and FORECAST-9's engine cannot parse anything; that is
 * the property being preserved. Natural language stops at this file.
 */

import { addMonths } from '@/lib/perspectives/time-range';
import { AssumptionOrigin, type ForecastHorizon } from '@/lib/forecast/policy';

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (from: string, n: number) =>
  iso(new Date(Date.parse(`${from}T00:00:00.000Z`) + n * DAY_MS));

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 10 - 1, ten: 10, twelve: 12,
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/** How far ahead a question may reach. Beyond this nothing is licensed anyway. */
const MAX_HORIZON_MONTHS = 24;

/**
 * A sentence that points at the PAST, so a bare period in it is a window rather
 * than a horizon. "The last 6 months" inside a comparison is not the horizon
 * being changed.
 */
const BACKWARD_RE = /\b(last|past|previous|ago|so far|to date|year.to.date|ytd)\b/;

/**
 * The forward interval a question asks about, or null.
 *
 * ⚠️ NULL IS A REAL ANSWER. A forecast question with no horizon is not given a
 * default one here — FORECAST-9 refuses an unbounded ending-cash forecast and
 * says so, which is more useful than silently answering a different question
 * than the one asked. The caller decides whether to supply a default; see
 * `DEFAULT_HORIZON_MONTHS` in the assembler, where that choice is disclosed as
 * a policy origin rather than hidden here.
 */
export function resolveForecastHorizon(question: string, todayISO: string): ForecastHorizon | null {
  const q = question.toLowerCase();

  const stated = (statedAs: string, toISO: string): ForecastHorizon => ({
    fromISO: todayISO, toISO,
    origin: AssumptionOrigin.USER_REQUESTED, statedAs,
  });

  // "next 3 months", "over the next three months", "in 6 months", "for 90 days"
  const rel = q.match(
    /\b(?:next|over the next|in|within|for|coming)\s+(?:the\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|days|week|weeks|month|months|year|years)\b/);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : WORDS[rel[1]];
    if (n && n > 0) {
      const unit = rel[2];
      if (unit.startsWith('day') && n <= MAX_HORIZON_MONTHS * 31) {
        return stated(rel[0], addDays(todayISO, n));
      }
      if (unit.startsWith('week') && n * 7 <= MAX_HORIZON_MONTHS * 31) {
        return stated(rel[0], addDays(todayISO, n * 7));
      }
      if (unit.startsWith('month') && n <= MAX_HORIZON_MONTHS) {
        return stated(rel[0], addMonths(todayISO, n));
      }
      if (unit.startsWith('year') && n * 12 <= MAX_HORIZON_MONTHS) {
        return stated(rel[0], addMonths(todayISO, n * 12));
      }
    }
    return null;
  }

  // "next month", "next year" — singular, no number.
  const singular = q.match(/\bnext\s+(month|quarter|year)\b/);
  if (singular) {
    const n = singular[1] === 'month' ? 1 : singular[1] === 'quarter' ? 3 : 12;
    return stated(singular[0], addMonths(todayISO, n));
  }

  // "through December", "by January", "until March" — the next occurrence of
  // that month, end-inclusive at its last day.
  const named = q.match(/\b(?:through|until|til|till|by|to)\s+(?:the\s+end\s+of\s+)?([a-z]+)\b/);
  if (named) {
    const idx = MONTHS.indexOf(named[1]);
    if (idx >= 0) {
      const [ty, tm] = [Number(todayISO.slice(0, 4)), Number(todayISO.slice(5, 7))];
      const year = idx + 1 >= tm ? ty : ty + 1;
      // The last day of that month: the first of the next, minus one day.
      const firstOfNext = addMonths(`${year}-${String(idx + 1).padStart(2, '0')}-01`, 1);
      const end = addDays(firstOfNext, -1);
      if (end > todayISO) return stated(named[0], end);
    }
  }

  // A bare duration in a forecast refinement — "What about 6 months?".
  //
  // ⚠️ LAST, AND GUARDED BY A PAST MARKER. This resolver is only ever called
  // for a question CF-8 already resolved as FORECAST, so a bare "6 months"
  // there is a forward re-scoping. It still refuses when the sentence points
  // backwards, because "the last 6 months" inside a comparison is not the
  // horizon being changed.
  if (!BACKWARD_RE.test(q)) {
    // A bare MONTH NAME in a refinement — "And what about February?"
    //
    // ⚠️ FOUND BY THE V26-REASONING SLICE 4 CONVERSATION GATE, and it is an
    // ordinary sentence the resolver could not read. The named-month branch
    // above requires a preposition (through/until/by/to), so the single most
    // natural way to move a horizon in conversation resolved to NOTHING — and
    // the turn silently kept December while the user had asked about February.
    // That is PROJECTION-1's defect exactly: answering a question the user did
    // not ask, silently, with a different number.
    //
    // Guarded the same way the bare-duration branch below is, plus past-tense
    // verbs: "how much did I spend in February" points backwards, and a bare
    // month there is a window rather than a horizon.
    const bareMonth = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
    if (bareMonth && !/\b(did|was|were|spent|earned|made|had)\b/.test(q)) {
      const idx = MONTHS.indexOf(bareMonth[1]);
      const [ty, tm] = [Number(todayISO.slice(0, 4)), Number(todayISO.slice(5, 7))];
      const year = idx + 1 >= tm ? ty : ty + 1;
      const firstOfNext = addMonths(`${year}-${String(idx + 1).padStart(2, '0')}-01`, 1);
      const end = addDays(firstOfNext, -1);
      if (end > todayISO) return stated(bareMonth[0], end);
    }

    const bare = q.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)[- ](day|days|week|weeks|month|months|year|years)\b/);
    if (bare) {
      const n = /^\d+$/.test(bare[1]) ? Number(bare[1]) : WORDS[bare[1]];
      const unit = bare[2];
      if (n && n > 0) {
        if (unit.startsWith('day') && n <= MAX_HORIZON_MONTHS * 31) return stated(bare[0], addDays(todayISO, n));
        if (unit.startsWith('week') && n * 7 <= MAX_HORIZON_MONTHS * 31) return stated(bare[0], addDays(todayISO, n * 7));
        if (unit.startsWith('month') && n <= MAX_HORIZON_MONTHS) return stated(bare[0], addMonths(todayISO, n));
        if (unit.startsWith('year') && n * 12 <= MAX_HORIZON_MONTHS) return stated(bare[0], addMonths(todayISO, n * 12));
      }
    }
  }

  return null;
}

/**
 * FORECAST-17 — an explicit calendar date named in a sentence.
 *
 * ⚠️ EXPLICIT FORMS ONLY, AND THE OMISSIONS ARE THE CONTRACT. "October 15",
 * "Oct 15", "October 15, 2026" and "2026-10-15" all denote one day. "Sometime in
 * October", "around the holidays", "in a few weeks" and "probably next month"
 * do NOT, and none of them appears below — FORECAST-3 refused to invent a day
 * inside a range, and an extractor that guessed one would hand it a date the
 * user never gave.
 *
 * ⚠️ A MISSING YEAR RESOLVES FORWARD, NEVER BACKWARD. "October 15" said in
 * August means this October; said in December it means next October. Any other
 * rule would put a future cash event in the past. A date that lands before the
 * as-of even after rolling forward is refused rather than shifted again.
 */
export function resolveExplicitDate(sentence: string, asOfISO: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(sentence);
  if (iso) {
    const d = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return d >= asOfISO && isValid(d) ? d : null;
  }

  const named = new RegExp(
    `\\b(${MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`
    + '(?:,?\\s+(\\d{4}))?\\b', 'i').exec(sentence);
  if (!named) return null;

  const monthIdx = MONTHS.findIndex((m) => m.startsWith(named[1].toLowerCase().slice(0, 3)));
  const day = Number(named[2]);
  if (monthIdx < 0 || day < 1 || day > 31) return null;

  const year = named[3] ? Number(named[3]) : Number(asOfISO.slice(0, 4));
  const fmt = (y: number) =>
    `${y}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let candidate = fmt(year);
  // Roll forward exactly once when the year was not stated.
  if (!named[3] && candidate < asOfISO) candidate = fmt(year + 1);
  return candidate >= asOfISO && isValid(candidate) ? candidate : null;
}

/** A real calendar day — rejects February 30 rather than letting Date roll it. */
function isValid(d: string): boolean {
  const dt = new Date(`${d}T00:00:00.000Z`);
  return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}
