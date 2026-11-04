/**
 * lib/platform/intelligence/ai/conversations/conversations.test.ts  (B11 — the pure pieces, the handlers, the pins)
 *
 * No database, no key, no network: the handlers run over an in-memory fake
 * store and a fake FRESH area guard; history / answer / purge are pure. The
 * real store is proven against real PostgreSQL roles in
 * scripts/platform-ai-conversations-acceptance.ts.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/conversations/conversations.test.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformArea } from "@prisma/client";
import { scrubOperatorText } from "@/lib/ai/privacy/scrub";
import {
  isStoredAnswer, parseEvidenceRefs, parseStoredAnswer, serializeStoredAnswer, validateEvidenceRefs,
  type EvidenceRef, type StoredAnswerV1,
} from "./answer";
import { PLATFORM_AI_QUESTION_MAX, PLATFORM_AI_TURN_TIMEOUT_MS } from "../core";
import {
  PLATFORM_AI_ABANDON_AFTER_MS, PLATFORM_AI_MESSAGE_MAX,
  PLATFORM_AI_CONVERSATIONS_MAX, PLATFORM_AI_HISTORY_MESSAGES, PLATFORM_AI_LABEL_MAX,
  PLATFORM_AI_PURGE_BATCH, PLATFORM_AI_PURGE_EXCHANGE_FACTOR, PLATFORM_AI_PURGE_MAX_CALLS,
} from "./constants";
import {
  CONVERSATION_ID, NOT_FOUND_BODY, deriveLabel, handleCreateConversation, handleDeleteConversation, handleGetConversation,
  handleListConversations, parseTurnBody, type AreaAccess, type ConversationDeps, type ConversationStoreSeam, type TurnAdmissionDeps,
} from "./handlers";
import {
  HistoryScopeError, PLATFORM_AI_HISTORY_RULE, assemblePlatformAiHistory, buildConversationTurnMessages, figureMarker,
  type HistoryMessage,
} from "./history";
import { parsePurgeRow, runPlatformAiConversationPurge } from "./purge";
import type { ConversationRecord, CreateOutcome, MessageRecord, TurnPair } from "./store";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const T0 = new Date("2026-11-04T10:00:00.000Z");
const UUID_A = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const UUID_B = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const answer = (segments: StoredAnswerV1["segments"], extra: Partial<StoredAnswerV1> = {}): StoredAnswerV1 =>
  ({ v: 1, segments, citations: [], notes: [], stop: "ANSWERED", ...extra });

// ─────────────────────────────────────────────────────────────────────────────
console.log("0. the constants duplicated from the v0 core are equal to it (constants.ts imports nothing)");
{
  check("PLATFORM_AI_MESSAGE_MAX === core.PLATFORM_AI_QUESTION_MAX", PLATFORM_AI_MESSAGE_MAX === PLATFORM_AI_QUESTION_MAX);
  check("PLATFORM_AI_ABANDON_AFTER_MS === 2 × core.PLATFORM_AI_TURN_TIMEOUT_MS", PLATFORM_AI_ABANDON_AFTER_MS === 2 * PLATFORM_AI_TURN_TIMEOUT_MS);
  check("constants.ts has no import (it is reachable from the background-job graph)", !/^\s*import\b/m.test(code(read("lib/platform/intelligence/ai/conversations/constants.ts"))));
  check("purge.ts imports only audit-actions and ./constants", [...code(read("lib/platform/intelligence/ai/conversations/purge.ts")).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort().join() === "./constants,@/lib/audit-actions");
}

console.log("1. the turn body and the derived label");
{
  check("a valid body parses (trimmed, uuid lower-cased)",
    JSON.stringify(parseTurnBody({ clientRequestId: UUID_A.toUpperCase(), question: "  How are providers?  " })) === JSON.stringify({ clientRequestId: UUID_A, question: "How are providers?" }));
  check("an unknown key ⇒ refused", parseTurnBody({ clientRequestId: UUID_A, question: "q", area: "SECURITY_OPS" }) === null);
  check("a missing clientRequestId ⇒ refused", parseTurnBody({ question: "q" }) === null);
  check("a non-UUID clientRequestId ⇒ refused", parseTurnBody({ clientRequestId: "abc", question: "q" }) === null);
  check("501 characters ⇒ refused; 500 accepted", parseTurnBody({ clientRequestId: UUID_A, question: "x".repeat(501) }) === null
    && parseTurnBody({ clientRequestId: UUID_A, question: "x".repeat(500) }) !== null);
  check("an empty question ⇒ refused", parseTurnBody({ clientRequestId: UUID_A, question: "   " }) === null);
  check("the label is the question when short", deriveLabel("Which providers failed today?", "PLATFORM_OPS") === "Which providers failed today?");
  const long = "Which providers have been failing most often across the whole fleet since the start of the week";
  const lab = deriveLabel(long, "PLATFORM_OPS");
  check(`a long question is cut on a word boundary at ≤ ${PLATFORM_AI_LABEL_MAX} chars plus "…"`,
    lab.endsWith("…") && lab.length <= PLATFORM_AI_LABEL_MAX + 1 && long.startsWith(lab.slice(0, -1)) && long[lab.length - 1] === " ", lab);
  check("no remaining message ⇒ \"<area label> conversation\"", deriveLabel(null, "SECURITY_OPS").endsWith(" conversation") && deriveLabel(null, "SECURITY_OPS").length > " conversation".length);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("2. the stored answer and evidence shapes (keys and page ids only)");
{
  const ok = answer([{ kind: "text", text: "There are " }, { kind: "figure", text: "3", metric: "incident-broken-now@1", window: null },
    { kind: "link", text: "Broken now", page: "PLATFORM_OPS:platform-incidents:open", params: {} }], { citations: [{ metric: "incident-broken-now@1", label: "Broken now", window: "now" }] });
  check("a valid answer serialises and parses back identically", JSON.stringify(parseStoredAnswer(serializeStoredAnswer(ok))) === JSON.stringify(ok));
  const withHref = { ...ok, segments: [{ kind: "link", text: "x", page: "PLATFORM_OPS:x", params: {}, href: "/evil" }] };
  check("a link carrying an href is refused (links are page ids, re-resolved on read)", !isStoredAnswer(withHref));
  check("a figure carrying a value field is refused", !isStoredAnswer({ ...ok, segments: [{ kind: "figure", text: "3", metric: "m@1", window: null, value: 3 }] }));
  check("an extra top-level key is refused", !isStoredAnswer({ ...ok, model: "gpt" }));
  let threw = false; try { serializeStoredAnswer(withHref as unknown as StoredAnswerV1); } catch { threw = true; }
  check("serialising a malformed answer THROWS (never stored)", threw);
  check("garbage plaintext parses to null (never shown as raw text)", parseStoredAnswer("not json") === null && parseStoredAnswer('{"v":2}') === null);
  const refs: EvidenceRef[] = [{ k: "m", id: "provider-outcome@1", w: 7 }, { k: "p", id: "PLATFORM_OPS:platform-incidents:open" }];
  check("evidence refs of keys / windows / page ids are accepted", JSON.stringify(validateEvidenceRefs(refs)) === JSON.stringify(refs));
  let refused = 0;
  for (const bad of [[{ k: "m", id: "x@1", w: 7, value: 12 }], [{ k: "m", id: "x@1", w: 7, status: "OK" }], [{ k: "p", id: "x", href: "/a" }], [{ k: "m", id: "bad id with spaces", w: null }], [{ k: "z", id: "x" }]]) {
    try { validateEvidenceRefs(bad as unknown as EvidenceRef[]); } catch { refused++; }
  }
  check("a value, a status, an href, a free-text id or an unknown kind is refused", refused === 5, refused);
  check("a stored value is read defensively (invalid entries dropped)", parseEvidenceRefs([refs[0], { k: "m", id: "x", w: 1, value: 3 }, "junk"]).length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("3. history assembly (design §4): bounded, complete exchanges only, figures masked, refs filtered");
{
  const C = "conv_aaaaaaaaaaaaaaaaaaaa";
  let n = 0;
  const at = (min: number) => new Date(T0.getTime() + min * 60_000);
  const pair = (min: number, q: string, a: StoredAnswerV1 | null, status: "COMPLETE" | "FAILED" | "PENDING" = "COMPLETE", refs: EvidenceRef[] = []): HistoryMessage[] => {
    const uid = `u${++n}`;
    return [
      { id: uid, conversationId: C, role: "USER", status: "COMPLETE", createdAt: at(min), replyToId: null, content: q, evidenceRefs: [] },
      { id: `a${n}`, conversationId: C, role: "ASSISTANT", status, createdAt: at(min), replyToId: uid, content: status === "COMPLETE" ? a : null, evidenceRefs: refs },
    ];
  };
  const scope = { describeMetric: (id: string) => (id === "hidden-metric@1" ? null : { label: id }), pageVisible: (id: string) => id !== "PLATFORM_OPS:hidden" };
  const fig = answer([{ kind: "text", text: "There are " }, { kind: "figure", text: "1,234", metric: "incident-broken-now@1", window: null },
    { kind: "text", text: " broken now; 56% of them are new. See " }, { kind: "link", text: "Broken now", page: "PLATFORM_OPS:platform-incidents:open", params: {} }, { kind: "text", text: "." }]);
  const msgs = [
    ...pair(0, "How many incidents are broken?", fig, "COMPLETE", [{ k: "m", id: "incident-broken-now@1", w: null }, { k: "m", id: "hidden-metric@1", w: 7 }, { k: "p", id: "PLATFORM_OPS:hidden" }]),
    ...pair(1, "This one failed", null, "FAILED"),
    ...pair(2, "This one is in flight", null, "PENDING"),
  ];
  const h = assemblePlatformAiHistory({ conversationId: C, messages: msgs, scope });
  const all = h.messages.map((m) => m.content).join("\n");
  check("only the COMPLETE exchange is used — FAILED and PENDING pairs contribute neither question nor reply",
    h.messages.length === 2 && !all.includes("This one failed") && !all.includes("in flight"), h.messages);
  check("the prior figure is a marker naming its metric and time — its value never reaches the model",
    all.includes(figureMarker("incident-broken-now@1", at(0))) && !all.includes("1,234") && !/\d{2,}%/.test(all.replace(/\[figure from[^\]]*\]/g, "")), all);
  check("…stray digits in a prior answer's prose are masked too (defence in depth)", !all.includes("56") && all.includes("[figure]"));
  check("a prior link becomes its plain label (no href replayed)", all.includes("See Broken now.") && !all.includes("/dashboard"));
  check("the earlier-evidence block lists only refs the CURRENT token can see",
    h.earlierEvidence === "Earlier turns read: incident-broken-now@1." , h.earlierEvidence);
  check("a prior USER message is replayed as the stored (scrubbed) text", h.messages[0].content === "How many incidents are broken?");

  const many: HistoryMessage[] = [];
  for (let i = 0; i < 7; i++) many.push(...pair(10 + i, `question ${"q".repeat(3)} number ${i}`, answer([{ kind: "text", text: `answer ${i}` }])));
  const b = assemblePlatformAiHistory({ conversationId: C, messages: many.slice().reverse(), scope });
  check(`≤ ${PLATFORM_AI_HISTORY_MESSAGES} messages: the newest 5 exchanges kept, the oldest 2 dropped, in order`,
    b.messages.length === PLATFORM_AI_HISTORY_MESSAGES && b.exchangesDropped === 2 && b.messages[0].content.endsWith("number 2") && b.messages[9].content === "answer [figure]", b.messages.map((m) => m.content));
  const big: HistoryMessage[] = [];
  for (let i = 0; i < 4; i++) big.push(...pair(30 + i, `${"w".repeat(2_000)} ${i}`, answer([{ kind: "text", text: "ok" }])));
  const tb = assemblePlatformAiHistory({ conversationId: C, messages: big, scope });
  check("≤ 3,000 estimated tokens (chars ÷ 3): whole exchanges dropped oldest first, never cut mid-text",
    tb.estimatedTokens <= 3_000 && tb.exchangesUsed === 4 - tb.exchangesDropped && tb.exchangesUsed >= 1
      && tb.messages.filter((m) => m.role === "user").every((m) => m.content.length === 2_002) && tb.messages[tb.messages.length - 2].content.endsWith(" 3"), { used: tb.exchangesUsed, tokens: tb.estimatedTokens });
  const expired = assemblePlatformAiHistory({ conversationId: C, messages: many.slice(8), scope });
  check("R1 option (b): a thread whose oldest messages expired assembles from what remains", expired.exchangesUsed === 3 && expired.messages[0].content.endsWith("number 4"));
  const orphan = assemblePlatformAiHistory({ conversationId: C, messages: [many[1]], scope });
  check("a reply whose question is gone contributes nothing", orphan.messages.length === 0);
  let scoped = false;
  try { assemblePlatformAiHistory({ conversationId: C, messages: [...msgs, { ...msgs[0], id: "x", conversationId: "conv_other" }], scope }); } catch (e) { scoped = e instanceof HistoryScopeError; }
  check("ONE conversation: a message from another conversation is refused (no cross-conversation memory)", scoped);
  const turn = buildConversationTurnMessages({ systemPrompt: "SYSTEM", history: h, question: "and last month?" }) as Array<{ role: string; content: string }>;
  check("the turn transcript: system (+ the history rule) → history → server-written refs → the new question",
    turn[0].role === "system" && turn[0].content.endsWith(PLATFORM_AI_HISTORY_RULE) && turn[1].role === "user" && turn[2].role === "assistant"
      && turn[3].role === "system" && turn[3].content.startsWith("Earlier turns read:") && turn[4].role === "user" && turn[4].content === "and last month?" && turn.length === 5);
}

async function asyncSections(): Promise<void> {
// ─────────────────────────────────────────────────────────────────────────────
console.log("4. the handlers over a fake store and a fake FRESH area guard");
{
  type Conv = ConversationRecord & { operatorUserId: string; deleted: boolean; createRequestId: string; messages: MessageRecord[] };
  const convs: Conv[] = [];
  const writes: string[] = [];
  const cuid = (i: number) => `c${String(i).padStart(24, "0")}`;
  let seq = 0;
  const msg = (cid: string, role: "USER" | "ASSISTANT", status: MessageRecord["status"], content: MessageRecord["content"], extra: Partial<MessageRecord> = {}): MessageRecord => ({
    id: `m${String(++seq).padStart(24, "0")}`, conversationId: cid, role, status, createdAt: T0, completedAt: status === "PENDING" ? null : T0,
    replyToId: null, content, unreadable: false, failureCode: null, evidenceRefs: [], ...extra,
  });
  const seed = (i: number, owner: string, area: PlatformArea, q: string, a: MessageRecord["content"], status: MessageRecord["status"] = "COMPLETE", createRequestId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) => {
    const id = cuid(i);
    const u = msg(id, "USER", "COMPLETE", q);
    const r = msg(id, "ASSISTANT", status, a, { replyToId: u.id, failureCode: status === "FAILED" ? "TIMEOUT" : null });
    convs.push({ id, area, createdAt: T0, lastActivityAt: T0, operatorUserId: owner, deleted: false, createRequestId, messages: [u, r] });
    return id;
  };
  const live = (owner: string, id: string) => convs.find((c) => c.id === id && c.operatorUserId === owner && !c.deleted) ?? null;
  let lastCreate: { scrubbedQuestion: string } | null = null;
  let createResult: (() => CreateOutcome) | null = null;
  const store: ConversationStoreSeam = {
    findLiveConversation: async (o, id) => { const c = live(o, id); return c ? { id: c.id, area: c.area, createdAt: c.createdAt, lastActivityAt: c.lastActivityAt } : null; },
    listLiveConversations: async (o) => convs.filter((c) => c.operatorUserId === o && !c.deleted).map((c) => ({
      id: c.id, area: c.area, createdAt: c.createdAt, lastActivityAt: c.lastActivityAt, messageCount: c.messages.length,
      firstQuestion: (c.messages.find((m) => m.role === "USER")?.content as string | undefined) ?? null })),
    readConversation: async (o, id) => { const c = live(o, id); return c ? { conversation: { id: c.id, area: c.area, createdAt: c.createdAt, lastActivityAt: c.lastActivityAt }, messages: c.messages } : null; },
    createConversation: async (input) => { lastCreate = { scrubbedQuestion: input.scrubbedQuestion }; writes.push("create"); return createResult ? createResult() : { kind: "LIMIT", used: 50 }; },
    softDeleteConversation: async (o, id) => { const c = live(o, id); if (!c) return { deleted: false }; c.deleted = true; writes.push("delete"); return { deleted: true, messageCount: c.messages.length }; },
  };
  const grants = new Map<string, Set<PlatformArea>>([["opA", new Set<PlatformArea>(["PLATFORM_OPS", "SECURITY_OPS"])], ["opB", new Set<PlatformArea>(["PLATFORM_OPS"])]]);
  const resolvable = new Set(["PLATFORM_OPS:platform-incidents:open"]);
  const deps: ConversationDeps = {
    areaAccess: async (area, op): Promise<AreaAccess | null> => grants.get(op)?.has(area)
      ? { resolvePage: (page) => (resolvable.has(page) ? { href: `/dashboard/platform/incidents?view=open` } : null) } : null,
    store,
    now: () => T0,
  };
  const A = { operatorId: "opA", area: "PLATFORM_OPS" as PlatformArea };
  const B = { operatorId: "opB", area: "PLATFORM_OPS" as PlatformArea };
  const fig = answer([{ kind: "text", text: "There are " }, { kind: "figure", text: "3", metric: "incident-broken-now@1", window: null },
    { kind: "text", text: ". See " }, { kind: "link", text: "Broken now", page: "PLATFORM_OPS:platform-incidents:open", params: {} },
    { kind: "text", text: " or " }, { kind: "link", text: "a page that no longer resolves", page: "PLATFORM_OPS:gone", params: {} }],
    { citations: [{ metric: "incident-broken-now@1", label: "Broken now", window: "now" }], notes: ["note"] });
  const ops = seed(1, "opA", "PLATFORM_OPS", "How many incidents are broken?", fig);
  const sec = seed(2, "opA", "SECURITY_OPS", "Any detections today?", answer([{ kind: "text", text: "None." }]));
  const bobs = seed(3, "opB", "PLATFORM_OPS", "Bob's question", answer([{ kind: "text", text: "ok" }]));
  const sig = (r: { status: number; body: unknown; headers?: unknown }) => JSON.stringify([r.status, r.body, r.headers ?? null]);

  // list
  const l1 = await handleListConversations(A, deps);
  const rows = (l1.body as { conversations: Array<{ id: string; label: string; full: boolean }>; limits: { conversations: { used: number; max: number } } });
  check("list: the operator's own conversations, labels derived at read time", l1.status === 200 && rows.conversations.length === 2 && rows.conversations.some((c) => c.label === "How many incidents are broken?"));
  check("list: never another operator's", !rows.conversations.some((c) => c.id === bobs));
  grants.get("opA")!.delete("SECURITY_OPS");
  const l2 = await handleListConversations(A, deps);
  const rows2 = l2.body as { conversations: Array<{ id: string }>; limits: { conversations: { used: number; max: number } } };
  check("list: a revoked area's conversations are dropped — neither listed nor counted",
    rows2.conversations.length === 1 && rows2.conversations[0].id === ops && rows2.limits.conversations.used === 1 && rows2.limits.conversations.max === PLATFORM_AI_CONVERSATIONS_MAX, rows2);

  // get — the ONE 404
  const g = await handleGetConversation(A, ops, deps);
  const gb = g.body as { messages: Array<Record<string, unknown>> };
  const content = gb.messages[1].content as Array<{ kind: string; href?: string; text: string }>;
  check("get: own conversation ⇒ 200 with both messages", g.status === 200 && gb.messages.length === 2);
  check("get: a stored link is re-resolved through the CURRENT token (href from the resolver, never stored)",
    content.some((s) => s.kind === "link" && s.href === "/dashboard/platform/incidents?view=open"));
  check("get: a link that no longer resolves renders as plain text", content.some((s) => s.kind === "text" && s.text === "a page that no longer resolves") && content.filter((s) => s.kind === "link").length === 1);
  check("get: figures stay typed; every prior answer is stale; citations and notes carried",
    content.some((s) => s.kind === "figure") && gb.messages[1].stale === true && gb.messages[0].stale === false && (gb.messages[1].citations as unknown[]).length === 1);
  const random = await handleGetConversation(A, cuid(999), deps);
  const other = await handleGetConversation(A, bobs, deps);
  const revoked = await handleGetConversation(A, sec, deps);
  const badShape = await handleGetConversation(A, "../../etc", deps);
  check("get: random id, another operator's id, a revoked area and a malformed id ⇒ byte-identical 404 (status, body, headers)",
    [random, other, revoked, badShape].every((r) => sig(r) === sig(random)) && random.status === 404 && JSON.stringify(random.body) === JSON.stringify(NOT_FOUND_BODY),
    [random, other, revoked, badShape].map(sig));
  check("get / list never wrote anything (R2: reads never extend retention)", writes.length === 0, writes);

  // delete
  const d404 = await handleDeleteConversation(B, ops, deps);
  const dRev = await handleDeleteConversation(A, sec, deps);
  check("delete: another operator's id and a revoked area ⇒ the same 404, nothing deleted", sig(d404) === sig(random) && sig(dRev) === sig(random) && writes.length === 0);
  const d = await handleDeleteConversation(A, ops, deps);
  check("delete: own live conversation ⇒ 204", d.status === 204 && d.body === null && writes.join() === "delete");
  const again = await handleDeleteConversation(A, ops, deps);
  const afterGet = await handleGetConversation(A, ops, deps);
  check("delete: already deleted ⇒ 404 (invisible), and it is gone from get", sig(again) === sig(random) && sig(afterGet) === sig(random));

  // create
  const adm: TurnAdmissionDeps = { admission: async () => ({ paused: false }), freeze: async () => ({ frozen: false }), turns: async () => ({ allowed: true }) };
  const body = { clientRequestId: UUID_A, question: "Email me at ops.lead@example.test about card 4111 1111 1111 1111?" };
  writes.length = 0;
  check("create: a bad body ⇒ 400 VALIDATION, nothing stored", (await handleCreateConversation(A, { question: "q" }, { ...deps, ...adm })).status === 400 && writes.length === 0);
  const ks = await handleCreateConversation(A, body, { ...deps, ...adm, admission: async () => ({ paused: true }) });
  const fz = await handleCreateConversation(A, body, { ...deps, ...adm, freeze: async () => ({ frozen: true }) });
  const cap = await handleCreateConversation(A, body, { ...deps, ...adm, turns: async () => ({ allowed: false, detail: "DAILY_TURNS" }) });
  const unread = await handleCreateConversation(A, body, { ...deps, ...adm, turns: async () => { throw new Error("ledger down"); } });
  check("create: kill switch 503 · freeze 503 · daily cap 429 + Retry-After · unreadable cap 503 — all BEFORE anything is stored (§5.3)",
    ks.status === 503 && (ks.body as { reason: string }).reason === "KILL_SWITCH" && fz.status === 503 && (fz.body as { reason: string }).reason === "COST_FREEZE"
      && cap.status === 429 && Number(cap.headers?.["Retry-After"]) > 0 && unread.status === 503 && writes.length === 0);
  const lim = await handleCreateConversation(A, body, { ...deps, ...adm });
  check("create: the 50-conversation cap ⇒ 409 CONVERSATION_LIMIT", lim.status === 409 && (lim.body as { code: string }).code === "CONVERSATION_LIMIT");
  check("create: the stored question is byte-equal to scrubOperatorText(question) — one scrub for both sinks (S2 B3)",
    lastCreate !== null && (lastCreate as { scrubbedQuestion: string }).scrubbedQuestion === scrubOperatorText(body.question.trim(), 500)
      && !(lastCreate as { scrubbedQuestion: string }).scrubbedQuestion.includes("ops.lead@example.test") && !(lastCreate as { scrubbedQuestion: string }).scrubbedQuestion.includes("4111"));
  const conv: ConversationRecord = { id: cuid(7), area: "PLATFORM_OPS", createdAt: T0, lastActivityAt: T0 };
  const mk = (status: MessageRecord["status"]): TurnPair => {
    const u = msg(conv.id, "USER", "COMPLETE", "q");
    return { user: u, assistant: msg(conv.id, "ASSISTANT", status, status === "COMPLETE" ? answer([{ kind: "text", text: "ok" }]) : null, { replyToId: u.id, failureCode: status === "FAILED" ? "PROVIDER" : null }) };
  };
  const done = mk("COMPLETE");
  createResult = () => ({ kind: "CREATED", conversation: conv, pair: mk("PENDING") });
  const created = await handleCreateConversation(A, body, { ...deps, ...adm });
  check("create: CREATED ⇒ 201 { conversation, userMessage, assistantMessage (PENDING) }",
    created.status === 201 && (created.body as { assistantMessage: { status: string } }).assistantMessage.status === "PENDING" && "conversation" in (created.body ?? {}));
  createResult = () => ({ kind: "REPLAY", conversation: conv, pair: done });
  const r1 = await handleCreateConversation(A, body, { ...deps, ...adm });
  const r2 = await handleCreateConversation(A, body, { ...deps, ...adm });
  check("create replay after COMPLETE ⇒ 200 with the SAME body twice", r1.status === 200 && sig(r1) === sig(r2));
  createResult = () => ({ kind: "REPLAY", conversation: conv, pair: mk("PENDING") });
  const rp = await handleCreateConversation(A, body, { ...deps, ...adm });
  check("create replay while PENDING ⇒ 409 TURN_IN_FLIGHT with Retry-After", rp.status === 409 && (rp.body as { code: string }).code === "TURN_IN_FLIGHT" && Number(rp.headers?.["Retry-After"]) > 0);
  createResult = () => ({ kind: "REPLAY", conversation: conv, pair: mk("FAILED") });
  const rf = await handleCreateConversation(A, body, { ...deps, ...adm });
  check("create replay after FAILED ⇒ 200 with the failed assistant message and its code",
    rf.status === 200 && (rf.body as { assistantMessage: { failureCode: string; status: string } }).assistantMessage.failureCode === "PROVIDER");
  createResult = () => ({ kind: "REPLAY", conversation: { ...conv, area: "SECURITY_OPS" }, pair: done });
  check("create replay of a conversation whose area is now refused ⇒ the same 404", sig(await handleCreateConversation(A, body, { ...deps, ...adm })) === sig(random));
  createResult = () => ({ kind: "DELETED" });
  check("create replay of a deleted conversation ⇒ the same 404", sig(await handleCreateConversation(A, body, { ...deps, ...adm })) === sig(random));
  check("CONVERSATION_ID admits a cuid and nothing else", CONVERSATION_ID.test(cuid(1)) && !CONVERSATION_ID.test(UUID_B) && !CONVERSATION_ID.test("x"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("5. the purge rule (DISABLED by default; batch-bounded; counts-only audit; fail-safe)");
{
  const run = async (enabled: boolean, rows: Array<{ conversations: number; messages: number } | Error>) => {
    const calls: number[] = []; const audits: unknown[] = [];
    const orig = { log: console.log, error: console.error }; console.log = () => {}; console.error = () => {};
    try {
      const r = await runPlatformAiConversationPurge({ enabled, call: async (l) => { calls.push(l); const x = rows.shift() ?? { conversations: 0, messages: 0 }; if (x instanceof Error) throw x; return x; }, audit: async (d) => { audits.push(d); } });
      return { r, calls, audits };
    } finally { console.log = orig.log; console.error = orig.error; }
  };
  const off = await run(false, [{ conversations: 5, messages: 5 }]);
  check("disabled ⇒ no call, no audit", off.calls.length === 0 && off.audits.length === 0 && off.r.enabled === false);
  const sat = { conversations: PLATFORM_AI_PURGE_BATCH, messages: PLATFORM_AI_PURGE_BATCH * PLATFORM_AI_PURGE_EXCHANGE_FACTOR };
  const twice = await run(true, [sat, { conversations: 2, messages: 3 }]);
  check("a saturated call ⇒ another call; the first below both bounds ⇒ exhausted", twice.calls.length === 2 && twice.r.exhausted && twice.r.conversations === sat.conversations + 2);
  const forever = await run(true, Array.from({ length: 40 }, () => ({ ...sat })));
  check(`at most ${PLATFORM_AI_PURGE_MAX_CALLS} calls per run, then "more remain" (exhausted: false)`, forever.calls.length === PLATFORM_AI_PURGE_MAX_CALLS && !forever.r.exhausted);
  check("the audit detail is counts only", Object.keys(forever.audits[0] as object).sort().join() === "batches,conversations,exhausted,messages");
  const partial = await run(true, [sat, new Error("connection reset")]);
  check("a throwing call stops the rule (error reported), never throws, and the deleted counts are still audited",
    partial.r.error === "connection reset" && partial.r.conversations === sat.conversations && partial.audits.length === 1);
  const nothing = await run(true, [{ conversations: 0, messages: 0 }]);
  check("nothing expired ⇒ no audit row", nothing.audits.length === 0 && nothing.calls.length === 1);
  let refused = 0;
  for (const bad of [[], [{ conversations: 1 }], [{ conversations: 1, messages: 2, id: "x" }], [{ conversations: -1, messages: 0 }], [{ conversations: 1, messages: 0 }, { conversations: 1, messages: 0 }]]) {
    try { parsePurgeRow(bad); } catch { refused++; }
  }
  check("the function's row is parsed strictly (exactly { conversations, messages } non-negative integers)", refused === 5 && parsePurgeRow([{ conversations: BigInt(2), messages: 3 }]).messages === 3);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("6. source pins");
{
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${e}`;
      if (e === "node_modules" || e.startsWith(".")) continue;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
    }
    return out;
  };
  const files = ["app", "lib", "jobs", "components"].flatMap((d) => walk(d));
  const STORE = "lib/platform/intelligence/ai/conversations/store.ts";
  const store = code(read(STORE));
  check("the data module runs through withTenantDb and never names systemDb / db / authDb", /withTenantDb\(/.test(store) && !/\b(systemDb|authDb)\b/.test(store) && !/from\s+["']@\/lib\/db["']/.test(store));
  const modelUsers = files.filter((f) => /\b(platformAiConversation|platformAiMessage)\b/.test(code(read(f))));
  check("the two models are touched by the data module ONLY", modelUsers.join() === STORE, modelUsers.join(", "));
  const importers = files.filter((f) => /conversations\/store["']/.test(code(read(f))));
  check("…and no importer of it names systemDb", importers.length > 0 && importers.every((f) => !/\bsystemDb\b/.test(code(read(f)))), importers.join(", "));
  const dataBlocks = [...store.matchAll(/data:\s*(\{[\s\S]*?\})\s*,?\s*\n?\s*(select|\}\))/g)].map((m) => m[1]).join(" ");
  check("no write of a timestamp or retention column anywhere in the module (createdAt, lastActivityAt, purgeAfter, completedAt)",
    !/\b(createdAt|lastActivityAt|purgeAfter|completedAt)\s*:/.test(dataBlocks) && !/\$executeRaw[^`]*`[^`]*\b(UPDATE|INSERT)\b/i.test(store), dataBlocks.slice(0, 400));
  check("the soft delete writes deletedAt ONLY", /updateMany\(\{ where: \{ id, operatorUserId: operatorId, deletedAt: null \}, data: \{ deletedAt: new Date\(\) \} \}\)/.test(store));
  check("the module logs nothing", !/console\./.test(store));
  const audits = [...store.matchAll(/detail:\s*(\{[^}]*\})/g)].map((m) => m[1]);
  check("audit rows carry area / messageCount only — never content, a label or a message id",
    audits.length === 2 && audits.every((d) => /^\{\s*(area(: c\.area)?|messageCount)(,\s*(area(: c\.area)?|messageCount))*\s*\}$/.test(d)), audits);
  const ROUTES = ["app/api/platform/ai/conversations/route.ts", "app/api/platform/ai/conversations/[id]/route.ts"];
  for (const r of ROUTES) {
    const src = code(read(r));
    const logs = [...src.matchAll(/console\.\w+\(([^;]*)\);/g)].map((m) => m[1]);
    check(`${r}: errors are reported by code (one fixed line with the error NAME only) — no body, question or id`,
      logs.length === 1 && /^`\[platform-ai-conversations\] \$\{route\} failed \(\$\{err instanceof Error \? err\.name : "error"\}\)`$/.test(logs[0]), logs);
    check(`${r}: the flag is the first statement of every handler`,
      [...src.matchAll(/export async function (GET|POST|DELETE)\([^)]*\) \{\s*([^\n]*)/g)].every((m) => m[2].startsWith("if (!env.isPlatformAiConversationsEnabled) return")));
    check(`${r}: a break-glass session (no grant) is refused before any lookup`, (src.match(/if \(!auth\.grant\) return FORBIDDEN\(\);/g) ?? []).length === (src.match(/export async function/g) ?? []).length);
    check(`${r}: no Sentry / request-body echo`, !/Sentry|captureException|JSON\.stringify\(body\)/.test(src));
  }
  const access = code(read("app/api/platform/ai/conversations/area-access.ts"));
  check("step 6 refuses a null grant (no break-glass) and a session that is not the operator", /if \(err \|\| !auth\.grant \|\| auth\.grant\.area !== area \|\| auth\.user\.id !== operatorId\) return null;/.test(access));
  const hist = code(read("lib/platform/intelligence/ai/conversations/history.ts"));
  check("the assembler takes ONE conversation id and refuses any other conversation's message",
    /export function assemblePlatformAiHistory\(input: \{\s*conversationId: string;/.test(hist) && /if \(m\.conversationId !== conversationId\) throw new HistoryScopeError/.test(hist));
  check("history assembly is pure (no db, env, clock or provider)", !/@\/lib\/db|@\/lib\/env|new Date\(\)|Date\.now|generateWithTools/.test(hist));
  const env = code(read("lib/env.ts"));
  check("the conversations flag is strict and needs PLATFORM_AI_ENABLED too; the purge flag is strict",
    /get isPlatformAiConversationsEnabled\(\) \{ return _e\.PLATFORM_AI_ENABLED === "true" && _e\.PLATFORM_AI_CONVERSATIONS_ENABLED === "true"; \}/.test(env)
      && /get isPlatformAiPurgeEnabled\(\) \{ return _e\.PLATFORM_AI_PURGE_ENABLED === "true"; \}/.test(env));
  const actions = code(read("lib/audit-actions.ts"));
  const feeds = actions.slice(actions.indexOf("export const PRODUCT_EVENT_ACTIONS"));
  check("the conversation audit actions are in no operator / product feed (another operator must not learn of them)", !/PLATFORM_AI_CONVERSATION/.test(feeds));
}

}

asyncSections().then(() => {
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}).catch((e) => { console.error(e); process.exit(1); });
