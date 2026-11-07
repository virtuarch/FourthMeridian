/**
 * components/ai/shared-primitives.test.ts  (Platform AI parity — PR 1)
 *
 * PR 1 extracts the Personal Space AI presentational primitives so Platform AI
 * can adopt them later (AiShell slots, ConversationLog + ThinkingIndicator,
 * AnswerFrame, ComposerFrame). It must not change a single byte of what
 * Personal Space AI renders. Standalone tsx (house pattern):
 * npx tsx components/ai/shared-primitives.test.ts — exits 0/1.
 *
 * PROOF OF NO CHANGE: `__snapshots__/shared-primitives.before.json` holds the
 * static markup of every case in SNAPSHOT_CASES as rendered by origin/develop
 * @ 3451c3a, BEFORE the extraction. It was captured once with
 * `npx tsx components/ai/shared-primitives.test.ts --capture` on that commit.
 * ⚠️ Never re-capture it on a branch that changes these components — that
 * would turn the proof into a tautology. A deliberate Personal visual change
 * re-captures it in its own PR and says so.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiShell } from "@/components/ai/AiShell";
import { Composer } from "@/components/ai/Composer";
import { ConversationView } from "@/components/ai/ConversationView";
import { AnswerCard } from "@/components/ai/AnswerCard";
import { StarterLine } from "@/components/ai/StarterLine";
import { composeStarters, conversationLayoutMode } from "@/components/ai/conversation-surface";
import { AnalyzeClient } from "@/components/dashboard/AnalyzeClient";
import type { AiMessage } from "@/components/ai/types";
import * as primitives from "@/components/ai";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const noop = () => {};
const AI_DIR = path.join(process.cwd(), "components", "ai");
const SNAPSHOT = path.join(AI_DIR, "__snapshots__", "shared-primitives.before.json");

const thread: AiMessage[] = [
  { role: "user", content: "How am I looking?" },
  { role: "assistant", content: "**Net worth** is up this month.\n\n- Cash: steady\n- Debt: down\n\n[Accounts](/dashboard/accounts) · ![x](https://example.com/x.png)" },
  { role: "user", content: "And next month?\nTwo lines." },
  { role: "assistant", content: "Couldn't reach the model.", status: "failed" },
];

// ── Personal Space AI markup, exactly as the orchestrator composes it ───────────
// Only APIs that exist on origin/develop @ 3451c3a may appear here.
const SNAPSHOT_CASES: Record<string, () => ReactElement> = {
  "AiShell/empty": () => h(AiShell, {
    mode: conversationLayoutMode(0),
    contextLabel: "Household",
    controls: h("button", { type: "button" }, "New chat"),
    lead: h(StarterLine, { initialIndex: 0, frozen: false }),
    aside: h("div", null, "SUGGESTIONS"),
    composer: h(Composer, { value: "", onChange: noop, onSubmit: noop }),
    children: null,
  }),
  "AiShell/conversation": () => h(AiShell, {
    mode: conversationLayoutMode(thread.length),
    contextLabel: "Household",
    composer: h(Composer, { value: "draft", onChange: noop, onSubmit: noop, onStop: noop, busy: true }),
    children: h(ConversationView, { messages: thread, busy: false, onRetry: noop, announceFailureIndex: 3 }),
  }),
  "AiShell/no-context-no-controls": () => h(AiShell, {
    mode: "conversation",
    composer: h(Composer, { value: "", onChange: noop, onSubmit: noop }),
    children: h(ConversationView, { messages: [{ role: "user", content: "hi" }] }),
  }),
  "ConversationView/empty": () => h(ConversationView, { messages: [] }),
  "ConversationView/busy": () => h(ConversationView, { messages: [{ role: "user", content: "Project my cash" }], busy: true }),
  "ConversationView/thread-with-extras": () => h(ConversationView, {
    messages: thread,
    renderExtras: (i: number) => (i === 1 ? h("div", { "data-extra": "gap" }, "Sharpen this answer") : null),
    onRetry: noop,
    announceFailureIndex: 3,
  }),
  "ConversationView/answered-busy": () => h(ConversationView, { messages: thread.slice(0, 2), busy: true }),
  "AnswerCard/plain": () => h(AnswerCard, { message: "About eleven months at your current pace." }),
  "AnswerCard/markdown-with-extras": () => h(AnswerCard, { message: thread[1].content }, h("p", null, "EXTRA")),
  "Composer/blank": () => h(Composer, { value: "   ", onChange: noop, onSubmit: noop }),
  "Composer/draft": () => h(Composer, { value: "Can I afford this?", onChange: noop, onSubmit: noop }),
  "Composer/busy-stop": () => h(Composer, { value: "", onChange: noop, onSubmit: noop, onStop: noop, busy: true }),
  "Composer/busy-no-stop": () => h(Composer, { value: "x", onChange: noop, onSubmit: noop, busy: true }),
  "Composer/no-hint-custom-placeholder": () => h(Composer, { value: "", onChange: noop, onSubmit: noop, hint: "", placeholder: "Ask anything" }),
  "Composer/twice-in-one-root": () => h("div", null,
    h(Composer, { value: "a", onChange: noop, onSubmit: noop }),
    h(Composer, { value: "b", onChange: noop, onSubmit: noop })),
  "AnalyzeClient/empty": () => h(AnalyzeClient, {
    advice: null, starterIndex: 2, spaceId: "space_active", spaceName: "Household", starter: composeStarters(null),
    userId: "usr_1", expectTranscript: false,
  }),
  "AnalyzeClient/restoring": () => h(AnalyzeClient, {
    advice: null, starterIndex: 0, spaceId: "space_active", spaceName: "Household", starter: composeStarters(null),
    userId: "usr_1", expectTranscript: true,
  }),
};

function renderAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, el] of Object.entries(SNAPSHOT_CASES)) out[name] = renderToStaticMarkup(el());
  return out;
}

if (process.argv.includes("--capture")) {
  mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify({
    _comment: "Personal Space AI static markup captured on origin/develop @ 3451c3a BEFORE parity PR 1. Compared byte-for-byte by components/ai/shared-primitives.test.ts. Do not re-capture on a branch that changes these components.",
    cases: renderAll(),
  }, null, 2) + "\n");
  console.log(`captured ${Object.keys(SNAPSHOT_CASES).length} cases → ${path.relative(process.cwd(), SNAPSHOT)}`);
  process.exit(0);
}

console.log("Personal Space AI markup is byte-identical to origin/develop (pre-extraction)");
{
  const before = (JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { cases: Record<string, string> }).cases;
  const now = renderAll();
  check("every snapshot case is still rendered", Object.keys(before).sort().join() === Object.keys(now).sort().join());
  for (const name of Object.keys(before)) {
    const same = now[name] === before[name];
    let detail: string | undefined;
    if (!same && now[name] !== undefined) {
      let i = 0;
      while (i < before[name].length && before[name][i] === now[name][i]) i++;
      detail = `first difference at ${i}: before …${before[name].slice(Math.max(0, i - 40), i + 60)}… now …${now[name].slice(Math.max(0, i - 40), i + 60)}…`;
    }
    check(`${name} is byte-identical`, same, detail);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall checks passed");
void primitives;
