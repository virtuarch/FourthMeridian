/**
 * lib/ai/conversation/refusal-sentences.ts  (AI RELIABILITY — F1/F2)
 *
 * THE SENTENCES CONVERSATIONS SAYS WHEN IT DID NOT ANSWER, in one place.
 *
 * They are what the chat route, the pacing and allowance gates and the paid-AI
 * pause send as `{ error }`, plus the two the browser writes itself on a network
 * failure. Pure and client-safe — no server import — because both sides need
 * the list:
 *
 *   - the CLIENT labels a legacy cached transcript's refusal line as a failed
 *     turn rather than an answer (transcripts written before the typed failure
 *     state stored them as ordinary assistant prose);
 *   - the SERVER drops such a line from posted history (request.ts), so an old
 *     browser or an old cache can never hand the model one of its own refusals
 *     as something it said.
 *
 * ⚠️ EXACT, NEVER FUZZY. A posted assistant turn is dropped only when its WHOLE
 * content is one of these sentences, or matches one of the anchored templates
 * below with its variable part constrained. "Nothing was changed" inside a real
 * answer is still a real answer. The producers build their text from the
 * builders here, and `refusal-sentences.test.ts` calls each producer and pins
 * that what it returns is recognised — so a reworded refusal cannot drift out
 * of the list unnoticed.
 */

/** The chat route's own refusals (app/api/ai/chat/route.ts SAY). */
export const CHAT_REFUSAL_SAY = {
  malformed: 'That request didn’t arrive in a form I could read. Try asking again.',
  empty:     'I didn’t catch a question there — what would you like to know?',
  tooLong:   'This conversation has grown longer than I can carry in one piece. '
    + 'Start a new one and I’ll pick the thread back up.',
  forbidden: 'You don’t have access to that Space.',
  failed:    'Something went wrong while I was working on that. Nothing was changed. '
    + 'Please try again.',
  silent:    'I wasn’t able to put an answer together for that one. Try rephrasing it, '
    + 'or ask me something narrower.',
  unpriced:  'Conversations are paused: the model in use can’t be priced yet, so your '
    + 'daily AI allowance can’t be checked. Nothing was changed. Please try again later.',
  timedOut:  'That took longer than I can spend on one question, so I stopped. Nothing was '
    + 'changed. Try asking something narrower, or try again in a moment.',
} as const;

/** What the browser shows when the route answered with no sentence, or not at all. */
export const CLIENT_FAILURE_TEXT = {
  generic: 'Something went wrong. Please try again.',
  network: 'Network error. Please check your connection and try again.',
  /** A restored question with no answer after it — the request did not complete. */
  unanswered: 'This question didn’t get an answer. Nothing was changed.',
} as const;

/** The paid-AI pause sentence (lib/platform/ai/paid-requests-admission.ts AI_PAUSED_CUSTOMER_MESSAGE). */
export const AI_PAUSED_SENTENCE =
  'AI features are paused for maintenance. Nothing was changed. Please try again later.';

/** The generic pacing refusal (lib/ai/pacing.ts, HTTP 429). */
export const PACING_LIMITED_SENTENCE = 'Too many requests. Please slow down and try again shortly.';

// ── Templated refusals: one builder each, used by the producer itself ─────────

export const pacingUnavailableSentence = (surfaceLabel: string): string =>
  `${surfaceLabel} is briefly unavailable: your request rate couldn’t be checked just now. Nothing was changed. Please try again in a moment.`;

export const allowanceUnavailableSentence = (surfaceLabel: string): string =>
  `${surfaceLabel} is briefly unavailable: your daily AI allowance couldn’t be checked just now. Nothing was changed. Please try again in a moment.`;

export const allowanceUnpricedSentence = (surfaceLabel: string): string =>
  `${surfaceLabel} is paused for today: some of today’s usage can’t be priced yet, so your daily AI allowance can’t be checked. Nothing was changed. It resets at midnight UTC.`;

export const allowanceExhaustedSentence = (surfaceLabel: string, amount: string): string =>
  `You’ve used today’s AI allowance (about ${amount} of estimated usage). ${surfaceLabel} resets at midnight UTC. Nothing was changed.`;

export const planUnavailableSentence = (surfaceLabel: string): string =>
  `${surfaceLabel} isn’t available on your plan.`;

/** FAIL CLOSED (owner ruling, 2026-10-30) — a missing or invalid plan assignment: honest, non-alarming. */
export const planNeedsAttentionSentence = (surfaceLabel: string): string =>
  `${surfaceLabel} is paused: your account’s plan needs attention, so new requests are on hold until it’s fixed. Your data is safe and nothing was changed.`;

/** The surface label every Conversations refusal is built with. */
export const CONVERSATIONS_LABEL = 'Conversations';

const EXACT: ReadonlySet<string> = new Set<string>([
  ...Object.values(CHAT_REFUSAL_SAY),
  ...Object.values(CLIENT_FAILURE_TEXT),
  AI_PAUSED_SENTENCE,
  PACING_LIMITED_SENTENCE,
  pacingUnavailableSentence(CONVERSATIONS_LABEL),
  allowanceUnavailableSentence(CONVERSATIONS_LABEL),
  allowanceUnpricedSentence(CONVERSATIONS_LABEL),
  planUnavailableSentence(CONVERSATIONS_LABEL),
  planNeedsAttentionSentence(CONVERSATIONS_LABEL),
]);

/**
 * The one refusal with a variable part: the allowance amount. Anchored at both
 * ends; the amount is a short run with no parenthesis, so a sentence that merely
 * contains this one never matches.
 */
const EXHAUSTED = new RegExp(
  '^' + escape(allowanceExhaustedSentence(CONVERSATIONS_LABEL, '\u0000'))
    .replace('\u0000', '[^()\\n]{1,32}') + '$',
);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True only when `content` is, in full, a sentence Conversations says instead of answering. */
export function isKnownRefusalSentence(content: string): boolean {
  const c = content.trim();
  return EXACT.has(c) || EXHAUSTED.test(c);
}
