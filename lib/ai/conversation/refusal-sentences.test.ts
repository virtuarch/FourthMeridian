/**
 * lib/ai/conversation/refusal-sentences.test.ts  (AI RELIABILITY — F1/F2)
 *
 *   1. every sentence Conversations sends instead of answering is recognised —
 *      checked against what each PRODUCER actually returns, not a copy;
 *   2. recognition is exact: a real answer that contains a refusal, or the
 *      exhausted template with anything added, is NOT a refusal;
 *   3. the server history safeguard (request.ts answeredHistory) drops only an
 *      assistant line that is wholly a refusal — never a user turn, never a real
 *      answer — so the conversation tail (and the sealed plan bound to it) stays
 *      on the last real answer.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/conversation/refusal-sentences.test.ts
 */

import {
  AI_PAUSED_SENTENCE, CHAT_REFUSAL_SAY, CLIENT_FAILURE_TEXT, CONVERSATIONS_LABEL, PACING_LIMITED_SENTENCE, isKnownRefusalSentence,
} from "./refusal-sentences";
import { answeredHistory, readChatRequest } from "./request";
import { conversationTail } from "./runtime-state";
import { allowanceRefusalBody, type AllowanceVerdict } from "@/lib/ai/allowance-core";
import { pacingResponse } from "@/lib/ai/pacing";
import { paidRequestsPausedResponse, AI_PAUSED_CUSTOMER_MESSAGE } from "@/lib/platform/ai/paid-requests-admission";
import { refuseIfDisabled } from "@/lib/entitlements/consume";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const refused = (reason: "ALLOWANCE_EXHAUSTED" | "UNPRICED_MODEL" | "RESERVATION_UNAVAILABLE" | "LEDGER_UNTRUSTED") =>
  ({ allowed: false, reason, unpricedInvocations: 0, spentUsd: 5.01, allowanceUsd: 5, enforced: true, reservation: "NONE", inFlight: 0 }) as unknown as Extract<AllowanceVerdict, { allowed: false }>;

async function main() {
  console.log("1. every producer's Conversations refusal is recognised");
  for (const [k, v] of Object.entries(CHAT_REFUSAL_SAY)) check(`route SAY.${k}`, isKnownRefusalSentence(v));
  for (const [k, v] of Object.entries(CLIENT_FAILURE_TEXT)) check(`client ${k}`, isKnownRefusalSentence(v));
  for (const reason of ["RESERVATION_UNAVAILABLE", "LEDGER_UNTRUSTED", "UNPRICED_MODEL", "ALLOWANCE_EXHAUSTED"] as const) {
    const body = allowanceRefusalBody(refused(reason), CONVERSATIONS_LABEL);
    check(`allowance ${reason} (as the route builds it)`, isKnownRefusalSentence(body.error), body.error);
  }
  {
    const limited = await pacingResponse({ status: "limited", retryAfterSec: 30 }, CONVERSATIONS_LABEL)!.json() as { error: string };
    const down = await pacingResponse({ status: "unavailable" }, CONVERSATIONS_LABEL)!.json() as { error: string };
    check("pacing 429", isKnownRefusalSentence(limited.error) && limited.error === PACING_LIMITED_SENTENCE);
    check("pacing unavailable 503", isKnownRefusalSentence(down.error), down.error);
    const paused = await paidRequestsPausedResponse().json() as { error: string };
    check("paid-AI pause 503 (one source)", isKnownRefusalSentence(paused.error) && AI_PAUSED_CUSTOMER_MESSAGE === AI_PAUSED_SENTENCE);
    const plan = await refuseIfDisabled({ dimensions: { conversations: { value: false } } } as never, "conversations" as never, CONVERSATIONS_LABEL)?.json() as { error: string } | undefined;
    check("plan disabled 403", plan !== undefined && isKnownRefusalSentence(plan.error), plan?.error);
  }

  console.log("\n2. exact, never fuzzy");
  check("a real answer that mentions 'Nothing was changed' is not a refusal",
    !isKnownRefusalSentence("Your balance is $4,812. Nothing was changed. Please try again later if you want a fresh read."));
  check("a refusal with an answer appended is not a refusal", !isKnownRefusalSentence(`${AI_PAUSED_SENTENCE} Meanwhile, your cash is $3,000.`));
  check("the exhausted template with extra text is not a refusal",
    !isKnownRefusalSentence("You’ve used today’s AI allowance (about $5.00 of estimated usage). Conversations resets at midnight UTC. Nothing was changed. Here is a summary anyway."));
  check("the exhausted template's amount cannot span a parenthesis",
    !isKnownRefusalSentence("You’ve used today’s AI allowance (about $5 (or more) of estimated usage). Conversations resets at midnight UTC. Nothing was changed."));
  check("another surface's sentence (the Brief's) is not in the Conversations list",
    !isKnownRefusalSentence(allowanceRefusalBody(refused("RESERVATION_UNAVAILABLE"), "The Daily Brief").error));
  check("whitespace around a refusal still matches", isKnownRefusalSentence(`  ${CLIENT_FAILURE_TEXT.network}\n`));

  console.log("\n3. the server keeps the conversation as it was ANSWERED");
  {
    const outage = allowanceRefusalBody(refused("RESERVATION_UNAVAILABLE"), CONVERSATIONS_LABEL).error;
    const answer = "Your liquid cash covers about 3.1 months of spending.";
    const posted = [
      { role: "user", content: "How long does my cash last?" },
      { role: "assistant", content: answer },
      { role: "user", content: "And if I cut dining by half?" },
      { role: "assistant", content: outage },
      { role: "user", content: "And if I cut dining by half?" },
    ];
    const r = readChatRequest({ spaceId: "s1", messages: posted });
    check("the request is accepted", r.ok);
    if (r.ok) {
      check("the refusal line is dropped from history", r.history.every((m) => m.content !== outage) && r.history.length === 3);
      check("both user turns are kept, verbatim", r.history.filter((m) => m.role === "user").length === 2 && r.asked === "And if I cut dining by half?");
      check("the tail is the last REAL answer (the sealed plan still binds)",
        conversationTail(r.history) === conversationTail([{ role: "assistant", content: answer }]));
    }
    check("a USER turn that quotes a refusal is never dropped",
      answeredHistory([{ role: "user", content: AI_PAUSED_SENTENCE }]).length === 1);
    check("a real assistant answer is never dropped",
      answeredHistory([{ role: "assistant", content: answer }, { role: "assistant", content: `${answer} Nothing was changed.` }]).length === 2);
    const onlyRefusal = readChatRequest({ messages: [{ role: "assistant", content: outage }] });
    check("the last turn must still be the user's (a refusal as the last turn is MALFORMED)", !onlyRefusal.ok);
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
