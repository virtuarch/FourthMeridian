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
 *   3. stale evidence (§4.3; owner + S2) — answer-level chip when figures share one time, per-figure otherwise
 *   4. no Markdown parser — typed segments only; links only same-origin
 *   5. the short line + "Privacy & retention" (S2 C1–C4)
 *   6. thread states — failed / pending / full / limit / expired
 *   7. layout — 375 px column, the mobile sheet control, the desktop rail
 *   8. reuse (§11) — shared presentation only; no customer-only modules
 *   9. privacy — no analytics, no logging, no draft storage, routes only
 *  10. shared shell (parity PR3) — AiShell, ConversationLog + ThinkingIndicator,
 *      the answer frame around the typed segments, ComposerFrame (Enter-to-send,
 *      no Stop), starter chips, the rail in the `side` slot
 *  11. history (parity PR4) — the `?c=` parse and href, Today / Earlier grouping
 *      (UTC), delete-next, the loading skeleton, the one History writer, no
 *      rename / per-conversation export, Referrer-Policy. The behaviour on a real
 *      orchestrator (deep link, PUSH / REPLACE / Back, not-found, delete-next,
 *      storage) is components/platform/platform-ai-history.test.ts.
 *  12. v0 parity (PR6) — flag-on v0 renders the same shell, nothing saved
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
import { AnswerSegments, PlatformAiAsk, PlatformAiSessionView, SessionAnswer } from "./PlatformAiAsk";
import { PLATFORM_AI_SUBJECT_NOTICE, showsSubjectNotice } from "@/lib/platform/intelligence/ai/authz/subject-notice";
import { renderStoredAnswer } from "@/lib/platform/intelligence/ai/conversations/handlers";
import { AiShell } from "@/components/ai/AiShell";
import { ComposerFrame } from "@/components/ai/Composer";
import { SuggestedPrompt } from "@/components/ai/SuggestedPrompt";
import { isSendKey } from "@/components/ai/conversation-surface";
import {
  AssistantAnswer, ConversationList, PlatformAiConversations, PlatformAiConversationsView, Thread,
  type PlatformAiConversationsViewProps,
} from "./PlatformAiConversations";
import { PlatformAiComposer, PlatformAiStarters, TypedAnswerSegments } from "./platform-ai-presentation";
import {
  CONVERSATION_FULL_COPY, CONVERSATION_LIMIT_COPY, EARLIER_EXPIRED_COPY, FAILURE_COPY, NOT_FOUND_COPY,
  PLATFORM_AI_COMPOSER_MAX, PLATFORM_AI_CONVERSATIONS_DISCLOSURE, PLATFORM_AI_CONVERSATIONS_LINE, PLATFORM_AI_COUNTER_FROM, PLATFORM_AI_PRIVACY_HINT,
  PLATFORM_AI_RETENTION_DAYS_CLIENT, PLATFORM_AI_SESSION_LINE, PLATFORM_AI_SESSION_NOT_SAVED, PLATFORM_AI_STARTER_HEADLINE, PLATFORM_AI_STARTER_PROMPTS, PLATFORM_AI_THINKING_LABEL,
  NOT_FOUND_PROBLEM, PLATFORM_AI_CONVERSATION_PARAM, RAIL_COLLAPSED_KEY, REFUSAL_COPY, STALE_AFTER_MS, TURN_IN_FLIGHT_COPY, PLATFORM_AI_PROVIDER,
  answerBlocks, conversationHref, groupConversations, nextConversationAfterDelete, readConversationParam, showConversationCount, staleChips, noticeDefaultOpen,
  answerAsOf, conversationMessagesUrl, conversationUrl, earlierMessagesExpired, hasPendingTurn,
  parseList, parseMessage, parsePair, parseThread, problemFor, questionBefore, relativeTime, utcStamp,
  type ClientConversation, type ClientMessage, type ClientSegment,
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
const PRESENTATION = "components/platform/platform-ai-presentation.tsx";
const V0 = "components/platform/PlatformAiAsk.tsx";
const PAGE = "app/(shell)/dashboard/platform/ai/page.tsx";

// ── 1. flag gating ──────────────────────────────────────────────────────────
console.log("1. flag gating — decided server-side by the page; OFF by default; v0 untouched");
{
  check("the flags are unset in this process ⇒ env.isPlatformAiConversationsEnabled is false (and v0 is off too)",
    env.isPlatformAiConversationsEnabled === false && env.isPlatformAiEnabled === false);
  const page = code(PAGE);
  const iV0Flag = page.indexOf("if (!env.isPlatformAiEnabled) return <PlatformAiPlaceholder />;");
  const iArea = page.indexOf("const area = platformAiAreaFor(spaces);");
  const iConv = page.indexOf("if (env.isPlatformAiConversationsEnabled) return <PlatformAiConversations areaLabel={platformAiAreaLabel(area)} memory={isMemoryEffective(env)} subjectNotice={subjectNotice} />;");
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
  // v0 (flag on, conversations off): the SAME shell as conversations (Personal parity PR6), a single session, no history UI.
  const v0 = renderToStaticMarkup(createElement(PlatformAiAsk, { areaLabel: "Platform Operations" }));
  check("v0 PlatformAiAsk renders the shared shell (empty layout, Platform AI title, the area as the header context), no conversation UI",
    /data-platform-ai-session=""/.test(v0) && /data-ai-layout="empty"/.test(v0) && /<h1[^>]*>Platform AI<\/h1>/.test(v0)
    && /<span class="sr-only">Answering from: <\/span>Platform Operations/.test(v0)
    && !/data-platform-ai-conversations|data-platform-ai-rail|data-platform-ai-sheet-toggle|History/.test(v0), v0);
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
    PLATFORM_AI_RETENTION_DAYS_CLIENT === PLATFORM_AI_RETENTION_DAYS && PLATFORM_AI_RETENTION_DAYS === 7, [PLATFORM_AI_RETENTION_DAYS_CLIENT, PLATFORM_AI_RETENTION_DAYS]);
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const gapAfter = (createdAt: string) => [{ createdAt: new Date(Date.parse(createdAt) + 2 * DAY).toISOString() }];
  const R = PLATFORM_AI_RETENTION_DAYS_CLIENT * DAY;
  const twoDays = ago(2 * DAY), pastLine = ago(R + DAY), exactly = ago(R), justUnder = ago(R - 1);
  check("S2 on #434: a 2-day-old conversation WITH a gap ⇒ no 'expired' copy (retention cannot have acted yet)",
    !earlierMessagesExpired({ createdAt: twoDays }, [{ createdAt: ago(60 * 60 * 1000) }], NOW));
  check("an 8-day-old conversation with a gap ⇒ the copy", earlierMessagesExpired({ createdAt: pastLine }, gapAfter(pastLine), NOW));
  check("boundary: exactly 7 days old ⇒ the copy (≥); 7 days − 1 ms ⇒ none",
    earlierMessagesExpired({ createdAt: exactly }, gapAfter(exactly), NOW) && !earlierMessagesExpired({ createdAt: justUnder }, gapAfter(justUnder), NOW));
  check("old enough but no gap (same transaction), or no messages ⇒ no copy",
    !earlierMessagesExpired({ createdAt: pastLine }, [{ createdAt: pastLine }], NOW) && !earlierMessagesExpired({ createdAt: pastLine }, [], NOW)
    && !earlierMessagesExpired({ createdAt: "nope" }, gapAfter(pastLine), NOW));
  check("the view passes the render clock (p.now) to the age condition",
    /earlierMessagesExpired\(p\.selected\.conversation, messages, p\.now\)/.test(code(COMPONENT)));
  check("pending + retry question helpers",
    hasPendingTurn([user("u", "q"), answer("a", { status: "PENDING", content: null })]) && !hasPendingTurn([user("u", "q"), answer("a")])
    && questionBefore([user("u", "the question"), answer("a")], 1) === "the question" && questionBefore([answer("a")], 0) === null);
}

// ── 3. stale evidence ───────────────────────────────────────────────────────
console.log("\n3. stale evidence (§4.3; owner + S2) — one answer-level chip when figures share one time; per-figure chips otherwise; never stale-as-current");
{
  const render = (m: ClientMessage, now = NOW) => renderToStaticMarkup(createElement(AssistantAnswer, { message: m, now }));
  const shared = render(answer("a1"));
  check("all figures share one observation time (the answer's; no observedAt from the server) ⇒ ONE answer-level 'Figures as of 3 h ago' chip, UTC title, no per-figure chip",
    (shared.match(/data-platform-ai-stale-chip="answer"/g) ?? []).length === 1 && /data-platform-ai-stale-chip="answer" title="2026-01-10 09:00 UTC"[^>]*>Figures as of 3 h ago</.test(shared)
    && !/data-platform-ai-stale-chip="figure"/.test(shared) && answerAsOf(H3, NOW) === "Figures as of 3 h ago", shared);
  check("…the chip sits above the answer body", shared.indexOf('data-platform-ai-stale-chip="answer"') < shared.indexOf("data-platform-ai-body"));
  const sharedOther = render(answer("a1b", { content: [
    { kind: "figure", text: "1", metric: "k@1", window: 7, observedAt: "2026-01-10T06:00:00.000Z" },
    { kind: "text", text: " and " }, { kind: "figure", text: "2", metric: "j@1", window: 7, observedAt: "2026-01-10T06:00:00.000Z" },
  ] }));
  check("all figures share an observedAt that differs from the answer time ⇒ the ONE answer-level chip states THAT time", /Figures as of 6 h ago/.test(sharedOther) && !/data-platform-ai-stale-chip="figure"/.test(sharedOther));
  const mixedMsg = answer("a2", { content: [
    { kind: "text", text: "Jobs " }, { kind: "figure", text: "5", metric: "k@1", window: 7 },
    { kind: "text", text: ", providers " }, { kind: "figure", text: "9", metric: "j@1", window: 7, observedAt: "2026-01-09T12:00:00.000Z" },
  ] });
  const mixed = render(mixedMsg);
  check("figures with DIFFERENT observation times ⇒ the answer chip (the answer's time) + an 'as of' chip on the figure whose time differs only",
    /Figures as of 3 h ago/.test(mixed) && (mixed.match(/data-platform-ai-stale-chip="figure"/g) ?? []).length === 1
    && /data-platform-ai-figure=""[^>]*>9<\/span><span data-platform-ai-stale-chip="figure" title="2026-01-09 12:00 UTC"[^>]*>as of 1 day ago</.test(mixed)
    && !/>5<\/span><span data-platform-ai-stale-chip/.test(mixed), mixed);
  const sc = staleChips(mixedMsg, NOW);
  check("staleChips: per-figure map keyed by segment index", sc.answer === H3 && sc.figures.size === 1 && sc.figures.get(3) === "2026-01-09T12:00:00.000Z");
  const recent = "2026-01-10T11:30:00.000Z";
  const currentFresh = render(answer("a3", { stale: false, createdAt: recent }));
  check("a just-answered current answer under the threshold ⇒ no chip", !/data-platform-ai-stale-chip/.test(currentFresh) && /data-platform-ai-answer="current"/.test(currentFresh) && STALE_AFTER_MS === 60 * 60 * 1000);
  check("a PRIOR answer is never shown as current: chip even when under the threshold", /Figures as of 30 min ago/.test(render(answer("a4", { createdAt: recent }))));
  check("a current answer older than the threshold ⇒ chip", /Figures as of 3 h ago/.test(render(answer("a5", { stale: false }))));
  check("…and a current answer whose differing figure is old ⇒ that figure's chip even with the answer fresh",
    staleChips(answer("a6", { stale: false, createdAt: recent, content: [{ kind: "figure", text: "1", metric: "k@1", window: 7 }, { kind: "figure", text: "2", metric: "j@1", window: 7, observedAt: H3 }] }), NOW).figures.get(1) === H3);
  check("no figures ⇒ no chip", staleChips(answer("a7", { content: [{ kind: "text", text: "Nothing measured." }] }), NOW).answer === null);
  check("observedAt is parsed only as a valid time string", (parseMessage({ id: "m", role: "ASSISTANT", status: "COMPLETE", createdAt: H3, content: [{ kind: "figure", text: "1", metric: "k@1", observedAt: "bad" }, { kind: "figure", text: "2", metric: "k@1", observedAt: H3 }] })?.content as { observedAt?: string }[]).map((x) => x.observedAt ?? "-").join() === `-,${H3}`);
  check("every prior answer carries its UTC time as a title", /data-platform-ai-answer="stale" title="2026-01-10 09:00 UTC"/.test(shared));
  check("the figure text is the server's stored text, never refreshed in place", /data-platform-ai-figure=""[^>]*>12</.test(shared) && /data-platform-ai-figure=""[^>]*>3</.test(shared));
  const cmp = code(COMPONENT);
  check("the orchestrator marks every earlier answer stale when a new pair lands (as a re-read would)", /role === "ASSISTANT" \? \{ \.\.\.m, stale: true \}/.test(cmp));
}

// ── 4. no Markdown parser ───────────────────────────────────────────────────
console.log("\n4. no Markdown parser — typed segments only (paragraph / list STRUCTURE only); links only same-origin");
{
  const hostile = renderToStaticMarkup(createElement(TypedAnswerSegments, { segments: [
    { kind: "text", text: "**bold** _em_ ![x](https://evil.test/a.png) <img src=x onerror=alert(1)> [y](https://evil.test)" },
    { kind: "link", text: "abs", href: "https://evil.test/forged" },
    { kind: "link", text: "proto", href: "//evil.test" },
    { kind: "link", text: "js", href: "javascript:alert(1)" },
    { kind: "link", text: "ok", href: "/dashboard/platform/PLATFORM_OPS" },
    { kind: "text", text: "\n- <script>x</script> item\n1. [z](https://evil.test) numbered" },
  ] }));
  check("Markdown syntax and HTML stay literal text (no <strong>, <em>, <img>, <script>)",
    !/<(strong|em|img|script)\b/.test(hostile) && hostile.includes("**bold**") && hostile.includes("&lt;img") && hostile.includes("&lt;script&gt;"), hostile);
  check("only the same-origin link renders as <a>; absolute, protocol-relative and javascript: are text",
    (hostile.match(/<a /g) ?? []).length === 1 && /<a href="\/dashboard\/platform\/PLATFORM_OPS"/.test(hostile) && !/href="(https?:|\/\/|javascript:)/.test(hostile), hostile);
  check("…and a list item's text is still text ([z](…) literal inside the <li>)", /<li class="min-w-0"><span>\[z\]\(https:\/\/evil\.test\) numbered<\/span><\/li>/.test(hostile), hostile);
  // answerBlocks: structure only.
  const blocks = answerBlocks([
    { kind: "text", text: "Para one line A\nline B with " }, { kind: "figure", text: "7", metric: "k@1", window: 7 }, { kind: "text", text: ".\n\nPara two.\n- first " },
    { kind: "link", text: "Providers", href: "/x" }, { kind: "text", text: "\n* second\n• third\n\n1. one\n2) two\n\n**not a list**" },
    { kind: "correction", text: "Correction: excluded from the body." },
  ]);
  check("answerBlocks: blank lines split paragraphs, single newlines are line breaks, -/*/• lines form a <ul>, 1./2) lines an <ol>",
    blocks.map((b) => b.kind).join() === "p,p,ul,ol,p"
    && blocks[0].kind === "p" && blocks[0].lines.length === 2 && blocks[0].lines[1].some((x) => x.kind === "figure")
    && blocks[2].kind === "ul" && blocks[2].items.length === 3 && blocks[2].items[0].some((x) => x.kind === "link")
    && blocks[3].kind === "ol" && blocks[3].items.length === 2
    && blocks[4].kind === "p" && blocks[4].lines[0][0].text === "**not a list**", JSON.stringify(blocks));
  check("answerBlocks: the marker is dropped from the item text, nothing else is rewritten; corrections are not in the body",
    blocks[2].kind === "ul" && blocks[2].items[1][0].text === "second" && !JSON.stringify(blocks).includes("Correction"));
  // S2 pre-flag 4: typed server segments are never split or interpreted.
  const fig = { kind: "figure" as const, text: "1\n\n- 2", metric: "k@1", window: 7 };
  const atStart = answerBlocks([{ kind: "text", text: "Intro.\n" }, { kind: "figure", text: "- 5", metric: "k@1", window: 7 }, { kind: "text", text: " jobs.\n\n" }, fig, { kind: "link", text: "a\n\n1. b", href: "/x" }]);
  const inl = atStart.flatMap((b) => (b.kind === "p" ? b.lines.flat() : b.kind === "label" ? b.line : b.items.flat()));
  check("answerBlocks: a {{m:}} figure segment is never split and never read as a list marker, even when its text holds newlines or '- '",
    atStart.every((b) => b.kind === "p") && inl.filter((x) => x.kind === "figure").map((x) => x.text).join("|") === "- 5|1\n\n- 2"
    && inl.some((x) => x.kind === "figure" && x.seg === 1) && inl.some((x) => x.kind === "figure" && x.seg === 3), JSON.stringify(atStart));
  check("answerBlocks: a server link segment is never split either", inl.filter((x) => x.kind === "link").map((x) => x.text).join() === "a\n\n1. b");
  check("answerBlocks: splitting happens ONLY inside model text — the figures, links and text come back in order, text unchanged except newlines and list markers",
    (() => {
      const segsIn: ClientSegment[] = [{ kind: "text", text: "Costs " }, { kind: "figure", text: "$1", metric: "c@1", window: 30 }, { kind: "text", text: " for Providers (Plaid).\n\n- Jobs: " }, { kind: "figure", text: "4", metric: "j@1", window: 7 }];
      const out = answerBlocks(segsIn).flatMap((b) => (b.kind === "p" ? b.lines.flat() : b.kind === "label" ? b.line : b.items.flat())).map((x) => x.text).join("");
      return out === "Costs $1 for Providers (Plaid).Jobs: 4";
    })());
  const CORR2 = "Correction: these cover this month.\n\n- not a list\n1. not numbered";
  const corrSegs: ClientSegment[] = [{ kind: "text", text: "Model prose\n- item" }, { kind: "correction", text: CORR2 }, { kind: "text", text: "\nmore model text" }];
  check("answerBlocks: a correction segment is never part of the body, never split", !JSON.stringify(answerBlocks(corrSegs)).includes("Correction") && !JSON.stringify(answerBlocks(corrSegs)).includes("not a list"));
  const corrHtml = renderToStaticMarkup(createElement(TypedAnswerSegments, { segments: corrSegs }));
  const callout = (/<div role="note" aria-label="Correction" data-platform-ai-correction=""[\s\S]*?<\/div><\/div>/.exec(corrHtml) ?? [""])[0];
  check("the correction renders WHOLE in its callout (one paragraph, verbatim), and NO model text ever appears inside the callout",
    (callout.match(/<p /g) ?? []).length === 1 && callout.includes(CORR2.replace(/\n/g, "\n")) && !/Model prose|more model text|<li|<ul|<ol/.test(callout), callout);
  check("…while the model's prose lays out below it", corrHtml.indexOf("Model prose") > corrHtml.indexOf("data-platform-ai-correction") && /<li class="min-w-0"><span>item<\/span><\/li>/.test(corrHtml));
  check("answerBlocks: no segment ⇒ no block; whitespace-only text ⇒ no block", answerBlocks([]).length === 0 && answerBlocks([{ kind: "text", text: " \n\n " }]).length === 0);
  const cmp = code(COMPONENT), model = code(MODEL), pres = code(PRESENTATION), v0 = code(V0);
  check("the Markdown module contributes ONLY isSameOriginPath (presentation + v0); nothing renders <Markdown>, no parser, no innerHTML",
    /import \{ isSameOriginPath \} from "@\/components\/ai\/Markdown";/.test(pres) && !/@\/components\/ai\/Markdown/.test(cmp)
    && !/<Markdown\b|react-markdown|remark|rehype|dangerouslySetInnerHTML|innerHTML/.test(cmp + model + pres + v0));
  check("no AnswerCard (the customer Markdown answer)", !/AnswerCard/.test(cmp + pres + v0));
  check("links come from the server's re-resolved href only: the model has no page→href logic and no stored URL field",
    !/\bpage\b\s*:/.test(model.replace(/kind: "link", text: "no href", page/g, "")) && /if \(s\.kind === "link" && typeof s\.href === "string"\)/.test(model));
}

// ── 4b. S2 F-C1 (ii): the server correction segment ─────────────────────────
console.log("\n4b. the period CORRECTION segment — its own quiet note ABOVE the answer (v0 + conversations)");
{
  const CORR = "Correction: the figures for Estimated operating cost this cycle (by category) cover so far this month (since 2026-11-01), not the past 30 days you asked about; that period cannot be measured for them.";
  const PROSE = "In the past 30 days, the largest cost category is Providers (Plaid).";
  const conv = renderToStaticMarkup(createElement(TypedAnswerSegments, { segments: [{ kind: "correction", text: CORR }, { kind: "text", text: PROSE }] }));
  const v0 = renderToStaticMarkup(createElement(AnswerSegments, { segments: [{ kind: "correction", text: CORR }, { kind: "text", text: PROSE }] }));
  for (const [name, html] of [["conversations (TypedAnswerSegments)", conv], ["v0 (AnswerSegments)", v0]] as const) {
    const block = /<div role="note" aria-label="Correction" data-platform-ai-correction=""[^>]*>([\s\S]*?)<\/div><\/div>/.exec(html);
    check(`${name}: the correction is its OWN note (role=note) — not inline text in the answer body — and appears once`,
      !!block && block[1].includes(CORR) && (html.match(new RegExp(CORR.slice(0, 40).replace(/[()]/g, "\\$&"), "g")) ?? []).length === 1, html);
    check(`${name}: prominent and distinct from the prose (#460): a bordered, tinted callout with an accent rule, primary text, medium weight — not the old orange box, not muted`,
      /rounded-lg border /.test(block?.[0] ?? "") && /border-l-\[var\(--accent-info\)\]/.test(block?.[0] ?? "") && /bg-\[var\(--surface-inset\)\]/.test(block?.[0] ?? "")
      && /text-\[var\(--text-primary\)\]/.test(block?.[0] ?? "") && /font-medium/.test(block?.[0] ?? "")
      && !/accent-warning|text-\[var\(--text-(muted|secondary)\)\]/.test((block?.[0] ?? "x").replace(/<svg[\s\S]*?<\/svg>/, "")), block?.[0]);
    check(`${name}: placed ABOVE the answer body, and the model's prose is shown unchanged`,
      html.indexOf("data-platform-ai-correction") < html.indexOf("data-platform-ai-body") && html.includes(PROSE)
      && !/data-platform-ai-body[^]*Correction:/.test(html), html);
  }
  const plain = renderToStaticMarkup(createElement(TypedAnswerSegments, { segments: [{ kind: "text", text: "Note: x. " }, { kind: "text", text: PROSE }] }));
  check("no correction segment ⇒ no correction note (the plain note stays inline text)", !/data-platform-ai-correction/.test(plain));
  const parsed = parseMessage({
    id: "m9", role: "ASSISTANT", status: "COMPLETE", createdAt: H3, completedAt: H3, failureCode: null, unavailable: false, stale: true,
    content: [{ kind: "correction", text: CORR }, { kind: "text", text: PROSE }], citations: [], notes: [],
  });
  check("the client parser keeps a correction segment (typed), first", !!parsed && Array.isArray(parsed.content) && parsed.content[0]?.kind === "correction" && parsed.content[0].text === CORR, parsed);
  const rendered = renderStoredAnswer({ v: 1, segments: [{ kind: "correction", text: CORR }, { kind: "text", text: PROSE }], citations: [], notes: [], stop: "ANSWERED" }, null);
  check("the stored answer is served with the correction typed (renderStoredAnswer)", rendered[0]?.kind === "correction" && rendered[0].text === CORR && rendered.length === 2, rendered);
}

// ── 5. disclosure + privacy hint (S2 C1–C4) ─────────────────────────────────
console.log("\n5. the short line + 'Privacy & retention' (S2 C1–C4): full OD-5 inline, first-visit expanded, describedby on the full text");
{
  check("the disclosure is the owner-approved OD-5 wording, exactly — changing it needs a new owner approval and S2 claim check",
    PLATFORM_AI_CONVERSATIONS_DISCLOSURE === "The text of your questions and answers is saved encrypted to your operator account. No one else can open your conversations in Fourth Meridian, and you can open them only while you have access to this area. A question and its answer are hidden 7 days after the question was asked, and a conversation you delete is hidden at once; both are then removed from our database at the next retention purge. Copies in database backups, and what was sent to OpenAI to answer you, follow their own retention terms.");
  check("…and no longer claims anything is pending", !/pending/i.test(PLATFORM_AI_CONVERSATIONS_DISCLOSURE) && !/PENDING OWNER|DISCLOSURE_PENDING/.test(src(MODEL)));
  const literalUses: string[] = [];
  for (const rel of [COMPONENT, PAGE, V0, PRESENTATION]) if (src(rel).includes("saved encrypted to your operator account")) literalUses.push(rel);
  check("the wording lives only in the model constant (no second copy)", literalUses.length === 0, literalUses);
  // C1 — the exact short line.
  check("C1: the short line, exactly (read-only · provider as OD-5 names it · 'hidden' after the retention days · don't enter personal details)",
    PLATFORM_AI_CONVERSATIONS_LINE === "Read-only · Sent to OpenAI · Chats hidden after 7 days · Don’t enter personal details"
    && PLATFORM_AI_SESSION_LINE === "Read-only · Sent to OpenAI · Not saved · Don’t enter personal details");
  check("C1: built from PLATFORM_AI_RETENTION_DAYS_CLIENT (no literal days) and the provider constant; the provider is the one OD-5 names; never 'deleted'",
    /`Read-only · Sent to \$\{PLATFORM_AI_PROVIDER\} · Chats hidden after \$\{PLATFORM_AI_RETENTION_DAYS_CLIENT\} days/.test(src(MODEL))
    && PLATFORM_AI_CONVERSATIONS_DISCLOSURE.includes(`sent to ${PLATFORM_AI_PROVIDER}`) && !/delet|remov|purg/i.test(PLATFORM_AI_CONVERSATIONS_LINE + PLATFORM_AI_SESSION_LINE));
  const mk = (over: Partial<Parameters<typeof PlatformAiComposer>[0]> = {}) =>
    renderToStaticMarkup(createElement(PlatformAiComposer, { value: "", onChange: noop, onSubmit: noop, disabled: false, busy: false, ...over }));
  const closed = mk();
  const opened = mk({ noticeOpen: true });
  const lineHtml = (closed.match(/<p data-platform-ai-disclosure="conversations"[^>]*>[\s\S]*?<\/p>/) ?? [""])[0];
  check("C1: the line is rendered (not truncated / ellipsized / clamped / hidden at any width) with its exact text, beneath the box",
    textOf(lineHtml).replace(/&#x2019;/g, "’").startsWith(PLATFORM_AI_CONVERSATIONS_LINE) && /break-words/.test(lineHtml)
    && !/truncate|text-ellipsis|line-clamp|whitespace-nowrap|\bhidden\b|max-sm:|sr-only/.test([...lineHtml.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ")) && !/ hidden=""/.test(lineHtml) && closed.indexOf("data-platform-ai-disclosure") > closed.indexOf("<textarea"), lineHtml);
  // C2 — the control.
  const toggle = /<button type="button" data-platform-ai-notice-toggle="" aria-expanded="(true|false)" aria-controls="platform-ai-notice"[^>]*>Privacy &amp; retention<\/button>/;
  check("C2: 'Privacy & retention' is a real button (keyboard-reachable, in the composer's tab order after the box) with aria-expanded + aria-controls",
    toggle.exec(closed)?.[1] === "false" && toggle.exec(opened)?.[1] === "true" && closed.indexOf("data-platform-ai-notice-toggle") > closed.indexOf("<textarea"));
  check("C2: expanding shows the FULL OD-5 text inline — no dialog, no modal, no scroll container, nothing clipped",
    /<div id="platform-ai-notice" data-platform-ai-notice="open" class="[^"]*"/.test(opened) && !/<div id="platform-ai-notice"[^>]*hidden/.test(opened)
    && textOf((opened.match(/data-platform-ai-conversations-disclosure=""[^>]*>([\s\S]*?)<\/p>/) ?? [])[1] ?? "") === textOf(PLATFORM_AI_CONVERSATIONS_DISCLOSURE)
    && !/aria-haspopup|role="dialog"|overflow-(y-|x-)?(auto|scroll|hidden)|max-h-|line-clamp|truncate/.test((opened.match(/<div data-platform-ai-composer-footer=""[\s\S]*$/) ?? [""])[0]));
  {
    let toggled: boolean | null = null;
    const el = PlatformAiComposer({ value: "", onChange: noop, onSubmit: noop, disabled: false, busy: false, noticeOpen: false, onNotice: (v) => { toggled = v; } }) as ReactElement;
    const lineEl = elements((el.props as { footer?: unknown }).footer).find((e) => typeof e.type === "function" && (e.type as { name?: string }).name === "PlatformAiDisclosureLine");
    const btn = lineEl ? elements((lineEl.type as (p: unknown) => ReactNode)(lineEl.props)).find((e) => (e.props as Record<string, unknown>)["data-platform-ai-notice-toggle"] === "") : undefined;
    (btn?.props as { onClick?: () => void } | undefined)?.onClick?.();
    check("C2: the button toggles through onNotice (focus stays on it: no navigation, no dialog)", toggled === true && !/focus\(|autoFocus/.test(code(PRESENTATION)));
  }
  // C4 — describedby on the full text, always in the DOM.
  check("C4: the box's aria-describedby points at the full-text elements, which are in the DOM collapsed (hidden) and expanded",
    /aria-describedby="platform-ai-privacy-hint platform-ai-conversations-disclosure"/.test(closed)
    && /<div id="platform-ai-notice" data-platform-ai-notice="closed" hidden=""/.test(closed)
    && /id="platform-ai-conversations-disclosure"/.test(closed) && /id="platform-ai-privacy-hint"/.test(closed)
    && textOf((closed.match(/data-platform-ai-privacy-hint=""[^>]*>([\s\S]*?)<\/p>/) ?? [])[1] ?? "").replace(/&#x2019;/g, "’") === PLATFORM_AI_PRIVACY_HINT);
  // C3 — first visit, server-derived.
  check("C3: noticeDefaultOpen = the server's list is empty and nothing is open (never storage); unknown list ⇒ collapsed",
    noticeDefaultOpen([], false) && !noticeDefaultOpen([CONV], false) && !noticeDefaultOpen([], true) && !noticeDefaultOpen(null, false)
    && !/localStorage[^\n]*notice|notice[^\n]*localStorage/i.test(code(COMPONENT)));
  const firstVisit = view({ conversations: [], selected: null });
  check("C3: first visit (zero conversations) ⇒ the full notice EXPANDED in the empty state (top of the reading region), exactly once",
    /data-ai-layout="empty"/.test(firstVisit) && /data-platform-ai-notice-lead=""[^>]*><div id="platform-ai-notice" data-platform-ai-notice="open"/.test(firstVisit)
    && firstVisit.indexOf("data-platform-ai-notice-lead") > firstVisit.indexOf("data-ai-scroll") && firstVisit.indexOf("data-platform-ai-notice-lead") < firstVisit.indexOf("data-ai-dock")
    && (firstVisit.match(/id="platform-ai-notice"/g) ?? []).length === 1 && (firstVisit.match(/id="platform-ai-conversations-disclosure"/g) ?? []).length === 1
    && /data-platform-ai-notice-toggle="" aria-expanded="true"/.test(firstVisit), firstVisit);
  check("C3: sending the first message keeps it expanded while in flight; once a conversation exists ⇒ collapsed",
    /data-platform-ai-notice="open"/.test(view({ conversations: [], selected: null, sendingQuestion: "first?" }))
    && /data-platform-ai-notice="closed"/.test(view({ conversations: [CONV], selected: { conversation: CONV, messages: [user("u1", "q"), answer("a1")] } })));
  check("C3: a returning operator (conversations exist) ⇒ collapsed, even on an empty composer", /data-platform-ai-notice="closed"/.test(view({ conversations: [CONV], selected: null })));
  check("C3: every conversation deleted ⇒ expanded again (the default is recomputed from the list)", /data-platform-ai-notice="open"/.test(view({ conversations: [], selected: null, noticeOpen: null })));
  check("C3: the operator's toggle wins over the default", /data-platform-ai-notice="closed"/.test(view({ conversations: [], selected: null, noticeOpen: false }))
    && /data-platform-ai-notice="open"/.test(view({ conversations: [CONV], selected: null, noticeOpen: true })));
  const cmp = code(COMPONENT);
  check("C3: the toggle override resets to the default when a first message creates a conversation and when the last one is deleted",
    /if \(!s\.conversationId\) setNoticeOpen\(null\);/.test(cmp) && /if \(!next\) setNoticeOpen\(null\);/.test(cmp) && /const \[noticeOpen, setNoticeOpen\] = useState<boolean \| null>\(null\);/.test(cmp));
  check("a 500-character box", /<textarea[^>]*maxLength="500"/i.test(closed));
  const near = mk({ value: "x".repeat(PLATFORM_AI_COUNTER_FROM) });
  check("the counter shows only near the limit (from 400 of 500), beneath the box",
    !/data-platform-ai-counter/.test(closed) && PLATFORM_AI_COUNTER_FROM === 400
    && /data-platform-ai-counter=""[^>]*>400(<!-- -->)?\/(<!-- -->)?500</.test(near) && near.indexOf("data-platform-ai-counter") > near.indexOf("<textarea"));
  check("contrast: the footer and the notice use the secondary-text token (muted measured below AA on the dark base)",
    /data-platform-ai-composer-footer=""[^>]*text-\[var\(--text-secondary\)\]/.test(closed) && /data-platform-ai-notice="closed" hidden="" class="[^"]*text-\[var\(--text-secondary\)\]/.test(closed));
}

// ── 6. thread states ────────────────────────────────────────────────────────
console.log("\n6. thread — failed / pending / full / limit / expired");
{
  const failedNewest = renderToStaticMarkup(createElement(Thread, {
    messages: [user("u1", "first"), answer("a1"), user("u2", "second"), answer("a2", { status: "FAILED", content: null, failureCode: "TIMEOUT" })],
    now: NOW, sendingQuestion: null, earlierExpired: false, onRetryFailed: noop, busy: false,
  }));
  check("a FAILED answer uses the FailedTurn pattern with its closed-code sentence and Retry on the newest",
    /data-turn="failed"/.test(failedNewest) && textOf(failedNewest).includes(FAILURE_COPY.TIMEOUT) && />\s*Retry<\/button>|<\/svg> Retry<\/button>/.test(failedNewest), failedNewest);
  const failedOlder = renderToStaticMarkup(createElement(Thread, {
    messages: [user("u1", "first"), answer("a1", { status: "FAILED", content: null, failureCode: "PROVIDER" }), user("u2", "second"), answer("a2")],
    now: NOW, sendingQuestion: null, earlierExpired: false, onRetryFailed: noop, busy: false,
  }));
  check("an older FAILED answer offers no Retry", /data-turn="failed"/.test(failedOlder) && !/Retry/.test(failedOlder));
  check("USER messages render as plain text bubbles (MessageCard)", /first<\/div>/.test(failedNewest) && /second<\/div>/.test(failedNewest));
  const sel = (messages: ClientMessage[], full = false) => ({ conversation: { ...CONV, full }, messages });
  const pending = view({ selected: sel([user("u1", "q"), answer("a1", { status: "PENDING", content: null })]) });
  check("a PENDING turn shows the in-flight state and DISABLES the composer",
    /data-platform-ai-in-flight/.test(pending) && /<textarea[^>]*disabled=""/.test(pending), pending);
  const sending = view({ selected: sel([user("u1", "q"), answer("a1")]), sendingQuestion: "next one", draft: "" });
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
  const sendBody = cmp.slice(cmp.indexOf("async function send(s: PendingSend)"), cmp.indexOf("function onSend()"));
  check("send() itself NEVER mints a clientRequestId (it sends the PendingSend it is given)",
    sendBody.length > 200 && !/randomUUID/.test(sendBody) && /clientRequestId: s\.clientRequestId/.test(sendBody));
  check("409 TURN_IN_FLIGHT ⇒ the client re-opens the conversation and sends nothing new",
    /if \(pr\.kind === "IN_FLIGHT" && s\.conversationId\) void openConversation\(s\.conversationId\);/.test(sendBody)
    && !/IN_FLIGHT[^\n]*send\(/.test(sendBody) && problemFor(409, { code: "TURN_IN_FLIGHT" }).kind === "IN_FLIGHT");
  check("a transport failure keeps the SAME PendingSend (setRetry(s)), and Try again resends exactly it",
    /if \(!r\) \{[\s\S]*?setRetry\(s\);/.test(sendBody) && /onRetrySend=\{\(\) => \{ if \(retry\) void send\(retry\); \}\}/.test(cmp));
  check("an explicit Retry on a FAILED turn mints a NEW id; the only other minting site is a fresh question (ask: onSend + starter chips)",
    (cmp.match(/crypto\.randomUUID\(\)/g) ?? []).length === 2
    && /onRetryFailed=\{\(q\) => \{ void send\(\{ [^}]*clientRequestId: crypto\.randomUUID\(\)/.test(cmp)
    && /function ask\(question: string\): boolean \{[^]*?clientRequestId: crypto\.randomUUID\(\)/.test(cmp)
    && /function onSend\(\) \{\s*if \(ask\(draft\)\) setDraft\(""\);\s*\}/.test(cmp) && /onStarter=\{\(q\) => \{ ask\(q\); \}\}/.test(cmp));
  const expired = renderToStaticMarkup(createElement(Thread, {
    messages: [user("u9", "later question", H3), answer("a9")], now: NOW, sendingQuestion: null, earlierExpired: true, busy: false,
  }));
  check("a thread whose oldest messages expired renders, with 'Earlier messages … have expired'", textOf(expired).includes(EARLIER_EXPIRED_COPY) && /later question/.test(expired));
  const unreadable = renderToStaticMarkup(createElement(AssistantAnswer, { message: answer("a3", { unavailable: true, content: null }), now: NOW }));
  check("an unreadable answer says so (never raw text)", /This message can&#x27;t be shown\.|This message can’t be shown\./.test(unreadable));
  const areaLine = view({ selected: sel([user("u1", "q"), answer("a1")]) });
  check("the area is the header's context label ('Answering from: ' for screen readers) — no per-answer or per-thread 'Answering from' line",
    /<span class="sr-only">Answering from: <\/span>Platform Operations/.test(areaLine) && !/Answering from Platform Operations data/.test(areaLine) && !/data-platform-ai-area=/.test(areaLine));
}

// ── 7. layout ───────────────────────────────────────────────────────────────
console.log("\n7. layout — 375 px column, the mobile History sheet, the desktop rail (collapsed by default)");
{
  const longLabel = { ...CONV, label: "A".repeat(60) + "…" };
  const html = view({ conversations: [longLabel, { ...CONV, id: "c0000000000000000000000b", full: true }], selected: { conversation: CONV, messages: [user("u1", "B".repeat(500)), answer("a1")] } });
  check("375 px: no fixed width wider than the screen anywhere", !/\b(?:w|min-w|max-w)-\[(?:3[8-9]\d|[4-9]\d\d|\d{4,})px\]/.test(html), html.match(/\b(?:w|min-w|max-w)-\[\d+px\]/g));
  check("375 px: min-w-0 on every column and break-words on free text", (html.match(/min-w-0/g) ?? []).length >= 12 && /break-words/.test(html));
  check("375 px: nothing scrolls the page sideways (no overflow-x-scroll / whitespace-nowrap blocks / w-screen)", !/overflow-x-(auto|scroll)|w-screen|min-w-max/.test(html));
  check("the 'History' sheet control is mobile-only (lg:hidden), declares its dialog, and is the Personal header-control style",
    /data-platform-ai-sheet-toggle=""[^>]*aria-haspopup="dialog"[^>]*aria-label="History" class="[^"]*h-8 rounded-lg[^"]*lg:hidden/.test(html)
    && /<span class="max-sm:sr-only" aria-hidden="true">History<\/span><\/button>/.test(html), html.match(/<button[^>]*data-platform-ai-sheet-toggle[^>]*>/)?.[0]);
  check("an OPEN desktop rail is hidden below lg and holds the same list", /<aside data-platform-ai-rail="open" aria-label="Conversation history" class="hidden [^"]*lg:flex/.test(html)
    && /<aside[\s\S]*data-platform-ai-conversation-list[\s\S]*<\/aside>/.test(html));
  const collapsed = view({ railCollapsed: true });
  check("collapsed rail: the toggle only (no list), labelled 'Show history'",
    /data-platform-ai-rail="collapsed"/.test(collapsed) && /aria-label="Show history"/.test(collapsed) && !/<aside[\s\S]*data-platform-ai-conversation-list[\s\S]*<\/aside>/.test(collapsed));
  const cmp = code(COMPONENT);
  check("the mobile sheet is the shared Panel (bottom sheet on a phone), listing the same ConversationList",
    /<Panel open=\{p\.sheetOpen\} onClose=\{\(\) => p\.onSheet\(false\)\} side="left"/.test(cmp) && /<PanelContent>\{list\}<\/PanelContent>/.test(cmp));
  check("the rail is COLLAPSED by default (initial state and when storage is empty / unavailable); a per-viewer localStorage convenience in try/catch, nothing else stored",
    (cmp.match(/localStorage/g) ?? []).length === 2 && /try \{ return window\.localStorage\.getItem\(RAIL_COLLAPSED_KEY\) !== "0"; \} catch \{ return true; \}/.test(cmp)
    && /const \[railCollapsed, setRailCollapsed\] = useState\(true\);/.test(cmp)
    && /try \{ window\.localStorage\.setItem\(RAIL_COLLAPSED_KEY, v \? "1" : "0"\); \} catch/.test(cmp) && RAIL_COLLAPSED_KEY === "fm.platform-ai.rail-collapsed" && !/sessionStorage|indexedDB|document\.cookie/.test(cmp));
  const list = (limits: { used: number; max: number } | null) => renderToStaticMarkup(createElement(ConversationList, {
    conversations: [longLabel], selectedId: CONV.id, now: NOW, limits, error: null, onSelect: noop, onDelete: noop,
  }));
  const listHtml = list({ used: 1, max: 50 });
  check("list rows: derived label (truncated), area chip, last-activity time, a labelled delete — and NO second 'New' button",
    /truncate/.test(listHtml) && /data-platform-ai-area-chip="[^"]*"[^>]*>Platform Operations</.test(listHtml) && /3 h ago/.test(listHtml)
    && /aria-label="Delete conversation: A{60}…"/.test(listHtml) && /aria-current="true"/.test(listHtml) && !/New conversation|New chat/.test(listHtml));
  check("'N of 50' only near the cap (within 5)", !/data-platform-ai-count/.test(listHtml) && !/of 50/.test(listHtml)
    && /data-platform-ai-count=""[^>]*>46(<!-- -->)? of (<!-- -->)?50(<!-- -->)? conversations</.test(list({ used: 46, max: 50 }))
    && !showConversationCount({ used: 44, max: 50 }) && showConversationCount({ used: 45, max: 50 }) && !showConversationCount(null));
  check("delete asks for confirmation: \"Deleted conversations can't be recovered.\"",
    /<ConfirmDialog open=\{p\.confirmDelete !== null\}[^>]*message=\{DELETE_CONFIRM_COPY\}/.test(cmp) && /Deleted conversations can't be recovered\./.test(src(MODEL)));
  check("the page opens on the latest conversation (the list is lastActivityAt desc), or an empty composer",
    /if \(openLatest && parsed\.conversations\.length > 0\) await openConversation\(parsed\.conversations\[0\]\.id, "replace"\);/.test(cmp) && /void loadList\(true\);/.test(cmp));
}

// ── 8. reuse ────────────────────────────────────────────────────────────────
console.log("\n8. reuse (§11) — shared presentation only; nothing customer-only");
{
  const cmp = code(COMPONENT), pres = code(PRESENTATION);
  const importsOf = (c: string) => [...c.matchAll(/^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"([^"]+)";/gm)].map((m) => m[1]).sort();
  check("conversations imports: exactly these modules", importsOf(cmp).join() === [
    "./PlatformAiMemory", "./PlatformAiPlaceholder", "./platform-ai-conversations-model", "./platform-ai-memory-model", "./platform-ai-presentation",
    "@/components/ai/AiShell", "@/components/ai/ConversationView", "@/components/ai/answer-frame",
    "@/components/ai/FailedTurn", "@/components/ai/MessageCard",
    "@/components/atlas/ConfirmDialog", "@/components/atlas/panels/Panel", "@/components/atlas/panels/PanelParts",
    "lucide-react", "react",
    // Owner 2026-11-10 / S2 09fc: the @ people picker hook (sends chip tokens, never a label; stores nothing).
    "./platform-ai-people-picker",
  ].sort().join(), importsOf(cmp));
  check("shared presentation imports: exactly these modules (the shared AI primitives + the model)", importsOf(pres).join() === [
    "./platform-ai-conversations-model", "./platform-ai-memory-model", "@/components/ai/Composer", "@/components/ai/Markdown",
    "@/components/ai/StarterLine", "@/components/ai/SuggestedPrompt", "lucide-react", "react",
    // P5 (S2 09dp): the customer-lookup notice text (pure, import-free).
    "@/lib/platform/intelligence/ai/authz/subject-notice",
    // Owner 2026-11-10 / S2 09fc: the @ people picker binding — a TYPE only (the composer's seams).
    "./platform-ai-people-picker",
  ].sort().join(), importsOf(pres));
  check("…the picker import in the shared presentation is type-only", /^import type \{ PeoplePickerBinding \} from "\.\/platform-ai-people-picker";$/m.test(src(PRESENTATION)));
  const named = (c: string, mod: string) => (c.match(new RegExp(`import \\{([^}]*)\\} from "${mod.replace(/[/@]/g, "\\$&")}";`)) ?? [])[1]?.split(",").map((x) => x.trim()).filter(Boolean).sort().join() ?? "";
  check("from ConversationView only ConversationLog + ThinkingIndicator; from Composer only ComposerFrame; nothing from the barrel",
    named(cmp, "@/components/ai/ConversationView") === "ConversationLog,ThinkingIndicator" && named(pres, "@/components/ai/Composer") === "ComposerFrame"
    && !/from "@\/components\/ai"/.test(cmp + pres + code(V0)));
  check("NOT reused: ConversationView (Markdown answers), Composer (the customer disclosure copy), the transcript cache, Space context, Talk-about-this",
    !/<ConversationView\b|<Composer\b|transcript-cache|TalkAboutThis|talk-about-this|SpaceContext|useSpace|spaceId/.test(cmp + pres + code(V0)));
  check("the customer AiDisclosure (its copy and modal) is not used on Platform", !/<AiDisclosure\b|components\/ai\/AiDisclosure|AI_DISCLOSURE_LINE|AI_DISCLOSURE_ABOUT/.test(cmp + pres + code(V0)));
  check("the model module imports nothing", !/^import /m.test(code(MODEL)));
}

// ── 9. privacy ──────────────────────────────────────────────────────────────
console.log("\n9. privacy — no analytics, no logging, no draft storage, routes only");
{
  const cmp = code(COMPONENT), model = code(MODEL), pres = code(PRESENTATION);
  check("no console, Sentry, analytics or tracking", !/console\.|Sentry|captureException|analytics|track\(|posthog|gtag|sendBeacon/i.test(cmp + model + pres + code(V0)));
  check("no keystroke handlers (only the controlled textarea's onChange)", !/onKey(Down|Up|Press)|onInput|addEventListener\(\s*["']key/.test(cmp + pres + code(V0)));
  check("no storage on the shared presentation or v0", !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(pres + code(V0)));
  const fetches = [...cmp.matchAll(/\bfetch\(/g)].length;
  check("ONE fetch site (the call() helper), same-origin credentials, no-store", fetches === 1 && /fetch\(url, \{ credentials: "same-origin", cache: "no-store", \.\.\.init \}\)/.test(cmp) && !/\bfetch\(/.test(pres));
  const urls = [...cmp.matchAll(/\b(call|postJson)\(([^,)]+)/g)].map((m) => m[2].trim());
  check("every call targets a conversation route", urls.length >= 5 && urls.every((u) => /^(PLATFORM_AI_CONVERSATIONS_URL|conversationUrl\(|conversationMessagesUrl\(|url)/.test(u)), urls);
  check("bodies are exactly { clientRequestId, question } (the strict server body)",
    (cmp.match(/\{ clientRequestId: s\.clientRequestId, question: s\.question \}/g) ?? []).length === 2 && !/\barea\b\s*:/.test(cmp.replace(/areaLabel/g, "")));
  check("clientRequestId is a fresh UUID per send", (cmp.match(/crypto\.randomUUID\(\)/g) ?? []).length === 2);
}

// ── 10. the shared shell (parity PR3 / PR6) ─────────────────────────────────
console.log("\n10. shared shell — frame, log, thinking dots, answer frame + Sources, composer, starters, rail");
{
  const sel = (messages: ClientMessage[]) => ({ conversation: CONV, messages });
  const conv = view({ selected: sel([user("u1", "q"), answer("a1")]) });
  check("the page is the shared AiShell: data-ai-layout / data-ai-scroll / data-ai-dock, h1 'Platform AI', the area as context",
    /data-ai-layout="conversation"/.test(conv) && /data-ai-scroll/.test(conv) && /data-ai-dock="conversation"/.test(conv)
    && /<h1[^>]*>Platform AI<\/h1>/.test(conv) && /<span class="sr-only">Answering from: <\/span>Platform Operations/.test(conv), conv);
  check("…the composer sits in the dock (once), the reading region scrolls inside the shell",
    (conv.match(/id="platform-ai-question"/g) ?? []).length === 1 && conv.indexOf("data-ai-dock") < conv.indexOf('id="platform-ai-question"')
    && conv.indexOf("data-ai-scroll") < conv.indexOf("data-ai-dock"));
  check("no Read-only badge in the header (it is in the disclosure line)", !/data-tone|ToneBadge/.test(conv.slice(0, conv.indexOf("</header>"))) && textOf(conv).replace(/&#x2019;/g, "’").includes(PLATFORM_AI_CONVERSATIONS_LINE));
  check("the thread is the shared reading column (ConversationLog: role=log, max-w-3xl, pb-10)",
    /<div role="log" aria-label="Conversation" class="max-w-3xl mx-auto w-full space-y-7 px-1 pt-3 pb-10">/.test(conv));
  check("ONE 'New chat' on the page (the header, Personal's class string); no 'New conversation' in the rail",
    /data-platform-ai-new-chat=""[^>]*>[\s\S]*?<span class="max-sm:sr-only">New chat<\/span>/.test(conv) && (conv.match(/New chat/g) ?? []).length === 1 && !/New conversation/.test(conv));

  // Rail in the side slot.
  const tree = PlatformAiConversationsView(viewProps({ selected: sel([user("u1", "q"), answer("a1")]) }));
  const shell = elements(tree).find((e) => e.type === AiShell);
  const sideRail = shell ? elements((shell.props as { side?: unknown }).side).find((e) => e.type === "aside") : undefined;
  check("the desktop rail is passed in AiShell's `side` slot (an <aside data-platform-ai-rail>)",
    !!sideRail && (sideRail.props as Record<string, unknown>)["data-platform-ai-rail"] === "open", shell ? Object.keys(shell.props as object) : "no AiShell");
  check("…rendered beside the reading region (before data-ai-scroll in the same row), hidden below lg, scrolling on its own",
    /<div class="flex flex-1 min-h-0 min-w-0"><aside data-platform-ai-rail="open" aria-label="Conversation history" class="hidden [^"]*overflow-y-auto[^"]*lg:flex/.test(conv)
    && conv.indexOf("data-platform-ai-rail") < conv.indexOf("data-ai-scroll"));

  // Thinking indicator while busy.
  const busy = view({ selected: sel([user("u1", "q"), answer("a1")]), sendingQuestion: "next one" });
  const dots = (busy.match(/animate-bounce/g) ?? []).length;
  check("while busy: the shared three-dot ThinkingIndicator (role=status, Platform sr label)",
    dots === 3 && /data-platform-ai-in-flight=""[^>]*><div role="status"/.test(busy) && busy.includes(`<span class="sr-only">${PLATFORM_AI_THINKING_LABEL}</span>`), busy);
  check("…and the sent question shows above it as the operator's bubble", busy.indexOf("next one") > -1 && busy.indexOf("next one") < busy.indexOf("animate-bounce"));
  const stored = view({ selected: sel([user("u1", "q"), answer("a1", { status: "PENDING", content: null })]) });
  check("a stored PENDING turn: the same dots plus 'Check again'", (stored.match(/animate-bounce/g) ?? []).length === 3 && /Check again<\/button>/.test(stored));
  const idle = view({ selected: sel([user("u1", "q"), answer("a1")]) });
  check("idle: no thinking indicator", !/animate-bounce|data-platform-ai-in-flight/.test(idle));

  // The answer frame around the typed segments; sources collapsed.
  const CORR = "Correction: these figures cover so far this month, not the period you asked about.";
  const framed = renderToStaticMarkup(createElement(AssistantAnswer, { message: answer("a5", {
    stale: false, content: [{ kind: "correction", text: CORR }, { kind: "text", text: "**not bold** <img src=x> " }, { kind: "figure", text: "7", metric: "k@1", window: 7 }],
  }), now: NOW }));
  const gutter = framed.indexOf('<div class="pt-1.5 shrink-0">'), prose = framed.indexOf("text-[15px]");
  const corr = framed.indexOf("data-platform-ai-correction"), body = framed.indexOf("data-platform-ai-body");
  check("the answer sits in the shared frame: AI-mark gutter, 15 px prose column; no bordered card",
    gutter > -1 && prose > gutter && /<span aria-hidden="true" class="inline-block[^"]*rounded-full/.test(framed.slice(gutter, prose)) && !/rounded-xl border[^"]*p-4/.test(framed), framed);
  check("the period correction is still its own note ABOVE the answer text, inside the frame", corr > prose && body > corr && framed.includes(CORR));
  check("no Markdown rendering path: Markdown syntax and HTML stay literal inside the frame",
    !/<(strong|em|img)\b/.test(framed) && framed.includes("**not bold**") && framed.includes("&lt;img"));
  const alias = src("components/ai/answer-frame.ts");
  const card = src("components/ai/AnswerCard.tsx");
  check("the frame module is a re-export of the frame only, and the frame itself renders no Markdown",
    /^export \{ AnswerFrame \} from "@\/components\/ai\/AnswerCard";$/m.test(alias) && (alias.match(/^(export|import) /gm) ?? []).length === 1
    && !/<Markdown/.test(card.slice(card.indexOf("export function AnswerFrame"), card.indexOf("export function AnswerCard("))));
  const sourcesAt = framed.indexOf("<details data-platform-ai-sources");
  check("notes and citations sit in a COLLAPSED 'Sources (n)' disclosure in the frame's extras (after the body); no 'Answering from' footer",
    sourcesAt > body && !/<details[^>]*\bopen/.test(framed) && /<summary[^>]*>Sources \(1\)<\/summary>/.test(framed)
    && framed.indexOf("A deterministic note.") > sourcesAt && framed.indexOf("Provider outcomes") > sourcesAt && !/Answering from/.test(framed), framed);
  const bare = renderToStaticMarkup(createElement(AssistantAnswer, { message: answer("a6", { stale: false, citations: [], notes: [] }), now: NOW }));
  check("no citations and no notes ⇒ no Sources disclosure; notes only ⇒ 'Notes'", !/data-platform-ai-sources/.test(bare)
    && /<summary[^>]*>Notes<\/summary>/.test(renderToStaticMarkup(createElement(AssistantAnswer, { message: answer("a7", { stale: false, citations: [] }), now: NOW }))));

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
  const auto = renderToStaticMarkup(createElement(PlatformAiComposer, { value: "", onChange: noop, onSubmit: noop, disabled: false, busy: false }));
  check("…wired in the frame: onKeyDown → isSendKey → preventDefault + onSubmit, enterKeyHint=send",
    /onKeyDown=\{\(e\) => \{\s*if \(isSendKey\(\{ key: e\.key, shiftKey: e\.shiftKey, isComposing: e\.nativeEvent\.isComposing \}\)\) \{\s*e\.preventDefault\(\);\s*onSubmit\(\);/.test(frameSrc)
    && /enterkeyhint="send"/i.test(auto));
  check("the box is the auto-growing Atlas Textarea inside the pill with the integrated send button", /rounded-\[22px\]/.test(auto) && !/resize-y/.test(auto) && /aria-label="Send message"/.test(auto));
  const busyComposer = renderToStaticMarkup(createElement(PlatformAiComposer, { value: "typing", onChange: noop, onSubmit: noop, disabled: false, busy: true }));
  check("busy: one disabled send button, never a Stop button",
    (busyComposer.match(/<button type="submit"/g) ?? []).length === 1 && /<button type="submit" disabled="" aria-label="Send message" aria-busy="true"/.test(busyComposer) && !/Stop/.test(busyComposer));

  // Empty state + starter chips.
  const empty = view({ selected: null, conversations: [] });
  check("empty state: the shared StarterLine headline at Personal's size and the starter chips, in the shell's empty layout; no area sub-line",
    /data-ai-layout="empty"/.test(empty) && /<h2 class="[^"]*text-2xl sm:text-\[28px\][^"]*"[^>]*>What would you like to check\?<\/h2>/.test(empty)
    && PLATFORM_AI_STARTER_PROMPTS.every((s) => empty.includes(`>${s.label.replace(/&/g, "&amp;")}</button>`)) && !/data-platform-ai-area=|Answering from Platform Operations data/.test(empty), empty);
  check("six short chips, 'How are we looking today?' first, each with a full prompt behind it",
    PLATFORM_AI_STARTER_PROMPTS.length === 6 && PLATFORM_AI_STARTER_PROMPTS[0].label === "How are we looking today?"
    && PLATFORM_AI_STARTER_PROMPTS.map((s) => s.label).join("|") === "How are we looking today?|Customer-impacting issues|Open incidents|Sync & connection health|Jobs & providers|Costs this month"
    && PLATFORM_AI_STARTER_PROMPTS.every((s) => s.label.length <= 28 && s.prompt.length > s.label.length && (s.prompt.endsWith("?") || s.prompt.endsWith("."))));
  check("starter copy is generic and figure-free (no digits, emails or ids)",
    [PLATFORM_AI_STARTER_HEADLINE, ...PLATFORM_AI_STARTER_PROMPTS.flatMap((s) => [s.label, s.prompt])].every((t) => !/\d|@|account number/i.test(t)));
  const asked: string[] = [];
  const startersEl = PlatformAiStarters({ onStarter: (q) => { asked.push(q); } });
  const chips = elements(startersEl).filter((e) => e.type === SuggestedPrompt);
  for (const c of chips) (c.props as { onSelect: () => void }).onSelect();
  check("each chip submits its FULL prompt (onStarter → ask → a fresh clientRequestId)",
    chips.length === PLATFORM_AI_STARTER_PROMPTS.length && asked.join("|") === PLATFORM_AI_STARTER_PROMPTS.map((s) => s.prompt).join("|"), asked);
  const emptyShell = elements(PlatformAiConversationsView(viewProps({ selected: null, conversations: [] }))).find((e) => e.type === AiShell);
  const asideEl = (emptyShell?.props as { aside?: ReactElement } | undefined)?.aside;
  check("the view passes the starters to AiShell's aside, wired to onStarter", !!asideEl && asideEl.type === PlatformAiStarters);
  check("the starters end with the dock's fade height (pb-8 = AiShell's h-8 fade), so the last chip scrolls clear of the dock",
    /(^|\s)pb-8(\s|$)/.test((startersEl.props as { className?: string }).className ?? "") && /-top-8 h-8/.test(readFileSync(path.join(process.cwd(), "components/ai/AiShell.tsx"), "utf8")));
  check("no chips when a new conversation is not allowed (limit reached)", !/data-platform-ai-starters/.test(view({ selected: null, limits: { used: 50, max: 50 } })));
  check("the empty state is the composer's, not a conversation's: no chips once a thread is open", !/data-platform-ai-starters/.test(conv));
}

// ── 12. v0 parity (PR6) ─────────────────────────────────────────────────────
console.log("\n12. v0 parity — flag on, conversations off: the same shell, a single session, nothing saved");
{
  const v0 = code(V0);
  const emptyV0 = renderToStaticMarkup(createElement(PlatformAiSessionView, {
    areaLabel: "Platform Operations", turns: [], draft: "", pending: false, onDraft: noop, onSend: noop, onAsk: noop, onNew: noop,
  }));
  check("empty: the shared StarterLine headline, the same six chips, the docked composer — no old form, no 'Ask' pill, no resize-y box",
    /data-ai-layout="empty"/.test(emptyV0) && emptyV0.includes(`>${PLATFORM_AI_STARTER_HEADLINE}</h2>`)
    && PLATFORM_AI_STARTER_PROMPTS.every((s) => emptyV0.includes(`>${s.label.replace(/&/g, "&amp;")}</button>`)) && /data-ai-dock="empty"/.test(emptyV0)
    && !/resize-y|>Ask<|Asking…|Nothing here is saved/.test(emptyV0) && /<textarea[^>]*maxLength="500"/i.test(emptyV0));
  check("v0's line says nothing is saved; no OD-5 element (nothing stored), the box described by the privacy hint only",
    textOf(emptyV0).replace(/&#x2019;/g, "’").includes(PLATFORM_AI_SESSION_LINE) && !/platform-ai-conversations-disclosure/.test(emptyV0)
    && /aria-describedby="platform-ai-privacy-hint"/.test(emptyV0) && /<div id="platform-ai-notice" data-platform-ai-notice="closed" hidden=""[^>]*><p data-platform-ai-session-notice=""/.test(emptyV0)
    && /id="platform-ai-privacy-hint" data-platform-ai-privacy-hint=""/.test(emptyV0) && /data-platform-ai-notice-toggle="" aria-expanded="false" aria-controls="platform-ai-notice"[^>]*>Privacy<\/button>/.test(emptyV0)
    && PLATFORM_AI_SESSION_NOT_SAVED.length > 0 && /PLATFORM_AI_SESSION_NOT_SAVED/.test(code(PRESENTATION)));

  // P5 (S2 09dp) — the customer-lookup notice: no name scrub; exact ID / email only, said in the UI where the pack is offered.
  check("P5 notice text is defined once, in code (S2 09dp)", PLATFORM_AI_SUBJECT_NOTICE === "Look customers up by their ID or email. Don't type customer names or usernames.");
  const notice = PLATFORM_AI_SUBJECT_NOTICE.replace(/'/g, "&#x27;");
  check("P5 notice OFF by default: v0 empty state and composer carry no notice", !/data-platform-ai-subject-notice/.test(emptyV0));
  const emptyV0Notice = renderToStaticMarkup(createElement(PlatformAiSessionView, {
    areaLabel: "Customer Success", turns: [], draft: "", pending: false, onDraft: noop, onSend: noop, onAsk: noop, onNew: noop, subjectNotice: true,
  }));
  check("P5 notice ON (v0): in the empty state AND the composer", emptyV0Notice.includes(`data-platform-ai-subject-notice="lead"`) && emptyV0Notice.includes(`data-platform-ai-subject-notice="composer"`)
    && emptyV0Notice.split(notice).length === 3, emptyV0Notice.split(notice).length);
  const convNotice = view({ subjectNotice: true, conversations: [] });
  check("P5 notice ON (conversations): in the empty state AND the composer", convNotice.includes(`data-platform-ai-subject-notice="lead"`) && convNotice.includes(`data-platform-ai-subject-notice="composer"`));
  check("P5 notice OFF (conversations) by default", !/data-platform-ai-subject-notice/.test(view({ conversations: [] })));
  check("P5 notice shown only with the customers pack ON and a Customer Success grant",
    showsSubjectNotice({ customersPackOn: true, areas: ["PLATFORM_OPS", "CUSTOMER_SUCCESS"] }) && !showsSubjectNotice({ customersPackOn: false, areas: ["CUSTOMER_SUCCESS"] })
    && !showsSubjectNotice({ customersPackOn: true, areas: ["PLATFORM_OPS"] }));
  const page = code("app/(shell)/dashboard/platform/ai/page.tsx");
  check("P5 the page decides the notice server-side from the strict pack getter and the operator's areas, and passes it to both views",
    /showsSubjectNotice\(\{ customersPackOn: env\.isPlatformAiPackCustomersEnabled, areas: platformAiAreasFor\(spaces\) \}\)/.test(page)
    && /<PlatformAiConversations [^>]*subjectNotice=\{subjectNotice\}/.test(page) && /if \(subjectNotice\) return <PlatformAiAsk [^>]*subjectNotice \/>/.test(page));
  const ANSWER = {
    surface: "Platform Operations", notes: ["A v0 note."], grounding: {} as never,
    answer: [{ kind: "text" as const, text: "Para one.\n\n- item " }, { kind: "link" as const, text: "Providers", href: "/dashboard/platform/PLATFORM_OPS" }],
    citations: [{ metric: "a@1", label: "Alpha", status: "MEASURED" as const, reason: null, window: "w", href: null, figures: ["1,234"] }],
  };
  const turns = [{ id: 0, question: "first?", answer: ANSWER as never, error: null }, { id: 1, question: "second?", answer: null, error: REFUSAL_COPY.DAILY_TURNS }];
  const convV0 = renderToStaticMarkup(createElement(PlatformAiSessionView, {
    areaLabel: "Platform Operations", turns, draft: "", pending: false, onDraft: noop, onSend: noop, onAsk: noop, onNew: noop,
  }));
  check("a session: question bubbles, the natural answer (paragraph + list) in the shared frame, citations under a collapsed Sources, the refusal as a FailedTurn with Retry",
    /data-ai-layout="conversation"/.test(convV0) && /first\?<\/div>/.test(convV0) && /<ul class="[^"]*list-disc/.test(convV0)
    && /<details data-platform-ai-sources/.test(convV0) && /<summary[^>]*>Sources \(1\)<\/summary>/.test(convV0)
    && /data-turn="failed"/.test(convV0) && textOf(convV0).includes(REFUSAL_COPY.DAILY_TURNS) && /Retry<\/button>/.test(convV0)
    && /data-platform-ai-new-chat/.test(convV0) && !/Answering from Platform Operations data/.test(convV0), convV0);
  const busyV0 = renderToStaticMarkup(createElement(PlatformAiSessionView, {
    areaLabel: "Platform Operations", turns: [{ id: 0, question: "q?", answer: null, error: null }], draft: "", pending: true, onDraft: noop, onSend: noop, onAsk: noop, onNew: noop,
  }));
  check("pending: the shared three dots, a disabled busy send button, no Stop", (busyV0.match(/animate-bounce/g) ?? []).length === 3
    && /<button type="submit" disabled="" aria-label="Send message" aria-busy="true"/.test(busyV0) && !/Stop/.test(busyV0));
  const answerHtml = renderToStaticMarkup(createElement(SessionAnswer, { answer: ANSWER as never }));
  check("the v0 answer keeps its status-word citations with the server figure beside its label, inside Sources", /Measured/.test(answerHtml) && /Alpha<\/span><span data-platform-ai-figure=""[^>]*>1,234<\/span>/.test(answerHtml));
  check("v0 stores nothing and fetches only its own route (one fetch site); earlier turns are never posted back",
    (v0.match(/\bfetch\(/g) ?? []).length === 1 && /fetch\(PLATFORM_AI_ASK_URL,/.test(v0) && /body: JSON\.stringify\(\{ question: q \}\)/.test(v0)
    && !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(v0));
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
    limits: null, error: null, onSelect: noop, onDelete: noop,
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
    && /export function PlatformAiConversations\(\{ areaLabel, memory = false, subjectNotice = false, View = PlatformAiConversationsView \}/.test(cmp));
}

// ── 13. F-1 window note + F-2 section labels / one nesting level (2026-11-08) ──
console.log("\n13. F-1 the window note is its own quiet note ABOVE the answer · F-2 section labels and one nested list level");
{
  const NOTE = "Note: You asked about the past 30 days; Estimated operating cost this cycle (by category) covers 1–10 Nov 2026 (month to date, UTC) instead.";
  const PROSE = "The largest measured cost is AI.";
  for (const [name, html] of [
    ["conversations", renderToStaticMarkup(createElement(TypedAnswerSegments, { segments: [{ kind: "note", text: NOTE }, { kind: "text", text: PROSE }] }))],
    ["v0", renderToStaticMarkup(createElement(AnswerSegments, { segments: [{ kind: "note", text: NOTE }, { kind: "text", text: PROSE }] }))],
  ] as const) {
    const block = /<div role="note" aria-label="Note" data-platform-ai-window-note=""[^>]*>([\s\S]*?)<\/div><\/div>/.exec(html);
    check(`F-1 ${name}: the window note renders in its OWN role="note" callout (aria-label Note), once, ABOVE the body; the body holds only model text`,
      !!block && block[1].includes(NOTE) && html.indexOf("data-platform-ai-window-note") < html.indexOf("data-platform-ai-body")
      && !/data-platform-ai-body[^]*you asked about/i.test(html) && html.includes(PROSE) && (html.match(/you asked about/gi) ?? []).length === 1, html);
    check(`F-1 ${name}: quiet (hairline border, secondary text, no accent rule, not medium weight) — distinct from the correction`,
      /border-\[var\(--border-hairline\)\]/.test(block?.[0] ?? "") && /text-\[var\(--text-secondary\)\]/.test(block?.[0] ?? "") && !/border-l-\[var\(--accent-info\)\]|font-medium/.test(block?.[0] ?? "x"), block?.[0]);
  }
  check("F-1: answerBlocks never puts a note in the body", !JSON.stringify(answerBlocks([{ kind: "note", text: NOTE }, { kind: "text", text: PROSE }])).includes("You asked about"));
  const parsedNote = parseMessage({ id: "m10", role: "ASSISTANT", status: "COMPLETE", createdAt: H3, completedAt: H3, failureCode: null, unavailable: false, stale: true,
    content: [{ kind: "note", text: NOTE }, { kind: "text", text: PROSE }], citations: [], notes: [] });
  check("F-1: the client keeps a stored note segment typed (parseMessage)", Array.isArray(parsedNote?.content) && (parsedNote!.content as ClientSegment[])[0]?.kind === "note");

  // F-2: "Incidents:" before list items is a label, not a bullet; an indented item nests one level.
  const fig = (text: string) => ({ kind: "figure" as const, text, metric: "k@1", window: null });
  const b2 = answerBlocks([
    { kind: "text", text: "Overall health:\n- " }, fig("1"), { kind: "text", text: " domain is degraded.\n  - Connections are affected.\n- Incidents:\n  - " }, fig("3"), { kind: "text", text: " active.\n\nIncidents: " }, fig("2"), { kind: "text", text: " open." },
  ]);
  check("F-2: label, list (item with one nested item), label, list, then a 'Label: figure' sentence stays a paragraph",
    b2.map((b) => b.kind).join() === "label,ul,label,ul,p" && b2[0].kind === "label" && b2[0].line[0].text === "Overall health:"
    && b2[1].kind === "ul" && b2[1].items.length === 1 && b2[1].sub?.[0]?.items.length === 1 && b2[1].sub?.[0]?.items[0][0].text === "Connections are affected."
    && b2[2].kind === "label" && b2[2].line[0].text === "Incidents:" && b2[3].kind === "ul" && b2[3].items.length === 1, JSON.stringify(b2));
  check("F-2: a label NOT followed by list items stays text; a label line carrying a figure is never a label",
    answerBlocks([{ kind: "text", text: "Overall health:\nAll fine." }]).every((b) => b.kind === "p")
    && answerBlocks([{ kind: "text", text: "- Jobs: " }, fig("4"), { kind: "text", text: "\n- next" }]).every((b) => b.kind === "ul"));
  check("F-2: an indented item with no item before it is a plain top-level item", JSON.stringify(answerBlocks([{ kind: "text", text: "  - a\n  - b" }]).map((b) => b.kind)) === '["ul"]');
  const html2 = renderToStaticMarkup(createElement(TypedAnswerSegments, { segments: [{ kind: "text", text: "Overall health:\n- " }, fig("1"), { kind: "text", text: " degraded.\n  - Connections." }] }));
  check("F-2 render: the label is a heading-style paragraph (not an <li>), the nested item is a <ul> inside its parent <li>",
    /<p data-platform-ai-section="" class="[^"]*font-semibold[^"]*"><span>Overall health:<\/span><\/p>/.test(html2) && !/<li[^>]*><span>Overall health/.test(html2)
    && /<li class="min-w-0">[\s\S]*?<ul data-platform-ai-nested=""[^>]*><li class="min-w-0"><span>Connections\.<\/span><\/li><\/ul><\/li>/.test(html2), html2);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
