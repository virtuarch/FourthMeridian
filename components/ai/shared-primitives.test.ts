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

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement as h, createRef, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiShell } from "@/components/ai/AiShell";
import { Composer } from "@/components/ai/Composer";
import { ConversationView } from "@/components/ai/ConversationView";
import { AnswerCard } from "@/components/ai/AnswerCard";
import { Markdown } from "@/components/ai/Markdown";
import { StarterLine } from "@/components/ai/StarterLine";
import { composeStarters, conversationLayoutMode } from "@/components/ai/conversation-surface";
import { AnalyzeClient } from "@/components/dashboard/AnalyzeClient";
import type { AiMessage } from "@/components/ai/types";
import {
  AnswerFrame, ComposerFrame, ConversationLog, ThinkingIndicator,
  AiShell as BarrelAiShell, AnswerCard as BarrelAnswerCard, Composer as BarrelComposer, ConversationView as BarrelConversationView,
} from "@/components/ai";

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

// ── New API: the slots and frames other surfaces will adopt ─────────────────────

console.log("the barrel exports the shared primitives beside the Personal components");
{
  check("AnswerFrame / ComposerFrame / ConversationLog / ThinkingIndicator are exported",
    [AnswerFrame, ComposerFrame, ConversationLog, ThinkingIndicator].every((c) => typeof c === "function"));
  check("…and the Personal components are the same objects as their files' exports",
    BarrelAiShell === AiShell && BarrelAnswerCard === AnswerCard && BarrelComposer === Composer && BarrelConversationView === ConversationView);
}

console.log("AiShell: slot defaults are Personal Space AI; given slots render");
{
  const base = { mode: "conversation" as const, composer: h("div", null, "C"), children: h("div", null, "BODY"), contextLabel: "Household" };
  const dflt = renderToStaticMarkup(h(AiShell, base));
  const explicit = renderToStaticMarkup(h(AiShell, { ...base, title: "Fourth Meridian AI", contextPrefix: "Space: ", headerExtra: undefined, side: undefined }));
  check("passing the defaults explicitly renders the same markup", dflt === explicit);
  check("default title is the Personal h1", /<h1[^>]*>Fourth Meridian AI<\/h1>/.test(dflt));
  check("default context prefix is the sr-only \"Space: \"", dflt.includes('<span class="sr-only">Space: </span>Household</p>'));
  check("no side wrapper without `side`", !dflt.includes('class="flex flex-1 min-h-0 min-w-0"'));

  const custom = renderToStaticMarkup(h(AiShell, {
    ...base, title: "Platform AI", contextPrefix: "Scope: ",
    headerExtra: h("span", { "data-x": "extra" }, "EXTRA"),
    controls: h("button", { type: "button" }, "CTRL"),
    side: h("nav", { "data-x": "rail" }, "RAIL"),
  }));
  check("title replaces the h1 text", /<h1[^>]*>Platform AI<\/h1>/.test(custom) && !custom.includes("Fourth Meridian AI"));
  check("contextPrefix replaces the sr-only prefix", custom.includes('<span class="sr-only">Scope: </span>Household</p>'));
  check("headerExtra renders in the header, before the controls",
    custom.indexOf("EXTRA") > custom.indexOf("<header") && custom.indexOf("EXTRA") < custom.indexOf("CTRL") && custom.indexOf("CTRL") < custom.indexOf("</header>"));
  check("side renders beside one column that holds the reading region",
    /<div class="flex flex-1 min-h-0 min-w-0"><nav data-x="rail">RAIL<\/nav><div data-ai-column="true" class="flex flex-1 min-h-0 min-w-0 flex-col"><div data-ai-scroll="true"/.test(custom));
  // Parity PR5: the dock shares that column, so the composer (max-w-3xl mx-auto)
  // centres on the message column rather than the full shell width.
  check("with a side, the dock follows the reading region inside the same column, after the rail",
    /<div data-ai-column="true"[^>]*><div data-ai-scroll="true"[\s\S]*<div data-ai-dock="conversation" class="shrink-0 relative pt-1">[\s\S]*>C<\/div><\/div><\/div><\/div><\/div>$/.test(custom)
    && custom.indexOf("RAIL") < custom.indexOf("data-ai-column"));
  check("the dock and the composer slot are unchanged with a side",
    custom.includes('data-ai-dock="conversation"') && (custom.match(/>C<\/div>/g) ?? []).length === 1);
  check("without a side there is no column wrapper (Personal DOM unchanged)", !dflt.includes("data-ai-column"));
  check("the reading region is still the only scroll container", (custom.match(/data-ai-scroll/g) ?? []).length === 1);
}

console.log("ThinkingIndicator: three dots, a status, a configurable screen-reader label");
{
  const dflt = renderToStaticMarkup(h(ThinkingIndicator));
  check("default label is the Personal sentence", dflt.includes('<span class="sr-only">Fourth Meridian AI is thinking…</span>'));
  check("it is a status with three bouncing dots", dflt.startsWith('<div role="status"') && (dflt.match(/animate-bounce/g) ?? []).length === 3);
  const custom = renderToStaticMarkup(h(ThinkingIndicator, { srLabel: "Platform AI is working…" }));
  check("srLabel is honoured", custom.includes(">Platform AI is working…</span>") && !custom.includes("Fourth Meridian AI is thinking"));
}

console.log("ConversationLog: the log column, the busy slot");
{
  const anchorRef = createRef<HTMLElement>();
  const idle = renderToStaticMarkup(h(ConversationLog, { scrollKey: 1, turnCount: 1, answered: true, anchorRef, children: h("p", null, "TURN") }));
  check("renders the Personal log column", idle.startsWith('<div role="log" aria-label="Conversation" class="max-w-3xl mx-auto w-full space-y-7 px-1 pt-3 pb-10"><p>TURN</p>'));
  check("no status when idle", !idle.includes('role="status"'));
  const busy = renderToStaticMarkup(h(ConversationLog, { scrollKey: 1, turnCount: 1, answered: false, anchorRef, busy: true, children: h("p", null, "TURN") }));
  check("busy defaults to the three-dot indicator", busy.includes('role="status"') && busy.includes("Fourth Meridian AI is thinking…"));
  const custom = renderToStaticMarkup(h(ConversationLog, {
    scrollKey: 1, turnCount: 1, answered: false, anchorRef, busy: true,
    busyNode: h(ThinkingIndicator, { srLabel: "Working…" }), children: h("p", null, "TURN"),
  }));
  check("busyNode replaces the default indicator", custom.includes(">Working…</span>") && !custom.includes("Fourth Meridian AI is thinking"));
}

console.log("AnswerFrame: gutter + prose without the Markdown renderer");
{
  const html = renderToStaticMarkup(h(AnswerFrame, { extras: h("p", null, "EXTRAS"), children: h("span", null, "**not markdown**") }));
  check("the AI mark sits in the gutter", html.startsWith('<div class="flex gap-3"><div class="pt-1.5 shrink-0">'));
  check("the body is the caller's, unrendered", html.includes("<span>**not markdown**</span>") && !html.includes("<strong>"));
  check("extras come after the body", html.indexOf("**not markdown**") < html.indexOf("EXTRAS"));
  check("AnswerCard = AnswerFrame + Markdown",
    renderToStaticMarkup(h(AnswerCard, { message: "Hi" }, h("i", null, "x")))
      === renderToStaticMarkup(h(AnswerFrame, { extras: h("i", null, "x"), children: h(Markdown, null, "Hi") })));
}

console.log("ComposerFrame: label, maxLength, disabled, trailing and footer slots");
{
  const base = { value: "hello", onChange: noop, onSubmit: noop };
  const dflt = renderToStaticMarkup(h(ComposerFrame, base));
  check("default label is the Personal one, bound to the textarea",
    /<label for="([^"]+)-input" class="sr-only">Message Fourth Meridian AI<\/label>/.test(dflt) && /<textarea[^>]*id="[^"]+-input"/.test(dflt));
  check("no disclosure, no hint, no maxlength, not disabled by default",
    !dflt.includes("data-ai-disclosure") && !dflt.includes("aria-describedby") && !dflt.includes("maxLength") && !dflt.includes("maxlength") && !/<textarea[^>]*disabled/.test(dflt));
  check("send is enabled for a draft", /<button type="submit"[^>]*aria-label="Send message"/.test(dflt) && !/<button type="submit"[^>]*\sdisabled=""/.test(dflt));
  check("send is disabled for a blank draft",
    /<button type="submit"[^>]*\sdisabled=""/.test(renderToStaticMarkup(h(ComposerFrame, { ...base, value: "  " }))));

  const custom = renderToStaticMarkup(h(ComposerFrame, {
    ...base, label: "Message Platform AI", placeholder: "Ask Platform AI", inputId: "pai-input", maxLength: 4000,
    describedBy: "pai-count", disabled: true, footer: h("p", { id: "pai-count" }, "FOOTER"),
  }));
  check("label + explicit inputId", custom.includes('<label for="pai-input" class="sr-only">Message Platform AI</label>') && custom.includes('id="pai-input"'));
  check("maxLength reaches the textarea", /<textarea[^>]*maxLength="4000"/i.test(custom));
  check("describedBy reaches the textarea", /<textarea[^>]*aria-describedby="pai-count"/.test(custom));
  check("disabled disables the textarea and the send button",
    /<textarea[^>]*\sdisabled=""/.test(custom) && /<button type="submit"[^>]*\sdisabled=""/.test(custom));
  check("the footer renders beneath the pill, inside the form",
    custom.indexOf("</textarea>") < custom.indexOf("FOOTER") && custom.indexOf("FOOTER") < custom.indexOf("</form>"));
  const trailing = renderToStaticMarkup(h(ComposerFrame, { ...base, trailing: h("button", { type: "button" }, "STOP") }));
  check("trailing replaces the send button", trailing.includes(">STOP</button>") && !trailing.includes("Send message"));
}

console.log("new primitives obey the components/ai boundaries (they live in the pinned files)");
{
  const files = readdirSync(AI_DIR).filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.endsWith(".test.ts"));
  const forbidden = /@\/lib\/space\b|@\/components\/space\b|SpaceShell|useSpaceData|useSpaceNavigation|WORKSPACE_REGISTRY|@\/lib\/ai\/|@\/lib\/perspectives/;
  for (const f of ["AiShell.tsx", "ConversationView.tsx", "AnswerCard.tsx", "Composer.tsx"]) {
    const src = readFileSync(path.join(AI_DIR, f), "utf8");
    check(`${f} is still a components/ai file`, files.includes(f));
    check(`${f} makes no fetch and imports no AI-domain runtime`, !/\bfetch\s*\(|XMLHttpRequest|EventSource/.test(src) && !forbidden.test(src));
  }
  const composer = readFileSync(path.join(AI_DIR, "Composer.tsx"), "utf8");
  check("ComposerFrame has no Stop and no disclosure of its own (both stay in Composer)",
    !/Stop generating|AiDisclosure/.test(composer.slice(composer.indexOf("export function ComposerFrame"), composer.indexOf("export function Composer("))));
  const answer = readFileSync(path.join(AI_DIR, "AnswerCard.tsx"), "utf8");
  check("AnswerFrame does not render Markdown (the sink stays in AnswerCard)",
    !/<Markdown/.test(answer.slice(answer.indexOf("export function AnswerFrame"), answer.indexOf("export function AnswerCard("))));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall checks passed");
