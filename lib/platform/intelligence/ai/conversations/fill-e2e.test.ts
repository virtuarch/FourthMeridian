/**
 * lib/platform/intelligence/ai/conversations/fill-e2e.test.ts  (Platform AI — conversations end to end with a REAL fill, S2 09jr E-a / E-b)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/conversations/fill-e2e.test.ts
 *
 * The Preview failure (every ops answer replaced by the fallback) had no CI test that ran a pack placeholder through
 * the WHOLE conversations path. This one does, with nothing faked between the model and the response except the
 * model (scripted: it COPIES the placeholder strings the pack results hand it) and the store (in memory):
 *
 *   handleCreateConversation → runTurn (as app/api/platform/ai/conversations/turn-runner.ts: the REAL turn boundary
 *   over the REAL incidents pack contracts and the E0 incident readers) → runConversationTurn → runPlatformAiTurn →
 *   compose → storedAnswerOf → the handler's settle → pairResponse (the record spans rendered by the REAL
 *   authz/record-render.ts under a FRESH guard, with the REAL INCIDENT record source);
 *
 * and asserts: figureSources is NON-EMPTY (a record field and an aggregate path, positioned on the response's own
 * content); the stored answer re-renders under fresh guards (GET: a new recheck per read, the same text; a revoked
 * area ⇒ "[no longer available]"); and E-b — `answerVerdict` is in the response only (COMPLETE here; FALLBACK:<code>
 * for a replaced answer), stripped before the settle (the store never sees it), absent on a replay, never inside
 * toolTrace, its key pinned, the clients ignore it. Also the /ask handler's body. No database, no network.
 */

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "fill-e2e-test-secret-not-real";

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import { E0_INCIDENT_IDS, e0IncidentReaders, e0IncidentWorld } from "../eval/fixtures";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 900)}` : ""}`); }
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const OP = "cop00000000000000000000e2e";
const NOW = new Date("2026-11-12T03:00:00.000Z");
const OPS: PlatformArea = "PLATFORM_OPS";
const OPS_TOKEN = { audience: "PLATFORM_OPS" } as never;
const CONV = "cfille2econversation00001";
const UUID_A = "00000000-0000-4000-8000-0000000e2e01";
const UUID_B = "00000000-0000-4000-8000-0000000e2e02";

type Msg = { role: string; content: string | null };
const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 };
const callStep = (name: string) => ({ content: null, toolCalls: [{ id: `c-${name}`, name, arguments: "{}" }], raw: { role: "assistant", content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: "{}" } }] }, usage });
const answerStep = (content: string) => ({ content, toolCalls: [], raw: { role: "assistant", content }, usage });

async function main() {
  const { createTurnBoundary } = await import("../authz/boundary");
  const { scopeFromGuard } = await import("../authz/scope");
  const { recordTextRenderer } = await import("../authz/record-render");
  const { incidentsPackTools } = await import("../tools/packs/incidents");
  const { incidentRecordSource } = await import("../tools/packs/incidents.server");
  const { placedSpansOf, FIGURE_SOURCE_KEYS } = await import("../tools/figure-sources");
  const { platformAiToolTrace } = await import("../tools/tool-trace");
  const { runConversationTurn } = await import("./turn");
  const { handleCreateConversation, handleGetConversation } = await import("./handlers");
  const { ANSWER_VERDICTS, handlePlatformAiAsk } = await import("../core");
  const { renderClosedValue, RECORD_GONE_TEXT } = await import("../compose/record");
  const { parsePair } = await import("@/components/platform/platform-ai-conversations-model");
  type PlatformAiBinding = import("../core").PlatformAiBinding;
  type PlatformAiGenerate = import("../core").PlatformAiGenerate;
  type AreaAccess = import("./handlers").AreaAccess;
  type MessageRecord = import("./store").MessageRecord;
  type TurnPair = import("./store").TurnPair;
  type SettleOutcome = import("./store").SettleOutcome;

  const authOf = (area: PlatformArea) => ({ user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" as const } });
  const scope = scopeFromGuard(authOf(OPS), OPS, OP)!;
  const binding: PlatformAiBinding = { surfaceLabel: "Platform Ops", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null };
  let held = true;
  let rechecks = 0;
  const recheck = async (a: PlatformArea) => { rechecks++; return held && a === OPS ? { auth: authOf(a), csTier: false, incidentToken: OPS_TOKEN } : null; };

  // The REAL INCIDENT read-time source over the fixture world (the drawer accessor, Ops projection).
  const w = e0IncidentWorld(NOW);
  const strip = (v: Record<string, unknown>) => { const { subjectUserId: _x, ...rest } = v; return rest; };
  const acc = { detail: async (_t: unknown, id: string) => { const v = w.verdicts.find((x) => x.id === id); return v ? strip(v) : null; }, investigate: async () => null };
  const source = incidentRecordSource(acc as never, { user: { findFirst: async () => null, findUnique: async () => null } } as never);
  const access = (): AreaAccess => ({
    resolvePage: () => null, binding, area: OPS, scope,
    renderRecords: recordTextRenderer({ operatorId: OP, mode: "history", recheck, sources: { INCIDENT: source } }),
  });

  /** The scripted model: overview, list, then an answer COPYING the strings the pack results handed it. */
  const scripted = (answer: (agg: Record<string, string>, rec: Record<string, string>) => string): { generate: PlatformAiGenerate; requests: Msg[][] } => {
    const requests: Msg[][] = [];
    let i = 0;
    return {
      requests,
      generate: async ({ messages }) => {
        requests.push(JSON.parse(JSON.stringify(messages)));
        i++;
        if (i === 1) return callStep("incident_overview") as never;
        if (i === 2) return callStep("list_incidents") as never;
        const tools = (messages as Msg[]).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content ?? "null") as Record<string, unknown>);
        const agg = (tools[0]?.placeholders ?? {}) as Record<string, string>;
        const rec = ((tools[1]?.records as { placeholders?: Record<string, string> }[] | undefined)?.[0]?.placeholders ?? {}) as Record<string, string>;
        return answerStep(answer(agg, rec)) as never;
      },
    };
  };

  /** runTurn exactly as the route's turn runner wires it (boundary + runConversationTurn + toolTrace + figureSources). */
  let model = scripted((agg, rec) => `Broken now: ${agg.brokenNow}. The most urgent incident is ${rec.state}, severity ${rec.severity}.`);
  const runTurn = async ({ question, access: a }: { question: string; access: AreaAccess }) => {
    const b = createTurnBoundary({
      operatorId: OP, correlationId: `corr-${Math.random()}`, areas: [{ scope: a.scope!, binding: a.binding }], binding: a.binding,
      recheck, packs: ["metrics", "navigation", "incidents"], packEnabled: () => true,
      registry: incidentsPackTools(e0IncidentReaders(NOW)) as never, recordSources: { INCIDENT: source },
    });
    const run = await runConversationTurn({
      conversationId: CONV, question, binding: a.binding, history: [], generate: model.generate, model: "scripted", classify: () => "PROVIDER",
      invoke: b.invoke, records: b.recordRef, remint: b.remint,
    });
    const toolTrace = platformAiToolTrace(run.result?.trace ?? []);
    const figureSources = run.outcome.status === "COMPLETE" ? placedSpansOf(run.typed ?? []) : [];
    return { ...run.outcome, toolTrace, figureSources };
  };

  // The in-memory store (one conversation, one pair).
  let settled: SettleOutcome | null = null;
  const settleCalls: unknown[] = [];
  let created = false;
  const conv = { id: CONV, area: OPS, createdAt: NOW, lastActivityAt: NOW };
  const user: MessageRecord = { id: "mu0000000000000000000000001", conversationId: CONV, role: "USER", status: "COMPLETE", createdAt: NOW, completedAt: NOW, replyToId: null, content: "How are incidents?", unreadable: false, failureCode: null, evidenceRefs: [] } as MessageRecord;
  const pending: MessageRecord = { ...user, id: "ma0000000000000000000000001", role: "ASSISTANT", status: "PENDING", completedAt: null, replyToId: user.id, content: null } as MessageRecord;
  const pair = (): TurnPair => settled === null ? { user, assistant: pending } : {
    user, assistant: { ...pending, status: settled.status, completedAt: NOW, content: settled.status === "COMPLETE" ? settled.answer : null,
      failureCode: settled.status === "FAILED" ? settled.failureCode : null, evidenceRefs: settled.status === "COMPLETE" ? [...settled.evidenceRefs] : [] } as MessageRecord,
  };
  const store = {
    findCreateConversation: async () => (created ? { kind: "FOUND" as const, conversation: conv } : null),
    findTurnPair: async () => pair(),
    appendTurn: async () => ({ kind: "NOT_FOUND" as const }),
    settleTurn: async (_o: string, _c: string, _a: string, outcome: SettleOutcome) => { settleCalls.push(outcome); settled = outcome; return true; },
    loadConversationHistory: async () => [],
    findLiveConversation: async () => conv,
    listLiveConversations: async () => [],
    readConversation: async () => ({ conversation: conv, messages: [pair().user, pair().assistant] }),
    createConversation: async () => { created = true; return { kind: "CREATED" as const, conversation: conv, pair: pair() }; },
    softDeleteConversation: async () => ({ deleted: false as const }),
  };
  const deps = {
    guard: async () => ({ pass: true as const }),
    areaAccess: async () => access(),
    store, now: () => NOW,
    admission: async () => ({ paused: false }), freeze: async () => ({ frozen: false }), turns: async () => ({ allowed: true }),
    runTurn,
  };
  const V = { operatorId: OP, area: OPS };

  console.log("E-a — a REAL fill through runConversationTurn → handler → response");
  const res = await handleCreateConversation(V, { clientRequestId: UUID_A, question: "How are incidents looking?" }, deps as never);
  const body = res.body as Record<string, unknown>;
  const content = (body.assistantMessage as { content: { kind: string; text: string }[] }).content;
  const sources = body.figureSources as Record<string, unknown>[];
  const text = content.map((s) => s.text).join("");
  check("201, the answer KEPT (not the fallback)", res.status === 201 && !/couldn't verify/.test(text), [res.status, text]);
  check("the model received ready-to-copy strings: the overview's placeholders.brokenNow and the record's placeholders.state",
    model.requests.length === 3 && /\{\{a:incident_overview\|brokenNow\}\}/.test(JSON.stringify(model.requests[2])) && /\{\{r:h_[A-Za-z0-9_-]{16}\|state\}\}/.test(JSON.stringify(model.requests[2])));
  check("figureSources is NON-EMPTY: an aggregate (incident_overview / brokenNow) and records (INCIDENT / state, severity)",
    Array.isArray(sources) && sources.length === 3
      && sources.some((s) => s.source === "aggregate" && s.tool === "incident_overview" && s.resultPath === "brokenNow")
      && sources.some((s) => s.source === "record" && s.recordKind === "INCIDENT" && s.fieldCode === "state")
      && sources.some((s) => s.source === "record" && s.recordKind === "INCIDENT" && s.fieldCode === "severity"), sources);
  check("each source is positioned on the response's OWN content (the span text is what the server rendered there)",
    sources.every((s) => typeof s.segment === "number" && content[s.segment as number] !== undefined && content[s.segment as number].text.slice(s.start as number, s.end as number).length > 0)
      && sources.every((s) => Object.keys(s).every((k) => (FIGURE_SOURCE_KEYS as readonly string[]).includes(k))), sources);
  const stored = settled as SettleOutcome | null;
  const recSegs = stored?.status === "COMPLETE" ? stored.answer.segments.filter((s) => s.kind === "record") : [];
  check("the stored answer: V3 record segments {rk INCIDENT, f state / severity, v = the tool's closed value}; an aggregate FIGURE agg:incident_overview:brokenNow",
    stored?.status === "COMPLETE" && stored.answer.v === 3 && recSegs.length === 2 && recSegs.every((s) => s.kind === "record" && s.rk === "INCIDENT" && (Object.values(E0_INCIDENT_IDS) as string[]).includes(s.rid) && (s as { v?: unknown }).v !== undefined)
      && stored.answer.segments.some((s) => s.kind === "figure" && s.metric === "agg:incident_overview:brokenNow"), stored);
  const expected = recSegs.map((s) => renderClosedValue((s as { v?: unknown }).v));
  check("the live response renders each record span to its closed value under the fresh guard", expected.length === 2 && expected.every((t) => t !== null && text.includes(t!)), [expected, text]);

  console.log("\nE-a — the stored answer re-renders under FRESH guards");
  const before = rechecks;
  const g1 = await handleGetConversation(V, CONV, deps as never);
  const gContent = ((g1.body as { messages: { content: { text: string }[] | string }[] }).messages[1].content as { text: string }[]).map((s) => s.text).join("");
  check("GET: a NEW fresh recheck for the read, the same rendered text (no value is re-read from the model)", rechecks > before && expected.every((t) => gContent.includes(t!)) && gContent === text, [gContent, text]);
  held = false;
  const g2 = await handleGetConversation(V, CONV, deps as never);
  const revokedText = ((g2.body as { messages: { content: { text: string }[] }[] }).messages[1].content).map((s) => s.text).join("");
  check("GET after the area's fresh guard refuses: every record span ⇒ \"[no longer available]\", no closed value",
    revokedText.split(RECORD_GONE_TEXT).length - 1 === 2 && !expected.some((t) => revokedText.includes(t!)), revokedText);
  held = true;

  console.log("\nE-b — answerVerdict: response only, stripped before the settle, absent on a replay, never in toolTrace");
  check("the 201 body carries answerVerdict = COMPLETE (a closed value)", body.answerVerdict === "COMPLETE" && ANSWER_VERDICTS.includes(body.answerVerdict as never));
  check("the 201 body's keys are pinned: conversation, userMessage, assistantMessage, toolTrace, figureSources, answerVerdict",
    JSON.stringify(Object.keys(body)) === JSON.stringify(["conversation", "userMessage", "assistantMessage", "toolTrace", "figureSources", "answerVerdict"]), Object.keys(body));
  check("never inside toolTrace (the trace keeps its closed key set)", !/answerVerdict|COMPLETE|FALLBACK/.test(JSON.stringify(body.toolTrace)));
  check("stripped BEFORE the settle: the store received no answerVerdict / toolTrace / figureSources", settleCalls.length === 1 && !/answerVerdict|toolTrace|figureSources/.test(JSON.stringify(Object.keys(settleCalls[0] as object))), Object.keys(settleCalls[0] as object));
  const replay = await handleCreateConversation(V, { clientRequestId: UUID_A, question: "How are incidents looking?" }, deps as never);
  check("a replay (the same clientRequestId) ⇒ 200, NO answerVerdict (nor toolTrace / figureSources)", replay.status === 200 && !/answerVerdict|toolTrace|figureSources/.test(Object.keys(replay.body as object).join()), Object.keys(replay.body as object));
  const getKeys = JSON.stringify(g1.body);
  check("GET (a read) never carries answerVerdict", !/answerVerdict/.test(getKeys));

  // A replaced answer: the model types a figure instead of copying ⇒ the verdict names the closed code.
  settled = null; created = false; settleCalls.length = 0;
  model = scripted(() => "There are 3 broken incidents.");
  const bad = await handleCreateConversation(V, { clientRequestId: UUID_B, question: "How are incidents looking?" }, deps as never);
  check("a replaced answer ⇒ answerVerdict FALLBACK:UNGROUNDED_DIGIT (after its one retry), the fallback text stored — and the verdict is NOT stored",
    (bad.body as Record<string, unknown>).answerVerdict === "FALLBACK:UNGROUNDED_DIGIT" && !/answerVerdict/.test(JSON.stringify(settleCalls)), [(bad.body as Record<string, unknown>).answerVerdict, settleCalls]);
  const p = { userMessage: (body.userMessage), assistantMessage: body.assistantMessage };
  check("the conversations client parses a pair the same with or without answerVerdict (ignored)", JSON.stringify(parsePair(p)) === JSON.stringify(parsePair({ ...p, answerVerdict: "FALLBACK:BUDGET" })) && parsePair(p) !== null);
  const clients = ["components/platform/PlatformAiAsk.tsx", "components/platform/platform-ai-conversations-model.ts"].map((f) => code(read(f))).join("\n");
  check("no client reads answerVerdict", !/answerVerdict/.test(clients));
  const h = code(read("lib/platform/intelligence/ai/conversations/handlers.ts"));
  const rs = h.slice(h.indexOf("async function runAndSettle("), h.indexOf("async function admit("));
  check("the handler destructures answerVerdict off BEFORE settleTurn", rs.indexOf("const { toolTrace, figureSources, answerVerdict, ...outcome } = run;") > 0
    && rs.indexOf("const { toolTrace, figureSources, answerVerdict, ...outcome } = run;") < rs.indexOf("settleTurn(v.operatorId, conversationId, pair.assistant.id, outcome)"));
  const storeSrc = code(read("lib/platform/intelligence/ai/conversations/store.ts")) + code(read("lib/platform/intelligence/ai/conversations/answer.ts"));
  check("the store and the stored-answer validator never mention answerVerdict (persist nothing new)", !/answerVerdict/.test(storeSrc));
  const verdictSrc = code(read("lib/platform/intelligence/ai/core.ts"));
  const fn = verdictSrc.slice(verdictSrc.indexOf("export function answerVerdictOf("), verdictSrc.indexOf("export const UNVERIFIED_FALLBACK"));
  check("answerVerdictOf has no operator / synthetic / env branch (the same for every operator)", fn.length > 0 && !/operator|synthetic|process\.env|userId|role/i.test(fn));

  console.log("\nE-b — the /ask handler's 200 body");
  {
    const b = createTurnBoundary({
      operatorId: OP, correlationId: "corr-ask", areas: [{ scope, binding }], binding, recheck, packs: ["metrics", "navigation", "incidents"], packEnabled: () => true,
      registry: incidentsPackTools(e0IncidentReaders(NOW)) as never, recordSources: { INCIDENT: source },
    });
    model = scripted((agg) => `Broken now: ${agg.brokenNow}.`);
    const r = await handlePlatformAiAsk({ question: "How are incidents looking?" }, {
      enabled: true, operatorId: OP, binding, admission: async () => ({ paused: false, state: "ok" }), freeze: async () => ({ frozen: false, state: "ok" }),
      turns: async () => ({ allowed: true, remaining: 5 }), generate: model.generate, model: "scripted", now: () => NOW, classify: () => "PROVIDER",
      guard: async () => ({ pass: true }), invoke: b.invoke, records: b.recordRef, toolTrace: (t) => platformAiToolTrace(t),
    });
    const ab = r.body as Record<string, unknown>;
    check("/ask: answerVerdict COMPLETE beside toolTrace (never inside it)", r.status === 200 && ab.answerVerdict === "COMPLETE" && !/answerVerdict|COMPLETE/.test(JSON.stringify(ab.toolTrace)), ab.answerVerdict);
  }

  if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
  console.log(`\nall ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
