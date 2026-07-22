/**
 * lib/ai/chat/message-analysis.ts
 *
 * Pure request-derivation for the chat route: given the conversation messages,
 * decide the intent route, the transaction window (with D6 carry-forward), any
 * transaction drilldown, the ambiguity clarification, and knowledge-gap
 * filtering. Deterministic — no DB, no LLM, no financial computation. These
 * decisions shape which context is assembled and how gaps are returned; they
 * are not prompt serialization.
 *
 * Extracted verbatim from app/api/ai/chat/route.ts (AI-ARCH) so the route
 * orchestrates rather than owning the message-analysis heuristics.
 */

import type { ChatMessage } from '@/lib/ai/provider';
import type { IntentRoute } from '@/lib/ai/intent';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import type { AssemblerOptions, KnowledgeGap } from '@/lib/ai/types';
import { NON_SPENDING_CATEGORY_NAMES } from '@/lib/ai/spending-categories';

/**
 * Layer 0 (D4) — classify the most recent user message into an IntentRoute.
 * Pure/deterministic; returns UNKNOWN routing when there is no user turn.
 * The result is injected into the system prompt as the === QUESTION ROUTING ===
 * block; it does not affect context assembly, DB access, or the model call.
 */
export function routeForMessages(msgs: ChatMessage[]): IntentRoute {
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  // Pass the current server time so Layer 0 can resolve dynamic transaction
  // windows (D6) against "now"; intent/temporal classification is unaffected.
  return classifyFinancialIntent(lastUser?.content ?? '', new Date());
}

/**
 * Convert a route's optional transactionWindow (D6) into the buildContext
 * option shape. Returns undefined for general prompts — which preserves the
 * transactions assembler's default 30/90-day window.
 */
function windowOptionFromRoute(
  route: IntentRoute,
): { startDate: string; endDate: string; label?: string } | undefined {
  const w = route.transactionWindow;
  if (w && w.startDate && w.endDate) {
    return { startDate: w.startDate, endDate: w.endDate, label: w.label };
  }
  return undefined;
}

/**
 * Follow-up detection (D6 carry-forward).
 *
 * A follow-up refines the previous question without restating its period
 * ("break it down", "month by month", "what about January"). When the latest
 * message names no window of its own but reads like one of these, we inherit
 * the most recently expressed window instead of silently snapping back to the
 * default 90-day window.
 *
 * Kept deliberately narrow: an unrelated new question ("how is my debt right
 * now") matches nothing here, so it does NOT inherit a stale window.
 */
const FOLLOW_UP_PATTERNS: RegExp[] = [
  /\bbreak (?:it|them|this|that)\s+down\b/,
  /\bbreak\s+down\b/,
  /\bbroken\s+down\b/,
  /\bbreak\s+it\s+out\b/,
  /\bmonth[\s-]by[\s-]month\b/,
  /\bmonthly\s+breakdown\b/,
  /\bby\s+month\b/,
  /\bwhat about\b/,
  /\bhow about\b/,
  /\bwhat if\b/,
  /\bshow me more\b/,
  /\bmore detail/,
  /\bdrill (?:down|into)\b/,
  /\band\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/,
  /\bfrom\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/,
];

/**
 * Bare month reference, e.g. "What about January?" or just "June". Treated as a
 * follow-up so it inherits the active window rather than resolving a lone month.
 * The ambiguous "may" is included for completeness; it only ever triggers
 * inheritance (never a fresh window), so the downside of a false positive is a
 * window carry-forward on a message that already had none.
 */
const MONTH_NAME_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;

function looksLikeFollowUp(message: string): boolean {
  const t = message.toLowerCase().replace(/\s+/g, ' ').trim();
  if (FOLLOW_UP_PATTERNS.some((re) => re.test(t))) return true;
  if (MONTH_NAME_RE.test(t)) return true;
  return false;
}

/**
 * Resolve the transaction window for the whole conversation (D6 carry-forward).
 *
 * Intent classification still uses only the latest message (routeForMessages).
 * The *window* is resolved with carry-forward:
 *   1. If the latest user message names its own window, use it.
 *   2. Else, if the latest message reads like a follow-up, scan previous user
 *      messages newest → oldest and inherit the most recent explicit window.
 *   3. Else return undefined — the assembler keeps its default 30/90-day window.
 */
export function resolveTransactionWindow(
  msgs: ChatMessage[],
  now:  Date,
): ReturnType<typeof windowOptionFromRoute> {
  const userMsgs = msgs.filter((m) => m.role === 'user');
  if (userMsgs.length === 0) return undefined;

  const latest = userMsgs[userMsgs.length - 1];
  const latestWindow = windowOptionFromRoute(classifyFinancialIntent(latest.content, now));
  if (latestWindow) return latestWindow;

  // Latest message has no window of its own — only inherit for a follow-up.
  if (!looksLikeFollowUp(latest.content)) return undefined;

  for (let i = userMsgs.length - 2; i >= 0; i--) {
    const inherited = windowOptionFromRoute(classifyFinancialIntent(userMsgs[i].content, now));
    if (inherited) return inherited;
  }
  return undefined;
}

// ── Ambiguity guard (D6) ──────────────────────────────────────────────────────
// A breakdown-style follow-up ("break it down", "month by month", "what about
// January") names neither WHAT to break down nor a period. On its own — with no
// prior financial topic or window to attach to — it is genuinely ambiguous. We
// ask a clarifying question instead of guessing with the default window.

/** Financial subjects a breakdown could be about. If the message names one of
 *  these itself, it is self-descriptive and NOT treated as ambiguous. */
const FINANCIAL_SUBJECT_WORDS = [
  'spend', 'spending', 'spent', 'expense', 'expenses', 'income', 'earn', 'earning',
  'earnings', 'debt', 'loan', 'loans', 'cash flow', 'cashflow', 'cash-flow',
  'saving', 'savings', 'net worth', 'budget', 'transfer', 'transfers',
  'dining', 'grocery', 'groceries', 'shopping', 'travel', 'subscription',
  'subscriptions', 'utilities', 'category', 'categories', 'transaction', 'transactions',
];

function namesFinancialSubject(lowerText: string): boolean {
  return FINANCIAL_SUBJECT_WORDS.some((w) => lowerText.includes(w));
}

/** Human month names keyed by first three letters (for month-specific prompts). */
const MONTH_DISPLAY: Record<string, string> = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
  jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December',
};

/**
 * True when the latest message is a contentless breakdown follow-up: it uses
 * follow-up phrasing (or a bare month) but names no financial subject of its own.
 */
export function isAmbiguousBreakdownFollowUp(message: string): boolean {
  const t = message.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length === 0) return false;
  if (namesFinancialSubject(t)) return false; // self-descriptive → not ambiguous
  return looksLikeFollowUp(t);
}

/**
 * True when an earlier user message established a financial topic or window the
 * follow-up could reasonably attach to. Only prior turns (not the latest) count.
 */
export function hasPriorFinancialContext(msgs: ChatMessage[], now: Date): boolean {
  const userMsgs = msgs.filter((m) => m.role === 'user');
  const prior = userMsgs.slice(0, -1); // exclude the latest (the follow-up itself)
  for (const m of prior) {
    const t = m.content.toLowerCase();
    if (namesFinancialSubject(t)) return true;
    if (windowOptionFromRoute(classifyFinancialIntent(m.content, now))) return true;
  }
  return false;
}

/**
 * Build the clarifying question for an ambiguous breakdown follow-up. A bare
 * month reference ("what about January?") gets a month-scoped prompt; everything
 * else gets the month-by-month prompt.
 */
export function buildBreakdownClarification(message: string): string {
  const t = message.toLowerCase();
  const monthMatch = t.match(MONTH_NAME_RE);
  const isBareMonth =
    !!monthMatch && !/\b(break|month by month|by month|breakdown|drill|more|show)\b/.test(t);
  if (isBareMonth) {
    const name = MONTH_DISPLAY[monthMatch![1].slice(0, 3)] ?? 'that month';
    return `Which figures would you like for ${name} — spending, income, debt payments, or cash flow?`;
  }
  return 'What would you like broken down month by month — spending, income, debt payments, or cash flow?';
}

// ── Transaction drilldown detection (D6 — category/merchant evidence) ─────────
// A drilldown is an explicit follow-up asking to SEE the transactions behind a
// category / merchant / period ("what is Other made up of?", "show me the
// largest transactions", "why is January so high?"). Detection is deterministic
// and conservative: it only fires on drilldown phrasing, and it never runs on an
// ordinary prompt — so raw rows are attached only when asked for.

/** Month name (first three letters) → 1..12. */
const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Free-text category word → canonical TransactionCategory string. */
const CATEGORY_SYNONYMS: Record<string, string> = {
  other: 'Other',
  dining: 'Dining', restaurant: 'Dining', restaurants: 'Dining',
  grocery: 'Groceries', groceries: 'Groceries',
  shopping: 'Shopping',
  travel: 'Travel',
  subscription: 'Subscriptions', subscriptions: 'Subscriptions',
  utility: 'Utilities', utilities: 'Utilities',
  income: 'Income', payroll: 'Income',
  interest: 'Interest',
  transfer: 'Transfer', transfers: 'Transfer',
  payment: 'Payment', payments: 'Payment',
};

/** Subjects that are not a real merchant — a bare pronoun or generic noun. */
const GENERIC_DRILLDOWN_SUBJECTS = new Set([
  'it', 'this', 'that', 'them', 'these', 'those', 'everything', 'all',
  'spending', 'expenses', 'my', 'my spending', 'my expenses', 'things',
  'the numbers', 'costs', 'the category', 'the rest',
]);

/** Resolve the first category word present in the text, or null. */
function detectDrilldownCategory(lowerText: string): string | null {
  for (const [word, category] of Object.entries(CATEGORY_SYNONYMS)) {
    if (new RegExp(`\\b${word}\\b`).test(lowerText)) return category;
  }
  return null;
}

/** Extract a merchant subject from "break down X" / "breakdown of X", or null. */
function detectDrilldownMerchant(text: string): string | null {
  const m =
    text.match(/\bbreak(?:\s*down|\s+out)\s+(?:the\s+|my\s+)?(.+?)\s*[?.!]*$/i) ||
    text.match(/\bbreakdown\s+of\s+(?:the\s+|my\s+)?(.+?)\s*[?.!]*$/i);
  if (!m) return null;

  const subject = m[1].trim().replace(/\s+(category|categories|spending|transactions?)$/i, '').trim();
  if (!subject) return null;

  const lower = subject.toLowerCase();
  if (GENERIC_DRILLDOWN_SUBJECTS.has(lower)) return null;
  if (detectDrilldownCategory(lower)) return null;      // a category — handled elsewhere
  // A bare month ("break down January") is a window follow-up, not a merchant.
  if (MONTH_NAME_RE.test(lower) && lower.split(/\s+/).length === 1) return null;

  return subject;
}

/** Regexes that signal an explicit ask to see the underlying transactions. */
const DRILLDOWN_EVIDENCE_PATTERNS: RegExp[] = [
  /\bmade up of\b/,
  /\bmade of\b/,
  /\bwhat(?:'s| is| are)?\b[^?]*\bin\b\s+(?:the\s+)?(?:other|dining|grocer|shopping|travel|subscription|utilit|income|interest|transfer|payment)/,
  /\bshow (?:me )?(?:the |all )?(?:transactions|purchases|charges|expenses)\b/,
  /\b(?:what|which)\s+transactions\b/,
  /\b(?:largest|biggest|top|highest)\s+(?:transactions|purchases|charges|expenses|spending)\b/,
  /\bwhy (?:is|was|are|were)\b[^?]*\bso (?:high|expensive|big|much)\b/,
  /\bwhat (?:caused|drove|made up|is driving|drove up)\b/,
  /\bwhat made\b[^?]*\bexpensive\b/,
  /\bwhat'?s? behind\b/,
  /\bwhat (?:caused|made)\b[^?]*\bspike\b/,
  /\bdrill (?:down|into)\b/,
];

/** Optional explicit result cap ("top 10", "largest 20"). */
function detectDrilldownLimit(lowerText: string): number | undefined {
  const m = lowerText.match(/\b(?:top|largest|biggest|first|highest)\s+(\d{1,2})\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve a transaction-drilldown request from the latest message, or undefined.
 *
 * Window resolution reuses the carry-forward window (so "what is January Other
 * made up of?" after a 2026 breakdown inherits the 2026 year) and narrows to a
 * named month when present. Category/merchant are resolved from the wording.
 */
export function resolveDrilldown(
  msgs: ChatMessage[],
  now:  Date,
): AssemblerOptions['drilldown'] | undefined {
  const latest = [...msgs].reverse().find((m) => m.role === 'user');
  if (!latest) return undefined;

  const text  = latest.content;
  const lower = text.toLowerCase().replace(/\s+/g, ' ').trim();

  const category = detectDrilldownCategory(lower);
  const merchant = category ? null : detectDrilldownMerchant(text);

  const evidenceAsk    = DRILLDOWN_EVIDENCE_PATTERNS.some((re) => re.test(lower));
  const breakdownAsk   = /\bbreak\b/.test(lower) && (!!merchant || !!category);
  if (!evidenceAsk && !breakdownAsk) return undefined;

  // ── Resolve the window ──────────────────────────────────────────────────────
  // Base = the conversation's carry-forward window (may be undefined). A named
  // month narrows to that whole calendar month within the base window's year.
  const base = resolveTransactionWindow(msgs, now);
  const monthMatch = lower.match(MONTH_NAME_RE);

  let startDate: string | undefined;
  let endDate:   string | undefined;
  let periodLabel: string | undefined;

  if (monthMatch) {
    const mo = MONTH_NUM[monthMatch[1].slice(0, 3)];
    // Year: the base window's most recent year, else the current year.
    const baseYear = base?.endDate ? Number(base.endDate.slice(0, 4)) : now.getUTCFullYear();
    const mm = String(mo).padStart(2, '0');
    const monthStart = `${baseYear}-${mm}-01`;
    const lastDay = new Date(Date.UTC(baseYear, mo, 0)).getUTCDate();
    let monthEnd = `${baseYear}-${mm}-${String(lastDay).padStart(2, '0')}`;
    // Never look past today (an in-progress or future month).
    const todayIso = now.toISOString().split('T')[0];
    if (monthEnd > todayIso) monthEnd = todayIso;
    startDate = monthStart;
    endDate   = monthEnd;
    periodLabel = `${MONTH_DISPLAY[monthMatch[1].slice(0, 3)]} ${baseYear}`;
  } else if (base) {
    startDate = base.startDate;
    endDate   = base.endDate;
    periodLabel = base.label;
  }

  // Slice 6: flow-derived (same members over resolvable banking categories).
  const includeNonSpending = category ? NON_SPENDING_CATEGORY_NAMES.has(category) : false;

  // Human label for provenance, e.g. "January 2026 · Other" or "Airbnb".
  const subjectLabel = category ?? merchant ?? 'largest transactions';
  const label = periodLabel ? `${periodLabel} · ${subjectLabel}` : subjectLabel;

  return {
    ...(category ? { category } : {}),
    ...(merchant ? { merchant } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(detectDrilldownLimit(lower) ? { limit: detectDrilldownLimit(lower) } : {}),
    includeNonSpending,
    label,
  };
}

/**
 * Filter knowledge gaps by field relevance.
 *
 * APR       — always returned (durable metadata; affects interest cost in any advisory context).
 * minimumPayment — returned only when payoff intent is detected (operational data; only
 *                  meaningful for schedule / timeline questions).
 */
export function filterGapsByIntent(gaps: KnowledgeGap[], includeMinPayment: boolean): KnowledgeGap[] {
  if (includeMinPayment) return gaps;
  return gaps.filter((g) => g.field !== 'minimumPayment');
}
