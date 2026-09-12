/**
 * components/ai/conversation-surface.ts  (AI Experience Convergence — AI-3)
 *
 * The pure decisions behind the conversation-first AI surface: which layout the
 * page is in, the curated starter copy, the empty-state suggestions, and the send
 * key. No React, no DOM — importable from the server page (which picks the starter
 * per request so SSR and hydration render the same line) and from tests.
 *
 * The layout rule is deliberately one line: a conversation exists as soon as there
 * is any turn, and the user's own turn is appended synchronously on submit — so the
 * first send flips the layout before the request is even in flight.
 */

export type ConversationLayoutMode = "empty" | "conversation";

export function conversationLayoutMode(turnCount: number): ConversationLayoutMode {
  return turnCount > 0 ? "conversation" : "empty";
}

/** The approved empty-state lines. One is chosen per visit; it never carousels. */
export const STARTER_LINES = [
  "What do you want to check today?",
  "How are you looking financially?",
  "Want to project something?",
  "What changed with your money?",
  "Where are you headed by year-end?",
  "Anything you want to sanity-check?",
] as const;

/** A gentle swap after a long idle stretch — only while the composer is untouched. */
export const STARTER_IDLE_SWAP_MS = 60_000;

/** Map a [0,1) random draw onto a starter index (clamped, NaN-safe). */
export function starterIndexFrom(random: number): number {
  if (!Number.isFinite(random)) return 0;
  const i = Math.floor(random * STARTER_LINES.length);
  return Math.min(Math.max(i, 0), STARTER_LINES.length - 1);
}

/** Coerce any incoming index onto the list (a prop is not trusted to be in range). */
export function normalizeStarterIndex(index: number): number {
  if (!Number.isInteger(index)) return 0;
  const n = STARTER_LINES.length;
  return ((index % n) + n) % n;
}

export function nextStarterIndex(index: number): number {
  return normalizeStarterIndex(index + 1);
}

/** Secondary empty-state chips: a short label, sent as a natural-language prompt. */
export const EMPTY_STATE_SUGGESTIONS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "How am I looking?", prompt: "How am I looking financially?" },
  { label: "Project my cash", prompt: "Project my cash over the next few months." },
  { label: "Where did I spend most?", prompt: "Where did I spend the most recently?" },
  { label: "Check my investments", prompt: "How are my investments doing?" },
];

/** Enter sends; Shift+Enter is a newline; Enter that confirms an IME composition is not a send. */
export function isSendKey(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}
