/**
 * lib/ai/intent/classifier.ts
 *
 * Layer 0 — deterministic intent classifier (D4).
 *
 * classifyFinancialIntent(message) is a PURE function: same input → same
 * output, no I/O, no clock, no randomness. It inspects the raw text of the
 * user's latest message and returns an IntentRoute (see ./types.ts).
 *
 * Approach:
 *   - Normalise the message (lowercase, collapse whitespace).
 *   - Evaluate an ORDERED list of rules. Order encodes precedence: more
 *     specific / higher-stakes intents are checked first so overlapping
 *     keyword sets resolve deterministically. Example: "pay off debt or buy
 *     stock" matches both debt-payoff and investing vocabulary, so
 *     DEBT_VS_INVESTING is checked before DEBT_PAYOFF_PLAN.
 *   - The first matching rule wins; UNKNOWN is the fallback.
 *
 * Section routing:
 *   Each intent maps to primary / supporting / suppress context-domain keys
 *   (FinanceDomains). These are advisory focus hints for Layer 3, not a
 *   context filter — the Context Builder is untouched by this layer.
 */

import { FinanceDomains } from '@/lib/ai/types';
import {
  PAYOFF_ROUTING_WORDS,
  UPDATE_ACTION_ROUTING_WORDS,
  UPDATE_FIELD_ROUTING_WORDS,
} from './keywords';
import {
  FinancialIntents,
  TemporalFrames,
  AnswerStyles,
  TransactionWindowModes,
  type IntentRoute,
  type FinancialIntent,
  type TemporalFrame,
  type AnswerStyle,
  type TransactionWindowRequest,
} from './types';

// ---------------------------------------------------------------------------
// Keyword groups
// ---------------------------------------------------------------------------

const DEBT_WORDS = [
  'debt', 'debts', 'loan', 'loans', 'credit card', 'credit-card',
  'card balance', 'owe', 'owed', 'owing', 'balance i owe', 'payoff',
  'pay off', 'pay-off', 'liabilit',
];

const INVEST_WORDS = [
  'invest', 'investing', 'investment', 'stock', 'stocks', 'equit',
  'etf', 'index fund', 'index funds', 'mutual fund', 'portfolio',
  'market', 'brokerage', 'shares', 'buy stock',
];

// KD-11: payoff / update-action / update-field vocabulary is owned by the
// authoritative ./keywords.ts (shared, single source of truth). The imported
// *_ROUTING_* lists are token-for-token identical to the pre-KD-11 arrays, so
// classifier semantics are unchanged. Aliased to the original local names to
// keep the rule definitions below untouched.
const PAYOFF_WORDS        = PAYOFF_ROUTING_WORDS;
const UPDATE_ACTION_WORDS = UPDATE_ACTION_ROUTING_WORDS;
const UPDATE_FIELD_WORDS  = UPDATE_FIELD_ROUTING_WORDS;

const SPENDING_CUT_WORDS = [
  'cut spending', 'cut back', 'cut down', 'reduce spending',
  'spend less', 'spending less', 'save money', 'where can i cut',
  'where can i save', 'trim', 'reduce my expenses', 'lower my expenses',
  'cut expenses', 'reduce costs', 'cut costs', 'overspending',
];

const CASH_FLOW_WORDS = ['cash flow', 'cashflow', 'cash-flow'];

// W2 — GOAL_WORDS / ALIGN_WORDS deleted with the GOAL_ALIGNMENT rule.

const READINESS_WORDS = [
  'ready to invest', 'ready to start investing', 'should i invest',
  'can i invest', 'can i afford to invest', 'am i ready', 'time to invest',
  'start investing', 'begin investing', 'afford to invest',
];

const OVERVIEW_WORDS = [
  'overview', 'summary', 'summarize', 'summarise', 'how am i doing',
  'how are we doing', 'financial health', 'financial picture',
  'big picture', 'snapshot', 'overall', 'where do i stand',
  'state of my finances', 'how do my finances look',
];

const STATUS_WORDS = [
  'situation', 'status', 'how is', "how's", 'how are', 'current',
  'right now', 'look like', 'looking', 'stand', 'where am i',
  'how bad', 'how much', 'what do i owe',
];

// ---------------------------------------------------------------------------
// Domain-key shorthands (canonical context-domain keys)
// ---------------------------------------------------------------------------

const ACCOUNTS      = FinanceDomains.ACCOUNTS;
const TRANSACTIONS  = FinanceDomains.TRANSACTIONS_SUMMARY;
const HOLDINGS      = FinanceDomains.HOLDINGS_SUMMARY;
// W2 — GOALS shorthand deleted with the domain (Goals retired): routing hints
// must never name a section that can no longer be assembled.
const SNAPSHOTS     = FinanceDomains.SNAPSHOT_HISTORY;
// REVIEW-3 C-10 — PROVIDERS / MEMBERS shorthands deleted with their rule
// references: no assembler is registered for either domain and the manifests no
// longer attempt them, so routing hints naming those sections claimed context
// that can never exist. The FinanceDomains enum values remain (types.ts) for
// when an assembler lands.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lowercase and collapse internal whitespace. */
function normalize(message: string): string {
  return message.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasAny(text: string, words: readonly string[]): boolean {
  return words.some((w) => text.includes(w));
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

interface Rule {
  intent: FinancialIntent;
  temporalFrame: TemporalFrame;
  answerStyle: AnswerStyle;
  primarySections: string[];
  supportingSections: string[];
  suppressSections: string[];
  /** Returns a confidence in (0,1] if the rule matches, else 0. */
  match: (text: string) => number;
}

/**
 * Ordered rules. First match wins. Precedence (high → low) is deliberate;
 * see the note at the top of the file.
 */
const RULES: Rule[] = [
  // 1. UPDATE_KNOWLEDGE — user wants to save/correct a stored field.
  //    Checked first: "update my Chase APR" also contains debt vocabulary.
  {
    intent: FinancialIntents.UPDATE_KNOWLEDGE,
    temporalFrame: TemporalFrames.CURRENT,
    answerStyle: AnswerStyles.CONFIRM_ACTION,
    primarySections: [ACCOUNTS],
    supportingSections: [],
    suppressSections: [TRANSACTIONS, HOLDINGS, SNAPSHOTS],
    match: (t) => {
      const action = hasAny(t, UPDATE_ACTION_WORDS);
      const field = hasAny(t, UPDATE_FIELD_WORDS);
      if (action && field) return 0.9;
      return 0;
    },
  },

  // 2. DEBT_VS_INVESTING — trade-off between paying debt and investing.
  //    Checked before payoff/status so "pay off debt or buy stock" resolves here.
  {
    intent: FinancialIntents.DEBT_VS_INVESTING,
    temporalFrame: TemporalFrames.PLANNING,
    answerStyle: AnswerStyles.TRADEOFF,
    primarySections: [ACCOUNTS, HOLDINGS],
    supportingSections: [SNAPSHOTS, TRANSACTIONS],
    suppressSections: [],
    match: (t) => {
      const debt = hasAny(t, DEBT_WORDS);
      const invest = hasAny(t, INVEST_WORDS);
      if (debt && invest) return 0.9;
      // "should i pay off X or invest" style with explicit "or invest".
      if (invest && /\bor\b/.test(t) && hasAny(t, ['pay off', 'pay down', 'payoff'])) return 0.85;
      return 0;
    },
  },

  // 3. DEBT_PAYOFF_PLAN — forward-looking payoff timeline / plan.
  {
    intent: FinancialIntents.DEBT_PAYOFF_PLAN,
    temporalFrame: TemporalFrames.PLANNING,
    answerStyle: AnswerStyles.PLAN,
    primarySections: [ACCOUNTS],
    supportingSections: [TRANSACTIONS, SNAPSHOTS],
    suppressSections: [HOLDINGS],
    match: (t) => {
      const debt = hasAny(t, DEBT_WORDS);
      const payoff = hasAny(t, PAYOFF_WORDS);
      if (debt && payoff) return 0.9;
      // "how long until i'm debt free" — payoff phrasing implies debt.
      if (hasAny(t, ['debt free', 'debt-free', 'get out of debt'])) return 0.85;
      return 0;
    },
  },

  // 4. CURRENT_DEBT_STATUS — "how is my debt situation right now".
  {
    intent: FinancialIntents.CURRENT_DEBT_STATUS,
    temporalFrame: TemporalFrames.CURRENT,
    answerStyle: AnswerStyles.DIRECT_STATUS,
    primarySections: [ACCOUNTS],
    supportingSections: [SNAPSHOTS],
    suppressSections: [TRANSACTIONS, HOLDINGS],
    match: (t) => {
      const debt = hasAny(t, DEBT_WORDS);
      if (!debt) return 0;
      if (hasAny(t, STATUS_WORDS)) return 0.9;
      // Bare "my debt" / "our debt" with no other qualifier → status.
      if (/\b(my|our|the)\s+(debt|debts|loan|loans|credit card)/.test(t)) return 0.7;
      return 0.55;
    },
  },

  // 5. INVESTMENT_READINESS — "am I ready to invest".
  {
    intent: FinancialIntents.INVESTMENT_READINESS,
    temporalFrame: TemporalFrames.CURRENT,
    answerStyle: AnswerStyles.ASSESSMENT,
    primarySections: [ACCOUNTS, HOLDINGS],
    supportingSections: [TRANSACTIONS, SNAPSHOTS],
    suppressSections: [],
    match: (t) => {
      if (hasAny(t, READINESS_WORDS)) return 0.9;
      // "ready" + invest vocabulary.
      if (t.includes('ready') && hasAny(t, INVEST_WORDS)) return 0.8;
      return 0;
    },
  },

  // 6. CASH_FLOW_EXPLANATION — "why is my cash flow negative".
  {
    intent: FinancialIntents.CASH_FLOW_EXPLANATION,
    temporalFrame: TemporalFrames.HISTORICAL,
    answerStyle: AnswerStyles.EXPLANATION,
    primarySections: [TRANSACTIONS],
    supportingSections: [ACCOUNTS, SNAPSHOTS],
    suppressSections: [HOLDINGS],
    match: (t) => {
      if (hasAny(t, CASH_FLOW_WORDS)) return 0.9;
      return 0;
    },
  },

  // 7. SPENDING_REDUCTION — "where can I cut spending".
  {
    intent: FinancialIntents.SPENDING_REDUCTION,
    temporalFrame: TemporalFrames.TREND,
    answerStyle: AnswerStyles.RECOMMENDATION,
    primarySections: [TRANSACTIONS],
    supportingSections: [SNAPSHOTS, ACCOUNTS],
    suppressSections: [HOLDINGS],
    match: (t) => {
      if (hasAny(t, SPENDING_CUT_WORDS)) return 0.9;
      // "spend"/"spending" + a reduction verb elsewhere in the sentence.
      if (hasAny(t, ['spend', 'spending', 'expenses', 'expense'])
          && hasAny(t, ['cut', 'reduce', 'lower', 'less', 'save', 'trim'])) return 0.8;
      return 0;
    },
  },

  // 8. W2 — the GOAL_ALIGNMENT rule was deleted with the Goals retirement.
  //    A goal-phrased question now falls through to whatever surviving rule
  //    its other vocabulary matches, or to the UNKNOWN fallback — the honest
  //    route when the product has no goals surface to answer from.

  // 9. GENERAL_FINANCIAL_OVERVIEW — "give me an overview".
  {
    intent: FinancialIntents.GENERAL_FINANCIAL_OVERVIEW,
    temporalFrame: TemporalFrames.CURRENT,
    answerStyle: AnswerStyles.OVERVIEW,
    primarySections: [ACCOUNTS, SNAPSHOTS],
    supportingSections: [TRANSACTIONS, HOLDINGS],
    suppressSections: [],
    match: (t) => {
      if (hasAny(t, OVERVIEW_WORDS)) return 0.85;
      return 0;
    },
  },
];

// UNKNOWN fallback — supports everything lightly, suppresses nothing.
const UNKNOWN_ROUTE: Omit<IntentRoute, 'confidence'> = {
  intent: FinancialIntents.UNKNOWN,
  temporalFrame: TemporalFrames.GENERAL,
  answerStyle: AnswerStyles.CLARIFY,
  primarySections: [],
  supportingSections: [ACCOUNTS, TRANSACTIONS, SNAPSHOTS, HOLDINGS],
  suppressSections: [],
};

// ---------------------------------------------------------------------------
// Transaction-window detection (D6 dynamic windows)
// ---------------------------------------------------------------------------
//
// Deterministic given (text, now). Resolves the user's wording into an explicit
// UTC start/end window. Returns undefined when no historical period is named —
// which preserves the assembler's default 30/90-day behavior. NEVER changes any
// financial calculation; it only moves the window boundaries the assembler uses.

/** Defensive cap so a "last N months" request cannot fetch unbounded history. */
const MAX_LOOKBACK_MONTHS = 24;

/** Spelled-out counts we accept in "last N months" phrasing. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  eighteen: 18,
};

/** CF-2 — month name (first three letters) → 0-based index, for "before June 2024". */
const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Format a Date as a UTC calendar date string (YYYY-MM-DD). */
function toIsoUtcDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/**
 * CF-3 — DOES THIS MESSAGE MAKE A TEMPORAL CLAIM AT ALL?
 *
 * The safeguard that keeps this contract honest about its own vocabulary.
 *
 * Every rule below resolves ONE phrasing. Nothing resolves the phrasings nobody
 * thought of, and before this slice those became `undefined` — which the CF-2
 * contract reads as "no period was named", and therefore as a request the
 * default window fully satisfies. Eight of eleven measured phrases took that
 * path and produced "The user asked about no particular period. The loaded
 * period FULLY COVERS what was asked."
 *
 * So the parser answers two questions instead of one: WHICH period (the rules),
 * and WHETHER a period was asked for at all (this). When the second says yes
 * and the first says nothing, the request is UNRESOLVED — useful window, honest
 * uncertainty — rather than silently becoming no request.
 *
 * ── Why these cues and not tense ────────────────────────────────────────────
 * "How much am I spending?" is present-tense and makes no temporal claim; it
 * must keep its default window and answer directly. So the cues are explicit
 * time EXPRESSIONS — period nouns under a determiner, relative markers,
 * seasons, named days, durations — never grammatical tense, and never a bare
 * verb. Over-detection is a real cost: it would turn ordinary questions into
 * refusals, which is the failure mode in the other direction.
 *
 * False negatives here are survivable (the phrase behaves as it did before
 * CF-3); false positives are not (an ordinary question starts hedging). The
 * list is therefore deliberately specific, and the ordinary-question corpus in
 * temporal-claim.test.ts pins that it stays that way.
 */
const TEMPORAL_CUES: RegExp[] = [
  // A period noun under a determiner or ordinal — "that month", "the summer",
  // "those years", "my first year". A bare "month" is not a claim; "that
  // month" is.
  /\b(?:that|those|this|these|the|my|our|his|her|their|previous|prior|following|next|coming|earlier|later|same|first|second|third|last)\s+(?:\w+\s+){0,2}(?:day|days|week|weeks|month|months|quarter|quarters|year|years|decade|season|summer|winter|spring|autumn|fall|holidays?|semester|term)\b/,
  // Seasons and named periods on their own.
  /\b(?:summer|winter|spring|autumn|christmas|thanksgiving|ramadan|easter|new year'?s?)\b/,
  // Relative day words.
  /\b(?:yesterday|today|tonight|tomorrow|overnight)\b/,
  // A relative marker followed by something — "before I moved", "during the
  // move", "since the wedding", "until then", "up to last spring".
  /\b(?:before|after|during|since|until|till|between|throughout|prior to|up to|as of|by the time)\b/,
  // "when I was …", "back when …" — an event standing in for a date.
  /\b(?:when (?:i|we|they|he|she) (?:was|were|had|got|moved|started|joined|lived|bought)|back when)\b/,
  // Durations and distances in time — "two years ago", "6 weeks back",
  // "over 3 years", "the past N days".
  /\b\d{1,3}\s*(?:day|days|week|weeks|month|months|quarter|quarters|year|years)\b/,
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:day|days|week|weeks|month|months|quarter|quarters|year|years)\b/,
  /\b(?:ago|thereafter|onwards?|henceforth)\b/,
  // An explicit month name or four-digit year the rules did not consume.
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/,
  /\b(?:19|20)\d{2}\b/,
  // Explicit period vocabulary that names a frame without naming its bounds.
  /\b(?:fiscal|calendar)\s+(?:year|quarter|month)\b/,
  /\b(?:ytd|mtd|qtd|year[\s-]to[\s-]date|month[\s-]to[\s-]date|quarter[\s-]to[\s-]date)\b/,
  /\b(?:period|timeframe|time frame|date range|timespan|time span)\b/,
];

/**
 * True when the message contains temporal language, whatever it means.
 *
 * Exported for the acceptance corpus, which has to prove BOTH directions: that
 * ordinary questions produce false here, and that unrecognised time phrases
 * produce true.
 */
export function hasTemporalCue(text: string): boolean {
  return TEMPORAL_CUES.some((re) => re.test(text));
}

/**
 * Detect a transaction-window request from the message text.
 * Order is specific → general so overlapping phrasings resolve deterministically.
 */
function detectTransactionWindow(text: string, now: Date): TransactionWindowRequest | undefined {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const today = toIsoUtcDate(now);

  // 1. LAST_N_MONTHS — "last/past/previous/trailing N months" (N as digit or word).
  const nMatch = text.match(
    /\b(?:last|past|previous|prior|trailing)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen)\s+months?\b/,
  );
  if (nMatch) {
    const raw = nMatch[1];
    const n = Math.min(
      /^\d+$/.test(raw) ? parseInt(raw, 10) : (NUMBER_WORDS[raw] ?? 0),
      MAX_LOOKBACK_MONTHS,
    );
    if (n >= 1) {
      const start = new Date(Date.UTC(y, m - n, now.getUTCDate()));
      return {
        mode:      TransactionWindowModes.LAST_N_MONTHS,
        startDate: toIsoUtcDate(start),
        endDate:   today,
        label:     `last ${n} months`,
        requested: 'LAST_N_MONTHS',
        requestedStart: toIsoUtcDate(start),
        requestedEnd:   today,
      };
    }
  }

  // 2. CALENDAR_MONTH — prior full calendar month.
  if (/\b(?:last|previous|prior)\s+month\b/.test(text)) {
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end   = new Date(Date.UTC(y, m, 0)); // day 0 of this month = last day of prior month
    return {
      mode:      TransactionWindowModes.CALENDAR_MONTH,
      startDate: toIsoUtcDate(start),
      endDate:   toIsoUtcDate(end),
      label:     'last month',
      requested: 'CALENDAR_MONTH',
      requestedStart: toIsoUtcDate(start),
      requestedEnd:   toIsoUtcDate(end),
    };
  }

  // 3. CALENDAR_MONTH — current calendar month to date.
  if (/\b(?:this|current)\s+month\b/.test(text)) {
    const start = new Date(Date.UTC(y, m, 1));
    return {
      mode:      TransactionWindowModes.CALENDAR_MONTH,
      startDate: toIsoUtcDate(start),
      endDate:   today,
      label:     'this month',
      requested: 'CALENDAR_MONTH',
      requestedStart: toIsoUtcDate(start),
      requestedEnd:   today,
    };
  }

  // ── CF-3 — CALENDAR QUARTERS ─────────────────────────────────────────────
  //
  // A quarter had no representation at all, so every quarter phrase fell
  // through to UNSPECIFIED and CF-2 declared the 90-day default a full match.
  // Measured: "last quarter", "previous quarter", "this quarter" and "quarter
  // to date" all rendered "The user asked about no particular period."
  //
  // NOT collapsed into "3 months". A calendar quarter has fixed boundaries; a
  // trailing three months does not. On 27 August the previous calendar quarter
  // (Apr–Jun) and the trailing three months (May 27–Aug 27) share no day at
  // all, so treating them as the same request would answer a different
  // question from the one asked.

  // 3a-i. Previous calendar quarter.
  if (/\b(?:last|previous|prior)\s+quarter\b/.test(text) && !/\bthe\s+last\s+quarter\b/.test(text)) {
    const q = Math.floor(m / 3);                 // current quarter, 0-based
    const startMonth = (q - 1) * 3;              // may go negative → previous year
    const start = new Date(Date.UTC(y, startMonth, 1));
    const end   = new Date(Date.UTC(y, startMonth + 3, 0));
    const label = `Q${((start.getUTCMonth() / 3) | 0) + 1} ${start.getUTCFullYear()}`;
    return {
      mode:      TransactionWindowModes.CUSTOM,
      startDate: toIsoUtcDate(start),
      endDate:   toIsoUtcDate(end),
      label:     `last quarter (${label})`,
      requested: 'CALENDAR_QUARTER',
      requestedStart: toIsoUtcDate(start),
      requestedEnd:   toIsoUtcDate(end),
    };
  }

  // 3a-ii. Current calendar quarter to date.
  if (/\b(?:this|current)\s+quarter\b/.test(text) || /\bquarter[\s-]to[\s-]date\b/.test(text) || /\bqtd\b/.test(text)) {
    const start = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
    const label = `Q${Math.floor(m / 3) + 1} ${y}`;
    return {
      mode:      TransactionWindowModes.CUSTOM,
      startDate: toIsoUtcDate(start),
      endDate:   today,
      label:     `this quarter (${label} to date)`,
      requested: 'CALENDAR_QUARTER',
      requestedStart: toIsoUtcDate(start),
      requestedEnd:   today,
    };
  }

  // 3a-iii. TRAILING three months — "past quarter", "the last quarter".
  //         A duration, not a calendar bucket; represented by the existing
  //         LAST_N_MONTHS request rather than a second quarter vocabulary.
  if (/\b(?:past|trailing)\s+quarter\b/.test(text) || /\bthe\s+last\s+quarter\b/.test(text)) {
    const start = new Date(Date.UTC(y, m - 3, now.getUTCDate()));
    return {
      mode:      TransactionWindowModes.LAST_N_MONTHS,
      startDate: toIsoUtcDate(start),
      endDate:   today,
      label:     'the past quarter (trailing 3 months)',
      requested: 'LAST_N_MONTHS',
      requestedStart: toIsoUtcDate(start),
      requestedEnd:   today,
    };
  }

  // ── CF-3 — BARE YEAR PHRASES ─────────────────────────────────────────────
  //
  // "last year" and "past year" are DIFFERENT REQUESTS and the difference is
  // not stylistic: on 27 August 2026 the first means 2025-01-01..2025-12-31
  // and the second means 2025-08-27..2026-08-27. Answering either with the
  // other's figure is simply a wrong answer, so they resolve separately.
  //
  // The determiner carries the distinction English speakers already make:
  // bare "last year" is the calendar year, "THE last year" / "over the last
  // year" is a duration. Both were UNSPECIFIED before this slice.

  // 3c-i. TRAILING twelve months — "past year", "the last year", "over the last year".
  if (/\b(?:past|trailing)\s+year\b/.test(text)
      || /\b(?:the|over the|in the|within the)\s+last\s+year\b/.test(text)
      || /\blast\s+twelve\s+months\b/.test(text)) {
    const start = new Date(Date.UTC(y - 1, m, now.getUTCDate()));
    return {
      mode:      TransactionWindowModes.LAST_N_MONTHS,
      startDate: toIsoUtcDate(start),
      endDate:   today,
      label:     'the past year (trailing 12 months)',
      requested: 'LAST_N_MONTHS',
      requestedStart: toIsoUtcDate(start),
      requestedEnd:   today,
    };
  }

  // 3c-ii. PREVIOUS calendar year — bare "last year", "previous year".
  //        Reuses CALENDAR_YEAR: an existing request that already means
  //        exactly this, so no duplicate vocabulary is introduced.
  if (/\b(?:last|previous|prior)\s+year\b/.test(text)) {
    const start = new Date(Date.UTC(y - 1, 0, 1));
    const end   = new Date(Date.UTC(y - 1, 11, 31));
    return {
      mode:      TransactionWindowModes.YTD,
      startDate: toIsoUtcDate(start),
      endDate:   toIsoUtcDate(end),
      label:     `last year (${y - 1})`,
      requested: 'CALENDAR_YEAR',
      requestedStart: toIsoUtcDate(start),
      requestedEnd:   toIsoUtcDate(end),
    };
  }

  // 3b. EXPLICIT_RANGE — "between March 2026 and May 2026", "from Jan to Mar".
  //
  // CF-2 — before this, the bare-year rule below matched "2026" and selected the
  // whole year to date. The totals shown were YTD while the question was about
  // three months of it, and the routing block announced the year as the
  // requested period. Runs ahead of the year rule for the same reason the
  // open-ended rules do: a more specific reading must win.
  const rangeMatch = text.match(
    /\b(?:between|from)\s+([a-z]{3,9})\.?\s*(20\d{2})?\s+(?:and|to|through|until|-|–)\s+([a-z]{3,9})\.?\s*(20\d{2})?\b/,
  );
  if (rangeMatch) {
    const m1 = MONTH_INDEX[rangeMatch[1].slice(0, 3)];
    const m2 = MONTH_INDEX[rangeMatch[3].slice(0, 3)];
    if (m1 !== undefined && m2 !== undefined) {
      // A missing year on either side inherits the other's, then the current
      // one — "from January to March" means one range, not two half-specified.
      const y2 = rangeMatch[4] ? Number(rangeMatch[4]) : rangeMatch[2] ? Number(rangeMatch[2]) : y;
      const y1 = rangeMatch[2] ? Number(rangeMatch[2]) : y2;
      const startIso = toIsoUtcDate(new Date(Date.UTC(y1, m1, 1)));
      // Inclusive of the whole closing month: day 0 of the following month.
      const endIso   = toIsoUtcDate(new Date(Date.UTC(y2, m2 + 1, 0)));
      if (startIso <= endIso) {
        return {
          mode:      TransactionWindowModes.CUSTOM,
          startDate: startIso,
          endDate:   endIso,
          label:     rangeMatch[0],
          requested: 'EXPLICIT_RANGE',
          requestedStart: startIso,
          requestedEnd:   endIso,
        };
      }
    }
  }

  // ── CF-2 — OPEN-ENDED AND UNBOUNDED REQUESTS ─────────────────────────────
  //
  // These run BEFORE the bare-year rule below, which is the whole point.
  // `\b(20\d{2})\b` matched "before June 2024" and selected the WHOLE of 2024,
  // clamped to June–December — very nearly the complement of the question. The
  // model received figures for a period disjoint from the one asked about, with
  // nothing in the prompt saying so.
  //
  // Recognising them does NOT widen retrieval. An open-left request still
  // cannot be served, and says so; an open-right one resolves to an ordinary
  // bounded range the existing query path already handles.

  // 4a. BEFORE_DATE — open-left. No floor exists, so no window is produced:
  //     the assembler keeps its default and the scope block declares the
  //     shortfall. Manufacturing an all-history query here is exactly what this
  //     slice was told not to do.
  const beforeMatch = text.match(
    /\b(?:before|prior to|earlier than|up (?:un)?til|until)\s+(?:the\s+)?([a-z]{3,9}\.?\s+)?(20\d{2})\b/,
  );
  if (beforeMatch) {
    const mon = beforeMatch[1] ? MONTH_INDEX[beforeMatch[1].trim().slice(0, 3)] : undefined;
    const yr  = Number(beforeMatch[2]);
    const ceilingExclusive = new Date(Date.UTC(yr, mon ?? 0, 1));
    const requestedEnd = toIsoUtcDate(new Date(ceilingExclusive.getTime() - 86_400_000));
    return {
      mode:  TransactionWindowModes.CUSTOM,
      label: beforeMatch[0],
      requested: 'BEFORE_DATE',
      requestedStart: null,
      requestedEnd,
    };
  }

  // 4b. AFTER_DATE — open-right, and therefore an ORDINARY bounded range
  //     ending today. The existing query path serves it with no architectural
  //     change, so it is served rather than merely disclosed.
  const afterMatch = text.match(
    /\b(after|since|from|later than)\s+(?:the\s+)?([a-z]{3,9}\.?\s+)?(20\d{2})\b/,
  );
  if (afterMatch && !/\bsince (?:jan(?:uary)?\.?\s?1(?:st)?|the (?:start|beginning))/.test(text)) {
    const mon = afterMatch[2] ? MONTH_INDEX[afterMatch[2].trim().slice(0, 3)] : undefined;
    const yr  = Number(afterMatch[3]);
    // "from" is a weak signal — a bare "from 2024" reads as easily as the year
    // itself, and the existing bare-year rule already serves that well. Require
    // a month for it, so CF-2 adds a reading rather than reinterpreting one.
    const bareYearAllowed = afterMatch[1] !== 'from';
    if (mon !== undefined || (afterMatch[2] === undefined && bareYearAllowed)) {
      const startIso = toIsoUtcDate(new Date(Date.UTC(yr, mon ?? 0, 1)));
      return {
        mode:      TransactionWindowModes.CUSTOM,
        startDate: startIso,
        endDate:   today,
        label:     afterMatch[0],
        requested: 'AFTER_DATE',
        requestedStart: startIso,
        requestedEnd:   today,
      };
    }
  }

  // 4c. ALL_TIME — no bounded window can discharge it. Recorded, not served:
  //     the shortfall is the honest answer, and loading more rows would not
  //     change it (this Space's ledger starts before any window the system
  //     permits).
  if (/\b(?:ever|all[- ]time|all time|in total|of all time|since (?:i|we) (?:started|began|joined)|lifetime|to date in total)\b/.test(text)) {
    return {
      mode:  TransactionWindowModes.CUSTOM,
      label: 'all time',
      requested: 'ALL_TIME',
      requestedStart: null,
      requestedEnd:   null,
    };
  }

  // 4. YTD — "this year", "ytd", "since Jan 1", "for the year", or an explicit year.
  const ytdPhrase =
    /\b(?:this year|current year|ytd|year to date|year-to-date|for the year|this yr|so far this year)\b/.test(text) ||
    /\bsince (?:jan(?:uary)?\.?\s?1(?:st)?|the (?:start|beginning) of (?:the year|this year))\b/.test(text) ||
    /\bsince january\b/.test(text);

  const yearMatch = text.match(/\b(20\d{2})\b/);
  const explicitYear =
    yearMatch && Number(yearMatch[1]) >= y - 10 && Number(yearMatch[1]) <= y
      ? Number(yearMatch[1])
      : null;

  if (ytdPhrase || explicitYear !== null) {
    const refYear = explicitYear ?? y;
    const start = new Date(Date.UTC(refYear, 0, 1));
    const isPastYear = refYear < y;
    const end = isPastYear ? new Date(Date.UTC(refYear, 11, 31)) : now;
    return {
      mode:      TransactionWindowModes.YTD,
      startDate: toIsoUtcDate(start),
      endDate:   isPastYear ? toIsoUtcDate(end) : today,
      label:     isPastYear ? `${refYear}` : `year-to-date ${refYear}`,
      // CF-2 — a PAST year denotes a full calendar year; the current year
      // denotes only the part that has happened. Different claims, and the
      // clamp can fail the first while never touching the second.
      requested:      isPastYear ? 'CALENDAR_YEAR' : 'YTD',
      requestedStart: toIsoUtcDate(start),
      requestedEnd:   isPastYear ? toIsoUtcDate(end) : today,
    };
  }

  // ── CF-2 — VAGUE NEARNESS, DECLARED ──────────────────────────────────────
  //
  // "recently" and "currently" name no dates, and the rolling default window is
  // a perfectly good reading of them. The defect was never the interval — it
  // was that the prompt could not distinguish this legitimate interpretation
  // from the silent substitution ALL_TIME received. Recording the request makes
  // the reading DECLARED, which is the difference between an answer and a guess.
  //
  // No dates are returned: the assembler keeps its default, unchanged.
  if (/\b(?:recent(?:ly)?|lately|these days|of late|past few (?:weeks|days))\b/.test(text)) {
    return {
      mode: TransactionWindowModes.DEFAULT, label: 'recently', requested: 'RECENT',
      requestedStart: null, requestedEnd: null,
    };
  }
  if (/\b(?:currently|right now|at the moment|these days|nowadays|at present)\b/.test(text)) {
    return {
      mode: TransactionWindowModes.DEFAULT, label: 'currently', requested: 'CURRENT',
      requestedStart: null, requestedEnd: null,
    };
  }

  // ── CF-3 — THE SAFEGUARD ──────────────────────────────────────────────────
  //
  // Nothing above resolved this message, and it is the LAST thing tried. If the
  // message nonetheless contains temporal language, the honest answer is not
  // "no period was named" — it is "a period was named and I could not work out
  // which". The assembler still applies its default window, so the reply stays
  // useful; what changes is that the prompt stops claiming the default answers
  // the question.
  //
  // The label is deliberately generic rather than the message text: the model
  // already has the user's words in the conversation, and echoing a normalised
  // lower-cased copy of the whole question into the prompt reads as noise.
  if (hasTemporalCue(text)) {
    return {
      mode:  TransactionWindowModes.DEFAULT,
      label: 'the period named in the question',
      requested: 'UNRESOLVED',
      // Explicitly null, like every other unservable request: a consumer reading
      // these must not have to distinguish "absent" from "no bound exists".
      requestedStart: null, requestedEnd: null,
    };
  }

  // Genuinely no temporal claim. The default window is the product's answer to
  // a question that asked for no particular period — not a substitution.
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a single user message into an IntentRoute.
 *
 * Deterministic given (message, now). Intent, temporal frame, sections, and
 * confidence depend only on the message text — same input → same output. The
 * optional `now` is used ONLY to resolve `transactionWindow` dates (D6); it
 * defaults to the current server time. Empty / whitespace-only input returns
 * UNKNOWN with zero confidence and no window.
 */
export function classifyFinancialIntent(message: string, now: Date = new Date()): IntentRoute {
  const text = normalize(message ?? '');

  if (text.length === 0) {
    return { ...UNKNOWN_ROUTE, confidence: 0 };
  }

  const transactionWindow = detectTransactionWindow(text, now);

  for (const rule of RULES) {
    const confidence = rule.match(text);
    if (confidence > 0) {
      return {
        intent: rule.intent,
        temporalFrame: rule.temporalFrame,
        primarySections: [...rule.primarySections],
        supportingSections: [...rule.supportingSections],
        suppressSections: [...rule.suppressSections],
        answerStyle: rule.answerStyle,
        confidence,
        ...(transactionWindow ? { transactionWindow } : {}),
      };
    }
  }

  return {
    ...UNKNOWN_ROUTE,
    confidence: 0.2,
    ...(transactionWindow ? { transactionWindow } : {}),
  };
}
