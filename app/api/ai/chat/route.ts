/**
 * POST /api/ai/chat
 *
 * Space-scoped AI chat endpoint — D4 Slice 1 (Backend).
 *
 * ── Request ───────────────────────────────────────────────────────────────────
 * {
 *   spaceId:  string | "master",
 *   messages: [{ role: "user" | "assistant", content: string }]
 * }
 *
 * ── Behaviour ─────────────────────────────────────────────────────────────────
 * Specific Space:
 *   - Verifies the user is OWNER, ADMIN, or MEMBER. Rejects VIEWER with 403.
 *   - Calls buildContext(spaceId, userId, { scopeHint: "full" }).
 *   - Serializes context + signals into a grounded system prompt.
 *   - Calls generateChatReply() from lib/ai/provider.ts.
 *
 * Master ("master"):
 *   - Enumerates all OWNER/ADMIN/MEMBER Spaces (VIEWER excluded).
 *   - Calls buildContext for each via Promise.allSettled.
 *   - Aggregates all contexts into one prompt with per-Space boundaries.
 *   - Calls generateChatReply() with the merged prompt.
 *
 * ── Response ──────────────────────────────────────────────────────────────────
 * { "message": "...", "knowledgeGaps": [...], "knowledgeGapMode": "clarification" | "form" }
 * knowledgeGaps mirrors the KnowledgeGap[] assembled at context time so the
 * client can render structured input cards without parsing the assistant text.
 * knowledgeGapMode signals how the client should render gaps:
 *   "form"          — user explicitly asked to update a field; render full card immediately.
 *   "clarification" — context has gaps; render lightweight clarification card first.
 *
 * ── Not implemented in this slice ────────────────────────────────────────────
 * Streaming, conversation persistence, memory, actions, background jobs.
 *
 * Security notes:
 *   - Permission check is always server-side (db query), never client-asserted.
 *   - The OpenAI SDK is never imported here — all LLM calls go through
 *     lib/ai/provider.ts, the permanent AI provider boundary.
 *   - buildContext() carries its own membership guard (resolveSpaceContext
 *     fallback check) as a second layer of defence.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db }                        from '@/lib/db';
import { requireUser }               from '@/lib/session';
import { limitByUser }               from '@/lib/rate-limit';
import { SpaceMemberRole }           from '@prisma/client';
import { buildContext }              from '@/lib/ai/context-builder';
import { generateChatReply }      from '@/lib/ai/provider';
import type { ChatMessage }        from '@/lib/ai/provider';
import type { SpaceContext_AI, KnowledgeGap, TransactionsSummaryData, AssemblerOptions } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { displaySpaceName }        from '@/lib/format';
import { computeAssessment, computeAverageMonthlySpending, reliableMonths } from '@/lib/ai/intelligence';
import type { FinancialAssessment }  from '@/lib/ai/intelligence';
import { classifyFinancialIntent, serializeRoutingBlock } from '@/lib/ai/intent';
import { detectsPayoffIntent, detectsExplicitUpdateIntent } from '@/lib/ai/intent';
import type { IntentRoute }          from '@/lib/ai/intent';
import { planContextSelection, DEFAULT_CONTEXT_BUDGET_TOKENS } from '@/lib/ai/context-priority';
import { validateOutput } from '@/lib/ai/output-validator';
import { AuditAction }               from '@/lib/audit-actions';
import type { Prisma }               from '@prisma/client';

export const preferredRegion = 'sin1';
export const runtime         = 'nodejs';

// ── Permission constants ─────────────────────────────────────────────────────
// VIEWER is explicitly excluded from AI chat — same rule as the Daily Brief.

const ELIGIBLE_ROLES: SpaceMemberRole[] = [
  SpaceMemberRole.OWNER,
  SpaceMemberRole.ADMIN,
  SpaceMemberRole.MEMBER,
];

// ── Shadow-mode context selection logging (D6.3D-1) ──────────────────────────
//
// Computes a deterministic SelectionPlan for each assembled context and writes
// it to the AuditLog as AI_CONTEXT_SELECTION_PLANNED. This is OBSERVATIONAL
// ONLY: the plan is never consulted when building the system prompt, so prompt
// output is byte-for-byte unchanged. Any failure here is swallowed so shadow
// logging can never affect the chat response.
//
// The existing AI_CONTEXT_ASSEMBLED row is written inside buildContext(), before
// the intent route and assessment exist, so it cannot carry the plan. A separate
// row is the low-risk, additive way to capture it.
async function logShadowSelectionPlans(
  userId:      string,
  contexts:    SpaceContext_AI[],
  assessments: FinancialAssessment[],
  intentRoute: IntentRoute,
): Promise<void> {
  try {
    await Promise.all(
      contexts.map((context, i) => {
        const assessment = assessments[i];
        if (!assessment) return Promise.resolve(null);

        const plan = planContextSelection({
          intentRoute,
          context,
          assessment,
          budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
        });

        return db.auditLog.create({
          data: {
            action:   AuditAction.AI_CONTEXT_SELECTION_PLANNED,
            userId,
            spaceId:  context.spaceId,
            metadata: plan as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
      }),
    );
  } catch (err) {
    // Non-fatal: shadow logging must never break the chat response.
    console.error('[api/ai/chat] shadow selection-plan logging failed (non-fatal):', err);
  }
}

// ── Shadow-mode output validation (AI-4 / KD-2) ──────────────────────────────
//
// Deterministically checks that every numeric claim in the LLM reply reconciles
// to a number present in the grounded system prompt (membership-with-tolerance,
// lib/ai/output-validator.ts). SHADOW ONLY: the reply is already returned to the
// caller unchanged; this writes an AuditLog row ONLY when unreconciled numbers
// exist, so it adds no per-message write amplification (KD-12) and can never
// alter, delay, or fail the response. All errors are swallowed.
async function logOutputValidation(
  userId:       string,
  spaceId:      string,
  reply:        string,
  systemPrompt: string,
  messages:     ChatMessage[],
): Promise<void> {
  try {
    const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content);
    const result = validateOutput(reply, systemPrompt, userMessages);
    if (result.unreconciled.length === 0) return; // clean — write nothing.

    await db.auditLog.create({
      data: {
        action:   AuditAction.AI_OUTPUT_VALIDATION_FLAGGED,
        userId,
        // Master mode has no single Space — spaceId is nullable on AuditLog.
        spaceId:  spaceId === 'master' ? null : spaceId,
        metadata: {
          mode:         spaceId === 'master' ? 'master' : 'space',
          unreconciled: result.unreconciled,
          checkedCount: result.checkedCount,
          sourceCount:  result.sourceCount,
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  } catch (err) {
    // Non-fatal: shadow validation must never break the chat response.
    console.error('[api/ai/chat] shadow output validation failed (non-fatal):', err);
  }
}

// ── System prompt builder ────────────────────────────────────────────────────

/** Returns today's date as a UTC ISO date string (YYYY-MM-DD). Computed per-request. */
function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

// Maps KnowledgeGap.field to a short phrase explaining its calculation impact.
// Used in the serialized gaps section so the AI understands why each field matters
// without needing to infer it from the field name alone.
const GAP_IMPACT: Record<string, string> = {
  apr:            'affects payoff calculations and interest cost',
  minimumPayment: 'affects payoff timeline',
};

// ── Knowledge-gap gating heuristics (KD-11) ───────────────────────────────────
// detectsPayoffIntent / detectsExplicitUpdateIntent, and their keyword arrays,
// now live in lib/ai/intent/gap-intent.ts (relocated verbatim so they are
// importable and covered by characterization tests). They are imported at the
// top of this file and used unchanged in the route handler below.

/**
 * Layer 0 (D4) — classify the most recent user message into an IntentRoute.
 * Pure/deterministic; returns UNKNOWN routing when there is no user turn.
 * The result is injected into the system prompt as the === QUESTION ROUTING ===
 * block; it does not affect context assembly, DB access, or the model call.
 */
function routeForMessages(msgs: ChatMessage[]): IntentRoute {
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
function resolveTransactionWindow(
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
function isAmbiguousBreakdownFollowUp(message: string): boolean {
  const t = message.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length === 0) return false;
  if (namesFinancialSubject(t)) return false; // self-descriptive → not ambiguous
  return looksLikeFollowUp(t);
}

/**
 * True when an earlier user message established a financial topic or window the
 * follow-up could reasonably attach to. Only prior turns (not the latest) count.
 */
function hasPriorFinancialContext(msgs: ChatMessage[], now: Date): boolean {
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
function buildBreakdownClarification(message: string): string {
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

/** Non-spending categories — a drilldown into one of these opts into inflows/
 *  transfers/payments instead of the default spending-only (amount < 0) filter. */
const NON_SPENDING_CATEGORY_SET = new Set(['Income', 'Interest', 'Transfer', 'Payment']);

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
function resolveDrilldown(
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

  const includeNonSpending = category ? NON_SPENDING_CATEGORY_SET.has(category) : false;

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
function filterGapsByIntent(gaps: KnowledgeGap[], includeMinPayment: boolean): KnowledgeGap[] {
  if (includeMinPayment) return gaps;
  return gaps.filter((g) => g.field !== 'minimumPayment');
}

/**
 * Extract knowledge gaps from the assembled accounts domain, if present.
 * Returns an empty array when the accounts domain is absent or has no gaps.
 * Type-narrows via a minimal structural check to avoid importing AccountsSectionData.
 */
function extractKnowledgeGaps(ctx: SpaceContext_AI): KnowledgeGap[] {
  const section = ctx.domains['accounts'];
  if (!section?.data) return [];
  const data = section.data as { knowledgeGaps?: KnowledgeGap[] };
  return Array.isArray(data.knowledgeGaps) ? data.knowledgeGaps : [];
}

/**
 * Serialize a single SpaceContext_AI into a compact text block.
 * Domain data is rendered as compact JSON; signals as a structured list;
 * knowledge gaps as a human-readable list with impact annotations.
 * The prompt explicitly constrains the model to this data only.
 */
function serializeContextBlock(ctx: SpaceContext_AI): string {
  const lines: string[] = [];

  lines.push(`Space: ${displaySpaceName(ctx.space.name)}`);
  lines.push(`Your role: ${ctx.role}`);
  lines.push('');

  // ── Analysis window (D6 provenance) ─────────────────────────────────────────
  // Every aggregate derived from transactions is bounded by this window.
  // Surfaced explicitly so the model states the period, month count, and
  // transaction denominator instead of an unqualified "monthly average", and
  // never answers a longer-period question ("this year", "YTD") using it
  // without saying only this window is available.
  const txn = getTransactionsSummary(ctx);
  if (txn) {
    lines.push(
      'Transaction analysis window (use this exact period whenever presenting any ' +
      'average, total, or cash-flow figure derived from spending, income, or category data):',
    );
    lines.push(`  Period: ${fmtMonthYear(txn.startDate)} – ${fmtMonthYear(txn.endDate)}`);
    lines.push(`  Months analyzed: ~${approxMonths(txn.windowDays)} (${txn.windowDays}-day window)`);
    lines.push(`  Transactions in window: ${txn.transactionCount}`);
    lines.push(
      '  This is the ONLY period for which transaction data exists in this Space. ' +
      'Do not describe it as "this year", "YTD", or any longer span unless the dates match. ' +
      'If the user asks about a longer period, state plainly that only this window is available.',
    );

    // ── Fetch-cap coverage caveat (KD-7) ─────────────────────────────────────
    // When the summary was truncated, the totals/rollups/monthly figures below
    // cover only [coverageStartDate, endDate]. Tell the model the data is
    // incomplete before that date so it never presents truncated historical
    // figures as exact or compares the clipped earliest month like a full one.
    if (txn.truncated) {
      lines.push(
        `  COVERAGE LIMIT (data cap): this Space has more transactions in the requested window ` +
        `than the ${txn.fetchLimit}-row fetch cap allows, so only the most recent ${txn.fetchLimit} ` +
        `were analyzed. Every total, category, merchant, income, and monthly figure below covers ONLY ` +
        `${txn.coverageStartDate} – ${txn.endDate}; data before ${txn.coverageStartDate} is NOT included. ` +
        'Do NOT present these figures as exact or as covering the full requested window, and treat the ' +
        'earliest included month as incomplete. If the user asks about the full period, say plainly ' +
        'that the older portion exceeds the current data limit.',
      );
    }

    // ── Spending aggregates: single source of truth (D6.3 Part B) ────────────
    // Average monthly spending, month-by-month spending, and category averages
    // ALL derive from the same deterministic monthlyBreakdown rows. Averages are
    // taken over COMPLETE calendar months only (partial/clipped/in-progress
    // months are excluded) so a January-through-June average never gets diluted
    // by a partial July. The prior window-normalized estimate (total ÷ windowDays
    // × 30) is gone — it could diverge from the monthly rows and let the model
    // treat the two as separate data sources.
    // Categories that are NOT discretionary spending. Excluded from every
    // "spending" figure (monthly category lines AND category averages) so that
    // per-month category totals always reconcile to that month's expenseTotal
    // and can never exceed it.
    const NON_SPENDING = new Set(['Income', 'Interest', 'Transfer', 'Payment']);

    // KD-7: exclude fetch-cap truncated months from averages, same as partial.
    // KD-10: reliableMonths is the shared predicate the assessment also uses.
    const completeMonths = reliableMonths(txn);
    const completeCount   = completeMonths.length;

    if (completeCount > 0) {
      const firstM = completeMonths[0].month;
      const lastM  = completeMonths[completeCount - 1].month;
      const monthsLabel = firstM === lastM
        ? fmtMonthYear(`${firstM}-01`)
        : `${fmtMonthYear(`${firstM}-01`)} – ${fmtMonthYear(`${lastM}-01`)}`;

      // KD-10: single authoritative value shared with the assessment block.
      // Non-null here because completeCount > 0.
      const avgSpend   = computeAverageMonthlySpending(txn) ?? 0;

      lines.push(
        `  AVERAGE MONTHLY SPENDING (deterministic — total spending across the ${completeCount} ` +
        `complete month(s) ${monthsLabel}, divided by ${completeCount}): ${fmtMoney(avgSpend)}/month. ` +
        'Use this exact figure for "average monthly spending". Do NOT recompute it from a window ' +
        'total, and do NOT include partial months unless the user explicitly asks for a month-to-date figure.',
      );

      // Per-category spending averages over the SAME complete months, summed from
      // each month's byCategory (the same rows the monthly section prints), so
      // category averages reconcile with both the overall average and the monthly
      // rows. Non-spending categories are excluded so nothing is mislabeled as
      // spending. These are AVERAGES — never a substitute for a single month's value.
      const catTotals = new Map<string, number>();
      for (const m of completeMonths) {
        for (const c of m.byCategory) {
          if (NON_SPENDING.has(c.category)) continue;
          catTotals.set(c.category, (catTotals.get(c.category) ?? 0) + c.total);
        }
      }

      const catAverages = Array.from(catTotals.entries())
        .map(([category, total]) => ({
          category,
          total,
          avg: Math.round((total / completeCount) * 100) / 100,
        }))
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 8);

      if (catAverages.length > 0) {
        lines.push(
          `  AVERAGE MONTHLY CATEGORY SPENDING (each category's total across the ${completeCount} ` +
          'complete month(s) ÷ month count — these are AVERAGES, valid ONLY when the user asks for ' +
          'a typical/average month; NEVER use them as any single month\'s value):',
        );
        for (const c of catAverages) {
          lines.push(
            `    ${c.category}: ${fmtMoney(c.avg)}/month ` +
            `(${fmtMoney(Math.round(c.total * 100) / 100)} across ${completeCount} mo)`,
          );
        }
      }
    } else if (txn.byCategory.length > 0) {
      // No complete calendar month in the window: present exact window totals and
      // decline to assert a monthly average rather than fabricate one from a
      // partial window.
      lines.push(
        '  Category totals for this window (exact sums; the window contains no complete calendar ' +
        'month, so no monthly average is asserted — do not divide these by a month count):',
      );
      for (const cat of txn.byCategory.slice(0, 8)) {
        lines.push(`    ${cat.category}: ${fmtMoney(cat.total)} total (${cat.count} txn(s))`);
      }
    }

    // ── Monthly breakdown (D6 deterministic rollups) ─────────────────────────
    // Authoritative per-calendar-month figures. The model must read these for
    // any month-by-month question instead of inferring buckets from window
    // totals or averages (which previously produced inconsistent, invented
    // monthly numbers). Only months inside the requested window appear here.
    if (txn.monthlyBreakdown.length > 0) {
      lines.push('');
      lines.push(
        'MONTHLY SPENDING BY MONTH (deterministic per-calendar-month rollup — these are the ONLY ' +
        'valid month-by-month figures; each line is summed directly from that month\'s transactions). ' +
        'For every month the listed categories are that month\'s OWN spending and always sum to ≤ ' +
        'that month\'s "spending" total:',
      );
      for (const m of txn.monthlyBreakdown) {
        // KD-7: a truncated boundary month had older rows dropped by the fetch
        // cap — mark it incomplete so it is never compared as a full month.
        const flag = m.truncated
          ? ' [INCOMPLETE month — older transactions exceed the data cap; figure understated]'
          : m.partial
            ? ' [PARTIAL month — window does not fully cover it]'
            : '';
        // Per-month category line: SPENDING categories only (income, interest,
        // transfers, debt payments excluded). This guarantees the categories
        // reconcile to — and never exceed — this month's expenseTotal.
        const spendingCats = (m.byCategory ?? []).filter((c) => !NON_SPENDING.has(c.category));
        const catsStr = spendingCats.length > 0
          ? spendingCats.map((c) => `${c.category} ${fmtMoney(c.total)}`).join(', ')
          : '(no categorized spending this month)';
        lines.push(
          `  - ${m.month}${flag}: spending ${fmtMoney(m.expenseTotal)}; categories: ${catsStr}`,
        );
        // Non-spending flows for the same month, bracketed separately so they can
        // never be misread as spending categories.
        lines.push(
          `      [other flows this month — NOT spending: income ${fmtMoney(m.incomeTotal)}, ` +
          `debt payments ${fmtMoney(m.debtPaymentTotal)}, transfers ${fmtMoney(m.transferTotal)}; ` +
          `${m.transactionCount} txn(s)]`,
        );
      }
      lines.push(
        '  Rules for month-by-month questions: use these exact per-month values. For a month-by-month ' +
        'table, each category value MUST come only from that same month\'s "categories:" line. NEVER ' +
        'use an AVERAGE MONTHLY CATEGORY SPENDING value, a window total, or another month\'s value as a ' +
        'monthly value. Do NOT divide a window total by a month count, and do NOT report a month not ' +
        'listed above — it has no data in the requested window. Describe any month flagged PARTIAL as incomplete.',
      );
      lines.push(
        '  Category rule (month-by-month category tables): the "categories:" line for each month is the ' +
        'COMPLETE deterministic list of that month\'s classified spending, and its entries sum to ≤ that ' +
        'month\'s "spending" total. Use ONLY these values. If a category is not listed for a month, it had ' +
        'no matching classified spending that month — leave the cell blank, write "—", or omit the column. ' +
        'NEVER render an unlisted category as $0, and NEVER infer or fill a category figure from an average, ' +
        'another month, or a window total. A single category can never exceed that month\'s spending total.',
      );
    }

    // ── Merchant summary (D6.3A-1 + D6.3 — top SPENDING merchants only) ──────
    // Canonicalized per-merchant SPENDING totals over the same window. Settled
    // expense rows only — income/payroll, transfers, and debt payments are
    // excluded upstream, so this answers "who did I spend the most with" without
    // ever surfacing payroll or a Chase/Amex payment as a merchant.
    if (txn.merchants && txn.merchants.length > 0) {
      lines.push('');
      lines.push(
        'MERCHANT SUMMARY — TOP SPENDING MERCHANTS (settled expenses only in the window above; ' +
        'grouped by canonical merchant name; totals are exact absolute settled spend). ' +
        'Income/payroll, internal transfers, and debt payments are already EXCLUDED here:',
      );
      for (const mrc of txn.merchants.slice(0, 8)) {
        lines.push(
          `  ${mrc.canonicalName}: ${fmtMoney(mrc.total)} across ${mrc.occurrences} txn(s), ` +
          `mostly ${mrc.category}, ${mrc.firstSeen} → ${mrc.lastSeen}`,
        );
      }
      lines.push(
        '  Use these exact totals for "who did I spend the most with / top merchants" questions. ' +
        'These are SPENDING merchants only — never describe an income source, transfer, or debt ' +
        'payment as a spending merchant, and never pull a payroll/employer name into this list.',
      );
    }

    // ── Income sources (D6.3 — inflow rollup, kept separate from merchants) ──
    // Payroll and other inflows live here, NOT in the merchant summary above.
    if (txn.incomeSources && txn.incomeSources.length > 0) {
      lines.push('');
      lines.push(
        'INCOME SOURCES (settled inflows only — Income + Interest — in the window above; grouped ' +
        'by canonical name; totals are exact settled sums). This is a SEPARATE list from spending merchants:',
      );
      for (const src of txn.incomeSources.slice(0, 8)) {
        lines.push(
          `  ${src.canonicalName}: ${fmtMoney(src.total)} across ${src.occurrences} txn(s), ` +
          `${src.firstSeen} → ${src.lastSeen}`,
        );
      }
      lines.push(
        '  Use these for "top income sources / where does my money come from" questions. ' +
        'Do NOT describe these as spending merchants and do NOT include them in spending totals or averages.',
      );
    }

    // ── Transaction drilldown (D6 — evidence for a follow-up; only when present) ─
    // The actual line items behind a resolved category/merchant/period. Attached
    // only for explicit drilldown follow-ups, so it appears here rarely and never
    // on ordinary prompts. Rows are FULL-visibility only.
    if (txn.drilldown && txn.drilldown.transactions.length > 0) {
      const d = txn.drilldown;
      const scope = d.label
        ? d.label
        : d.category ?? d.merchant ?? 'largest transactions';
      lines.push('');
      lines.push(
        `TRANSACTION DRILLDOWN — evidence for "${scope}" (${d.startDate} → ${d.endDate}; actual ` +
        'transactions, FULL-visibility accounts only, sorted by amount, largest first):',
      );
      for (const t of d.transactions) {
        const desc = t.description ? ` — ${t.description}` : '';
        const acct = t.accountName ? ` · ${t.accountName}` : '';
        lines.push(
          `  ${t.date}  ${t.merchant}  ${fmtMoney(t.amount)}  (${t.category})${desc}${acct}`,
        );
      }
      const coverage = d.truncated
        ? `Showing the ${d.shownCount} largest of ${d.totalCount} matching transactions ` +
          `(${d.totalCount - d.shownCount} more not shown).`
        : `Showing all ${d.shownCount} matching transaction(s).`;
      lines.push(
        `  ${coverage} Shown total: ${fmtMoney(d.shownTotal)}. ` +
        `Total for "${scope}" this period: ${fmtMoney(d.matchedTotal)}.`,
      );
      lines.push(
        '  Use these exact rows to explain what the category/merchant is made up of. They are the ' +
        'evidence behind the aggregate — do NOT invent transactions beyond this list, and if rows ' +
        'were omitted by the cap, say so rather than implying the list is exhaustive.',
      );
    }

    lines.push('');
  }

  // ── Domains ───────────────────────────────────────────────────────────────
  const domainKeys = Object.keys(ctx.domains);
  if (domainKeys.length > 0) {
    lines.push('Financial context:');
    for (const key of domainKeys) {
      const section = ctx.domains[key];
      if (section?.data) {
        lines.push(`  [${key}]`);
        lines.push(`  ${JSON.stringify(section.data)}`);
      }
    }
  } else {
    lines.push('Financial context: none assembled for this Space.');
  }

  lines.push('');

  // ── Signals ───────────────────────────────────────────────────────────────
  if (ctx.signals.length > 0) {
    lines.push('Active signals:');
    for (const sig of ctx.signals) {
      const detail = sig.body ? ` — ${sig.body}` : '';
      lines.push(`  [${sig.severity.toUpperCase()}] ${sig.title}${detail}`);
    }
  } else {
    lines.push('Active signals: none.');
  }

  // ── Knowledge gaps ────────────────────────────────────────────────────────
  // Surfaced as a human-readable list so the AI can reference them by account
  // name and field label without parsing the raw accounts JSON blob.
  // Only populated for FULL-visibility debt accounts (enforced by the assembler).
  const gaps = extractKnowledgeGaps(ctx);
  if (gaps.length > 0) {
    lines.push('');
    lines.push('Knowledge gaps (missing verified metadata — do not invent these values):');
    for (const gap of gaps) {
      const impact = GAP_IMPACT[gap.field] ?? 'affects related calculations';
      lines.push(`  [${gap.accountName}] ${gap.label} not set — ${impact}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the full system prompt for a single-Space chat session.
 */

// ── Advisor reasoning principles ──────────────────────────────────────────────
// Establishes the reasoning mode before any formatting rules.
// Injected into every system prompt.

const ADVISOR_PRINCIPLES = [
  'Reasoning approach — think like a financial advisor, not a reporting tool:',
  '- Synthesize first. Open with a 1–2 sentence overall assessment or conclusion, then support it with data.',
  '- Lead with what matters most: the biggest risk, the clearest opportunity, or the most urgent observation.',
  '- Explain causal relationships when they exist. If high debt payments drove negative cash flow, say so directly. Do not list the components in isolation.',
  '- Identify the likely cause of a notable pattern when the data supports it.',
  '- Give a concrete recommendation when one is clearly supported by the data.',
  '- Reference only the numbers that substantiate your reasoning. Never enumerate every metric in context.',
  '- When a signal is high-severity or the magnitude is large, prioritize it in your response.',
  '- Be direct. Hedge only when the data is genuinely ambiguous.',
  '',
  'Temporal doctrine — current state vs. history:',
  '- When the user asks about their current position (debt situation, net worth, balances, liquidity, goals progress): lead with current values from the accounts and goals domains. Transaction summaries are supporting evidence, not the primary answer.',
  '- Never open a current-state answer primarily with 30- or 90-day aggregates. Historical data belongs after the current-state assessment, or when the user explicitly asks about history.',
  '- Switch to history-first framing only when the user uses past-tense language or references a time period ("last month", "over 90 days", "historically", "what did I spend").',
  '',
  'Debt payment doctrine:',
  '- The debtPaymentTotal field represents intentional debt reduction, not a consumption expense. It is capital directed toward a financial goal.',
  '- When cash flow is negative and debt payments are a primary driver: say so plainly. Cross-reference any debt-reduction goals to confirm it is the user\'s strategy, not a problem.',
  '- Do not label high debt payments as overspending. Only flag a spending problem when expenses excluding debt payments are themselves high relative to income.',
  '',
  'Financial Assessment doctrine:',
  '- The === FINANCIAL ASSESSMENT === block above the space context contains deterministic pre-computed findings. Read it before drawing any conclusions from the raw context data.',
  '- When incomeConfidence is LOW or cashFlowReliability is UNRELIABLE: do not state that expenses exceed income, do not declare cash flow negative as a fact, and do not project deficit timelines from the income figure. Instead, note that transaction history appears incomplete and suggest the user connect all income accounts.',
  '- Account balances, debt balances, and liquid cash totals are always reliable regardless of income confidence — use them confidently even when DATA_QUALITY is the current priority.',
  '- Lead with the currentStatePriority topic when the user asks an open-ended financial question.',
].join('\n');

// ── Executive-summary doctrine (D4 prompt polish) ─────────────────────────────
// Behaviour-only guidance injected after ADVISOR_PRINCIPLES. Covers:
//   POLISH 2 — executive priority (lead with the highest-priority conclusion).
//   POLISH 5 — avoid repeating the same caveat multiple times in one answer.
//   POLISH 6 — answer-first ordering (answer → evidence → caveats → next step).
// No data is added and no calculation changes; this only shapes response form.

const EXECUTIVE_SUMMARY_DOCTRINE = [
  'Executive priority (how to open every answer):',
  '- Answer the user\'s actual question in the first sentence. Do not lead with caveats, disclaimers, or a list of missing data.',
  '- Then state the single highest-priority conclusion — the biggest risk, the clearest opportunity, or the most urgent item — before the supporting detail. Prefer a conclusion over a raw fact.',
  '  Example: instead of "Your debt is $12,400", open with "Your biggest priority right now is improving liquidity — here\'s why," then give the numbers.',
  '- Use the RISK & OPPORTUNITY section as the source of that lead conclusion whenever it is populated. Do not restate every assessment section to get there.',
  '',
  'Answer ordering (POLISH 6): answer first, then supporting evidence, then any caveats, then a single concrete next recommendation — in that order.',
  '',
  'Do not repeat yourself (POLISH 5):',
  '- Mention a caveat such as "critical liquidity", "missing APR", or "income data is incomplete" at most ONCE per response. State it, then keep reasoning — never re-raise the same caveat in multiple paragraphs.',
  '- Follow the QUESTION ROUTING block\'s data-gap emphasis: only foreground a missing field when it materially affects THIS question.',
].join('\n');

// ── Explainability & provenance doctrine (D6) ─────────────────────────────────
// Behaviour-only guidance. Governs how the model attributes numbers to their
// source period, states data completeness, distinguishes exact vs estimated
// values, and avoids contradictory time windows. Adds no data and changes no
// calculation — it shapes how existing figures are explained.

const EXPLAINABILITY_DOCTRINE = [
  'Explainability & provenance — always show where a number came from:',
  '',
  '1. Time window on every aggregate. When you present average spending, average income, average debt payment, average category spend, average monthly savings, or cash flow, always name the analysis period and how many months it covers. Use the "Transaction analysis window" period from the space context verbatim. Never say only "monthly average" or "per month" without the period behind it. Example: "Average monthly spending, Jan 2026 – Apr 2026 (3 months): $8,894/month."',
  '',
  '2. State completeness. When it matters to the answer, add one concise completeness statement drawn from the DATA QUALITY block — e.g. "Based on complete transaction history for this window" when completeness is HIGH, or "Based on partial transaction history" when it is LOW or MEDIUM. Never invent a completeness level; use only what the assessment reports.',
  '',
  '3. Distinguish exact vs estimated vs average — and keep the wording consistent:',
  '   - Exact: a figure summed directly from settled transactions or a current balance. Say "You paid $30,829 toward debt."',
  '   - Estimated: a figure inferred or projected (implied income, projected monthly expense). Say "Estimated monthly income…". Estimated figures are the impliedMonthlyIncome / estimated* fields in the assessment.',
  '   - Average: a total divided across the window. Say "Average monthly dining spend…".',
  '   Do not mix these terms — never call an estimate "exact", and never present an average as though it were a single observed value.',
  '',
  '4. Explain the calculation. For any average or derived value, briefly state the denominator using metadata already in context: "Calculated across ~3 months", "Based on 412 transactions", or "Averaged over the 90-day window". Do not run new queries to obtain this — use the window and counts already provided.',
  '',
  '5. Historical questions ("this year", "last year", "last 6 months", "YTD", "since January"). If the analysis window covers the period asked about, answer directly. If it does not, answer with the data you have but clearly explain the window is shorter — e.g. "I only have the last 90 days of transactions, not the full year, so this covers Jan–Apr 2026." Never silently answer a different period than the one asked.',
  '',
  '6. Never present contradictory windows. Do not answer a "this year" question using a 90-day figure without explicitly saying only 90 days are available. Conversely, do not claim only 90 days exist if the window shown is longer. Always describe the actual coverage from the analysis-window block.',
  '',
  '7. Recommendation transparency. When you make a recommendation, state the driving evidence in the same sentence. Prefer "Build liquidity first — your cash covers only 0.5 months of expenses" over a bare "Build liquidity." Draw the evidence from the RISK & OPPORTUNITY, LIQUIDITY, or DEBT blocks.',
].join('\n');

// ── Shared response-style rules ───────────────────────────────────────────────
// Covers formatting and presentation. Injected after ADVISOR_PRINCIPLES.

const RESPONSE_STYLE = [
  'Response style:',
  '- Short paragraphs. Use a compact bullet list only when comparing 3+ items or when the user explicitly asks for a list.',
  '- Never expose internal field names, type codes, or category labels.',
  '- Do not enumerate every field in the context.',
  '',
  'Formatting:',
  '- Responses are rendered as Markdown. Use formatting where it improves clarity.',
  '- Produce a Markdown table when the user explicitly requests a table, comparison, schedule, breakdown, matrix, checklist, or plan.',
  '- When a calculation requires a field listed in Knowledge Gaps, provide the best answer with available data, explain what the gap prevents, and ask for the missing value. Do not refuse the calculation.',
  '- For general questions, prose is preferred over tables.',
].join('\n');

// ── Knowledge Gaps rules ──────────────────────────────────────────────────────
// Injected into every system prompt alongside RESPONSE_STYLE.
// Explains gap semantics and governs how the AI handles user-supplied values.

const KNOWLEDGE_GAPS_RULES = [
  'Knowledge Gaps rules:',
  '- Gaps list fields the user has not yet entered in Fourth Meridian. They are authoritative — the value is genuinely unknown.',
  '- Never invent, estimate, or assume a gap value. If you use an industry assumption, say so explicitly and label the result approximate.',
  '- When a gap field is needed: explain what is missing and why it matters, deliver the best answer with available data, and ask for the value naturally.',
  '- APR is the most important missing field for debt analysis. Mention it when relevant to interest cost, capital allocation, or debt strategy.',
  '- Minimum payment is only relevant for payoff schedule or timeline questions. Do not ask for minimum payment in general advisory conversations.',
  '- If the user provides a gap value during this conversation: confirm you are using it, and explicitly state it has NOT been saved. Example: "I\'ll use 24.99% for this conversation — this isn\'t saved yet, so tell Fourth Meridian when you\'re ready."',
  '- Never claim to save, remember, or persist a user-supplied value across sessions.',
  '- When a user wants to save or update a value such as APR, minimum payment, due day, or statement close day: tell them the form below this message saves it directly to their account. Their next message will automatically use the updated value.',
  '- You do not write data directly. Directing the user to the save form is a supported action — it is not a data modification by you.',
].join('\n');

/**
 * Alias guidance for a single-Space session.
 * Tells the AI that informal terms like "personal", "my finances", "dashboard"
 * refer to the named space, so the user is never required to use the exact name.
 */
function buildSpaceAliasGuidance(spaceName: string): string {
  return (
    `Space alias guidance: The user may refer to this space as "${spaceName}", ` +
    'or by informal terms such as "personal", "personal space", "home", "dashboard", ' +
    '"my finances", "my money", or similar. Interpret these as references to the ' +
    'current space unless context clearly indicates otherwise.'
  );
}

// ── Financial Assessment serialization ────────────────────────────────────────

/** Format a number as a USD money string (e.g. $4,320.00). */
function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Explainability & provenance helpers (D6 polish) ───────────────────────────
// Presentation-only. These derive human-readable provenance strings from
// metadata the assemblers already produce (windowDays, startDate, endDate,
// transactionCount, per-category totals). They introduce no new queries and
// change no financial calculation.

/** Format a YYYY-MM-DD date string as "Mon YYYY" (e.g. "2026-01-15" → "Jan 2026"). */
function fmtMonthYear(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Approximate whole months covered by a day span (minimum 1). */
function approxMonths(windowDays: number): number {
  return Math.max(1, Math.round(windowDays / 30));
}

/** Read the transactions_summary domain data from a context, or null if absent. */
function getTransactionsSummary(ctx: SpaceContext_AI): TransactionsSummaryData | null {
  const section = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  if (!section?.data) return null;
  return section.data as TransactionsSummaryData;
}

/**
 * Human-readable provenance descriptor for the transaction analysis window.
 * Uses only existing assembler metadata — no new queries, no new calculation.
 *   e.g. "Jan 2026 – Apr 2026 (~3 months; 90-day window), 412 transaction(s)"
 * Returns null when the transactions domain is absent (no window to describe).
 */
function analysisWindowNote(ctx: SpaceContext_AI): string | null {
  const txn = getTransactionsSummary(ctx);
  if (!txn) return null;
  const period = `${fmtMonthYear(txn.startDate)} – ${fmtMonthYear(txn.endDate)}`;
  const months = approxMonths(txn.windowDays);
  return (
    `${period} (~${months} month${months === 1 ? '' : 's'}; ${txn.windowDays}-day window), ` +
    `${txn.transactionCount} transaction(s)`
  );
}

/** Return a one-sentence LLM instruction based on the current priority. */
function priorityGuidance(assessment: FinancialAssessment): string {
  switch (assessment.currentStatePriority) {
    case 'DATA_QUALITY':
      return 'Note that transaction history is partial. Describe balances, liquidity, and debt figures confidently. Do not make income or cash flow statements.';
    case 'LIQUIDITY':
      return assessment.liquidity.classification === 'CRITICAL'
        ? 'Liquidity is critically low — lead with the coverage gap and near-term implications.'
        : 'Lead with the liquidity position and what it means for the user\'s financial flexibility.';
    case 'DEBT':
      return assessment.debt.classification === 'CRITICAL'
        ? 'High-APR debt is urgent — lead with the monthly interest cost and recommended payoff priority.'
        : 'High-APR debt is the most actionable item — discuss the interest burden and payoff options.';
    case 'CASH_FLOW':
      return (
        assessment.cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF' ||
        assessment.cashFlow.deficitCause === 'MIXED'
      )
        ? 'Affirm the intentional debt payoff strategy. Note any liquidity constraint if coverage is below 3 months.'
        : 'Spending may be exceeding income — identify the specific expense categories driving the gap.';
    case 'GOALS':
      return 'A goal may need attention — discuss its status and recommend the next action.';
    case 'GOALS_GOOD':
      return 'Financial position looks healthy — affirm progress and highlight the next milestone.';
    default:
      return 'Provide an overall financial assessment.';
  }
}

/**
 * Serialize a FinancialAssessment into the === FINANCIAL ASSESSMENT === prompt block.
 *
 * v2 structure (order is deliberate):
 *   1.  INTERPRETED STATE       — priority + leading instruction, so LLM reads intent first.
 *   2.  DATA QUALITY            — completeness + confidence before any numbers.
 *   3.  CASH FLOW               — confidence + warnings before deficit framing.
 *   4.  DEBT                    — confidence + balances + APR state.
 *   5.  LIQUIDITY               — confidence + coverage + space-scope warning.
 *   6.  CAPITAL ALLOCATION      — 2.1: allocation context + evidence + primary/ignored domains.
 *   7.  DEBT STRATEGY           — 2.2: avalanche/snowball candidates + urgency.
 *   8.  SPENDING OPPORTUNITIES  — 2.3: category breakdown + discretionary total (conditional).
 *   8B. SPENDING TRENDS        — 2.3B: deterministic MoM / rolling trends (conditional).
 *   9.  GOAL ALIGNMENT          — 2.4: per-goal alignment status (conditional).
 *   10. INVESTMENT READINESS    — 2.5: readiness context (conditional).
 *   11. RISK & OPPORTUNITY      — 2.6: top-3 aggregated risks + opportunities (conditional).
 *   12. ADVISOR FLAGS           — typed heuristics for calibration.
 *   13. PRIORITIES              — ranked deterministic hints (not recommendations).
 */
function serializeAssessmentBlock(assessment: FinancialAssessment, windowNote?: string | null): string {
  const {
    dataQuality, cashFlow, debt, liquidity,
    capitalAllocation, debtStrategy,
    spendingOpportunities, spendingTrends, goalAlignment, investmentReadiness,
    riskOpportunities,
  } = assessment;
  const lines: string[] = [];

  // ── 1. Interpreted state ──────────────────────────────────────────────────
  lines.push(`INTERPRETED STATE: ${assessment.currentStatePriority}`);
  lines.push(`  ${priorityGuidance(assessment)}`);
  lines.push('');

  // ── 2. Data quality ───────────────────────────────────────────────────────
  lines.push('DATA QUALITY');
  if (windowNote) {
    // Provenance (D6): the period + denominators every derived figure is bounded by.
    lines.push(`  Analysis period: ${windowNote}`);
  }
  lines.push(
    `  Transaction completeness: ${dataQuality.transactionHistoryCompleteness}` +
    ` (${dataQuality.snapshotSpanDays}-day history in 90-day window;` +
    ` ${dataQuality.incomeTransactionCount} income transaction(s) captured)`,
  );
  lines.push(
    dataQuality.transactionHistoryCompleteness === 'HIGH'
      ? '  → Completeness is HIGH: you may say "based on complete transaction history for this window".'
      : '  → Completeness is not HIGH: say "based on partial transaction history" when presenting derived figures.',
  );
  lines.push(`  Income confidence: ${dataQuality.incomeConfidence}`);

  if (dataQuality.incomeConfidence === 'LOW') {
    lines.push('  ⚠ Income data is incomplete. Do not state cash flow is negative or income is insufficient as fact.');
    lines.push('    Account balances, debt balances, and liquid cash are always reliable — use them confidently.');
    lines.push('    Suggest the user connect all income accounts for a complete picture.');
  }

  lines.push('');

  // ── 3. Cash flow ──────────────────────────────────────────────────────────
  lines.push(`CASH FLOW  [confidence: ${cashFlow.confidence}]`);
  lines.push(`  Reliability: ${cashFlow.reliability}`);
  lines.push(`  Deficit cause: ${cashFlow.deficitCause}`);

  if (cashFlow.incompleteIncomeWarning) {
    lines.push('  ⚠ Do not treat apparent deficit as fact — income history is incomplete.');
  } else if (cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF') {
    lines.push('  → Negative cash flow is intentional debt-reduction strategy — active debt goal confirms this.');
  } else if (cashFlow.deficitCause === 'MIXED') {
    lines.push('  → Deficit has both intentional debt payments and non-debt spending above income.');
  }

  if (cashFlow.impliedMonthlyIncome !== null) {
    const qualifier = dataQuality.incomeConfidence === 'LOW' ? ' (likely understated — partial data)' : '';
    lines.push(`  Implied monthly income: ${fmtMoney(cashFlow.impliedMonthlyIncome)}/mo${qualifier}`);
  }
  if (cashFlow.estimatedMonthlyExpenses !== null) {
    lines.push(`  Est. monthly expenses: ${fmtMoney(cashFlow.estimatedMonthlyExpenses)}/mo`);
  }
  if (cashFlow.estimatedMonthlyDebtPayments !== null) {
    lines.push(`  Est. monthly debt payments: ${fmtMoney(cashFlow.estimatedMonthlyDebtPayments)}/mo`);
  }

  lines.push('');

  // ── 4. Debt ───────────────────────────────────────────────────────────────
  lines.push(`DEBT  [confidence: ${debt.confidence}]`);
  lines.push(`  Classification: ${debt.classification}`);
  lines.push(`  Total liabilities: ${fmtMoney(debt.totalLiabilities)}`);

  if (debt.classification === 'INSUFFICIENT_DATA') {
    lines.push(`  APR completeness: ${debt.aprCompleteness}`);
    if (debt.aprGapAccountNames.length > 0) {
      lines.push(
        `  APR not entered for: ${debt.aprGapAccountNames.join(', ')} — ` +
        'enter in Fourth Meridian to enable full interest analysis.',
      );
    }
    if (debt.hasBalanceOnlyDebt) {
      lines.push(
        '  Some debt accounts are at balance-only visibility — APR is not accessible ' +
        'in this Space (structural limitation, not missing user input).',
      );
    }
  }

  if (debt.monthlyInterestBurden !== null) {
    const partial = debt.hasNullAPR ? ' (partial — APR missing for some accounts)' : '';
    lines.push(`  Monthly interest burden: ${fmtMoney(debt.monthlyInterestBurden)}/mo${partial}`);
  } else if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    lines.push('  Monthly interest burden: cannot be computed — APR missing.');
  }

  lines.push('');

  // ── 5. Liquidity ──────────────────────────────────────────────────────────
  lines.push(`LIQUIDITY  [confidence: ${liquidity.confidence}]`);

  if (!liquidity.hasAccountsDomain) {
    lines.push('  No accounts are linked to this Space — balance data is unavailable.');
  } else {
    lines.push(`  Liquid cash: ${fmtMoney(liquidity.liquidCashTotal)} (${liquidity.liquidAccountCount} account(s))`);

    if (liquidity.noLiquidAccountsInSpace) {
      lines.push(
        '  ⚠ No checking or savings accounts are linked to this Space.' +
        ' Liquid balances may exist in other Spaces. Do not say the user has no liquid cash.',
      );
    }

    if (liquidity.estimatedMonthlyExpense !== null) {
      const partial = dataQuality.snapshotSpanDays < SNAPSHOT_HIGH_THRESHOLD_NOTE
        ? ' (from partial expense data)'
        : '';
      lines.push(`  Est. monthly expenses: ${fmtMoney(liquidity.estimatedMonthlyExpense)}/mo${partial}`);
    }

    if (liquidity.coverageMonths !== null) {
      lines.push(`  Coverage: ${liquidity.coverageMonths.toFixed(1)} months → ${liquidity.classification}`);
    } else {
      lines.push(`  Coverage: ${liquidity.classification}`);
    }
  }

  lines.push('');

  // ── 6. Capital Allocation (2.1) ───────────────────────────────────────────
  lines.push(`CAPITAL ALLOCATION  [confidence: ${capitalAllocation.confidence}]`);
  lines.push(`  Context: ${capitalAllocation.recommendation}`);

  if (capitalAllocation.primaryEvidence.length > 0) {
    lines.push(`  Driven by: ${capitalAllocation.primaryEvidence.join(', ')}`);
  }
  if (capitalAllocation.ignoredEvidence.length > 0) {
    lines.push(
      `  Note: ${capitalAllocation.ignoredEvidence.join(', ')} is NOT primary to this recommendation` +
      (capitalAllocation.ignoredEvidence.includes('cashFlow')
        ? ' — recommendation holds even if income data is incomplete'
        : ''),
    );
  }

  const ev = capitalAllocation.evidence;
  if (ev.weightedDebtApr !== null) {
    lines.push(`  Weighted debt APR: ${ev.weightedDebtApr.toFixed(2)}% vs ${MARKET_RETURN_THRESHOLD_NOTE}% market reference`);
    if (ev.guaranteedReturnAdvantage !== null) {
      if (ev.guaranteedReturnAdvantage > 0) {
        lines.push(
          `  Paying down debt ≈ earning a guaranteed ${ev.weightedDebtApr.toFixed(2)}% return` +
          ` (${ev.guaranteedReturnAdvantage.toFixed(2)}% above ${MARKET_RETURN_THRESHOLD_NOTE}% market reference)`,
        );
      } else {
        lines.push(
          `  Debt APR (${ev.weightedDebtApr.toFixed(2)}%) is below the ${MARKET_RETURN_THRESHOLD_NOTE}% market reference — investing return context may apply`,
        );
      }
    }
  }
  if (ev.monthlyInterestBurden !== null) {
    lines.push(`  Monthly interest cost of carrying debt: ${fmtMoney(ev.monthlyInterestBurden)}/mo`);
  }
  if (ev.liquidityMonths !== null) {
    lines.push(`  Liquid coverage: ${ev.liquidityMonths.toFixed(1)} months`);
  }
  if (capitalAllocation.missingAprPreventsComparison) {
    lines.push(`  ⚠ APR completeness: ${ev.aprCompleteness} — debt vs. investing comparison blocked`);
  }
  if (capitalAllocation.blockers.length > 0) {
    lines.push(`  Blockers: ${capitalAllocation.blockers.join('; ')}`);
  }

  lines.push('');

  // ── 7. Debt Strategy (2.2) ────────────────────────────────────────────────
  if (debt.totalLiabilities > 0) {
    lines.push(`DEBT STRATEGY  [confidence: ${debtStrategy.confidence}]`);
    lines.push(`  Payoff urgency: ${debtStrategy.payoffUrgency}`);

    if (debtStrategy.weightedAvgApr !== null) {
      lines.push(`  Weighted avg APR: ${debtStrategy.weightedAvgApr.toFixed(2)}%`);
    }
    if (debtStrategy.avalancheCandidate) {
      const c = debtStrategy.avalancheCandidate;
      lines.push(
        `  Avalanche target: ${c.accountName}` +
        ` (${c.apr!.toFixed(2)}% APR, ${fmtMoney(c.balance)} balance)`,
      );
    }
    if (debtStrategy.snowballCandidate) {
      const c   = debtStrategy.snowballCandidate;
      const apr = c.apr != null ? `, ${c.apr.toFixed(2)}% APR` : ', APR unknown';
      lines.push(`  Snowball target: ${c.accountName} (${fmtMoney(c.balance)} balance${apr})`);
    }
    if (debtStrategy.missingAprAccountNames.length > 0) {
      lines.push(`  APR missing for: ${debtStrategy.missingAprAccountNames.join(', ')}`);
    }
    if (debtStrategy.hasBalanceOnlyDebt) {
      lines.push('  Some debt accounts are balance-only — APR structurally inaccessible in this Space.');
    }
    if (!debtStrategy.avalancheCandidate && !debtStrategy.snowballCandidate) {
      lines.push('  No debt account detail available in this Space.');
    }

    lines.push('');
  }

  // ── 8. Spending Opportunities (2.3) ──────────────────────────────────────
  if (spendingOpportunities.hasTransactionData && spendingOpportunities.topCategories.length > 0) {
    lines.push(`SPENDING OPPORTUNITIES  [confidence: ${spendingOpportunities.confidence}]`);

    if (spendingOpportunities.topReductionOpportunity) {
      const top = spendingOpportunities.topReductionOpportunity;
      lines.push(`  Top reduction opportunity: ${top.category} (${fmtMoney(top.monthlyEquivalent)}/mo, ${top.transactionCount} txn(s))`);
    }
    lines.push(`  Total discretionary spend: ${fmtMoney(spendingOpportunities.discretionaryTotal)}/mo`);

    const displayCats = spendingOpportunities.topCategories.slice(0, 6);
    if (displayCats.length > 0) {
      lines.push('  By category:');
      for (const cat of displayCats) {
        lines.push(`    ${cat.category}: ${fmtMoney(cat.monthlyEquivalent)}/mo [${cat.classification}]`);
      }
    }

    if (spendingOpportunities.categoriesNeedingReview.length > 0) {
      lines.push(`  Review needed: ${spendingOpportunities.categoriesNeedingReview.join(', ')}`);
    }
    lines.push('');
  }

  // ── 8B. Spending Trends (2.3B) ────────────────────────────────────────────
  // Deterministic month-over-month / rolling trends computed from COMPLETE
  // months only (partial months are excluded upstream). Facts only — the LLM
  // must not infer a trend where the direction is INSUFFICIENT_DATA.
  if (
    spendingTrends.completeMonthsAnalyzed > 0 ||
    spendingTrends.partialMonthsExcluded.length > 0
  ) {
    lines.push(`SPENDING TRENDS  [confidence: ${spendingTrends.confidence}]`);
    lines.push(
      `  Complete months analyzed: ${spendingTrends.completeMonthsAnalyzed}` +
      (spendingTrends.partialMonthsExcluded.length > 0
        ? ` (excluded partial month(s): ${spendingTrends.partialMonthsExcluded.join(', ')})`
        : ''),
    );

    for (const t of spendingTrends.metricTrends) {
      const label = t.metric.charAt(0).toUpperCase() + t.metric.slice(1);

      if (t.direction === 'INSUFFICIENT_DATA') {
        lines.push(
          `  ${label} [INSUFFICIENT_DATA]: fewer than 2 complete months — do not infer or state a trend.`,
        );
        continue;
      }

      const abs =
        t.momDeltaAbs !== null
          ? `${t.momDeltaAbs > 0 ? '+' : t.momDeltaAbs < 0 ? '−' : ''}${fmtMoney(Math.abs(t.momDeltaAbs))}`
          : 'n/a';
      const pct =
        t.momDeltaPct !== null
          ? ` (${t.momDeltaPct > 0 ? '+' : ''}${t.momDeltaPct.toFixed(1)}%)`
          : '';
      const roll =
        t.rolling3moAvg !== null
          ? `; 3-mo avg ${fmtMoney(t.rolling3moAvg)}`
          : '; 3-mo avg n/a (needs 3 complete months)';

      lines.push(
        `  ${label} [${t.direction}]: ${t.latestCompleteMonth} vs ${t.previousCompleteMonth} ${abs}${pct}${roll}`,
      );
    }

    lines.push(
      '  Use only these deterministic figures. Where a metric is INSUFFICIENT_DATA, do NOT ' +
      'infer, estimate, or narrate a trend for it. Partial / in-progress months are excluded ' +
      'and must never be compared against complete months.',
    );
    lines.push('');
  }

  // ── 9. Goal Alignment (2.4) ───────────────────────────────────────────────
  if (goalAlignment.hasGoalsDomain && goalAlignment.activeGoalCount > 0) {
    lines.push(`GOAL ALIGNMENT  [confidence: ${goalAlignment.confidence}]`);
    lines.push(
      `  Overall: ${goalAlignment.overallStatus}` +
      ` (${goalAlignment.alignedCount} aligned, ${goalAlignment.misalignedCount} misaligned,` +
      ` ${goalAlignment.blockedCount} insufficient data)`,
    );
    for (const g of goalAlignment.goalAlignments) {
      lines.push(`  ${g.goalName} [${g.goalType}]: ${g.status} — ${g.evidence}`);
      if (g.blocker) lines.push(`    ↳ Needs: ${g.blocker}`);
    }
    lines.push('');
  }

  // ── 10. Investment Readiness (2.5) ────────────────────────────────────────
  lines.push(`INVESTMENT READINESS  [confidence: ${investmentReadiness.confidence}]`);
  lines.push(`  Classification: ${investmentReadiness.classification}`);
  if (investmentReadiness.debtBeatsMarket !== null) {
    lines.push(
      `  Debt APR exceeds ${MARKET_RETURN_THRESHOLD_NOTE}% market reference: ` +
      (investmentReadiness.debtBeatsMarket ? 'YES' : 'NO'),
    );
  }
  if (!investmentReadiness.holdingsDomainPresent) {
    lines.push('  No holdings data in this Space context — existing investments not visible here.');
  }
  if (investmentReadiness.blockers.length > 0) {
    lines.push(`  Blockers: ${investmentReadiness.blockers.join('; ')}`);
  }
  lines.push('');

  // ── 11. Risk & Opportunity (2.6) ──────────────────────────────────────────
  // Aggregated candidates only — top 3 of each to avoid bloating context.
  // These are inputs for the LLM to reason from, not final recommendations.
  if (riskOpportunities.risks.length > 0 || riskOpportunities.opportunities.length > 0) {
    lines.push(`RISK & OPPORTUNITY  [confidence: ${riskOpportunities.confidence}]`);

    if (riskOpportunities.risks.length > 0) {
      lines.push('  Top risks:');
      riskOpportunities.risks.slice(0, 3).forEach((r, i) => {
        lines.push(
          `    ${i + 1}. [${r.severity.toUpperCase()}] ${r.code} (confidence: ${r.confidence})` +
          ` — ${r.evidence} [${r.affectedSections.join(', ')}]`,
        );
      });
    }

    if (riskOpportunities.opportunities.length > 0) {
      lines.push('  Top opportunities:');
      riskOpportunities.opportunities.slice(0, 3).forEach((o, i) => {
        lines.push(
          `    ${i + 1}. [${o.impact.toUpperCase()}] ${o.code} (confidence: ${o.confidence})` +
          ` — ${o.evidence} [${o.affectedSections.join(', ')}]`,
        );
      });
    }

    lines.push('');
  }

  // ── 12. Advisor flags ──────────────────────────────────────────────────────
  if (assessment.advisorHeuristics.length > 0) {
    lines.push('ADVISOR FLAGS (deterministic — calibrate advice accordingly)');
    for (const flag of assessment.advisorHeuristics) {
      lines.push(`  • ${flag}`);
    }
    lines.push('');
  }

  // ── 13. Priorities ────────────────────────────────────────────────────────
  if (assessment.priorities.length > 0) {
    lines.push('PRIORITIES (ranked hints — not recommendations; LLM decides how to apply)');
    assessment.priorities.forEach((p, i) => {
      lines.push(`  ${i + 1}. [${p.severity.toUpperCase()}] ${p.code}: ${p.reason}`);
    });
  }

  return lines.join('\n');
}

// Thresholds used in the assessment serialization block.
// Mirror named constants from annotations.ts — defined here to avoid importing
// module-private constants for a formatting-only concern.
const SNAPSHOT_HIGH_THRESHOLD_NOTE  = 45;
/** Passive-index annual return reference (%) — mirrors MARKET_RETURN_THRESHOLD in annotations.ts. */
const MARKET_RETURN_THRESHOLD_NOTE  = 7;

function buildSpaceSystemPrompt(
  ctx: SpaceContext_AI,
  annotations: FinancialAssessment,
  route: IntentRoute,
): string {
  return [
    'You are a skilled, direct financial advisor powered by Fourth Meridian.',
    'You advise on the space described below.',
    `Today's date: ${todayDateString()}.`,
    'Answer using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient, explain what is missing and why.',
    'Do not claim to execute trades, rebalance portfolios, or modify accounts or transaction records.',
    'Saving debt metadata (APR, minimum payment, due day, statement close day) is a supported user action via the form below your message — direct users there when they want to save those values.',
    '',
    ADVISOR_PRINCIPLES,
    '',
    RESPONSE_STYLE,
    '',
    KNOWLEDGE_GAPS_RULES,
    '',
    buildSpaceAliasGuidance(displaySpaceName(ctx.space.name)),
    '',
    EXECUTIVE_SUMMARY_DOCTRINE,
    '',
    EXPLAINABILITY_DOCTRINE,
    '',
    '=== QUESTION ROUTING ===',
    serializeRoutingBlock(route),
    '=== END ROUTING ===',
    '',
    '=== FINANCIAL ASSESSMENT ===',
    serializeAssessmentBlock(annotations, analysisWindowNote(ctx)),
    '=== END ASSESSMENT ===',
    '',
    '=== SPACE CONTEXT ===',
    serializeContextBlock(ctx),
    '=== END CONTEXT ===',
  ].join('\n');
}

/**
 * Alias guidance for master (cross-Space) sessions.
 * Lists all space names and instructs the AI to map informal references
 * to the most likely space without requiring exact name matches.
 */
function buildMasterAliasGuidance(contexts: SpaceContext_AI[]): string {
  const names = contexts
    .map((ctx) => `"${displaySpaceName(ctx.space.name)}"`)
    .join(', ');
  return (
    `Space alias guidance: The user has access to these spaces: ${names}. ` +
    'Informal terms like "personal", "personal space", "home", "dashboard", ' +
    '"my finances", or "my money" typically refer to a personal or primary space. ' +
    'When the user\'s intent is ambiguous across spaces, use the most relevant ' +
    'space\'s data or ask which space they mean.'
  );
}

/**
 * Build the full system prompt for master (cross-Space) chat.
 * Each Space gets its own clearly delimited block to prevent cross-leakage.
 */
function buildMasterSystemPrompt(
  contexts: SpaceContext_AI[],
  annotationsList: FinancialAssessment[],
  route: IntentRoute,
): string {
  const spaceBlocks = contexts
    .map((ctx, i) => {
      const assessment = annotationsList[i];
      return [
        `--- Space ${i + 1} of ${contexts.length} ---`,
        '=== FINANCIAL ASSESSMENT ===',
        assessment ? serializeAssessmentBlock(assessment, analysisWindowNote(ctx)) : '(no assessment available)',
        '=== END ASSESSMENT ===',
        serializeContextBlock(ctx),
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are a skilled, direct financial advisor powered by Fourth Meridian.',
    `You have context for ${contexts.length} space(s) the user belongs to.`,
    `Today's date: ${todayDateString()}.`,
    'Answer using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient, explain what is missing and why.',
    'Do not claim to execute trades, rebalance portfolios, or modify accounts or transaction records.',
    'Saving debt metadata (APR, minimum payment, due day, statement close day) is a supported user action via the form below your message — direct users there when they want to save those values.',
    'When referencing data, attribute it to the correct space by name.',
    '',
    ADVISOR_PRINCIPLES,
    '',
    RESPONSE_STYLE,
    '',
    KNOWLEDGE_GAPS_RULES,
    '',
    buildMasterAliasGuidance(contexts),
    '',
    EXECUTIVE_SUMMARY_DOCTRINE,
    '',
    EXPLAINABILITY_DOCTRINE,
    '',
    '=== QUESTION ROUTING ===',
    serializeRoutingBlock(route),
    '=== END ROUTING ===',
    '',
    '=== SPACE CONTEXTS ===',
    spaceBlocks,
    '=== END CONTEXTS ===',
  ].join('\n');
}

// ── Request validation ────────────────────────────────────────────────────────

interface ChatRequestBody {
  spaceId:  string;
  messages: ChatMessage[];
}

function parseBody(raw: unknown): ChatRequestBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;

  if (typeof b.spaceId !== 'string' || !b.spaceId.trim()) return null;

  if (!Array.isArray(b.messages)) return null;
  for (const m of b.messages) {
    if (
      !m ||
      typeof m !== 'object' ||
      !('role' in m) ||
      !('content' in m) ||
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string'
    ) {
      return null;
    }
  }

  return {
    spaceId:  b.spaceId.trim(),
    messages: b.messages as ChatMessage[],
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  // ── Rate limit (KD-3) ───────────────────────────────────────────────────────
  // Per-user cap to contain LLM cost abuse. SYSTEM_ADMIN is exempt.
  if (user.role !== 'SYSTEM_ADMIN') {
    const limited = await limitByUser(user.id, 'ai-chat', { limit: 30, windowSec: 60 });
    if (limited) return limited;
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const body = parseBody(rawBody);
  if (!body) {
    return NextResponse.json(
      { error: 'Invalid request. Required: spaceId (string), messages (array of {role, content}).' },
      { status: 400 },
    );
  }

  const { spaceId, messages } = body;

  // ── Body guard (KD-3) ───────────────────────────────────────────────────────
  // Cheap ceilings that bound prompt size independent of the rate limiter:
  // reject oversized conversations before any context build or LLM call.
  const MAX_MESSAGES            = 50;
  const MAX_TOTAL_CONTENT_CHARS = 24_000;
  if (messages.length > MAX_MESSAGES) {
    return NextResponse.json(
      { error: `Too many messages in one request (max ${MAX_MESSAGES}).` },
      { status: 400 },
    );
  }
  const totalContentChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalContentChars > MAX_TOTAL_CONTENT_CHARS) {
    return NextResponse.json(
      { error: `Message content too large (max ${MAX_TOTAL_CONTENT_CHARS} characters).` },
      { status: 400 },
    );
  }

  // Must have at least one user message
  if (!messages.some((m) => m.role === 'user')) {
    return NextResponse.json(
      { error: 'messages must contain at least one user turn.' },
      { status: 400 },
    );
  }

  let systemPrompt: string;
  // Knowledge gaps assembled at context time — returned alongside the reply so
  // the client can render structured input UI without parsing assistant text.
  let gapsForResponse: KnowledgeGap[] = [];

  // Layer 0 (D4): classify the latest user message into routing metadata.
  // Injected into the system prompt as === QUESTION ROUTING ===.
  const intentRoute = routeForMessages(messages);

  // D6 dynamic windows (with carry-forward): an optional explicit transaction
  // window derived from the user's wording ("this year", "last 6 months", …).
  // The latest message's own window wins; a follow-up ("month by month",
  // "what about January") inherits the most recent explicit window instead of
  // resetting to the default. Undefined for unrelated general prompts, which
  // keeps the assembler's default 30/90-day window.
  const transactionWindow = resolveTransactionWindow(messages, new Date());

  // D6 transaction drilldown (evidence retrieval): present ONLY for an explicit
  // drilldown follow-up ("what is this Other category made up of?", "show me the
  // largest transactions"). Undefined otherwise — no raw rows on ordinary prompts.
  const drilldown = resolveDrilldown(messages, new Date());

  // ── Ambiguity guard ────────────────────────────────────────────────────────
  // An antecedent-less breakdown follow-up ("break it down", "month by month",
  // "what about January") with no window of its own and no prior financial topic
  // is genuinely ambiguous — there is no subject for "it". Ask what to break down
  // rather than guessing (which previously produced a default-90-day Apr–Jun
  // table). The clarification is space-agnostic and exposes no financial data.
  const latestUser = [...messages].reverse().find((m) => m.role === 'user');
  if (
    latestUser &&
    transactionWindow === undefined &&
    isAmbiguousBreakdownFollowUp(latestUser.content) &&
    !hasPriorFinancialContext(messages, new Date())
  ) {
    return NextResponse.json({
      message:          buildBreakdownClarification(latestUser.content),
      knowledgeGaps:    [],
      knowledgeGapMode: 'clarification',
    });
  }

  if (spaceId === 'master') {
    // ── Master mode: aggregate all eligible Spaces ─────────────────────────
    // Enumerate OWNER/ADMIN/MEMBER memberships only. VIEWER excluded.

    const memberships = await db.spaceMember.findMany({
      where: {
        userId: user.id,
        status: 'ACTIVE',
        role:   { in: ELIGIBLE_ROLES },
        space:  { archivedAt: null, deletedAt: null },
      },
      select: { spaceId: true },
    });

    if (memberships.length === 0) {
      return NextResponse.json(
        { error: 'No eligible spaces found.' },
        { status: 403 },
      );
    }

    const contextResults = await Promise.allSettled(
      memberships.map((m) =>
        buildContext(m.spaceId, user.id, { scopeHint: 'full', transactionWindow, drilldown }),
      ),
    );

    const contexts: SpaceContext_AI[] = contextResults
      .filter(
        (r): r is PromiseFulfilledResult<SpaceContext_AI> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value);

    // Log failures without crashing
    contextResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(
          `[api/ai/chat] buildContext failed for Space ${memberships[i]?.spaceId}:`,
          r.reason,
        );
      }
    });

    if (contexts.length === 0) {
      return NextResponse.json(
        { error: 'Could not assemble context for any eligible space.' },
        { status: 500 },
      );
    }

    const masterAssessments = contexts.map(computeAssessment);
    systemPrompt = buildMasterSystemPrompt(contexts, masterAssessments, intentRoute);
    // Shadow-mode selection plan (D6.3D-1): logged only — prompt is unchanged.
    await logShadowSelectionPlans(user.id, contexts, masterAssessments, intentRoute);
    gapsForResponse = filterGapsByIntent(
      contexts.flatMap(extractKnowledgeGaps),
      detectsPayoffIntent(messages),
    );

  } else {
    // ── Specific Space: verify membership, reject VIEWER ──────────────────
    const membership = await db.spaceMember.findUnique({
      where:  { spaceId_userId: { spaceId, userId: user.id } },
      select: { role: true, status: true, space: { select: { archivedAt: true, deletedAt: true } } },
    });

    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      membership.space.archivedAt !== null ||
      membership.space.deletedAt !== null
    ) {
      return NextResponse.json({ error: 'Space not found.' }, { status: 404 });
    }

    if (!ELIGIBLE_ROLES.includes(membership.role)) {
      // VIEWER — explicitly excluded from AI chat
      return NextResponse.json(
        { error: 'AI chat is not available for viewer-role members.' },
        { status: 403 },
      );
    }

    // buildContext carries a second membership guard internally.
    let ctx: SpaceContext_AI;
    try {
      ctx = await buildContext(spaceId, user.id, { scopeHint: 'full', transactionWindow, drilldown });
    } catch (err) {
      console.error('[api/ai/chat] buildContext error:', err);
      return NextResponse.json(
        { error: 'Failed to assemble space context.' },
        { status: 500 },
      );
    }

    const assessment = computeAssessment(ctx);
    systemPrompt = buildSpaceSystemPrompt(ctx, assessment, intentRoute);
    // Shadow-mode selection plan (D6.3D-1): logged only — prompt is unchanged.
    await logShadowSelectionPlans(user.id, [ctx], [assessment], intentRoute);
    gapsForResponse = filterGapsByIntent(
      extractKnowledgeGaps(ctx),
      detectsPayoffIntent(messages),
    );
  }

  // ── Gap mode ─────────────────────────────────────────────────────────────
  // "form"          — user explicitly asked to update a field; render full card immediately.
  // "clarification" — context has gaps but user didn't ask to update; render lightweight prompt.
  const gapMode: 'clarification' | 'form' =
    detectsExplicitUpdateIntent(messages) ? 'form' : 'clarification';

  // ── LLM call ──────────────────────────────────────────────────────────────
  // generateChatReply is the only sanctioned path to the OpenAI SDK.
  // If OPENAI_API_KEY is not set it throws a clear error caught below.

  let reply: string;
  try {
    reply = await generateChatReply(systemPrompt, messages);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error.';
    console.error('[api/ai/chat] generateChatReply error:', message);

    // Surface key-not-configured errors as 503 so the client can distinguish
    // from transient errors.
    if (message.includes('OPENAI_API_KEY')) {
      return NextResponse.json(
        { error: 'AI provider is not configured. Set OPENAI_API_KEY.' },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { error: 'AI provider error. Please try again.' },
      { status: 502 },
    );
  }

  // Shadow-mode output validation (AI-4 / KD-2): observational only. Runs after
  // the reply exists and before it is returned; the reply below is unchanged.
  await logOutputValidation(user.id, spaceId, reply, systemPrompt, messages);

  return NextResponse.json({
    message:          reply,
    knowledgeGaps:    gapsForResponse,
    knowledgeGapMode: gapMode,
  });
}
