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

const GOAL_WORDS = ['goal', 'goals', 'target', 'targets', 'saving for', 'on track'];

const ALIGN_WORDS = [
  'align', 'aligned', 'alignment', 'on track', 'consistent with',
  'match my', 'line up', 'in line with',
];

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
const GOALS         = FinanceDomains.GOALS;
const SNAPSHOTS     = FinanceDomains.SNAPSHOT_HISTORY;
const PROVIDERS     = FinanceDomains.PROVIDERS;
const MEMBERS       = FinanceDomains.MEMBERS;

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
    primarySections: [ACCOUNTS, PROVIDERS],
    supportingSections: [],
    suppressSections: [TRANSACTIONS, HOLDINGS, GOALS, SNAPSHOTS],
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
    supportingSections: [GOALS, SNAPSHOTS, TRANSACTIONS],
    suppressSections: [MEMBERS],
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
    supportingSections: [TRANSACTIONS, SNAPSHOTS, PROVIDERS],
    suppressSections: [HOLDINGS, MEMBERS],
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
    supportingSections: [SNAPSHOTS, PROVIDERS],
    suppressSections: [TRANSACTIONS, HOLDINGS, GOALS],
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
    supportingSections: [GOALS, TRANSACTIONS, SNAPSHOTS],
    suppressSections: [MEMBERS],
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
    suppressSections: [HOLDINGS, GOALS],
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

  // 8. GOAL_ALIGNMENT — "are my goals aligned with my spending".
  {
    intent: FinancialIntents.GOAL_ALIGNMENT,
    temporalFrame: TemporalFrames.CURRENT,
    answerStyle: AnswerStyles.ASSESSMENT,
    primarySections: [GOALS, TRANSACTIONS],
    supportingSections: [ACCOUNTS, SNAPSHOTS],
    suppressSections: [HOLDINGS],
    match: (t) => {
      const goal = hasAny(t, GOAL_WORDS);
      if (goal && hasAny(t, ALIGN_WORDS)) return 0.9;
      if (goal && hasAny(t, ['spend', 'spending', 'saving', 'progress'])) return 0.75;
      if (goal) return 0.6;
      return 0;
    },
  },

  // 9. GENERAL_FINANCIAL_OVERVIEW — "give me an overview".
  {
    intent: FinancialIntents.GENERAL_FINANCIAL_OVERVIEW,
    temporalFrame: TemporalFrames.CURRENT,
    answerStyle: AnswerStyles.OVERVIEW,
    primarySections: [ACCOUNTS, SNAPSHOTS],
    supportingSections: [GOALS, TRANSACTIONS, HOLDINGS],
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
  supportingSections: [ACCOUNTS, TRANSACTIONS, GOALS, SNAPSHOTS, HOLDINGS],
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

/** Format a Date as a UTC calendar date string (YYYY-MM-DD). */
function toIsoUtcDate(d: Date): string {
  return d.toISOString().split('T')[0];
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
    };
  }

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
