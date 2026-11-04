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
 *   5. the disclosure line (OD-5 placeholder) and the v0 privacy hint
 *   6. thread states — failed / pending / full / limit / expired
 *   7. layout — 375 px column, the mobile sheet control, the desktop rail
 *   8. reuse (§11) — MessageCard + FailedTurn only; no customer-only modules
 *   9. privacy — no analytics, no logging, no draft storage, routes only
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-ai-conversations.test.ts
 */

import "@/lib/test-support/route-env";

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { env } from "@/lib/env";
import { PLATFORM_AI_MESSAGE_MAX, PLATFORM_AI_RETENTION_DAYS } from "@/lib/platform/intelligence/ai/conversations/constants";
import { PlatformAiAsk } from "./PlatformAiAsk";
import {
  AssistantAnswer, ConversationList, PlatformAiComposer, PlatformAiConversations, PlatformAiConversationsView, Thread, TypedAnswerSegments,
  type PlatformAiConversationsViewProps,
} from "./PlatformAiConversations";
import {
  CONVERSATION_FULL_COPY, CONVERSATION_LIMIT_COPY, EARLIER_EXPIRED_COPY, FAILURE_COPY, NOT_FOUND_COPY,
  PLATFORM_AI_COMPOSER_MAX, PLATFORM_AI_CONVERSATIONS_DISCLOSURE, PLATFORM_AI_CONVERSATIONS_DISCLOSURE_PENDING, PLATFORM_AI_PRIVACY_HINT,
  PLATFORM_AI_RETENTION_DAYS_CLIENT, RAIL_COLLAPSED_KEY, REFUSAL_COPY, TURN_IN_FLIGHT_COPY,
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
function view(over: Partial<PlatformAiConversationsViewProps> = {}): string {
  const props: PlatformAiConversationsViewProps = {
    areaLabel: "Platform Operations", now: NOW, conversations: [CONV], limits: { used: 1, max: 50 }, listError: null,
    selected: null, threadLoading: false, draft: "", sendingQuestion: null, problem: null, canRetrySend: false,
    sheetOpen: false, railCollapsed: false, confirmDelete: null, deleting: false,
    onDraft: noop, onSend: noop, onRetrySend: noop, onRetryFailed: noop, onCheckPending: noop, onSelect: noop, onNew: noop,
    onAskDelete: noop, onConfirmDelete: noop, onCancelDelete: noop, onSheet: noop, onRail: noop, ...over,
  };
  return renderToStaticMarkup(createElement(PlatformAiConversationsView, props));
}

const COMPONENT = "components/platform/PlatformAiConversations.tsx";
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

// ── 5. disclosure + privacy hint ────────────────────────────────────────────
console.log("\n5. the disclosure line (OD-5 placeholder) and the v0 privacy hint");
{
  check("the disclosure is ONE exported constant, clearly marked OD-5 pending owner",
    PLATFORM_AI_CONVERSATIONS_DISCLOSURE.includes(PLATFORM_AI_CONVERSATIONS_DISCLOSURE_PENDING) && /OD-5 WORDING PENDING OWNER/.test(src(MODEL)));
  check("…and states no retention period, provider term or policy commitment (placeholder, not legal text)",
    !/\d|days?|retain|retention|OpenAI|policy|privacy|legal|deleted after|encrypt/i.test(PLATFORM_AI_CONVERSATIONS_DISCLOSURE.replace(PLATFORM_AI_CONVERSATIONS_DISCLOSURE_PENDING, "")));
  check("SHIP GUARD (S2 on #434): the disclosure STILL contains 'pending owner' — when the owner's OD-5 wording lands, this pin is updated in the same PR, never by accident",
    PLATFORM_AI_CONVERSATIONS_DISCLOSURE.includes("pending owner"));
  const literalUses: string[] = [];
  for (const rel of [COMPONENT, PAGE, "components/platform/PlatformAiAsk.tsx"]) if (src(rel).includes("Conversations are saved")) literalUses.push(rel);
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
  check("while a send is in flight: the question shows, Ask reads 'Asking…' and is disabled",
    /next one/.test(sending) && /data-platform-ai-in-flight/.test(sending) && /<button type="submit" disabled=""[^>]*>Asking…<\/button>/.test(sending));
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
  check("an explicit Retry on a FAILED turn mints a NEW id; the only other minting site is a fresh send (onSend)",
    (cmp.match(/crypto\.randomUUID\(\)/g) ?? []).length === 2
    && /onRetryFailed=\{\(q\) => \{ void send\(\{ [^}]*clientRequestId: crypto\.randomUUID\(\)/.test(cmp)
    && /function onSend\(\) \{[\s\S]*?clientRequestId: crypto\.randomUUID\(\)/.test(cmp));
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
    /data-platform-ai-sheet-toggle=""[^>]*aria-haspopup="dialog"[^>]*class="[^"]*lg:hidden/.test(html) && /Conversations<\/button>/.test(html));
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
  check("the page opens on the latest conversation (the list is lastActivityAt desc), or an empty composer",
    /if \(openLatest && parsed\.conversations\.length > 0\) await openConversation\(parsed\.conversations\[0\]\.id\);/.test(cmp) && /void loadList\(true\);/.test(cmp));
}

// ── 8. reuse ────────────────────────────────────────────────────────────────
console.log("\n8. reuse (§11) — MessageCard and FailedTurn only; nothing customer-only");
{
  const cmp = code(COMPONENT);
  const imports = [...cmp.matchAll(/^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"([^"]+)";/gm)].map((m) => m[1]).sort();
  check("imports: exactly these modules", imports.join() === [
    "./PlatformAiAsk", "./PlatformAiPlaceholder", "./platform-ai-conversations-model",
    "@/components/ai/AiMark", "@/components/ai/FailedTurn", "@/components/ai/Markdown", "@/components/ai/MessageCard",
    "@/components/atlas/ConfirmDialog", "@/components/atlas/panels/Panel", "@/components/atlas/panels/PanelParts",
    "@/components/platform/platform-surface", "lucide-react", "react",
  ].sort().join(), imports);
  check("NOT reused: ConversationView (Markdown answers), Composer (the customer disclosure), the transcript cache, Space context, Talk-about-this",
    !/ConversationView|components\/ai\/Composer|transcript-cache|TalkAboutThis|talk-about-this|AiDisclosure|AiShell|SpaceContext|useSpace|spaceId/.test(cmp));
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

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
