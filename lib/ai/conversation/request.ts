/**
 * lib/ai/conversation/request.ts
 *
 * WHAT A BROWSER IS ALLOWED TO SAY, AND WHAT IT MEANS.
 *
 * ⚠️ PURE, AND SEPARATE FROM THE ROUTE ON PURPOSE. Everything here is a decision
 * about untrusted input — which roles may appear, how long a transcript may be,
 * which turn is the question, whether a Space was actually named. Those are the
 * decisions most worth testing exhaustively and least worth testing through an
 * HTTP handler, so they live where a test can call them directly with no
 * session, no database and no model.
 *
 * ⚠️ IT DECIDES NOTHING ABOUT AUTHORITY. A Space id that survives this module is
 * a well-formed string, not an authorised one; the route re-resolves it against
 * membership and refuses a mismatch. Nothing here reads data, and nothing here
 * grants anything.
 */

import type { ConversationMessage } from './engine';

/**
 * The Space selector's "all my Spaces" default.
 *
 * ⚠️ THE ONE ID THAT IS NOT AN ID. The client initialises its selector to this
 * sentinel before the Space list has loaded, so it is the value most first
 * questions are asked under. It means "no Space named", and it is the only
 * value permitted to resolve to a Space other than the one requested.
 */
export const ALL_SPACES_SENTINEL = 'master';

// ⚠️ A TRANSCRIPT IS AN INPUT, AND AN INPUT HAS A SIZE. The prompt is billed by
// the token and the model has a finite window; unbounded, one request could be
// made to cost whatever the caller likes. These are generous against real use —
// the 17-turn promotion dogfood sat well inside all three — and exceeding one is
// refused in a sentence rather than truncated into a conversation the user never
// had.
export const MAX_TURNS             = 80;
export const MAX_MESSAGE_CHARS     = 8_000;
export const MAX_TRANSCRIPT_CHARS  = 160_000;

/**
 * Why a request cannot be answered.
 *
 * MALFORMED — not the shape of a transcript, or carries a role the client has no
 *             business sending.
 * EMPTY     — nothing was asked.
 * TOO_LONG  — past a stated ceiling.
 */
export type ChatRequestRefusal = 'MALFORMED' | 'EMPTY' | 'TOO_LONG';

export type ChatRequest =
  | {
      ok: true;
      /** The Space the user named, or null for "my own" — the sentinel resolved. */
      spaceId: string | null;
      /** The question being asked now. */
      asked: string;
      /** Everything said before it, prose only. */
      history: ConversationMessage[];
    }
  | { ok: false; refusal: ChatRequestRefusal };

/**
 * Read a posted chat request, or refuse it.
 *
 * ⚠️ THE ROLE FILTER IS A SECURITY BOUNDARY, NOT TIDINESS. `system` is the
 * behavioural instruction and `tool` is financial evidence the server produced;
 * a client able to post either would be writing the parts of the prompt this
 * architecture exists to keep server-owned. An unrecognised role is therefore a
 * REFUSED REQUEST and never a dropped message — dropping would answer a
 * conversation the user did not have.
 */
export function readChatRequest(body: unknown): ChatRequest {
  if (typeof body !== 'object' || body === null) return { ok: false, refusal: 'MALFORMED' };
  const { spaceId, messages } = body as { spaceId?: unknown; messages?: unknown };

  if (!Array.isArray(messages)) return { ok: false, refusal: 'MALFORMED' };
  if (messages.length === 0) return { ok: false, refusal: 'EMPTY' };
  if (messages.length > MAX_TURNS) return { ok: false, refusal: 'TOO_LONG' };

  const turns: ConversationMessage[] = [];
  let chars = 0;
  for (const item of messages) {
    if (typeof item !== 'object' || item === null) return { ok: false, refusal: 'MALFORMED' };
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') return { ok: false, refusal: 'MALFORMED' };
    if (typeof content !== 'string') return { ok: false, refusal: 'MALFORMED' };
    if (content.length > MAX_MESSAGE_CHARS) return { ok: false, refusal: 'TOO_LONG' };
    chars += content.length;
    if (chars > MAX_TRANSCRIPT_CHARS) return { ok: false, refusal: 'TOO_LONG' };
    turns.push({ role, content });
  }

  // ⚠️ THE LAST TURN IS THE QUESTION. A transcript whose final turn is the
  // assistant's is not a request to answer anything — it is a replay, and
  // answering it would put words after a reply the user never responded to.
  const asked = turns[turns.length - 1];
  if (asked.role !== 'user') return { ok: false, refusal: 'MALFORMED' };
  if (asked.content.trim() === '') return { ok: false, refusal: 'EMPTY' };

  if (spaceId !== undefined && spaceId !== null && typeof spaceId !== 'string') {
    return { ok: false, refusal: 'MALFORMED' };
  }
  const named = typeof spaceId === 'string' ? spaceId.trim() : '';

  return {
    ok: true,
    spaceId: named === '' || named === ALL_SPACES_SENTINEL ? null : named,
    asked: asked.content,
    history: turns.slice(0, -1),
  };
}
