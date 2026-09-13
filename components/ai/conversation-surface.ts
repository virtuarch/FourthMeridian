/**
 * components/ai/conversation-surface.ts  (AI Experience Convergence — AI-3, AI-4)
 *
 * The pure decisions behind the conversation-first AI surface: which layout the
 * page is in, the curated starter copy, the empty-state suggestions, and the send
 * key. No React, no DOM — importable from the server page (which picks the starter
 * per request so SSR and hydration render the same line) and from tests.
 *
 * The layout rule is deliberately one line: a conversation exists as soon as there
 * is any turn, and the user's own turn is appended synchronously on submit — so the
 * first send flips the layout before the request is even in flight.
 *
 * AI-4: the empty state may be personal. The server page turns the user's own
 * memory into a headline and a few prompts (lib/ai/conversation/starter-topics);
 * `composeStarters` lays those over the generic set here. Personal prompts lead,
 * generic ones fill the remaining slots, and a generic prompt on a topic a personal
 * one already covers steps aside. With nothing personal it is exactly the generic
 * empty state.
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

/** One empty-state chip: a short label, sent as a natural-language prompt. */
export interface StarterPrompt {
  label: string;
  prompt: string;
  /** What it is about — a personal prompt on the same topic replaces a generic one. */
  topic?: string;
}

/** The generic chips. Also the fallback whenever memory offers nothing. */
export const EMPTY_STATE_SUGGESTIONS: ReadonlyArray<StarterPrompt> = [
  { label: "How am I looking?", prompt: "How am I looking financially?" },
  { label: "Project my cash", prompt: "Project my cash over the next few months.", topic: "cash-projection" },
  { label: "Where did I spend most?", prompt: "Where did I spend the most recently?" },
  { label: "Check my investments", prompt: "How are my investments doing?" },
];

export const MAX_STARTER_PROMPTS = 4;

/** What the empty state renders — display strings only, nothing else reaches the browser. */
export interface StarterModel {
  /** A personal headline, or null for the rotating generic line. */
  headline: string | null;
  prompts: ReadonlyArray<{ label: string; prompt: string }>;
}

/** Lay personal starters (if any) over the generic set. */
export function composeStarters(
  personal: { headline: string | null; prompts: ReadonlyArray<StarterPrompt> } | null,
): StarterModel {
  const mine = (personal?.prompts ?? []).slice(0, MAX_STARTER_PROMPTS);
  const topics = new Set(mine.map((p) => p.topic).filter((t): t is string => Boolean(t)));
  const labels = new Set(mine.map((p) => p.label.toLowerCase()));
  const fill = EMPTY_STATE_SUGGESTIONS.filter(
    (g) => !(g.topic && topics.has(g.topic)) && !labels.has(g.label.toLowerCase()),
  );
  return {
    headline: personal?.headline ?? null,
    prompts: [...mine, ...fill]
      .slice(0, MAX_STARTER_PROMPTS)
      .map(({ label, prompt }) => ({ label, prompt })),
  };
}

/** Enter sends; Shift+Enter is a newline; Enter that confirms an IME composition is not a send. */
export function isSendKey(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}
