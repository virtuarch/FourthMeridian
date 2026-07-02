/**
 * lib/ai/intent/gap-intent.ts
 *
 * Knowledge-gap gating heuristics for the AI chat route (KD-11).
 *
 * These two pure functions decide how the chat route surfaces knowledge-gap UI:
 *   - detectsPayoffIntent        → whether `minimumPayment` gaps are returned.
 *   - detectsExplicitUpdateIntent → whether the gap card renders as a full
 *                                   `form` (vs the lighter `clarification`).
 *
 * They were previously defined inline in `app/api/ai/chat/route.ts`. They are
 * relocated here VERBATIM (KD-11 Phase A) — identical logic and identical
 * keyword tokens — so they become importable and can be covered by
 * characterization tests. No behaviour change is introduced by the move.
 *
 * Deterministic: each function inspects only the latest user message text.
 * Same input → same output. No I/O, clock, or randomness.
 *
 * KD-11 Phase B: the keyword vocabulary now lives in the authoritative
 * `./keywords.ts` (single source of truth, shared with the classifier). This
 * module imports the gap-gating lists from there and remains the home of the
 * gap-gating *decisions*. The `*_KEYWORDS` names are re-exported for stability.
 */

import type { ChatMessage } from '@/lib/ai/provider';
import {
  PAYOFF_GAP_KEYWORDS,
  UPDATE_ACTION_GAP_KEYWORDS,
  UPDATE_FIELD_GAP_KEYWORDS,
} from './keywords';

/**
 * Keywords that signal the user is asking a payoff-schedule or payoff-timeline question.
 * Only when these are present is minimumPayment included in the knowledge gaps response.
 * APR is always included — it is durable account metadata, not operational data.
 */
export const PAYOFF_INTENT_KEYWORDS = PAYOFF_GAP_KEYWORDS;

/**
 * Action verbs that signal the user wants to explicitly enter or update a gap field.
 * Must be paired with UPDATE_FIELD_KEYWORDS to confirm the intent is field-related.
 */
export const UPDATE_ACTION_KEYWORDS = UPDATE_ACTION_GAP_KEYWORDS;

/**
 * Field nouns identifying knowledge-gap fields the user might want to update.
 */
export const UPDATE_FIELD_KEYWORDS = UPDATE_FIELD_GAP_KEYWORDS;

/**
 * Returns true when the most recent user message signals a payoff-schedule intent.
 * Used to gate whether minimumPayment gaps are returned alongside APR gaps.
 */
export function detectsPayoffIntent(msgs: ChatMessage[]): boolean {
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  const lower = lastUser.content.toLowerCase();
  return PAYOFF_INTENT_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Returns true when the most recent user message explicitly asks to update or save
 * a gap field (APR, minimum payment, interest rate, etc.).
 * Requires both an action verb AND a field noun to avoid false positives.
 * Used to gate whether the knowledge gap card renders as a full form immediately
 * (vs. the lighter clarification card).
 */
export function detectsExplicitUpdateIntent(msgs: ChatMessage[]): boolean {
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  const lower = lastUser.content.toLowerCase();
  const hasAction = UPDATE_ACTION_KEYWORDS.some((kw) => lower.includes(kw));
  const hasField  = UPDATE_FIELD_KEYWORDS.some((kw) => lower.includes(kw));
  return hasAction && hasField;
}
