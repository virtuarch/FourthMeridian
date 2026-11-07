/**
 * components/platform/platform-ai-conversations.test.ts  (Platform AI conversations, PR C: the UX)
 *
 * DOM-less render tests (renderToStaticMarkup) plus source pins, the repo's
 * component-test idiom. Synthetic fixtures only: no real figure, name, email,
 * host or id. No network, no database, no provider.
 *
 *   1. flag gating — the page decides server-side, after every gate; the
 *      component is mounted by the page alone; flags unset ⇒ OFF
 *   2. the client model — defensive parsing, problem copy, time labels
 *   3. stale chip (§4.3) — every prior answer and every prior figure
 *   4. no Markdown parser — typed segments only; links only same-origin
 *   5. the disclosure line (OD-5, owner-approved) and the v0 privacy hint
 *   6. thread states — failed / pending / full / limit / expired
 *   7. layout — 375 px column, the mobile sheet control, the desktop rail
 *   8. reuse (§11) — MessageCard + FailedTurn only; no customer-only modules
 *   9. privacy — no analytics, no logging, no draft storage, routes only
 *  10. shared shell (parity PR3) — AiShell, ConversationLog + ThinkingIndicator,
 *      the answer frame around the typed segments, ComposerFrame (Enter-to-send,
 *      no Stop), starter chips, the rail in the `side` slot
 *  11. history (parity PR4) — the `?c=` parse and href, Today / Earlier grouping
 *      (UTC), delete-next, the loading skeleton, the one History writer, no
 *      rename / per-conversation export, Referrer-Policy. The behaviour on a real
 *      orchestrator (deep link, PUSH / REPLACE / Back, not-found, delete-next,
 *      storage) is components/platform/platform-ai-history.test.ts.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-ai-conversations.test.ts
 */

import "@/lib/test-support/route-env";

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { env } from "@/lib/env";
import { PLATFORM_AI_MESSAGE_MAX, PLATFORM_AI_RETENTION_DAYS } from "@/lib/platform/intelligence/ai/conversations/constants";
import { AnswerSegments, PlatformAiAsk } from "./PlatformAiAsk";
import { renderStoredAnswer } from "@/lib/platform/intelligence/ai/conversations/handlers";
import { AiShell } from "@/components/ai/AiShell";
import { ComposerFrame } from "@/components/ai/Composer";
import { SuggestedPrompt } from "@/components/ai/SuggestedPrompt";
import { isSendKey } from "@/components/ai/conversation-surface";
import {
  AssistantAnswer, ConversationList, PlatformAiComposer, PlatformAiConversations, PlatformAiConversationsView, Thread, TypedAnswerSegments,
  type PlatformAiConversationsViewProps,
} from "./PlatformAiConversations";
import {
  CONVERSATION_FULL_COPY, CONVERSATION_LIMIT_COPY, EARLIER_EXPIRED_COPY, FAILURE_COPY, NOT_FOUND_COPY,
  PLATFORM_AI_COMPOSER_MAX, PLATFORM_AI_CONVERSATIONS_DISCLOSURE, PLATFORM_AI_PRIVACY_HINT,
  PLATFORM_AI_RETENTION_DAYS_CLIENT, PLATFORM_AI_STARTER_HEADLINE, PLATFORM_AI_STARTER_PROMPTS, PLATFORM_AI_THINKING_LABEL,
  NOT_FOUND_PROBLEM, PLATFORM_AI_CONVERSATION_PARAM, RAIL_COLLAPSED_KEY, REFUSAL_COPY, TURN_IN_FLIGHT_COPY,
  conversationHref, groupConversations, nextConversationAfterDelete, readConversationParam,
  answeredLine, asOfChip, conversationMessagesUrl, conversationUrl, earlierMessagesExpired, hasPendingTurn,
  parseList, parseMessage, parsePair, parseThread, problemFor, questionBefore, relativeTime, utcStamp,
  type ClientConversation, type ClientMessage,
} from "./platform-ai-conversations-model";

const ROOT = path.resolve(__dirname, "../..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Source without comments (so a pin reads code, not prose). */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}

// ── Synthetic fixtures ──────────────────────────────────────────────────────
const NOW = new Date("2026-01-10T12:00:00.000Z");
const H3 = "2026-01-10T09:00:00.000Z";
const CONV: ClientConversation = {
  id: "c0000000000000000000000a", area: "PLATFORM_OPS", areaLabel: "Platform Operations",
  createdAt: H3, lastActivityAt: H3, label: "How are providers doing this week?", messageCount: 2, full: false,
};
const user = (id: string, content: string, createdAt = H3): ClientMessage => ({
  id, role: "USER", status: "COMPLETE", createdAt, completedAt: createdAt, content, citations: [], notes: [], failureCode: null, unavailable: false, stale: false,
});
const answer = (id: string, over: Partial<ClientMessage> = {}): ClientMessage => ({
  id, role: "ASSISTANT", status: "COMPLETE", createdAt: H3, completedAt: H3,
  content: [
    { kind: "text", text: "Providers: " },
    { kind: "figure", text: "12", metric: "provider-outcome@1", window: 7 },
    { kind: "text", text: " failing, " },
    { kind: "figure", text: "3", metric: "incident-broken-now@1", window: null },
    { kind: "text", text: " incidents. See " },
    { kind: "link", text: "Providers", href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-providers" },
  ],
  citations: [{ metric: "provider-outcome@1", label: "Provider outcomes", window: "last 7 days" }],
  notes: ["A deterministic note."], failureCode: null, unavailable: false, stale: true, ...over,
});
const noop = () => {};
function viewProps(over: Partial<PlatformAiConversationsViewProps> = {}): PlatformAiConversationsViewProps {
  return {
    areaLabel: "Platform Operations", now: NOW, conversations: [CONV], limits: { used: 1, max: 50 }, listError: null,
    selected: null, threadLoading: false, draft: "", sendingQuestion: null, problem: null, canRetrySend: false,
    sheetOpen: false, railCollapsed: false, confirmDelete: null, deleting: false,
    onDraft: noop, onSend: noop, onStarter: noop, onRetrySend: noop, onRetryFailed: noop, onCheckPending: noop, onSelect: noop, onNew: noop,
    onAskDelete: noop, onConfirmDelete: noop, onCancelDelete: noop, onSheet: noop, onRail: noop, ...over,
  };
}
function view(over: Partial<PlatformAiConversationsViewProps> = {}): string {
  return renderToStaticMarkup(createElement(PlatformAiConversationsView, viewProps(over)));
}
/** Every element in a tree of props (function components are NOT expanded): the view is hook-free, so it can be called and walked. */
function elements(node: ReactNode | unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) { for (const n of node) elements(n, out); return out; }
  if (isValidElement(node)) {
    out.push(node);
    for (const v of Object.values(node.props as Record<string, unknown>)) elements(v, out);
  }
  return out;
}

const COMPONENT = "components/platform/PlatformAiConversations.tsx";
const UNAVAILABLE_COPY_T = "Platform AI is unavailable right now.";
const MODEL = "components/platform/platform-ai-conversations-model.ts";
const PAGE = "app/(shell)/dashboard/platform/ai/page.tsx";

// ── 1. flag gating ──────────────────────────────────────────────────────────
console.log("1. flag gating — decided server-side by the page; OFF by default; v0 untouched");
{
  check("the flags are unset in this process ⇒ env.isPlatformAiConversationsEnabled is false (and v0 is off too)",
    env.isPlatformAiConversationsEnabled === false && env.isPlatformAiEnabled === false);
  const page = code(PAGE);
  const iV0Flag = page.indexOf("if (!env.isPlatformAiEnabled) return <PlatformAiPlaceholder />;");
  const iArea = page.indexOf("const area = platformAiAreaFor(spaces);");
  const iConv = page.indexOf("if (env.isPlatformAiConversationsEnabled) return <PlatformAiConversations areaLabel={platformAiAreaLabel(area)} />;");
  const iAsk = page.indexOf("return <PlatformAiAsk areaLabel={platformAiAreaLabel(area)} />;");
  const iTotp = page.indexOf("redirect(OPERATOR_TOTP_ENROLMENT_PATH)");
  check("page order: gates → v0 flag (placeholder) → area → conversations flag → v0 PlatformAiAsk (the fallthrough)",
    iTotp > -1 && iV0Flag > iTotp && iArea > iV0Flag && iConv > iArea && iAsk > iConv, { iTotp, iV0Flag, iArea, iConv, iAsk });
  check("the page renders PlatformAiConversations in exactly ONE place, behind the server-side getter",
    (page.match(/<PlatformAiConversations\b/g) ?? []).length === 1 && (page.match(/isPlatformAiConversationsEnabled/g) ?? []).length === 1);
  check("the page still reads no Platform data and names no API route", !/\/api\/platform|systemDb|@\/lib\/db"/.test(page));
  // The component has exactly one importer: the page. (No other surface can mount it, flag or not.)
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${f}`;
      if (f === "node_modules" || f.startsWith(".")) continue;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts") && rel !== COMPONENT && /PlatformAiConversations["']/.test(src(rel))) importers.push(rel);
    }
  };
  for (const d of ["app", "components", "lib"]) walk(d);
  check("PlatformAiConversations is imported ONLY by the AI page", importers.join() === PAGE, importers);
  check("the component reads no env and no flag itself (the decision is the page's)",
    !/process\.env|@\/lib\/env|isPlatformAi/.test(code(COMPONENT)) && !/process\.env|@\/lib\/env/.test(code(MODEL)));
  // v0 renders exactly as before (the same pins as platform-ai.test.ts §11, re-read here).
  const v0 = renderToStaticMarkup(createElement(PlatformAiAsk, { areaLabel: "Platform Operations" }));
  check("v0 PlatformAiAsk still renders its own box, unchanged copy ('Nothing here is saved' path intact, no conversation UI)",
    /Answering from Platform Operations data only\. Other areas you can open are not included in v0\./.test(textOf(v0))
    && !/data-platform-ai-conversations|data-platform-ai-rail|Conversations/.test(v0));
  check("the orchestrator itself renders (initial state, before any fetch) without throwing",
    /data-platform-ai-conversations/.test(renderToStaticMarkup(createElement(PlatformAiConversations, { areaLabel: "Platform Operations" }))));
}

// ── 2. the client model ─────────────────────────────────────────────────────
console.log("\n2. client model — defensive parsing, copy, time");
{
  check("composer bound = the server's PLATFORM_AI_MESSAGE_MAX (500)", PLATFORM_AI_COMPOSER_MAX === PLATFORM_AI_MESSAGE_MAX && PLATFORM_AI_COMPOSER_MAX === 500);
  check("URLs are the PR B routes only", conversationUrl("abc") === "/api/platform/ai/conversations/abc" && conversationMessagesUrl("abc") === "/api/platform/ai/conversations/abc/messages");
  const m = parseMessage({
    id: "m1", role: "ASSISTANT", status: "COMPLETE", createdAt: H3, completedAt: H3, failureCode: null, unavailable: false, stale: true,
    content: [{ kind: "text", text: "a" }, { kind: "html", text: "<b>x</b>" }, { kind: "link", text: "no href", page: "PLATFORM_OPS:x" }, { kind: "figure", text: "9", metric: "k@1", window: 30 }],
    citations: [{ metric: "k@1", label: "K", window: "w" }, { metric: 1 }], notes: ["n", 3],
  });
  check("an unknown segment kind and a link without a resolved href are DROPPED (never shown as raw text)",
    !!m && Array.isArray(m.content) && m.content.length === 2 && m.content[0].kind === "text" && m.content[1].kind === "figure", m);
  check("malformed citations / notes dropped", !!m && m.citations.length === 1 && m.notes.length === 1);
  check("stale is honoured only on ASSISTANT rows", parseMessage({ id: "u", role: "USER", status: "COMPLETE", createdAt: H3, content: "q", stale: true })?.stale === false);
  check("an unknown status / role / failure code ⇒ null or a null code",
    parseMessage({ id: "x", role: "SYSTEM", status: "COMPLETE", createdAt: H3 }) === null
    && parseMessage({ id: "x", role: "ASSISTANT", status: "DONE", createdAt: H3 }) === null
    && parseMessage({ id: "x", role: "ASSISTANT", status: "FAILED", createdAt: H3, failureCode: "provider said something" })?.failureCode === null);
  const list = parseList({ conversations: [{ ...CONV }, { id: 1 }], limits: { conversations: { used: 1, max: 50 } } });
  check("list: bad rows dropped, limits read", list?.conversations.length === 1 && list.limits?.max === 50);
  check("thread / pair parse", parseThread({ conversation: CONV, messages: [user("u1", "q"), answer("a1")] })?.messages.length === 2
    && parsePair({ conversation: CONV, userMessage: user("u1", "q"), assistantMessage: answer("a1") })?.conversation?.id === CONV.id
    && parsePair({ userMessage: answer("a1"), assistantMessage: user("u1", "q") }) === null);
  check("problems by closed code: FULL / LIMIT / IN_FLIGHT / NOT_FOUND",
    problemFor(409, { code: "CONVERSATION_FULL" }).text === CONVERSATION_FULL_COPY
    && problemFor(409, { code: "CONVERSATION_LIMIT" }).text === CONVERSATION_LIMIT_COPY
    && problemFor(409, { code: "TURN_IN_FLIGHT" }).text === TURN_IN_FLIGHT_COPY
    && problemFor(404, { code: "NOT_FOUND" }).text === NOT_FOUND_COPY);
  check("daily cap ⇒ v0's own message; an unknown reason ⇒ the generic sentence (never server text)",
    problemFor(429, { code: "AI_UNAVAILABLE", reason: "DAILY_TURNS" }).text === REFUSAL_COPY.DAILY_TURNS
    && problemFor(500, { error: "raw server words" }).text === "Platform AI is unavailable right now.");
  const v0 = src("components/platform/PlatformAiAsk.tsx");
  check("every refusal sentence is v0's, verbatim", Object.entries(REFUSAL_COPY).every(([k, v]) => v0.includes(`${k}: ${JSON.stringify(v)}`)), REFUSAL_COPY);
  check("FAILED codes map to closed sentences (no provider text)", Object.values(FAILURE_COPY).every((s) => typeof s === "string" && s.length > 0) && FAILURE_COPY.ABANDONED.length > 0);
  check("relative time", relativeTime("2026-01-10T11:59:30Z", NOW) === "just now" && relativeTime("2026-01-10T11:55:00Z", NOW) === "5 min ago"
    && relativeTime(H3, NOW) === "3 h ago" && relativeTime("2026-01-09T12:00:00Z", NOW) === "1 day ago" && relativeTime("2026-01-07T12:00:00Z", NOW) === "3 days ago" && relativeTime("nope", NOW) === "earlier");
  check("UTC stamp", utcStamp(H3) === "2026-01-10 09:00 UTC" && utcStamp("nope") === "");
  check("the client's retention constant = the server's PLATFORM_AI_RETENTION_DAYS (duplicated; the migration-pin pattern)",
    PLATFORM_AI_RETENTION_DAYS_CLIENT === PLATFORM_AI_RETENTION_DAYS && PLATFORM_AI_RETENTION_DAYS === 90, [PLATFORM_AI_RETENTION_DAYS_CLIENT, PLATFORM_AI_RETENTION_DAYS]);
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const gapAfter = (createdAt: string) => [{ createdAt: new Date(Date.parse(createdAt) + 2 * DAY).toISOString() }];
  const twoDays = ago(2 * DAY), ninetyOne = ago(91 * DAY), exactly = ago(90 * DAY), justUnder = ago(90 * DAY - 1);
  check("S2 on #434: a 2-day-old conversation WITH a gap ⇒ no 'expired' copy (retention cannot have acted yet)",
    !earlierMessagesExpired({ createdAt: twoDays }, [{ createdAt: ago(60 * 60 * 1000) }], NOW));
  check("a 91-day-old conversation with a gap ⇒ the copy", earlierMessagesExpired({ createdAt: ninetyOne }, gapAfter(ninetyOne), NOW));
  check("boundary: exactly 90 days old ⇒ the copy (≥); 90 days − 1 ms ⇒ none",
    earlierMessagesExpired({ createdAt: exactly }, gapAfter(exactly), NOW) && !earlierMessagesExpired({ createdAt: justUnder }, gapAfter(justUnder), NOW));
  check("old enough but no gap (same transaction), or no messages ⇒ no copy",
    !earlierMessagesExpired({ createdAt: ninetyOne }, [{ createdAt: ninetyOne }], NOW) && !earlierMessagesExpired({ createdAt: ninetyOne }, [], NOW)
    && !earlierMessagesExpired({ createdAt: "nope" }, gapAfter(ninetyOne), NOW));
  check("the view passes the render clock (p.now) to the age condition",
    /earlierMessagesExpired\(p\.selected\.conversation, messages, p\.now\)/.test(code(COMPONENT)));
  check("pending + retry question helpers",
    hasPendingTurn([user("u", "q"), answer("a", { status: "PENDING", content: null })]) && !hasPendingTurn([user("u", "q"), answer("a")])
    && questionBefore([user("u", "the question"), answer("a")], 1) === "the question" && questionBefore([answer("a")], 0) === null);
}

// ── 3. stale chip ───────────────────────────────────────────────────────────
console.log("\n3. stale chip (§4.3) — prior answers and prior figures say when they were true");
{
  const stale = renderToStaticMarkup(createElement(AssistantAnswer, { message: answer("a1"), areaLabel: "Platform Operations", now: NOW }));
  check("a prior answer carries 'Answered <time>. Figures are as of then.'",
    textOf(stale).includes(answeredLine(H3, NOW)) && answeredLine(H3, NOW) === "Answered 3 h ago. Figures are as of then." && /data-platform-ai-stale-line/.test(stale), textOf(stale));
  const figures = (stale.match(/data-platform-ai-figure/g) ?? []).length;
  const chipsAfterFigures = (stale.match(/data-platform-ai-figure="[^"]*"[^>]*>[^<]*<\/span><span data-platform-ai-stale-chip="[^"]*" title="2026-01-10 09:00 UTC"[^>]*>as of 3 h ago<\/span>/g) ?? []).length;
  check("EVERY figure is followed by its own 'as of' chip (with the UTC stamp as a title)", figures === 2 && chipsAfterFigures === 2, stale);
  check("the citation rows carry the chip too", /Provider outcomes<\/span><span[^>]*>last 7 days<\/span><span data-platform-ai-stale-chip/.test(stale));
  check("asOfChip wording", asOfChip(H3, NOW) === "as of 3 h ago");
  const fresh = renderToStaticMarkup(createElement(AssistantAnswer, { message: answer("a2", { stale: false }), areaLabel: "Platform Operations", now: NOW }));
  check("a just-answered (current) answer has no stale line and no chip", !/data-platform-ai-stale/.test(fresh) && /data-platform-ai-answer="current"/.test(fresh));
  check("the figure text is the server's stored text, never refreshed in place", /data-platform-ai-figure="[^"]*"[^>]*>12</.test(stale) && /data-platform-ai-figure="[^"]*"[^>]*>3</.test(stale));
  const cmp = code(COMPONENT);
  check("the orchestrator marks every earlier answer stale when a new pair lands (as a re-read would)", /role === "ASSISTANT" \? \{ \.\.\.m, stale: true \}/.test(cmp));
}

// ── 4. no Markdown parser ───────────────────────────────────────────────────
console.log("\n4. no Markdown parser — typed segments only; links only same-origin");
{
  const hostile = renderToStaticMarkup(createElement(TypedAnswerSegments, { staleAsOf: null, segments: [
    { kind: "text", text: "**bold** _em_ ![x](https://evil.test/a.png) <img src=x onerror=alert(1)> [y](https://evil.test)" },
    { kind: "link", text: "abs", href: "https://evil.test/forged" },
    { kind: "link", text: "proto", href: "//evil.test" },
    { kind: "link", text: "js", href: "javascript:alert(1)" },
    { kind: "link", text: "ok", href: "/dashboard/platform/PLATFORM_OPS" },
  ] }));
  check("Markdown syntax stays literal text (no <strong>, <em>, <img>)", !/<(strong|em|img)\b/.test(hostile) && hostile.includes("**bold**") && hostile.includes("&lt;img"), hostile);
  check("only the same-origin link renders as <a>; absolute, protocol-relative and javascript: are text",
    (hostile.match(/<a /g) ?? []).length === 1 && /<a href="\/dashboard\/platform\/PLATFORM_OPS"/.test(hostile) && !/href="(https?:|\/\/|javascript:)/.test(hostile), hostile);
  const cmp = code(COMPONENT), model = code(MODEL);
  check("the component imports only isSameOriginPath from the Markdown module and never renders <Markdown>",
    /import \{ isSameOriginPath \} from "@\/components\/ai\/Markdown";/.test(cmp) && !/<Markdown\b|react-markdown|remark|rehype|dangerouslySetInnerHTML|innerHTML/.test(cmp + model));
  check("no AnswerCard (the customer Markdown answer)", !/AnswerCard/.test(cmp));
  check("links come from the server's re-resolved href only: the model has no page→href logic and no stored URL field",
    !/\bpage\b\s*:/.test(model.replace(/kind: "link", text: "no href", page/g, "")) && /if \(s\.kind === "link" && typeof s\.href === "string"\)/.test(model));
}

// ── 4b. S2 F-C1 (ii): the server correction segment ─────────────────────────
console.log("\n4b. the period CORRECTION segment — its own block, prominent, ABOVE the answer (v0 + conversations)");
{
  const CORR = "Correction: the figures for Estimated operating cost this cycle (by category) cover so far this month (since 2026-11-01), not the past 30 days you asked about; that period cannot be measured for them.";
  const PROSE = "In the past 30 days, the largest cost category is Providers (Plaid).";
  const conv = renderToStaticMarkup(createElement(TypedAnswerSegments, { staleAsOf: null, segments: [{ kind: "correction", text: CORR }, { kind: "text", text: PROSE }] }));
  const v0 = renderToStaticMarkup(createElement(AnswerSegments, { segments: [{ kind: "correction", text: CORR }, { kind: "text", text: PROSE }] }));
  for (const [name, html] of [["conversations (TypedAnswerSegments)", conv], ["v0 (AnswerSegments)", v0]] as const) {
    const block = /<div role="note" data-platform-ai-correction=""[^>]*>(.*?)<\/div>/.exec(html);
    check(`${name}: the correction is its OWN prominent block (role=note, warning border, medium weight) — not inline text in the answer paragraph`,
      !!block && block[1].includes(CORR) && /border-\[var\(--accent-warning\)\]/.test(html) && /font-medium/.test(block[0]) && (html.match(new RegExp(CORR.slice(0, 40).replace(/[()]/g, "\\$&"), "g")) ?? []).length === 1, html);
    check(`${name}: placed ABOVE the answer paragraph, and the model's prose is shown unchanged`,
      html.indexOf("data-platform-ai-correction") < html.indexOf("<p class=\"min-w-0 whitespace-pre-wrap") && html.includes(PROSE)
      && !/<p class="min-w-0 whitespace-pre-wrap[^"]*"[^>]*>[^]*Correction:/.test(html), html);
  }
  const plain = renderToStaticMarkup(createElement(TypedAnswerSegments, { staleAsOf: null, segments: [{ kind: "text", text: "Note: x. " }, { kind: "text", text: PROSE }] }));
  check("no correction segment ⇒ no correction block (the plain note stays inline text)", !/data-platform-ai-correction/.test(plain));
  const parsed = parseMessage({
    id: "m9", role: "ASSISTANT", status: "COMPLETE", createdAt: H3, completedAt: H3, failureCode: null, unavailable: false, stale: true,
    content: [{ kind: "correction", text: CORR }, { kind: "text", text: PROSE }], citations: [], notes: [],
  });
  check("the client parser keeps a correction segment (typed), first", !!parsed && Array.isArray(parsed.content) && parsed.content[0]?.kind === "correction" && parsed.content[0].text === CORR, parsed);
  const rendered = renderStoredAnswer({ v: 1, segments: [{ kind: "correction", text: CORR }, { kind: "text", text: PROSE }], citations: [], notes: [], stop: "ANSWERED" }, null);
  check("the stored answer is served with the correction typed (renderStoredAnswer)", rendered[0]?.kind === "correction" && rendered[0].text === CORR && rendered.length === 2, rendered);
}

// ── 5. disclosure + privacy hint ────────────────────────────────────────────
console.log("\n5. the disclosure line (OD-5, owner-approved) and the v0 privacy hint");
{
  check("the disclosure is the owner-approved OD-5 wording (2026-11-07), exactly — changing it needs a new owner approval and S2 claim check",
    PLATFORM_AI_CONVERSATIONS_DISCLOSURE === "The text of your questions and answers is saved encrypted to your operator account. No one else can open your conversations in Fourth Meridian, and you can open them only while you have access to this area. A question and its answer are hidden 90 days after the question was asked, and a conversation you delete is hidden at once; both are then removed from our database at the next retention purge. Copies in database backups, and what was sent to OpenAI to answer you, follow their own retention terms.");
  check("…and no longer claims anything is pending", !/pending/i.test(PLATFORM_AI_CONVERSATIONS_DISCLOSURE) && !/PENDING OWNER|DISCLOSURE_PENDING/.test(src(MODEL)));
  const literalUses: string[] = [];
  for (const rel of [COMPONENT, PAGE, "components/platform/PlatformAiAsk.tsx"]) if (src(rel).includes("saved encrypted to your operator account")) literalUses.push(rel);
  check("the wording lives only in the model constant (no second copy)", literalUses.length === 0, literalUses);
  const composer = renderToStaticMarkup(createElement(PlatformAiComposer, { value: "", onChange: noop, onSubmit: noop, disabled: false, busy: false }));
  check("the composer renders the disclosure line", /data-platform-ai-conversations-disclosure/.test(composer) && textOf(composer).includes(PLATFORM_AI_CONVERSATIONS_DISCLOSURE));
  check("the v0 privacy hint pattern is KEPT: data-platform-ai-privacy-hint, the same id, tied by aria-describedby",
    /id="platform-ai-privacy-hint" data-platform-ai-privacy-hint=""/.test(composer) && /aria-describedby="platform-ai-privacy-hint platform-ai-conversations-disclosure"/.test(composer));
  const v0 = renderToStaticMarkup(createElement(PlatformAiAsk, { areaLabel: "Platform Operations" }));
  const hintOf = (html: string) => textOf((html.match(/data-platform-ai-privacy-hint="[^"]*"[^>]*>([\s\S]*?)<\/p>/) ?? [])[1] ?? "").replace(/&#x2019;|’|&rsquo;/g, "’");
  check("…with v0's sentence verbatim", hintOf(composer) === hintOf(v0) && hintOf(v0) === PLATFORM_AI_PRIVACY_HINT, [hintOf(composer), hintOf(v0)]);
  check("a 500-character box", /<textarea[^>]*maxLength="500"/i.test(composer));
}

// ── 6. thread states ────────────────────────────────────────────────────────
console.log("\n6. thread — failed / pending / full / limit / expired");
{
  const failedNewest = renderToStaticMarkup(createElement(Thread, {
    messages: [user("u1", "first"), answer("a1"), user("u2", "second"), answer("a2", { status: "FAILED", content: null, failureCode: "TIMEOUT" })],
    areaLabel: "Platform Operations", now: NOW, sendingQuestion: null, earlierExpired: false, onRetryFailed: noop, busy: false,
  }));
  check("a FAILED answer uses the FailedTurn pattern with its closed-code sentence and Retry on the newest",
    /data-turn="failed"/.test(failedNewest) && textOf(failedNewest).includes(FAILURE_COPY.TIMEOUT) && />\s*Retry<\/button>|<\/svg> Retry<\/button>/.test(failedNewest), failedNewest);
  const failedOlder = renderToStaticMarkup(createElement(Thread, {
    messages: [user("u1", "first"), answer("a1", { status: "FAILED", content: null, failureCode: "PROVIDER" }), user("u2", "second"), answer("a2")],
    areaLabel: "Platform Operations", now: NOW, sendingQuestion: null, earlierExpired: false, onRetryFailed: noop, busy: false,
  }));
  check("an older FAILED answer offers no Retry", /data-turn="failed"/.test(failedOlder) && !/Retry/.test(failedOlder));
  check("USER messages render as plain text bubbles (MessageCard)", /first<\/div>/.test(failedNewest) && /second<\/div>/.test(failedNewest));
  const sel = (messages: ClientMessage[], full = false) => ({ conversation: { ...CONV, full }, messages });
  const pending = view({ selected: sel([user("u1", "q"), answer("a1", { status: "PENDING", content: null })]) });
  check("a PENDING turn shows the in-flight state and DISABLES the composer",
    /data-platform-ai-in-flight/.test(pending) && /<textarea[^>]*disabled=""/.test(pending), pending);
  const sending = view({ selected: sel([user("u1", "q"), answer("a1")]), sendingQuestion: "next one", draft: "" });
  // Parity PR3 (deliberate): the "Ask"/"Asking…" pill became the shared composer's
  // round send button. While a send is in flight it shows DISABLED (aria-busy) —
  // there is no Stop (S2 2026-11-07: an abort would not cancel the server turn).
  check("while a send is in flight: the question shows, the send button is disabled and busy, and there is no Stop",
    /next one/.test(sending) && /data-platform-ai-in-flight/.test(sending)
    && /<button type="submit" disabled="" aria-label="Send message" aria-busy="true"/.test(sending) && !/Stop generating|Stop waiting/.test(sending), sending);
  const full = view({ selected: sel([user("u1", "q"), answer("a1")], true) });
  check("conversation full ⇒ read-only notice + 'Start a new conversation', no composer",
    /data-platform-ai-full/.test(full) && textOf(full).includes(CONVERSATION_FULL_COPY) && /Start a new conversation/.test(full) && !/<textarea/.test(full));
  const limit = view({ selected: null, limits: { used: 50, max: 50 } });
  check("limit reached (new conversation) ⇒ 'Delete a conversation to start another' and the box is disabled",
    /data-platform-ai-limit/.test(limit) && textOf(limit).includes(CONVERSATION_LIMIT_COPY) && /<textarea[^>]*disabled=""/.test(limit));
  const capped = view({ problem: problemFor(429, { reason: "DAILY_TURNS" }) });
  check("daily cap ⇒ v0's message", textOf(capped).includes(REFUSAL_COPY.DAILY_TURNS));
  const network = view({ problem: { kind: "NETWORK", text: "Couldn’t reach Platform AI." }, canRetrySend: true });
  check("a transport failure offers Try again (the same clientRequestId — an idempotent replay)",
    /data-platform-ai-problem="NETWORK"/.test(network) && /Try again<\/button>/.test(network));
  const cmp = code(COMPONENT);
  check("Try again on a FAILED turn sends a NEW clientRequestId; a transport retry resends the SAME pending send",
    /onRetryFailed=\{\(q\) => \{ void send\(\{ conversationId: selected\?\.conversation\.id \?\? null, clientRequestId: crypto\.randomUUID\(\), question: q \}\); \}\}/.test(cmp)
    && /onRetrySend=\{\(\) => \{ if \(retry\) void send\(retry\); \}\}/.test(cmp));
  // S2 on #434: which sends mint a clientRequestId, and which never do.
  const sendBody = cmp.slice(cmp.indexOf("async function send(s: PendingSend)"), cmp.indexOf("function onSend()"));
  check("send() itself NEVER mints a clientRequestId (it sends the PendingSend it is given)",
    sendBody.length > 200 && !/randomUUID/.test(sendBody) && /clientRequestId: s\.clientRequestId/.test(sendBody));
  check("409 TURN_IN_FLIGHT ⇒ the client re-opens the conversation and sends nothing new",
    /if \(pr\.kind === "IN_FLIGHT" && s\.conversationId\) void openConversation\(s\.conversationId\);/.test(sendBody)
    && !/IN_FLIGHT[^\n]*send\(/.test(sendBody) && problemFor(409, { code: "TURN_IN_FLIGHT" }).kind === "IN_FLIGHT");
  check("a transport failure keeps the SAME PendingSend (setRetry(s)), and Try again resends exactly it",
    /if \(!r\) \{[\s\S]*?setRetry\(s\);/.test(sendBody) && /onRetrySend=\{\(\) => \{ if \(retry\) void send\(retry\); \}\}/.test(cmp));
  // Parity PR3 (deliberate): a typed question (onSend) and a starter chip share ONE
  // fresh-question path, ask(), which is the only other minting site.
  check("an explicit Retry on a FAILED turn mints a NEW id; the only other minting site is a fresh question (ask: onSend + starter chips)",
    (cmp.match(/crypto\.randomUUID\(\)/g) ?? []).length === 2
    && /onRetryFailed=\{\(q\) => \{ void send\(\{ [^}]*clientRequestId: crypto\.randomUUID\(\)/.test(cmp)
    && /function ask\(question: string\): boolean \{[^]*?clientRequestId: crypto\.randomUUID\(\)/.test(cmp)
    && /function onSend\(\) \{\s*if \(ask\(draft\)\) setDraft\(""\);\s*\}/.test(cmp) && /onStarter=\{\(q\) => \{ ask\(q\); \}\}/.test(cmp));
  const expired = renderToStaticMarkup(createElement(Thread, {
    messages: [user("u9", "later question", H3), answer("a9")], areaLabel: "Platform Operations", now: NOW, sendingQuestion: null, earlierExpired: true, busy: false,
  }));
  check("a thread whose oldest messages expired renders, with 'Earlier messages … have expired'", textOf(expired).includes(EARLIER_EXPIRED_COPY) && /later question/.test(expired));
  const unreadable = renderToStaticMarkup(createElement(AssistantAnswer, { message: answer("a3", { unavailable: true, content: null }), areaLabel: "Platform Operations", now: NOW }));
  check("an unreadable answer says so (never raw text)", /This message can&#x27;t be shown\.|This message can’t be shown\./.test(unreadable));
  const areaLine = view({ selected: sel([user("u1", "q"), answer("a1")]) });
  check("'Answering from <area label> data' per conversation (v0 wording)", textOf(areaLine).includes("Answering from Platform Operations data only."));
}

// ── 7. layout ───────────────────────────────────────────────────────────────
console.log("\n7. layout — 375 px column, the mobile sheet control, the desktop rail");
{
  const longLabel = { ...CONV, label: "A".repeat(60) + "…" };
  const html = view({ conversations: [longLabel, { ...CONV, id: "c0000000000000000000000b", full: true }], selected: { conversation: CONV, messages: [user("u1", "B".repeat(500)), answer("a1")] } });
  check("375 px: no fixed width wider than the screen anywhere", !/\b(?:w|min-w|max-w)-\[(?:3[8-9]\d|[4-9]\d\d|\d{4,})px\]/.test(html), html.match(/\b(?:w|min-w|max-w)-\[\d+px\]/g));
  check("375 px: min-w-0 on every column and break-words on free text", (html.match(/min-w-0/g) ?? []).length >= 12 && /break-words/.test(html));
  check("375 px: nothing scrolls the page sideways (no overflow-x-scroll / whitespace-nowrap blocks / w-screen)", !/overflow-x-(auto|scroll)|w-screen|min-w-max/.test(html));
  check("the 'Conversations' sheet control is mobile-only (lg:hidden) and declares its dialog",
    /data-platform-ai-sheet-toggle=""[^>]*aria-haspopup="dialog"[^>]*class="[^"]*lg:hidden/.test(html)
    // Parity PR3 (deliberate): in the shell header the word is sr-only below sm (icon + name), like "New chat".
    && /<span class="max-sm:sr-only">Conversations<\/span><\/button>/.test(html));
  check("the desktop rail is hidden below lg and holds the same list", /<aside data-platform-ai-rail="open" aria-label="Conversations" class="hidden [^"]*lg:flex/.test(html)
    && /<aside[\s\S]*data-platform-ai-conversation-list[\s\S]*<\/aside>/.test(html));
  const collapsed = view({ railCollapsed: true });
  check("collapsed rail: the toggle only (no list), labelled 'Show conversations'",
    /data-platform-ai-rail="collapsed"/.test(collapsed) && /aria-label="Show conversations"/.test(collapsed) && !/<aside[\s\S]*data-platform-ai-conversation-list[\s\S]*<\/aside>/.test(collapsed));
  const cmp = code(COMPONENT);
  check("the mobile sheet is the shared Panel (bottom sheet on a phone), listing the same ConversationList",
    /<Panel open=\{p\.sheetOpen\} onClose=\{\(\) => p\.onSheet\(false\)\} side="left"/.test(cmp) && /<PanelContent>\{list\}<\/PanelContent>/.test(cmp));
  check("the rail's collapsed state is a per-viewer localStorage convenience in try/catch, nothing else is stored",
    (cmp.match(/localStorage/g) ?? []).length === 2 && /try \{ return window\.localStorage\.getItem\(RAIL_COLLAPSED_KEY\) === "1"; \} catch/.test(cmp)
    && /try \{ window\.localStorage\.setItem\(RAIL_COLLAPSED_KEY, v \? "1" : "0"\); \} catch/.test(cmp) && RAIL_COLLAPSED_KEY === "fm.platform-ai.rail-collapsed" && !/sessionStorage|indexedDB|document\.cookie/.test(cmp));
  const listHtml = renderToStaticMarkup(createElement(ConversationList, {
    conversations: [longLabel], selectedId: CONV.id, now: NOW, limits: { used: 1, max: 50 }, error: null, onSelect: noop, onNew: noop, onDelete: noop,
  }));
  check("list rows: derived label (truncated), area chip, last-activity time, 'New conversation' at the top, a labelled delete",
    listHtml.indexOf("New conversation") < listHtml.indexOf("data-platform-ai-area-chip") && /truncate/.test(listHtml)
    && /data-platform-ai-area-chip="[^"]*"[^>]*>Platform Operations</.test(listHtml) && /3 h ago/.test(listHtml)
    && /aria-label="Delete conversation: A{60}…"/.test(listHtml) && /aria-current="true"/.test(listHtml));
  check("delete asks for confirmation: \"Deleted conversations can't be recovered.\"",
    /<ConfirmDialog open=\{p\.confirmDelete !== null\}[^>]*message=\{DELETE_CONFIRM_COPY\}/.test(cmp) && /Deleted conversations can't be recovered\./.test(src(MODEL)));
  // Parity PR4 (deliberate): opening the latest normalises the URL to its id (REPLACE).
  check("the page opens on the latest conversation (the list is lastActivityAt desc), or an empty composer",
    /if \(openLatest && parsed\.conversations\.length > 0\) await openConversation\(parsed\.conversations\[0\]\.id, "replace"\);/.test(cmp) && /void loadList\(true\);/.test(cmp));
}

// ── 8. reuse ────────────────────────────────────────────────────────────────
console.log("\n8. reuse (§11) — MessageCard and FailedTurn only; nothing customer-only");
{
  const cmp = code(COMPONENT);
  const imports = [...cmp.matchAll(/^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"([^"]+)";/gm)].map((m) => m[1]).sort();
  // Parity PR3 (deliberate): the shared PRESENTATION primitives join the list —
  // AiShell, ConversationLog/ThinkingIndicator, the answer frame (via its own
  // module name), ComposerFrame and SuggestedPrompt. AiMark now comes with them.
  check("imports: exactly these modules", imports.join() === [
    "./PlatformAiAsk", "./PlatformAiPlaceholder", "./platform-ai-conversations-model",
    "@/components/ai/AiShell", "@/components/ai/Composer", "@/components/ai/ConversationView", "@/components/ai/SuggestedPrompt", "@/components/ai/answer-frame",
    "@/components/ai/FailedTurn", "@/components/ai/Markdown", "@/components/ai/MessageCard",
    "@/components/atlas/ConfirmDialog", "@/components/atlas/panels/Panel", "@/components/atlas/panels/PanelParts",
    "@/components/platform/platform-surface", "lucide-react", "react",
  ].sort().join(), imports);
  // Parity PR3 (deliberate): the MODULES ConversationView and Composer are now
  // imported, but only for their shared frames — never the customer components.
  const named = (mod: string) => (cmp.match(new RegExp(`import \\{([^}]*)\\} from "${mod.replace(/[/@]/g, "\\$&")}";`)) ?? [])[1]?.split(",").map((x) => x.trim()).filter(Boolean).sort().join() ?? "";
  check("from ConversationView only ConversationLog + ThinkingIndicator; from Composer only ComposerFrame; nothing from the barrel",
    named("@/components/ai/ConversationView") === "ConversationLog,ThinkingIndicator" && named("@/components/ai/Composer") === "ComposerFrame"
    && !/from "@\/components\/ai"/.test(cmp), [named("@/components/ai/ConversationView"), named("@/components/ai/Composer")]);
  check("NOT reused: ConversationView (Markdown answers), Composer (the customer disclosure), the transcript cache, Space context, Talk-about-this",
    !/<ConversationView\b|<Composer\b|transcript-cache|TalkAboutThis|talk-about-this|AiDisclosure|StarterLine|SpaceContext|useSpace|spaceId/.test(cmp));
  check("the model module imports nothing", !/^import /m.test(code(MODEL)));
}

// ── 9. privacy ──────────────────────────────────────────────────────────────
console.log("\n9. privacy — no analytics, no logging, no draft storage, routes only");
{
  const cmp = code(COMPONENT), model = code(MODEL);
  check("no console, Sentry, analytics or tracking", !/console\.|Sentry|captureException|analytics|track\(|posthog|gtag|sendBeacon/i.test(cmp + model));
  check("no keystroke handlers (only the controlled textarea's onChange)", !/onKey(Down|Up|Press)|onInput|addEventListener\(\s*["']key/.test(cmp));
  const fetches = [...cmp.matchAll(/\bfetch\(/g)].length;
  check("ONE fetch site (the call() helper), same-origin credentials, no-store", fetches === 1 && /fetch\(url, \{ credentials: "same-origin", cache: "no-store", \.\.\.init \}\)/.test(cmp));
  const urls = [...cmp.matchAll(/\b(call|postJson)\(([^,)]+)/g)].map((m) => m[2].trim());
  check("every call targets a conversation route", urls.length >= 5 && urls.every((u) => /^(PLATFORM_AI_CONVERSATIONS_URL|conversationUrl\(|conversationMessagesUrl\(|url)/.test(u)), urls);
  check("bodies are exactly { clientRequestId, question } (the strict server body)",
    (cmp.match(/\{ clientRequestId: s\.clientRequestId, question: s\.question \}/g) ?? []).length === 2 && !/\barea\b\s*:/.test(cmp.replace(/areaLabel/g, "")));
  check("clientRequestId is a fresh UUID per send", (cmp.match(/crypto\.randomUUID\(\)/g) ?? []).length === 2);
}

// ── 10. the shared shell (parity PR3) ───────────────────────────────────────
console.log("\n10. shared shell (parity PR3) — frame, log, thinking dots, answer frame, composer, starters, rail");
{
  const sel = (messages: ClientMessage[]) => ({ conversation: CONV, messages });
  const conv = view({ selected: sel([user("u1", "q"), answer("a1")]) });
  check("the page is the shared AiShell: data-ai-layout / data-ai-scroll / data-ai-dock, h1 'Platform AI', the area as context ('Area: ' for screen readers)",
    /data-ai-layout="conversation"/.test(conv) && /data-ai-scroll/.test(conv) && /data-ai-dock="conversation"/.test(conv)
    && /<h1[^>]*>Platform AI<\/h1>/.test(conv) && /<span class="sr-only">Area: <\/span>Platform Operations/.test(conv), conv);
  check("…the composer sits in the dock (once), the reading region scrolls inside the shell",
    (conv.match(/id="platform-ai-question"/g) ?? []).length === 1 && conv.indexOf("data-ai-dock") < conv.indexOf('id="platform-ai-question"')
    && conv.indexOf("data-ai-scroll") < conv.indexOf("data-ai-dock"));
  check("the area notice, privacy hint and OD-5 line are all still on the page",
    textOf(conv).includes("Answering from Platform Operations data only.") && textOf(conv).includes(PLATFORM_AI_CONVERSATIONS_DISCLOSURE)
    && /data-platform-ai-privacy-hint/.test(conv));
  check("the thread is the shared reading column (ConversationLog: role=log, max-w-3xl, pb-10)",
    /<div role="log" aria-label="Conversation" class="max-w-3xl mx-auto w-full space-y-7 px-1 pt-3 pb-10">/.test(conv));
  check("a header 'New chat' control (the Personal class string) starts a new conversation",
    /data-platform-ai-new-chat=""[^>]*>[\s\S]*?<span class="max-sm:sr-only">New chat<\/span>/.test(conv));

  // Rail in the side slot.
  const tree = PlatformAiConversationsView(viewProps({ selected: sel([user("u1", "q"), answer("a1")]) }));
  const shell = elements(tree).find((e) => e.type === AiShell);
  const sideRail = shell ? elements((shell.props as { side?: unknown }).side).find((e) => e.type === "aside") : undefined;
  check("the desktop rail is passed in AiShell's `side` slot (an <aside data-platform-ai-rail>)",
    !!sideRail && (sideRail.props as Record<string, unknown>)["data-platform-ai-rail"] === "open", shell ? Object.keys(shell.props as object) : "no AiShell");
  check("…rendered beside the reading region (before data-ai-scroll in the same row), hidden below lg, scrolling on its own",
    /<div class="flex flex-1 min-h-0 min-w-0"><aside data-platform-ai-rail="open" aria-label="Conversations" class="hidden [^"]*overflow-y-auto[^"]*lg:flex/.test(conv)
    && conv.indexOf("data-platform-ai-rail") < conv.indexOf("data-ai-scroll"));

  // Thinking indicator while busy.
  const busy = view({ selected: sel([user("u1", "q"), answer("a1")]), sendingQuestion: "next one" });
  const dots = (busy.match(/animate-bounce/g) ?? []).length;
  check("while busy: the shared three-dot ThinkingIndicator (role=status, Platform sr label), not the old 'Answering…' text",
    dots === 3 && /data-platform-ai-in-flight=""[^>]*><div role="status"/.test(busy) && busy.includes(`<span class="sr-only">${PLATFORM_AI_THINKING_LABEL}</span>`)
    && !/>Answering…</.test(busy), busy);
  check("…and the sent question shows above it as the operator's bubble", busy.indexOf("next one") > -1 && busy.indexOf("next one") < busy.indexOf("animate-bounce"));
  const stored = view({ selected: sel([user("u1", "q"), answer("a1", { status: "PENDING", content: null })]) });
  check("a stored PENDING turn: the same dots plus 'Check again'", (stored.match(/animate-bounce/g) ?? []).length === 3 && /Check again<\/button>/.test(stored));
  const idle = view({ selected: sel([user("u1", "q"), answer("a1")]) });
  check("idle: no thinking indicator", !/animate-bounce|data-platform-ai-in-flight/.test(idle));

  // The answer frame around the typed segments.
  const CORR = "Correction: these figures cover so far this month, not the period you asked about.";
  const framed = renderToStaticMarkup(createElement(AssistantAnswer, { message: answer("a5", {
    stale: false, content: [{ kind: "correction", text: CORR }, { kind: "text", text: "**not bold** <img src=x> " }, { kind: "figure", text: "7", metric: "k@1", window: 7 }],
  }), areaLabel: "Platform Operations", now: NOW }));
  const gutter = framed.indexOf('<div class="pt-1.5 shrink-0">'), prose = framed.indexOf("text-[15px]");
  const corr = framed.indexOf("data-platform-ai-correction"), body = framed.indexOf('<p class="min-w-0 whitespace-pre-wrap');
  check("the answer sits in the shared frame: AI-mark gutter, 15 px prose column; the bordered card is gone",
    gutter > -1 && prose > gutter && /<span aria-hidden="true" class="inline-block[^"]*rounded-full/.test(framed.slice(gutter, prose)) /* the AiMark */ && !/rounded-xl border[^"]*p-4/.test(framed), framed);
  check("the period correction is still its own block ABOVE the answer text, inside the frame", corr > prose && body > corr && framed.includes(CORR));
  check("no Markdown rendering path: Markdown syntax and HTML stay literal inside the frame",
    !/<(strong|em|img)\b/.test(framed) && framed.includes("**not bold**") && framed.includes("&lt;img"));
  const alias = src("components/ai/answer-frame.ts");
  const card = src("components/ai/AnswerCard.tsx");
  check("the frame module is a re-export of the frame only, and the frame itself renders no Markdown",
    /^export \{ AnswerFrame \} from "@\/components\/ai\/AnswerCard";$/m.test(alias) && (alias.match(/^(export|import) /gm) ?? []).length === 1
    && !/<Markdown/.test(card.slice(card.indexOf("export function AnswerFrame"), card.indexOf("export function AnswerCard("))));
  check("notes, citations and the area line ride in the frame's extras (after the body)",
    framed.indexOf("A deterministic note.") > body && framed.indexOf("Provider outcomes") > body && framed.indexOf("Answering from Platform Operations data.") > body);

  // Composer: the shared frame, Enter-to-send, no Stop.
  let submitted = 0;
  const composerEl = PlatformAiComposer({ value: "q", onChange: noop, onSubmit: () => { submitted++; }, disabled: false, busy: false }) as ReactElement;
  const cp = composerEl.props as Record<string, unknown>;
  check("the Platform composer IS the shared ComposerFrame with v0's box contract",
    composerEl.type === ComposerFrame && cp.inputId === "platform-ai-question" && cp.maxLength === PLATFORM_AI_COMPOSER_MAX && cp.label === "Ask Platform AI"
    && cp.describedBy === "platform-ai-privacy-hint platform-ai-conversations-disclosure" && cp.trailing === undefined);
  (cp.onSubmit as () => void)();
  check("…its submit is the Platform send (onSubmit passes straight through)", submitted === 1);
  check("Enter sends; Shift+Enter and an IME-confirming Enter do not (the shared isSendKey)",
    isSendKey({ key: "Enter", shiftKey: false }) && !isSendKey({ key: "Enter", shiftKey: true }) && !isSendKey({ key: "Enter", shiftKey: false, isComposing: true }) && !isSendKey({ key: "a", shiftKey: false }));
  const frameSrc = src("components/ai/Composer.tsx");
  check("…wired in the frame: onKeyDown → isSendKey → preventDefault + onSubmit, enterKeyHint=send",
    /onKeyDown=\{\(e\) => \{\s*if \(isSendKey\(\{ key: e\.key, shiftKey: e\.shiftKey, isComposing: e\.nativeEvent\.isComposing \}\)\) \{\s*e\.preventDefault\(\);\s*onSubmit\(\);/.test(frameSrc)
    && /enterkeyhint="send"/i.test(renderToStaticMarkup(createElement(PlatformAiComposer, { value: "", onChange: noop, onSubmit: noop, disabled: false, busy: false }))));
  const auto = renderToStaticMarkup(createElement(PlatformAiComposer, { value: "", onChange: noop, onSubmit: noop, disabled: false, busy: false }));
  check("the box is the auto-growing Atlas Textarea inside the pill (no bare resize-y textarea)", /rounded-\[22px\]/.test(auto) && !/resize-y/.test(auto));
  const busyComposer = renderToStaticMarkup(createElement(PlatformAiComposer, { value: "typing", onChange: noop, onSubmit: noop, disabled: false, busy: true }));
  check("busy: one disabled send button, never a Stop button",
    (busyComposer.match(/<button/g) ?? []).length === 1 && /<button type="submit" disabled="" aria-label="Send message" aria-busy="true"/.test(busyComposer) && !/Stop/.test(busyComposer));
  check("the counter stays beneath the box", /data-platform-ai-counter=""[^>]*>0(<!-- -->)?\/(<!-- -->)?500</.test(auto) && auto.indexOf("data-platform-ai-counter") > auto.indexOf("<textarea"), auto.match(/data-platform-ai-counter[^<]*<[^<]*/)?.[0]);

  // Empty state + starter chips.
  const empty = view({ selected: null, conversations: [] });
  check("empty state: a short headline and the starter chips, in the shell's empty layout",
    /data-ai-layout="empty"/.test(empty) && empty.includes(`>${PLATFORM_AI_STARTER_HEADLINE}</h2>`)
    && PLATFORM_AI_STARTER_PROMPTS.every((q) => empty.includes(`>${q}</button>`)) && PLATFORM_AI_STARTER_PROMPTS.length >= 3 && PLATFORM_AI_STARTER_PROMPTS.length <= 4);
  check("starter copy is generic and figure-free (no digits, emails, ids or customer wording)",
    [PLATFORM_AI_STARTER_HEADLINE, ...PLATFORM_AI_STARTER_PROMPTS].every((t) => !/\d|@|customer|user\b|account number/i.test(t)));
  const asked: string[] = [];
  const emptyTree = PlatformAiConversationsView(viewProps({ selected: null, conversations: [], onStarter: (q) => { asked.push(q); } }));
  const emptyShell = elements(emptyTree).find((e) => e.type === AiShell);
  const chips = emptyShell ? elements((emptyShell.props as { aside?: unknown }).aside).filter((e) => e.type === SuggestedPrompt) : [];
  for (const c of chips) (c.props as { onSelect: () => void }).onSelect();
  check("each chip submits exactly its own text (onStarter → ask → a fresh clientRequestId)",
    chips.length === PLATFORM_AI_STARTER_PROMPTS.length && asked.join("|") === PLATFORM_AI_STARTER_PROMPTS.join("|"), asked);
  check("no chips when a new conversation is not allowed (limit reached)", !/data-platform-ai-starters/.test(view({ selected: null, limits: { used: 50, max: 50 } })));
  check("the empty state is the composer's, not a conversation's: no chips once a thread is open", !/data-platform-ai-starters/.test(conv));
}

// ── 11. history (parity PR4) ────────────────────────────────────────────────
console.log("\n11. history (parity PR4) — ?c= deep link, grouping, delete-next, skeleton, one writer");
{
  // The parse: an opaque id or nothing; anything else is "invalid" (⇒ the same not-found, no request).
  check("?c= is the param; absent / empty ⇒ none", PLATFORM_AI_CONVERSATION_PARAM === "c"
    && readConversationParam("").kind === "none" && readConversationParam("?c=").kind === "none" && readConversationParam("?x=1").kind === "none");
  const ok = readConversationParam("?c=c0000000000000000000000a");
  check("a cuid-shaped value is an id", ok.kind === "id" && ok.id === "c0000000000000000000000a");
  check("a malformed value is invalid (never sent)", ["?c=%3Cscript%3E", "?c=a%2Fb", "?c=" + "x".repeat(65), "?c=a b", "?c=..%2F"].every((q) => readConversationParam(q).kind === "invalid"));
  check("href: sets / replaces / removes ?c= and keeps other params and the hash",
    conversationHref({ pathname: "/p", search: "" }, "abc") === "/p?c=abc"
    && conversationHref({ pathname: "/p", search: "?c=old&x=1", hash: "#h" }, "new") === "/p?c=new&x=1#h"
    && conversationHref({ pathname: "/p", search: "?c=old" }, null) === "/p"
    && conversationHref({ pathname: "/p", search: "?x=1&c=old" }, null) === "/p?x=1");

  // Grouping: the UTC calendar day of `now` (the clock utcStamp shows).
  const at = (id: string, lastActivityAt: string): ClientConversation => ({ ...CONV, id, lastActivityAt });
  const now = new Date("2026-01-10T00:30:00.000Z");
  const groups = groupConversations([
    at("t1", "2026-01-10T00:29:00.000Z"), at("t0", "2026-01-10T00:00:00.000Z"),
    at("e1", "2026-01-09T23:59:59.999Z"), at("e2", "2026-01-02T12:00:00.000Z"), at("bad", "not a time"),
  ], now);
  check("Today = at or after 00:00 UTC of now's day; 23:59:59.999 the day before is Earlier; unparseable is Earlier",
    groups.length === 2 && groups[0].label === "Today" && groups[0].conversations.map((c) => c.id).join() === "t1,t0"
    && groups[1].label === "Earlier" && groups[1].conversations.map((c) => c.id).join() === "e1,e2,bad", groups.map((x) => [x.label, x.conversations.map((c) => c.id)]));
  check("the boundary is UTC, not the process's local zone (00:30 UTC: a 23:59 UTC activity is Earlier even where it is the same local day)",
    groupConversations([at("x", "2026-01-09T23:59:00.000Z")], now)[0].key === "earlier");
  check("empty groups are omitted", groupConversations([at("e", "2026-01-01T00:00:00.000Z")], now).map((x) => x.label).join() === "Earlier"
    && groupConversations([], now).length === 0);
  const listHtml = renderToStaticMarkup(createElement(ConversationList, {
    conversations: [at("t1", "2026-01-10T11:00:00.000Z"), at("e1", "2026-01-08T11:00:00.000Z")], selectedId: "t1", now: NOW,
    limits: null, error: null, onSelect: noop, onNew: noop, onDelete: noop,
  }));
  check("the list renders 'Today' then 'Earlier' headings, each row with its title (full text in title=) and last activity",
    listHtml.indexOf(">Today</h3>") > -1 && listHtml.indexOf(">Today</h3>") < listHtml.indexOf(">Earlier</h3>")
    && (listHtml.match(/<span title="How are providers doing this week\?"[^>]*truncate/g) ?? []).length === 2
    && /data-platform-ai-last-activity="" title="2026-01-10 11:00 UTC">1 h ago</.test(listHtml) && /title="2026-01-08 11:00 UTC">2 days ago</.test(listHtml), listHtml);

  // Delete-next.
  check("delete-next: the most recent remaining by lastActivityAt (input order not trusted); none ⇒ null",
    nextConversationAfterDelete([at("a", "2026-01-10T10:00:00.000Z"), at("b", "2026-01-09T10:00:00.000Z"), at("c", "2026-01-10T11:00:00.000Z")], "c") === "a"
    && nextConversationAfterDelete([at("a", "2026-01-10T10:00:00.000Z"), at("z", "bad")], "a") === "z"
    && nextConversationAfterDelete([at("a", "2026-01-10T10:00:00.000Z")], "a") === null && nextConversationAfterDelete([], "a") === null);

  // No empty-state flash.
  const listLoading = view({ conversations: null, selected: null, limits: null });
  check("while the first list loads: the conversation layout with skeletons — no empty state, no chips, no 'No conversations yet.', box disabled",
    /data-ai-layout="conversation"/.test(listLoading) && /data-platform-ai-thread-loading=""[^>]*aria-busy="true"/.test(listLoading)
    && /data-platform-ai-list-loading=""[^>]*aria-busy="true"/.test(listLoading)
    && !/data-platform-ai-empty|data-platform-ai-starters|No conversations yet\.|Loading…/.test(listLoading) && /<textarea[^>]*disabled=""/.test(listLoading), listLoading);
  const threadLoading = view({ selected: null, threadLoading: true });
  check("while a thread loads: the same skeleton, never the empty state",
    /data-ai-layout="conversation"/.test(threadLoading) && /data-platform-ai-thread-loading/.test(threadLoading) && !/data-platform-ai-empty/.test(threadLoading));
  const listFailed = view({ conversations: [], listError: UNAVAILABLE_COPY_T, selected: null });
  check("a failed list read is not 'loading' forever (the empty composer shows, with the error)", /data-ai-layout="empty"/.test(listFailed) && listFailed.includes(UNAVAILABLE_COPY_T));
  const notFound = view({ selected: null, problem: NOT_FOUND_PROBLEM });
  check("the one not-found: the shared copy in the status line", /data-platform-ai-problem="NOT_FOUND"/.test(notFound) && textOf(notFound).includes(NOT_FOUND_COPY) && NOT_FOUND_PROBLEM.text === NOT_FOUND_COPY);

  // The one writer.
  const cmp = code(COMPONENT);
  check("ONE pushState and ONE replaceState site, both with null state (Next 16 __NA rule), inside writeConversationParam",
    (cmp.match(/history\.pushState\(/g) ?? []).length === 1 && (cmp.match(/history\.replaceState\(/g) ?? []).length === 1
    && /window\.history\.replaceState\(null, "", next\)/.test(cmp) && /window\.history\.pushState\(null, "", next\)/.test(cmp)
    && /function writeConversationParam\(id: string \| null, intent: HistoryIntent\): void \{[^}]*conversationHref\(loc, id\)/.test(cmp));
  check("writeConversationParam is called with an id or null only (never a title, question or area)",
    [...cmp.matchAll(/writeConversationParam\(([^,]+),/g)].map((m) => m[1].trim()).every((a) => /^(id|null|next|pair\.conversation\.id|id: string \| null)$/.test(a)),
    [...cmp.matchAll(/writeConversationParam\(([^,]+),/g)].map((m) => m[1]));
  check("open from the list PUSHES; New chat PUSHES the cleared URL; not-found / delete / latest / a new conversation REPLACE",
    /onSelect=\{\(id\) => \{ setSheetOpen\(false\); void openConversation\(id, "push"\); \}\}/.test(cmp)
    && /function onNew\(\) \{\s*clearSelection\("push"\);/.test(cmp)
    && /const showNotFound = useCallback\(\(id: string \| null\) => \{\s*clearSelection\("replace"\);/.test(cmp)
    && /if \(next\) void openConversation\(next, "replace"\);\s*else \{ clearSelection\("replace"\);/.test(cmp)
    && /writeConversationParam\(pair\.conversation\.id, "replace"\)/.test(cmp));
  check("every 404 on open ⇒ the ONE not-found (no branch on the body); Back / Forward never write",
    /if \(r && r\.status === 404\) \{ showNotFound\(id\); return; \}/.test(cmp)
    && /const onPop = \(\) => applyParam\(false\);/.test(cmp) && /if \(param\.kind === "id"\) \{ void openConversation\(param\.id\);/.test(cmp));
  check("no client existence hint: the component never compares the URL id with the list before asking the server",
    !/conversations[^;\n]*\.(some|find|includes)\([^)]*param/.test(cmp));
  check("the id is never put in browser storage (only the rail key is ever written)",
    (cmp.match(/localStorage\.setItem\(/g) ?? []).length === 1 && /localStorage\.setItem\(RAIL_COLLAPSED_KEY,/.test(cmp) && !/sessionStorage|indexedDB|document\.cookie/.test(cmp));

  // S2 rulings: no rename, no per-conversation export.
  check("no rename and no per-conversation export (the account data export stays the export path)",
    !/rename|Rename|export conversation|Export|download|Download|Blob\(|createObjectURL/.test(cmp) && !/method: "PATCH"|method: "PUT"/.test(cmp));

  // Referrer-Policy: the query never leaves the origin.
  const sh = src("lib/security-headers.test.ts");
  check("Referrer-Policy is strict-origin-when-cross-origin (next.config.ts; pinned by lib/security-headers.test.ts)",
    /\{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" \}/.test(src("next.config.ts"))
    && /headers\.get\("Referrer-Policy"\) === "strict-origin-when-cross-origin"/.test(sh));

  // The view seam is the page's default.
  check("the page passes no View (the seam is for the history test only)", !/View=/.test(code(PAGE))
    && /export function PlatformAiConversations\(\{ areaLabel, View = PlatformAiConversationsView \}/.test(cmp));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
