/**
 * lib/ai/chat/conversation-scope.ts
 *
 * CF-4 — THE ACTIVE TEMPORAL SCOPE OF A CONVERSATION.
 *
 * One authority, consumed by both transaction-summary retrieval and drilldown
 * retrieval. Deterministic: no model call, no clock of its own, no state
 * outside the message list it is handed.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * Measured through the production path at 73f6836:
 *
 *     "What did I spend in 2025?"          → 2025-01-01 … 2025-12-31
 *     "What was my most expensive purchase?" → 2026-05-29 … 2026-08-27
 *
 * The second question is a refinement of the first by any human reading, and
 * retrieval silently snapped back to the rolling ninety-day default. The user
 * then receives a confident answer about a period they did not ask about —
 * which CF-2 and CF-3 cannot catch, because from the second turn's point of
 * view no temporal claim was made and the default window fully satisfies it.
 *
 * Drilldown failed identically and for the same reason: it read its base window
 * from the same function, behind the same gate.
 *
 * ── Why inheritance was conditional, and why that inverts here ──────────────
 * Carry-forward existed, gated on `looksLikeFollowUp` — about fifteen surface
 * patterns ("break it down", "what about", "month by month"). The gate encodes
 * a reasonable worry: a genuinely new question should not silently drag a stale
 * period along with it.
 *
 * But the two errors are not symmetric. Inheriting when the user had moved on
 * shows them a period they can see named in the prompt and correct in one
 * sentence. FAILING to inherit shows them a confidently wrong number with no
 * indication anything changed — and the phrasings that fail the gate are the
 * most natural ones a person uses ("what was my biggest purchase?", "who did I
 * spend the most with?").
 *
 * So inheritance becomes the default and the phrase list disappears. What
 * replaces it is not a longer list but two explicit exits: an explicit claim
 * replaces the scope, and an explicit clearing discards it.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * It changes no retrieval limit and widens no window. An inherited scope is the
 * same interval the user already asked for, applied to one more turn. Topic
 * change is deliberately NOT detected: doing that well needs the model, and a
 * model in this position would put question interpretation inside the trust
 * boundary CF-1/CF-2/CF-3 exist to keep it out of.
 */

import { classifyFinancialIntent } from '@/lib/ai/intent';
import { TemporalRequests } from '@/lib/ai/temporal-scope';
import type { BuildContextOptions } from '@/lib/ai/context-builder';

type AssemblerWindow = NonNullable<BuildContextOptions['transactionWindow']>;

/** A conversation turn, as the chat route holds it. */
export interface ScopeMessage {
  role:    string;
  content: string;
}

/**
 * How this turn's scope came to be.
 *
 * Rendered into the prompt, because "why is this period selected?" is a
 * question the model would otherwise have to guess at — and guessing produces
 * exactly the unqualified confidence this program keeps removing.
 */
export const ScopeTransitions = {
  /** The newest message named a period. It replaces whatever was active. */
  SET:        'SET',
  /** The newest message named none, so the active scope carried forward. */
  INHERIT:    'INHERIT',
  /** The newest message explicitly discarded the active scope. */
  CLEAR:      'CLEAR',
  /** The newest message named a period that could not be resolved (CF-3). */
  UNRESOLVED: 'UNRESOLVED',
  /** No period named, and none active to inherit. The product's default. */
  DEFAULT:    'DEFAULT',
} as const;

export type ScopeTransition = typeof ScopeTransitions[keyof typeof ScopeTransitions];

/** The resolved scope for one turn. */
export interface ConversationScope {
  /**
   * The retrieval window, in the shape the assembler takes — or undefined when
   * the product default applies. Identical in kind to what
   * `resolveTransactionWindow` returned before CF-4, so nothing downstream
   * needs to learn a new shape.
   */
  window:     AssemblerWindow | undefined;
  transition: ScopeTransition;
  /**
   * The user's phrase the active scope came from, when inherited. Carried so
   * the prompt can say "still looking at 2025" rather than merely showing dates
   * the user never sees restated.
   */
  inheritedFrom: string | null;
}

/**
 * Explicit discards.
 *
 * Deliberately short and deliberately explicit. Every entry names the ACT of
 * removing a time bound rather than describing a topic — a list that tried to
 * detect "the user has moved on" would be the phrase-matching this slice exists
 * to delete, rebuilt on the other side.
 *
 * Checked only when the message names no period of its own, so "overall in
 * 2025" sets 2025 and never reaches here.
 */
const CLEAR_PATTERNS: RegExp[] = [
  /\boverall\b/,
  /\bin general\b/,
  /\ball together\b/,
  /\baltogether\b/,
  /\bacross (?:the )?(?:board|everything|all time)\b/,
  /\bforget (?:that|the|about the)?\s*(?:time\s?frame|period|window|date range|year|quarter|month)?\b/,
  /\bignore (?:that|the)\s*(?:time\s?frame|period|window|date range)\b/,
  /\bno (?:time|date) (?:limit|bound|restriction|filter)\b/,
  /\bregardless of (?:the )?(?:time|period|date|when)\b/,
  /\bany (?:time )?period\b/,
  /\bwithout (?:the )?(?:time|date|period) (?:filter|limit|restriction)\b/,
];

function clearsScope(text: string): boolean {
  return CLEAR_PATTERNS.some((re) => re.test(text));
}

/** The window a message names in its own right, or undefined. */
function claimOf(content: string, now: Date): AssemblerWindow | undefined {
  const w = classifyFinancialIntent(content, now).transactionWindow;
  if (!w) return undefined;
  const servable = Boolean(w.startDate && w.endDate);
  if (!servable && !w.requested) return undefined;
  return {
    ...(servable ? { startDate: w.startDate, endDate: w.endDate } : {}),
    label: w.label,
    ...(w.requested ? {
      requested:      w.requested,
      requestedStart: w.requestedStart ?? null,
      requestedEnd:   w.requestedEnd   ?? null,
    } : {}),
  };
}

/**
 * Resolve the conversation's active temporal scope for the newest user message.
 *
 * Order is the contract, and each step is an exit:
 *
 *   1. The newest message names a RESOLVED period    → SET
 *   2. …explicitly discards the active scope         → CLEAR
 *   3. …names a period that could not be resolved    → UNRESOLVED
 *   4. …names none, and one is active                → INHERIT
 *   5. …names none, and none is active               → DEFAULT
 *
 * Step 1 precedes 2 so "overall in 2025" resolves to 2025 rather than clearing.
 *
 * Step 2 precedes 3 because a clearing phrase IS resolved temporal language,
 * and CF-3's cue detector cannot tell the two apart: "forget that timeframe"
 * contains the word "timeframe" and so registers as a temporal claim, which
 * would make an explicit instruction to drop the period arrive as "a period I
 * could not identify". Deciding the clearing first is what keeps the two
 * contracts from fighting over the same sentence.
 *
 * Step 3 precedes 4 because an unresolved claim must never quietly become the
 * previous interval: the user asked about a DIFFERENT period, and inheriting
 * would report the old one as though it answered the new question.
 */
export function resolveConversationScope(
  msgs: readonly ScopeMessage[],
  now:  Date,
): ConversationScope {
  const userMsgs = msgs.filter((m) => m.role === 'user');
  if (userMsgs.length === 0) {
    return { window: undefined, transition: ScopeTransitions.DEFAULT, inheritedFrom: null };
  }

  const latest = userMsgs[userMsgs.length - 1];
  const claim  = claimOf(latest.content, now);
  const text   = latest.content.toLowerCase().replace(/\s+/g, ' ').trim();

  // 1 — a resolved period in the newest message speaks for itself.
  if (claim && claim.requested !== TemporalRequests.UNRESOLVED) {
    return { window: claim, transition: ScopeTransitions.SET, inheritedFrom: null };
  }

  // 2 — explicit discard, decided BEFORE the unresolved fallback.
  if (clearsScope(text)) {
    return { window: undefined, transition: ScopeTransitions.CLEAR, inheritedFrom: null };
  }

  // 3 — temporal language that could not be pinned to dates (CF-3).
  if (claim) {
    return { window: claim, transition: ScopeTransitions.UNRESOLVED, inheritedFrom: null };
  }

  // 4 — inherit the most recent scope that is still active.
  //
  // Newest → oldest, stopping at the first turn that either established a scope
  // or discarded one. Stopping at a discard is what keeps a cleared period from
  // resurrecting itself two turns later, which a naive "find the last window"
  // scan would do.
  for (let i = userMsgs.length - 2; i >= 0; i--) {
    const prior = userMsgs[i].content;
    const priorClaim = claimOf(prior, now);

    if (priorClaim) {
      // An UNRESOLVED turn never becomes the active scope — it could not be
      // pinned to dates, so there is nothing to carry. Keep scanning past it to
      // the last scope that WAS resolved.
      if (priorClaim.requested === TemporalRequests.UNRESOLVED) continue;
      return {
        window: priorClaim,
        transition: ScopeTransitions.INHERIT,
        inheritedFrom: priorClaim.label ?? null,
      };
    }
    if (clearsScope(prior.toLowerCase().replace(/\s+/g, ' ').trim())) {
      return { window: undefined, transition: ScopeTransitions.DEFAULT, inheritedFrom: null };
    }
  }

  // 5 — nothing to inherit.
  return { window: undefined, transition: ScopeTransitions.DEFAULT, inheritedFrom: null };
}
