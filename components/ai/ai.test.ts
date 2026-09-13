/**
 * components/ai/ai.test.ts  (AI Experience Convergence — AI-1, conversation-first AI-3)
 *
 * Guards for the AI presentation layer. Standalone tsx (house pattern):
 * npx tsx components/ai/ai.test.ts — exits 0/1. Auto-discovered by run-tests.
 * There is no DOM runner in-repo, so this (a) source-scans the load-bearing
 * boundaries: presentation-only (no fetch), no workspace/runtime imports, no
 * financial calculation, the honest future-slot contract; and (b) renders the real
 * components to static markup with react-dom/server — which is exactly the first
 * paint — to pin the conversation-first layout contract (AI-3).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiShell } from "@/components/ai/AiShell";
import { Composer } from "@/components/ai/Composer";
import { ConversationView } from "@/components/ai/ConversationView";
import { StarterLine } from "@/components/ai/StarterLine";
import {
  EMPTY_STATE_SUGGESTIONS,
  STARTER_LINES,
  conversationLayoutMode,
  isSendKey,
  nextStarterIndex,
  normalizeStarterIndex,
  starterIndexFrom,
} from "@/components/ai/conversation-surface";
import { AnalyzeClient } from "@/components/dashboard/AnalyzeClient";
import { KnowledgeGapCard } from "@/components/ai/KnowledgeGapCard";
import { KnowledgeClarificationCard } from "@/components/dashboard/KnowledgeAcquisitionCard";
import { readKnowledgeGaps } from "@/lib/ai/conversation/knowledge-gaps";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const AI_DIR = path.join(process.cwd(), "components", "ai");
const read = (f: string) => readFileSync(path.join(AI_DIR, f), "utf8");
const files = readdirSync(AI_DIR).filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.endsWith(".test.ts"));
const noop = () => {};

console.log("the named components exist");
{
  for (const f of ["AiShell.tsx", "ConversationView.tsx", "MessageCard.tsx", "AnswerCard.tsx", "Composer.tsx", "SuggestedPrompt.tsx", "KnowledgeGapCard.tsx", "StarterLine.tsx", "conversation-surface.ts", "index.ts"]) {
    check(`components/ai/${f} exists`, existsSync(path.join(AI_DIR, f)));
  }
}

console.log("presentation-only: no API calls, no persistence");
{
  for (const f of files) {
    const src = read(f);
    check(`${f} makes no fetch/XHR call`, !/\bfetch\s*\(|XMLHttpRequest|EventSource/.test(src));
    check(`${f} defines no API route / server action`, !/getServerSession|"use server"|from "@\/lib\/data\//.test(src));
  }
}

console.log("no workspace / runtime / semantic-authority imports");
{
  const forbidden = /@\/lib\/space\b|@\/components\/space\b|SpaceShell|useSpaceData|useSpaceNavigation|WORKSPACE_REGISTRY|@\/lib\/ai\/|@\/lib\/perspectives/;
  for (const f of files) {
    check(`${f} imports no workspace/AI-domain runtime`, !forbidden.test(read(f)));
  }
}

console.log("honest future-slot contract (AnswerCard)");
{
  const src = read("AnswerCard.tsx");
  // The v2.6 slots are declared as never[] (present in the type, un-populatable today).
  check("AnswerCard declares facts/evidence/actions as never[]",
    /facts\?:\s*never\[\]/.test(src) && /evidence\?:\s*never\[\]/.test(src) && /actions\?:\s*never\[\]/.test(src));
  // And renders ONLY message + the extras slot — never a facts/evidence/actions section.
  check("AnswerCard renders only message + children (no facts/evidence/actions rendering)",
    !/\{\s*facts\b|\{\s*evidence\b|\{\s*actions\b|facts\.map|evidence\.map|actions\.map/.test(src));
}

console.log("kit reuse (Composer on Atlas Textarea)");
{
  check("Composer builds on the Atlas Textarea (not a bare <textarea>)",
    /from "@\/components\/atlas\/fields"/.test(read("Composer.tsx")) && !/<textarea/.test(read("Composer.tsx")));
}

// ── AI-3: conversation-first layout ─────────────────────────────────────────────

console.log("layout mode is derived from the turn count alone");
{
  check("no turns ⇒ empty", conversationLayoutMode(0) === "empty");
  check("one (just-submitted) user turn ⇒ conversation", conversationLayoutMode(1) === "conversation");
  check("restored history ⇒ conversation", conversationLayoutMode(6) === "conversation");
  const client = readFileSync(path.join(process.cwd(), "components", "dashboard", "AnalyzeClient.tsx"), "utf8");
  check("AnalyzeClient derives mode from messages.length (no page state machine)",
    /conversationLayoutMode\(messages\.length\)/.test(client));
  check("AnalyzeClient starts with no synthetic greeting turn", /useState<Message\[\]>\(\[\]\)/.test(client));
}

console.log("1. empty conversation — centered composer + starter, no docked state");
{
  const html = renderToStaticMarkup(h(AnalyzeClient, { advice: null, starterIndex: 2 }));
  check("layout is empty", html.includes('data-ai-layout="empty"'));
  check("composer sits in the centered (empty) dock", html.includes('data-ai-dock="empty"') && !html.includes('data-ai-dock="conversation"'));
  check("no conversation scroll region / log", !html.includes("data-ai-scroll") && !html.includes('role="log"'));
  check("the server-chosen starter line is shown", html.includes(STARTER_LINES[2]));
  check("the starter is a heading under the page h1", /<h1[^>]*>Fourth Meridian AI<\/h1>/.test(html) && /<h2[^>]*>What do you want|<h2[^>]*>Want to project something\?<\/h2>/.test(html));
  check("the composer is present exactly once", (html.match(/<textarea/g) ?? []).length === 1);
  for (const s of EMPTY_STATE_SUGGESTIONS) check(`suggestion chip "${s.label}" shown`, html.includes(`>${s.label}</button>`));
  check("no 'New chat' control before a conversation exists", !html.includes("New chat"));
  check("the starter precedes the composer, suggestions follow it",
    html.indexOf(STARTER_LINES[2]) < html.indexOf("<textarea") && html.indexOf("<textarea") < html.indexOf(EMPTY_STATE_SUGGESTIONS[0].label));
}

console.log("2. existing conversation — first paint is already conversation mode");
{
  const messages = [
    { role: "user" as const, content: "How am I looking?" },
    { role: "assistant" as const, content: "**Net worth** is up this month." },
  ];
  const html = renderToStaticMarkup(
    h(AiShell, {
      mode: conversationLayoutMode(messages.length),
      lead: h(StarterLine, { initialIndex: 0, frozen: false }),
      aside: h("div", null, "SUGGESTIONS"),
      composer: h(Composer, { value: "", onChange: noop, onSubmit: noop }),
      children: h(ConversationView, { messages }),
    }),
  );
  check("layout is conversation", html.includes('data-ai-layout="conversation"'));
  check("composer is docked", html.includes('data-ai-dock="conversation"'));
  check("conversation is the scroll region, rendered as a log", html.includes("data-ai-scroll") && html.includes('role="log"'));
  check("both turns are visible", html.includes("How am I looking?") && html.includes("Net worth"));
  check("no starter line, no suggestions, no centered state", !STARTER_LINES.some((l) => html.includes(l)) && !html.includes("SUGGESTIONS") && !html.includes('data-ai-dock="empty"'));
  check("composer comes after the conversation (bottom-aligned)", html.indexOf('role="log"') < html.indexOf("<form"));
  check("a fade separates the docked composer from scrolling text", html.includes("linear-gradient(to top, var(--bg-base), transparent)"));
}

console.log("3. first submit — the same composer node moves; the user turn enters conversation mode");
{
  const shell = read("AiShell.tsx");
  // The composer slot is unconditional and sits in the same parent in both modes — it is never remounted.
  check("AiShell renders the composer in one unconditional slot", /<div ref=\{composerRef\}>\{composer\}<\/div>/.test(shell));
  check("mode-only siblings are conditional slots around it", /\{empty && lead\}/.test(shell) && /\{empty && aside\}/.test(shell));
  check("the move is a FLIP transform, skipped under reduced motion",
    /translateY\(\$\{delta\}px\)/.test(shell) && /prefers-reduced-motion: reduce/.test(shell));
  const client = readFileSync(path.join(process.cwd(), "components", "dashboard", "AnalyzeClient.tsx"), "utf8");
  check("the user turn is appended before the request is sent",
    client.indexOf("setMessages(nextMessages)") > -1 && client.indexOf("setMessages(nextMessages)") < client.indexOf('fetch("/api/ai/chat"'));
  const busy = renderToStaticMarkup(h(ConversationView, { messages: [{ role: "user" as const, content: "Project my cash" }], busy: true }));
  check("after the first submit the user's message and a thinking status render", busy.includes("Project my cash") && busy.includes('role="status"'));
}

console.log("4. input — typing + submission still go through the existing flow");
{
  const html = renderToStaticMarkup(h(Composer, { value: "Can I afford this?", onChange: noop, onSubmit: noop }));
  check("the draft renders in the textarea", html.includes(">Can I afford this?</textarea>"));
  check("the textarea has a real <label>", /<label for="([^"]+)"[^>]*>Message Fourth Meridian AI<\/label>/.test(html) && /<textarea[^>]*id="[^"]+-input"/.test(html));
  check("it is a form with a submit button", html.includes("<form") && /<button type="submit"[^>]*aria-label="Send message"/.test(html));
  check("send is enabled for a non-empty draft", !/<button type="submit"[^>]*\sdisabled=""/.test(html));
  const blank = renderToStaticMarkup(h(Composer, { value: "   ", onChange: noop, onSubmit: noop }));
  check("send is disabled for a blank draft", /<button type="submit"[^>]*\sdisabled=""/.test(blank));
  const busy = renderToStaticMarkup(h(Composer, { value: "", onChange: noop, onSubmit: noop, onStop: noop, busy: true }));
  check("busy shows an accessible stop button, not send", busy.includes('aria-label="Stop generating"') && !busy.includes("Send message"));
  check("Enter sends", isSendKey({ key: "Enter", shiftKey: false }));
  check("Shift+Enter does not send", !isSendKey({ key: "Enter", shiftKey: true }));
  check("an IME-confirming Enter does not send", !isSendKey({ key: "Enter", shiftKey: false, isComposing: true }));
  check("other keys do not send", !isSendKey({ key: "a", shiftKey: false }));
}

console.log("5. backend contract unchanged");
{
  const client = readFileSync(path.join(process.cwd(), "components", "dashboard", "AnalyzeClient.tsx"), "utf8");
  check("posts to /api/ai/chat", /fetch\("\/api\/ai\/chat", \{\s*method: "POST"/.test(client));
  check("body is {spaceId, messages[{role, content}]}",
    /spaceId: selectedSpaceId,/.test(client) && /messages: nextMessages\.map\(\(m\) => \(\{ role: m\.role, content: m\.content \}\)\)/.test(client));
  check("reads {message, knowledgeGaps, knowledgeGapMode}", /data\.message/.test(client) && /data\.knowledgeGaps/.test(client) && /data\.knowledgeGapMode/.test(client));
  check("still non-streaming (one JSON response)", /await res\.json\(\)/.test(client) && !/getReader\(\)|EventSource/.test(client));
  // ⚠️ ONE DECLARATION OF THE RESPONSE, SHARED WITH THE ROUTE. The client used to
  // restate the shape inline, which is how a server field and a client field drift
  // into two subtly different contracts.
  check("the response is typed by the shared contract, not an inline literal",
    /as AiChatResponse/.test(client) && /AiChatResponse/.test(readFileSync(path.join(process.cwd(), "types", "index.ts"), "utf8")));
  check("the gaps are narrowed at the boundary, not trusted wholesale",
    /readKnowledgeGaps\(data\.knowledgeGaps\)/.test(client));
  // A knowledge gap travels with a 200; a refusal is the other branch entirely.
  check("gaps are read on the OK path and never on the error path",
    client.indexOf("readKnowledgeGaps(") < client.indexOf("data.error ??"));
  check("the request still sends role and content only — a gap cannot be posted back",
    !/knowledgeGaps:[^\n]*JSON\.stringify|body: JSON\.stringify\([^)]*knowledgeGap/.test(client));
}

console.log("5a. a knowledge gap renders beneath the answer it belongs to");
{
  const gaps = [
    { accountId: "a1", accountName: "Amex Platinum", field: "apr" as const, label: "APR", debtSubtype: "credit_card" },
  ];
  const extras = () => h(KnowledgeGapCard, {
    children: h(KnowledgeClarificationCard, { gaps, onExpand: noop, onSnooze: noop }),
  });
  const view = renderToStaticMarkup(h(ConversationView, {
    messages: [
      { role: "user" as const, content: "How fast can I clear the card?" },
      { role: "assistant" as const, content: "About eleven months at your current pace." },
    ],
    renderExtras: (i: number) => (i === 1 ? extras() : null),
  }));

  check("the answer renders", view.includes("About eleven months at your current pace."));
  check("the gap renders too", view.includes("APR") && view.includes("Amex Platinum"));
  check("…in words, not by icon or colour alone",
    view.includes("missing for") && view.includes("adding it improves accuracy"));
  check("…beneath the answer, in document order",
    view.indexOf("About eleven months") < view.indexOf("Amex Platinum"));
  check("…under a quiet eyebrow, not a warning box",
    view.includes("Sharpen this answer") && !/role="alert"|aria-live/.test(view));
  check("the conversation log is the only announced region",
    (view.match(/role="log"/g) ?? []).length === 1);
  check("it offers an action and a way out", view.includes("Update APR") && view.includes("Not now"));
  check("it stays inside the reading column — no overflow container of its own",
    !/overflow-x|w-screen|absolute/.test(view.slice(view.indexOf("Sharpen this answer"))));

  // The control: the same answer with no gap is the answer and nothing else.
  const plain = renderToStaticMarkup(h(ConversationView, {
    messages: [{ role: "assistant" as const, content: "About eleven months at your current pace." }],
    renderExtras: () => null,
  }));
  check("an answer with no gap renders no frame at all",
    !plain.includes("Sharpen this answer") && !plain.includes("Not now"));
  check("…and the empty conversation is untouched by any of it",
    !renderToStaticMarkup(h(ConversationView, { messages: [] })).includes("Sharpen this answer"));

  // A malformed extra must cost the extra, never the answer.
  const junk = readKnowledgeGaps([{ accountId: "a1" }, "nope", null]);
  check("a malformed payload narrows to nothing, so nothing renders", junk.length === 0);
  check("…and the answer is unaffected by that", plain.includes("About eleven months"));
}

console.log("6. starter copy — approved lines only, never fights the user");
{
  check("exactly the six approved lines", STARTER_LINES.length === 6 && STARTER_LINES[0] === "What do you want to check today?");
  for (const r of [0, 0.2, 0.5, 0.9999999, 1, -1, Number.NaN]) {
    const i = starterIndexFrom(r);
    check(`starterIndexFrom(${r}) is a valid index`, Number.isInteger(i) && i >= 0 && i < STARTER_LINES.length);
  }
  check("an out-of-range prop still selects an approved line", normalizeStarterIndex(13) === 1 && normalizeStarterIndex(-1) === 5 && normalizeStarterIndex(1.5) === 0);
  check("the idle swap cycles through the list", nextStarterIndex(STARTER_LINES.length - 1) === 0);
  for (let i = 0; i < STARTER_LINES.length; i++) {
    const html = renderToStaticMarkup(h(StarterLine, { initialIndex: i, frozen: false }));
    check(`starter ${i} renders its approved line, fully visible`, html.includes(STARTER_LINES[i]) && html.includes("opacity:1"));
  }
  const starter = read("StarterLine.tsx");
  check("the swap timer does not run once frozen", /if \(frozen\) return;/.test(starter));
  check("the swapping heading is not a live region", !/aria-live|role="status"/.test(starter));
  const client = readFileSync(path.join(process.cwd(), "components", "dashboard", "AnalyzeClient.tsx"), "utf8");
  check("focus or typing freezes the starter", /onFocus=\{\(\) => setComposerEngaged\(true\)\}/.test(client) && /frozen=\{composerEngaged \|\| input\.length > 0\}/.test(client));
  const page = readFileSync(path.join(process.cwd(), "app", "(shell)", "dashboard", "analyze", "page.tsx"), "utf8");
  check("the starter is chosen server-side per request (no hydration mismatch)", /starterIndexFrom\(Math\.random\(\)\)/.test(page) && /starterIndex=\{starterIndex\}/.test(page));
}

console.log("7. responsive / layout classes");
{
  const composer = renderToStaticMarkup(h(Composer, { value: "", onChange: noop, onSubmit: noop }));
  check("composer shares the reading-column width", composer.includes("max-w-3xl mx-auto w-full"));
  check("textarea is 16px below sm (no iOS focus zoom)", composer.includes("max-sm:text-base"));
  check("keyboard hint hidden on touch-sized screens", /class="hidden sm:block[^"]*"/.test(composer));
  check("textarea auto-grows to a cap", /maxHeightPx=\{200\}/.test(read("Composer.tsx")));
  const log = renderToStaticMarkup(h(ConversationView, { messages: [{ role: "user" as const, content: "hi" }] }));
  check("conversation column is max-w-3xl (768px) and centered", log.includes("max-w-3xl mx-auto w-full"));
  check("conversation leaves bottom padding above the dock", /role="log"[^>]*class="[^"]*pb-10/.test(log));
  const shell = read("AiShell.tsx");
  check("shell height uses dynamic viewport units", /100dvh/.test(shell));
  check("scrolling stays inside the conversation container", /overflow-y-auto overscroll-contain/.test(shell) && /closest<HTMLElement>\("\[data-ai-scroll\]"\)/.test(read("ConversationView.tsx")));
}

if (failures > 0) {
  console.error(`\nai.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nai.test: all passed.");
