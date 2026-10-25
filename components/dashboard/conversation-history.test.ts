/**
 * components/dashboard/conversation-history.test.ts  (AI RELIABILITY — F1)
 *
 * A failed request is shown, kept across navigation and reload, labelled — and
 * is never an answer:
 *   1. never posted as history; the conversation tail (which binds the sealed
 *      plan) stays on the last real answer;
 *   2. Retry re-asks the same question once — nothing duplicated;
 *   3. it survives navigate-away-and-back through the browser cache (v2), and a
 *      v1 cache still restores — legacy refusal lines and a dangling question
 *      come back labelled;
 *   4. it renders as a failure (no AI mark, no Markdown, Retry on the newest
 *      only, announced only when it happened this session).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/dashboard/conversation-history.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  failureTurn, historyForRequest, isFailedTurn, restoreTurns, retryPlan, retryableFailureIndex, type ConversationTurn,
} from "./conversation-history";
import {
  parseTranscript, readTranscript, serializeTranscript, writeTranscript, TRANSCRIPT_CACHE_VERSION, TRANSCRIPT_TTL_MS,
  type TranscriptStore,
} from "@/components/ai/transcript-cache";
import { ConversationView } from "@/components/ai/ConversationView";
import { FAILED_TURN_LABEL } from "@/components/ai/FailedTurn";
import { CLIENT_FAILURE_TEXT } from "@/lib/ai/conversation/refusal-sentences";
import { conversationTail } from "@/lib/ai/conversation/runtime-state";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-10-26T09:00:00.000Z");
const OUTAGE = "Conversations is briefly unavailable: your daily AI allowance couldn’t be checked just now. Nothing was changed. Please try again in a moment.";
const Q1 = "How long does my cash last?";
const A1 = "About 3.1 months at your recent spending.";
const Q2 = "And if I cut dining by half?";
const thread = (): ConversationTurn[] => [
  { role: "user", content: Q1 }, { role: "assistant", content: A1 },
  { role: "user", content: Q2 }, failureTurn(OUTAGE),
];

function memoryStore(): TranscriptStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
  };
}

console.log("1. a failure is never history");
{
  const t = thread();
  const h = historyForRequest(t);
  check("the failure is not posted", h.length === 3 && h.every((m) => m.content !== OUTAGE));
  check("only role and content are posted", h.every((m) => Object.keys(m).join() === "role,content"));
  check("the tail is the last real answer, not the failure",
    conversationTail(h) === conversationTail([{ role: "assistant", content: A1 }]) && conversationTail(h) !== conversationTail(t));
  const typedOn = [...t, { role: "user" as const, content: "What about rent?" }];
  check("asking something new after a failure keeps the unanswered question (the user's words) and drops the failure",
    historyForRequest(typedOn).map((m) => m.content).join("|") === [Q1, A1, Q2, "What about rent?"].join("|"));
  check("a failure line carries the server's sentence, or the generic one when there was none",
    failureTurn(OUTAGE).content === OUTAGE && failureTurn(undefined).content === CLIENT_FAILURE_TEXT.generic && failureTurn("  ").content === CLIENT_FAILURE_TEXT.generic);
  check("a failure is an assistant line with the failed status, nothing else", JSON.stringify(failureTurn(OUTAGE)) === JSON.stringify({ role: "assistant", content: OUTAGE, status: "failed" }));
}

console.log("\n2. Retry re-asks the same question, once");
{
  const plan = retryPlan(thread())!;
  check("the failure is removed and nothing is added", plan.next.length === 3 && plan.next.at(-1)!.content === Q2 && plan.next.at(-1)!.role === "user");
  check("the posted history ends with the original question, exactly once",
    plan.history.at(-1)!.content === Q2 && plan.history.filter((m) => m.content === Q2).length === 1);
  check("only the NEWEST failure, directly after its question, is retryable", retryableFailureIndex(thread()) === 3);
  const older = [...thread(), { role: "user" as const, content: "New question" }, { role: "assistant" as const, content: "New answer" }];
  check("an older failure followed by more conversation is a record, not retryable", retryPlan(older) === null);
  check("nothing to retry on an answered thread", retryPlan([{ role: "user", content: Q1 }, { role: "assistant", content: A1 }]) === null);
}

console.log("\n3. it survives navigation and reload (browser cache v2), and v1 still restores");
{
  const s = memoryStore();
  writeTranscript("u1", "s1", thread(), NOW, s);
  const raw = [...s.data.values()][0];
  check("the cache writes v2", JSON.parse(raw).version === TRANSCRIPT_CACHE_VERSION && TRANSCRIPT_CACHE_VERSION === 2);
  const back = restoreTurns(readTranscript("u1", "s1", NOW + 60_000, s)!);
  check("navigate away and back: the question AND its failure are both there",
    back.length === 4 && back[2].content === Q2 && isFailedTurn(back[3]) && back[3].content === OUTAGE);
  check("the successful answer is restored as an answer", back[1].content === A1 && !isFailedTurn(back[1]));
  check("the 24-hour retention is unchanged", readTranscript("u1", "s1", NOW + TRANSCRIPT_TTL_MS + 1, s) === null && TRANSCRIPT_TTL_MS === 86_400_000);

  const v1 = (messages: unknown[]) => JSON.stringify({ version: 1, savedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + TRANSCRIPT_TTL_MS).toISOString(), messages });
  const legacy = parseTranscript(v1([{ role: "user", content: Q1 }, { role: "assistant", content: A1 }]), NOW);
  check("a v1 transcript still restores, unchanged", legacy !== null && restoreTurns(legacy).length === 2 && !restoreTurns(legacy).some(isFailedTurn));
  const legacyRefusal = restoreTurns(parseTranscript(v1([{ role: "user", content: Q1 }, { role: "assistant", content: OUTAGE }, { role: "user", content: Q2 }, { role: "assistant", content: A1 }]), NOW)!);
  check("a legacy refusal cached as prose comes back labelled failed (and is then never posted)",
    isFailedTurn(legacyRefusal[1]) && historyForRequest(legacyRefusal).every((m) => m.content !== OUTAGE) && !isFailedTurn(legacyRefusal[3]));
  const dangling = restoreTurns(parseTranscript(v1([{ role: "user", content: Q1 }, { role: "assistant", content: A1 }, { role: "user", content: Q2 }]), NOW)!);
  check("a question left with no answer comes back with an explicit 'didn't get an answer' failure",
    dangling.length === 4 && isFailedTurn(dangling[3]) && dangling[3].content === CLIENT_FAILURE_TEXT.unanswered);
  check("…which Retry re-asks without duplicating the question", retryPlan(dangling)!.history.filter((m) => m.content === Q2).length === 1);
  check("v1 refuses the failed label (it did not exist)", parseTranscript(v1([{ role: "user", content: Q1 }, { role: "assistant", content: OUTAGE, status: "failed" }]), NOW) === null);
  const v2 = (messages: unknown[]) => JSON.stringify({ version: 2, savedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + TRANSCRIPT_TTL_MS).toISOString(), messages });
  check("v2 refuses a failed USER line", parseTranscript(v2([{ role: "user", content: Q1, status: "failed" }]), NOW) === null);
  check("v2 refuses any other status", parseTranscript(v2([{ role: "user", content: Q1 }, { role: "assistant", content: A1, status: "ok" }]), NOW) === null);
  check("v2 still refuses anything beyond role, content and the failed label",
    parseTranscript(v2([{ role: "user", content: Q1 }, { role: "assistant", content: A1, status: "failed", guidance: "X" }]), NOW) === null);
  check("serialising keeps the label and drops everything else",
    JSON.stringify(JSON.parse(serializeTranscript([{ role: "user", content: Q2 }, { role: "assistant", content: OUTAGE, status: "failed", guidance: "X" } as never], NOW)!).messages)
      === JSON.stringify([{ role: "user", content: Q2 }, { role: "assistant", content: OUTAGE, status: "failed" }]));
  check("…and keeps it mid-thread", JSON.parse(serializeTranscript(thread(), NOW)!).messages[3].status === "failed");
}

console.log("\n4. it renders as a failure, never as an answer");
{
  const html = renderToStaticMarkup(createElement(ConversationView, { messages: thread(), onRetry: () => {}, announceFailureIndex: 3 }));
  check("a labelled failure group", html.includes(`aria-label="${FAILED_TURN_LABEL}"`) && html.includes('data-turn="failed"'));
  check("the server's sentence is shown as plain text", html.includes("briefly unavailable"));
  check("a failure that happened this session is announced", /role="alert"[^>]*>Conversations is briefly unavailable/.test(html));
  check("Retry is offered on the newest failure", />\s*Retry\s*</.test(html.replace(/<svg[\s\S]*?<\/svg>/g, "")));
  const restored = renderToStaticMarkup(createElement(ConversationView, { messages: thread(), onRetry: () => {}, announceFailureIndex: null }));
  check("a restored failure is shown but NOT re-announced", !/role="alert"/.test(restored) && restored.includes(FAILED_TURN_LABEL));
  const older = [...thread(), { role: "user" as const, content: "New question" }, { role: "assistant" as const, content: "New answer" }];
  const olderHtml = renderToStaticMarkup(createElement(ConversationView, { messages: older, onRetry: () => {} }));
  check("an older failure has no Retry", !/>\s*Retry\s*</.test(olderHtml.replace(/<svg[\s\S]*?<\/svg>/g, "")) && olderHtml.includes(FAILED_TURN_LABEL));
  const answerCount = (html.match(/leading-relaxed"><div/g) ?? []).length;
  check("the failure does not use the answer card (one answer card for one answer)", (html.match(/data-turn="failed"/g) ?? []).length === 1 && answerCount <= 1);
  const md = renderToStaticMarkup(createElement(ConversationView, { messages: [{ role: "user", content: "q" }, failureTurn("**bold** [x](https://example.com)")] }));
  check("failure text is never rendered as Markdown (no link, no bold)", !/<a |<strong>/.test(md) && md.includes("**bold**"));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
