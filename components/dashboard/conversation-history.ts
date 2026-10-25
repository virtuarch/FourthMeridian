/**
 * components/dashboard/conversation-history.ts  (AI RELIABILITY — F1)
 *
 * WHAT THE CONVERSATION WAS, AS OPPOSED TO WHAT WAS ON SCREEN.
 *
 * A failed request — a refusal, a timeout, a dropped connection — is shown in
 * the thread so the user knows their question got no answer, and it survives
 * navigation and reload (the transcript cache keeps it, labelled). But it is
 * NOT a turn of the conversation:
 *
 *   - it is never posted back to the model as history (`historyForRequest`), so
 *     the model never reads an outage notice as something it said;
 *   - it therefore never becomes the conversation's tail — the digest of the last
 *     assistant turn that binds the server's sealed plan — so a failed attempt no
 *     longer drops the plan under discussion;
 *   - a retry re-asks the SAME question (`retryPlan`): the failure is removed and
 *     the existing history, which already ends with that question, is posted. The
 *     question is never duplicated.
 *
 * Pure, so every rule here is provable without React or a browser.
 */

import { CLIENT_FAILURE_TEXT, isKnownRefusalSentence } from "@/lib/ai/conversation/refusal-sentences";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  /** This assistant line is a request that did not complete — not an answer. */
  status?: "failed";
}

export const isFailedTurn = (m: { role: string; status?: string }): boolean =>
  m.role === "assistant" && m.status === "failed";

/** The failure line the thread shows for a request that got no answer. */
export function failureTurn(sentence: string | undefined | null): ConversationTurn {
  const content = typeof sentence === "string" && sentence.trim() !== "" ? sentence.trim() : CLIENT_FAILURE_TEXT.generic;
  return { role: "assistant", content, status: "failed" };
}

/** The history posted to the model: every answered turn, and no failure. */
export function historyForRequest(messages: readonly ConversationTurn[]): { role: "user" | "assistant"; content: string }[] {
  return messages.filter((m) => !isFailedTurn(m)).map((m) => ({ role: m.role, content: m.content }));
}

/**
 * A cached transcript, ready to show again.
 *
 * - v2 lines keep their label.
 * - A legacy (v1) assistant line that is, in full, a known refusal sentence was
 *   a failure the old client cached as prose — it comes back labelled failed.
 * - A transcript that ends with a question and nothing after it is a request
 *   that never completed (the page was left or reloaded mid-answer, or the old
 *   client did not keep the refusal): it comes back with an explicit
 *   "didn't get an answer" line, so the question is never left looking pending.
 */
export function restoreTurns(cached: readonly ConversationTurn[]): ConversationTurn[] {
  const turns: ConversationTurn[] = cached.map((m) =>
    m.status === "failed" || (m.role === "assistant" && isKnownRefusalSentence(m.content))
      ? { role: "assistant", content: m.content, status: "failed" }
      : { role: m.role, content: m.content });
  if (turns.length > 0 && turns[turns.length - 1].role === "user") turns.push(failureTurn(CLIENT_FAILURE_TEXT.unanswered));
  return turns;
}

/**
 * The failure a Retry may act on: the LAST line, failed, directly after the
 * question it failed to answer. Earlier failures stay as a record; only the
 * newest unanswered question is re-asked.
 */
export function retryableFailureIndex(messages: readonly ConversationTurn[]): number | null {
  const i = messages.length - 1;
  if (i < 1) return null;
  return isFailedTurn(messages[i]) && messages[i - 1].role === "user" ? i : null;
}

/**
 * What a Retry does: the failure goes, nothing is added, and the posted history
 * ends with the original question. Null when there is nothing to retry.
 */
export function retryPlan(messages: readonly ConversationTurn[]): { next: ConversationTurn[]; history: ReturnType<typeof historyForRequest> } | null {
  const i = retryableFailureIndex(messages);
  if (i === null) return null;
  const next = messages.slice(0, i);
  return { next, history: historyForRequest(next) };
}
