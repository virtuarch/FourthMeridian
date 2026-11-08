/**
 * lib/platform/intelligence/ai/memory/memory-ui.test.ts  (Platform AI operational memory — PR-B unit tests)
 *
 * Design v2 §8 (unit, staleness, panel, area revocation) for the tools,
 * injection, token, confirm / remember / renew handlers and the UI. No database,
 * no network, no provider (a scripted model):
 *   1. token: signed + sealed; forged / other operator / other area / expired
 *      refused; no plaintext of any source in it; B5 shingles catch an edited note
 *      copying 6 words of the question, the answer or history; truncation (st)
 *      refuses any edit;
 *   2. confirm handler: every refusal (guard, NOTE_VERBATIM, NOTE_EDIT_UNAVAILABLE,
 *      RECORD_CHANGED, replayed jti ⇒ 409) and the 201;
 *   3. the {{mem}} renderer for every badge; the D10 correction (placeholder or
 *      bare label without a live read ⇒ the line; a live read ⇒ none); injection
 *      placement; tools only with memory; propose rules;
 *   4. staleness (B3), one case each; 100 recalls never write; area revocation;
 *   5. renew: OPERATIONAL_STATE CHANGED ⇒ 409, GONE ⇒ 409, otherwise renewed;
 *   6. panel: a GONE row is type only; the INCIDENT label is the reader's LIVE one
 *      (narrowed access ⇒ the narrowed label); the notice verbatim; the short line
 *      (memory on ⇒ the corrected line; off ⇒ the original) — both pinned;
 *   7. the gate, the stored memory span shape, the remember handler.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/memory/memory-ui.test.ts
 */

import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlatformArea } from "@prisma/client";

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
delete process.env.ENCRYPTION_KEY_PREVIOUS;

import { runPlatformAiTurn, MEMORY_LIVE_NOT_CHECKED, type PlatformAiBinding, type PlatformAiGenerate } from "../core";
import { isStoredAnswer, MEMORY_SPAN_SHAPE } from "../conversations/answer";
import { PLATFORM_AI_CONVERSATIONS_LINE } from "@/components/platform/platform-ai-conversations-model";
import { PLATFORM_AI_MEMORY_LINE, PLATFORM_AI_MEMORY_NOTICE, PLATFORM_AI_MEMORY_PANEL_HEADER } from "@/components/platform/platform-ai-memory-model";
import { PlatformAiDisclosureLine } from "@/components/platform/platform-ai-presentation";
import { PlatformAiMemoryPanelView, PlatformAiMemoryConfirmCardView } from "@/components/platform/PlatformAiMemory";
import { MEMORY_SHINGLES_MAX } from "./constants";
import { isMemoryEffective } from "./gate";
import { handleConfirm, handleListMemory, handleRemember, handleRenew, type MemoryDeps, type MemoryStoreSeam } from "./handlers";
import { memPlaceholderText, retrieveFacts, type RetrievedFact } from "./retrieve";
import { type FactCheck, type MemoryReaders, type RecordRead } from "./revalidate";
import type { MemoryRef } from "./schema";
import type { InsertFactInput, MemoryFactRecord } from "./store";
import { noteHitsShingles, shingleMacs, signProposal, verifyProposalToken } from "./token";
import { buildMemoryTurn } from "./turn";
import { EncryptionPurpose, openWithPurpose } from "@/lib/plaid/encryption";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === "" ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); }
}

const OP = "cop0000000000000000000000a";
const AREA: PlatformArea = "PLATFORM_OPS";
const NOW = new Date("2026-11-08T12:00:00Z");
const PAGE_ID = "PLATFORM_OPS:platform-incidents:open";
const METRIC = "provider-outcome@1";
const QUESTION = "why are the plaid webhook retries piling up for sync banks this morning";
const HISTORY = ["earlier we looked at the overnight refresh pipeline and it stalled twice"];
const ANSWER = "the retries come from one degraded provider and the queue is draining slowly now";

let seq = 0;
function fact(over: Partial<MemoryFactRecord> = {}): MemoryFactRecord {
  seq++;
  return {
    id: `cfact${String(seq).padStart(20, "0")}`, area: AREA, factType: "WATCHING_ISSUE", origin: "TOOL_DERIVED", concern: "DEGRADATION",
    note: "check after deploy", noteUnreadable: false, payload: {}, refs: [{ t: "PAGE", id: PAGE_ID, observedState: "OK" }], ttl: "D7",
    observedAt: new Date(NOW.getTime() - 86_400_000), createdAt: new Date(NOW.getTime() - 86_400_000), expiresAt: new Date(NOW.getTime() + 6 * 86_400_000),
    supersedesId: null, ...over,
  };
}
const read = (state: RecordRead["state"], label = "Live label", updatedAt: Date | null = null): RecordRead => ({ state, label, updatedAt });
function readers(over: Partial<MemoryReaders> = {}): MemoryReaders {
  return {
    metric: async () => read("DEGRADED", "Provider outcome verdict"), page: async () => read("OK", "Open incidents"),
    incident: async () => read("OPEN", "Sync failing"), job: async () => read("FAILED", "sync-banks"), provider: async () => read("DEGRADED", "Plaid"),
    ...over,
  };
}

/** An in-memory store applying the same visibility rule (not deleted / not invalidated). */
function fakeStore(initial: MemoryFactRecord[]) {
  const rows = new Map(initial.map((f) => [f.id, { f, invalidReason: null as string | null, deleted: false }]));
  const inserted: InsertFactInput[] = [];
  const refusals: string[] = [];
  const jtis = new Set<string>();
  const store: MemoryStoreSeam = {
    async visibleFacts(_op, opts) {
      return [...rows.values()].filter((r) => !r.deleted && r.invalidReason === null && (!opts.areas || opts.areas.includes(r.f.area)) && (!opts.ids || opts.ids.includes(r.f.id))).map((r) => r.f).slice(0, opts.take ?? 1e9);
    },
    async invalidateFacts(_op, items) { let n = 0; for (const it of items) { const r = rows.get(it.id); if (r && r.invalidReason === null) { r.invalidReason = it.reason; n++; } } return n; },
    async insertFact(input) {
      if (input.proposalJti && jtis.has(input.proposalJti)) return { kind: "REPLAY" };
      if (input.proposalJti) jtis.add(input.proposalJti);
      inserted.push(input);
      const f = fact({ id: `cnew${String(inserted.length).padStart(21, "0")}`, factType: input.factType, note: input.note, refs: [...input.refs] });
      rows.set(f.id, { f, invalidReason: null, deleted: false });
      return { kind: "CREATED", fact: f };
    },
    async renewFact(_op, id, refs) {
      const r = rows.get(id);
      if (!r || r.invalidReason || r.deleted) return { kind: "NOT_FOUND" };
      r.invalidReason = "SUPERSEDED";
      const f = fact({ factType: r.f.factType, refs: [...refs], supersedesId: id });
      rows.set(f.id, { f, invalidReason: null, deleted: false });
      return { kind: "RENEWED", fact: f };
    },
    async softDeleteFact(_op, id) { const r = rows.get(id); if (!r || r.deleted) return { deleted: 0 }; r.deleted = true; return { deleted: 1 }; },
    async softDeleteAllFacts() { let n = 0; for (const r of rows.values()) if (!r.deleted) { r.deleted = true; n++; } return { deleted: n }; },
    async recordProposalRefusals(_op, _area, codes) { refusals.push(...codes); },
  };
  return { store, rows, inserted, refusals };
}
const deps = (store: MemoryStoreSeam, rd: MemoryReaders | null = readers(), held: PlatformArea[] = [AREA]): MemoryDeps =>
  ({ heldAreas: async () => new Set(held), readersFor: async (a) => (held.includes(a) ? rd : null), store, now: () => NOW });

async function main(): Promise<void> {
  console.log("1. the proposal token (D3, B5)");
  const ref: MemoryRef = { t: "METRIC", id: METRIC, w: 7, observedState: "DEGRADED" };
  const signed = signProposal({ operatorId: OP, area: AREA, factType: "WATCHING_ISSUE", concern: "DEGRADATION", note: "watch the retry queue", refs: [ref], shingleSources: [QUESTION, ANSWER, ...HISTORY], now: NOW });
  const okv = verifyProposalToken(signed.token, { operatorId: OP, areaAllowed: (a) => a === AREA, now: NOW });
  check("a fresh token verifies (same operator, held area, < 15 min)", okv.ok && okv.ok && okv.proposal.jti === signed.proposal.jti);
  const forged = signed.token.slice(0, -4) + (signed.token.endsWith("AAAA") ? "BBBB" : "AAAA");
  check("a forged / edited token ⇒ BAD_TOKEN", (() => { const v = verifyProposalToken(forged, { operatorId: OP, areaAllowed: () => true, now: NOW }); return !v.ok && v.reason === "BAD_TOKEN"; })());
  check("another operator ⇒ WRONG_OPERATOR", (() => { const v = verifyProposalToken(signed.token, { operatorId: "cother000000000000000000000", areaAllowed: () => true, now: NOW }); return !v.ok && v.reason === "WRONG_OPERATOR"; })());
  check("an area not held ⇒ WRONG_AREA", (() => { const v = verifyProposalToken(signed.token, { operatorId: OP, areaAllowed: () => false, now: NOW }); return !v.ok && v.reason === "WRONG_AREA"; })());
  check("16 minutes later ⇒ EXPIRED", (() => { const v = verifyProposalToken(signed.token, { operatorId: OP, areaAllowed: () => true, now: new Date(NOW.getTime() + 16 * 60_000) }); return !v.ok && v.reason === "EXPIRED"; })());
  const opened = openWithPurpose(signed.token, EncryptionPurpose.PLATFORM_AI_MEMORY_TOKEN);
  const words = (s: string) => s.split(" ");
  const spans = [QUESTION, ANSWER, ...HISTORY].flatMap((s) => { const w = words(s); const out: string[] = []; for (let i = 0; i + 3 <= w.length; i++) out.push(w.slice(i, i + 3).join(" ")); return out; });
  check("the token (sealed AND opened) contains no plaintext substring of the question, answer or history", !spans.some((sp) => opened.includes(sp) || signed.token.includes(sp)), spans.find((sp) => opened.includes(sp)));
  check("…and no conversation / message id key", !/conversation|message/i.test(opened));
  check("B5: an edited note copying 6 words of the QUESTION hits", noteHitsShingles("note plaid webhook retries piling up for sync", signed.proposal));
  check("B5: …of the ANSWER hits", noteHitsShingles("the queue is draining slowly now ok", signed.proposal) || noteHitsShingles("one degraded provider and the queue is", signed.proposal));
  check("B5: …of HISTORY hits", noteHitsShingles("the overnight refresh pipeline and it stalled", signed.proposal));
  check("B5: an operator's own words do not hit", !noteHitsShingles("watch the retry queue after the deploy tonight", signed.proposal));
  check("B5 + §8: a 5-word copy of 24+ characters (under D7's 6 words / 40 chars) hits the word-aligned character windows", noteHitsShingles("x plaid webhook retries piling", signed.proposal));
  const big = Array.from({ length: 700 }, (_, i) => `w${i}`).join(" ");
  const trunc = shingleMacs([big]);
  check(`B5: at most ${MEMORY_SHINGLES_MAX} shingles; the cap sets st`, trunc.sh.length === MEMORY_SHINGLES_MAX && trunc.st === true);

  console.log("\n2. confirm (design §2 steps 1–6)");
  {
    const f = fakeStore([]);
    const body = (over: Record<string, unknown> = {}) => ({ token: signed.token, ttl: "D7", ...over });
    const r201 = await handleConfirm(OP, body(), deps(f.store));
    check("an unedited proposal confirms: 201, origin TOOL_DERIVED, proposalJti = jti, the server's refs", r201.status === 201 && f.inserted[0]?.proposalJti === signed.proposal.jti && f.inserted[0]?.origin === "TOOL_DERIVED" && f.inserted[0]?.refs[0]?.observedState === "DEGRADED");
    const replay = await handleConfirm(OP, body(), deps(f.store));
    check("a REPLAYED jti ⇒ 409 REPLAY (audited as a refusal)", replay.status === 409 && (replay.body as { code: string }).code === "REPLAY" && f.refusals.includes("REPLAY"));
    const f2 = fakeStore([]);
    const verb = await handleConfirm(OP, body({ note: "note plaid webhook retries piling up for sync" }), deps(f2.store));
    check("an EDITED note copying 6 words ⇒ 422 NOTE_VERBATIM, nothing inserted", verb.status === 422 && (verb.body as { code: string }).code === "NOTE_VERBATIM" && f2.inserted.length === 0);
    const amt = await handleConfirm(OP, body({ note: "cost spiked 5k" }), deps(f2.store));
    check("an edited note with an amount ⇒ 422 NOTE_AMOUNT", amt.status === 422 && (amt.body as { code: string }).code === "NOTE_AMOUNT");
    const tr = signProposal({ operatorId: OP, area: AREA, factType: "WATCHING_ISSUE", concern: null, note: "keep", refs: [ref], shingleSources: [big], now: NOW });
    const edit = await handleConfirm(OP, { token: tr.token, ttl: "D7", note: "a different note" }, deps(f2.store));
    const clear = await handleConfirm(OP, { token: tr.token, ttl: "D7", note: null }, deps(f2.store));
    check("shTrunc: any edit ⇒ 422 NOTE_EDIT_UNAVAILABLE; clearing the note is allowed", edit.status === 422 && (edit.body as { code: string }).code === "NOTE_EDIT_UNAVAILABLE" && clear.status === 201);
    const changed = await handleConfirm(OP, body({}), deps(fakeStore([]).store, readers({ metric: async () => read("OK", "x") })));
    const gone = await handleConfirm(OP, body({}), deps(fakeStore([]).store, readers({ metric: async () => null })));
    check("a ref that CHANGED or is GONE since the proposal ⇒ 409 RECORD_CHANGED", changed.status === 409 && gone.status === 409);
    const badTtl = await handleConfirm(OP, body({ ttl: "D30x" }), deps(fakeStore([]).store));
    const extra = await handleConfirm(OP, { ...body(), conversationId: "c1" }, deps(fakeStore([]).store));
    check("a TTL outside the type's choices, or an extra field ⇒ 400", badTtl.status === 400 && extra.status === 400);
    const os = signProposal({ operatorId: OP, area: AREA, factType: "OPERATIONAL_STATE", concern: null, note: null, refs: [ref], shingleSources: [], now: NOW });
    check("OPERATIONAL_STATE is fixed at 72 h (D7 refused)", (await handleConfirm(OP, { token: os.token, ttl: "D7" }, deps(fakeStore([]).store))).status === 400
      && (await handleConfirm(OP, { token: os.token, ttl: "H72" }, deps(fakeStore([]).store))).status === 201);
  }

  console.log("\n3. the turn: injection, {{mem}}, D10, tools");
  const target = { id: PAGE_ID, label: "Open incidents", workspaceLabel: null, areaLabel: "Platform Operations", metrics: [], params: [] };
  const binding = {
    surfaceLabel: "Platform Operations", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null,
    listPages: () => [target], resolvePage: (id: string) => (id === PAGE_ID ? { href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents&view=open" } : null),
  } as unknown as PlatformAiBinding;
  const watched = fact({ factType: "WATCHING_ISSUE" });
  const changedFact = fact({ factType: "FOLLOW_UP" });
  const facts: RetrievedFact[] = [
    { fact: watched, check: { status: "UNCHANGED", was: null, now: null, label: "Open incidents", currentRefs: watched.refs, refs: [] }, shown: "UNCHANGED" },
    { fact: changedFact, check: { status: "CHANGED", was: "OPEN", now: "RESOLVED", label: "Open incidents", currentRefs: changedFact.refs, refs: [] }, shown: "CHANGED" },
  ];
  const mt = () => buildMemoryTurn({ operatorId: OP, area: AREA, facts, question: QUESTION, historyNewestFirst: HISTORY, metricLabel: () => "Provider outcome verdict", pageLabel: () => "Open incidents", now: () => NOW });
  const scripted = (steps: Array<{ content?: string; calls?: Array<{ name: string; args: unknown }> }>): { generate: PlatformAiGenerate; seen: Array<{ messages: unknown[]; tools: unknown[] }> } => {
    const seen: Array<{ messages: unknown[]; tools: unknown[] }> = [];
    let i = 0;
    return {
      seen,
      generate: async ({ messages, tools }) => {
        seen.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
        const s = steps[i++] ?? { content: "done" };
        const calls = (s.calls ?? []).map((c, k) => ({ id: `c${i}${k}`, name: c.name, arguments: JSON.stringify(c.args) }));
        return { content: s.content ?? null, toolCalls: calls, raw: { role: "assistant", content: s.content ?? null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}) }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 } };
      },
    };
  };
  {
    const t = mt();
    const sc = scripted([{ content: `You were watching open incidents, {{mem:${watched.id}}}.` }]);
    const r = await runPlatformAiTurn({ question: QUESTION, questionScrubbed: true, binding, generate: sc.generate, model: "m", memory: t.hooks });
    const msgs = sc.seen[0].messages as Array<{ role: string; content: string }>;
    check("injection: ONE server system message right after the system prompt, before the question", msgs[1]?.role === "system" && msgs[1].content.startsWith("OPERATOR MEMORY — context only, NOT current facts. 2 facts (1 changed, 0 updated).") && msgs[msgs.length - 1].role === "user");
    check("the injected note is neutralised (no braces, digits masked) and the date is a placeholder", msgs[1].content.includes(`noted {{mem:${watched.id}}}`) && !/\d{4}/.test(msgs[1].content.replace(/cfact\d+|\{\{mem:[a-z0-9]+\}\}/g, "")));
    check("memory tools are offered with memory", JSON.stringify(sc.seen[0].tools).includes("recall_memory") && JSON.stringify(sc.seen[0].tools).includes("propose_memory"));
    const text = r.result.answer.map((s) => s.text).join("");
    check("{{mem:<id>}} renders the server's 'noted <date>'; the stored answer types it as a memory span", text.includes("noted 7 Nov 2026") && r.record.typed.some((s) => s.kind === "memory" && s.text === "noted 7 Nov 2026"));
    check("D10: cited with NO live read of the subject ⇒ the server appends the line", text.endsWith(MEMORY_LIVE_NOT_CHECKED));
    check("the answer is grounded (not replaced)", r.result.grounding.replaced === false, r.result.grounding);
  }
  {
    const sc = scripted([{ calls: [{ name: "open_page", args: { id: PAGE_ID } }] }, { content: `Open incidents, noted {{mem:${watched.id}}}, live now.` }]);
    const r = await runPlatformAiTurn({ question: QUESTION, questionScrubbed: true, binding, generate: sc.generate, model: "m", memory: mt().hooks });
    check("D10: a live read (open_page on the subject) this turn ⇒ no line", !r.result.answer.map((s) => s.text).join("").includes(MEMORY_LIVE_NOT_CHECKED));
  }
  {
    const sc = scripted([{ content: "The Open incidents item is still on your list." }]);
    const r = await runPlatformAiTurn({ question: QUESTION, questionScrubbed: true, binding, generate: sc.generate, model: "m", memory: mt().hooks });
    check("D10: a bare registered subject LABEL with no live read ⇒ the line", r.result.answer.map((s) => s.text).join("").endsWith(MEMORY_LIVE_NOT_CHECKED));
  }
  {
    const sc = scripted([{ content: "Nothing to add {{mem:cnotinjected0000000000000}}." }]);
    const r = await runPlatformAiTurn({ question: QUESTION, questionScrubbed: true, binding, generate: sc.generate, model: "m", memory: mt().hooks });
    check("{{mem}} resolves ONLY against facts injected this turn (an unknown id vanishes)", !r.result.answer.map((s) => s.text).join("").includes("mem:") && !r.record.typed.some((s) => s.kind === "memory"));
    const off = scripted([{ content: "plain" }]);
    await runPlatformAiTurn({ question: QUESTION, questionScrubbed: true, binding, generate: off.generate, model: "m" });
    check("memory OFF: no memory tools, no injected message", !JSON.stringify(off.seen[0].tools).includes("memory") && (off.seen[0].messages as Array<{ content: string }>).every((m) => !String(m.content).includes("OPERATOR MEMORY")));
  }
  check("the {{mem}} renderer covers every badge (UNCHANGED / UNVERIFIED plain, CHANGED and UPDATED tails), each a valid stored span",
    ["UNCHANGED", "UNVERIFIED", "CHANGED", "UPDATED"].map((s) => memPlaceholderText({ shown: s as RetrievedFact["shown"], fact: { observedAt: NOW } }))
      .every((t, i) => MEMORY_SPAN_SHAPE.test(t) && (i < 2 ? t === "noted 8 Nov 2026" : t.endsWith(i === 2 ? "— now changed" : "— updated since"))));
  {
    const t = mt();
    const ev = { envelopes: [{ metric: METRIC, status: "MEASURED", subjects: [{ label: "x-y", state: "degraded" }], window: { days: 7 } }], hrefs: new Set<string>(), definitions: [], labels: new Set<string>(), trace: [], pages: new Map() } as never;
    check("propose: a subjectRef this turn did NOT read ⇒ NOT_FOUND", JSON.stringify(t.hooks.propose({ factType: "WATCHING_ISSUE", subjectRef: "alerts-firing-now@1" }, ev)) === JSON.stringify({ found: false }));
    check("propose: refused note (copied span) ⇒ refused, counted for the audit", (t.hooks.propose({ factType: "WATCHING_ISSUE", subjectRef: METRIC, note: "plaid webhook retries piling up for sync banks" }, ev) as { proposed: boolean }).proposed === false);
    check("propose: a read metric ⇒ accepted; observedState from the server's envelope", (t.hooks.propose({ factType: "WATCHING_ISSUE", concern: "DEGRADATION", subjectRef: METRIC, note: "watch the retry queue" }, ev) as { proposed: boolean }).proposed === true);
    check("propose: at most ONE per turn", (t.hooks.propose({ factType: "FOLLOW_UP", subjectRef: METRIC }, ev) as { proposed: boolean }).proposed === false);
    const fin = t.finalize(ANSWER);
    check("finalize: the card (token, server label, TTL choices), refusal codes returned for the audit",
      !!fin.card && fin.card.subjectLabel === "Provider outcome verdict" && fin.card.ttlChoices.join() === "D7,D30" && fin.refusals.includes("NOTE_VERBATIM"), fin.refusals);
    const v = verifyProposalToken(fin.card!.token, { operatorId: OP, areaAllowed: () => true, now: NOW });
    check("…its token carries the server's ref state (DEGRADED from the envelope) and w = 7", v.ok && v.proposal.r[0].observedState === "DEGRADED" && v.proposal.r[0].w === 7);
    const t2 = mt();
    const evU = { envelopes: [{ metric: METRIC, status: "UNAVAILABLE", subjects: [], window: { days: 7 } }], hrefs: new Set(), definitions: [], labels: new Set(), trace: [], pages: new Map() } as never;
    check("propose: OPERATIONAL_STATE needs a live status (UNAVAILABLE ⇒ refused)", (t2.hooks.propose({ factType: "OPERATIONAL_STATE", subjectRef: METRIC }, evU) as { proposed: boolean }).proposed === false);
    const t3 = mt();
    t3.hooks.propose({ factType: "WATCHING_ISSUE", subjectRef: METRIC, note: "the queue is draining slowly now ok" }, ev);
    check("finalize: a note that copies the FINAL answer ⇒ no card, NOTE_VERBATIM", t3.finalize(ANSWER).card === null);
    check("recall: the index never carries a value; one id ⇒ that item", JSON.stringify(t.hooks.recall({})).includes(`{{mem:${watched.id}}}`) && JSON.stringify(t.hooks.recall({ id: changedFact.id })).includes("CHANGED (was OPEN, now RESOLVED)"));
  }

  console.log("\n4. staleness (B3) — one case each");
  const ret = (store: MemoryStoreSeam, rd: MemoryReaders | null, mode: "inject" | "panel" = "inject") =>
    retrieveFacts({ operatorId: OP, areas: [AREA], readersFor: async () => rd, store, mode });
  for (const [t, refs] of [["METRIC", [{ t: "METRIC", id: METRIC, observedState: "DEGRADED" }]], ["PAGE", [{ t: "PAGE", id: PAGE_ID, observedState: "OK" }]],
    ["INCIDENT", [{ t: "INCIDENT", id: `c${"a".repeat(24)}`, observedState: "OPEN" }]], ["JOB", [{ t: "JOB", id: "sync-banks", observedState: "FAILED" }]],
    ["PROVIDER", [{ t: "PROVIDER", id: "PLAID", observedState: "DEGRADED" }]]] as const) {
    for (const ft of ["WATCHING_ISSUE", "OPERATIONAL_STATE", "FOLLOW_UP"] as const) {
      const f0 = fact({ factType: ft, refs: refs as unknown as MemoryRef[] });
      const s = fakeStore([f0]);
      const r = await ret(s.store, readers({ metric: async () => null, page: async () => null, incident: async () => null, job: async () => null, provider: async () => null }));
      if (!(r.facts.length === 0 && s.rows.get(f0.id)?.invalidReason === "GONE")) check(`GONE: ${ft} on a deleted / invisible ${t} ⇒ invalidated GONE and hidden`, false);
    }
  }
  check("GONE: every type × every ref kind whose record is deleted / not visible ⇒ invalidated GONE and hidden", true);
  {
    const f0 = fact({ factType: "OPERATIONAL_STATE", refs: [{ t: "INCIDENT", id: `c${"b".repeat(24)}`, observedState: "OPEN" }] });
    const s = fakeStore([f0]);
    const rd = readers({ incident: async () => read("RESOLVED", "Sync failing") });
    const first = await ret(s.store, rd);
    const second = await ret(s.store, rd);
    const panel = await ret(s.store, rd, "panel");
    check("OPERATIONAL_STATE changed: the FIRST block shows CHANGED{was OPEN, now RESOLVED}; the next turn and the panel do not; invalidReason = STATE_CHANGED",
      first.facts[0]?.shown === "CHANGED" && first.facts[0].check.was === "OPEN" && first.facts[0].check.now === "RESOLVED"
        && second.facts.length === 0 && panel.facts.length === 0 && s.rows.get(f0.id)?.invalidReason === "STATE_CHANGED");
  }
  for (const ft of ["WATCHING_ISSUE", "FOLLOW_UP"] as const) {
    const f0 = fact({ factType: ft, refs: [{ t: "INCIDENT", id: `c${"c".repeat(24)}`, observedState: "OPEN" }] });
    const s = fakeStore([f0]);
    let state: RecordRead["state"] = "RESOLVED";
    const rd = readers({ incident: async () => read(state, "Sync failing") });
    const a = await ret(s.store, rd), b = await ret(s.store, rd);
    state = "OPEN";
    const c = await ret(s.store, rd);
    check(`${ft} changed: an OPEN incident resolved ⇒ CHANGED on every turn, never invalidated; reopened ⇒ UNCHANGED`,
      a.facts[0]?.shown === "CHANGED" && b.facts[0]?.shown === "CHANGED" && s.rows.get(f0.id)?.invalidReason === null && c.facts[0]?.shown === "UNCHANGED");
  }
  {
    const f0 = fact({ refs: [{ t: "INCIDENT", id: `c${"d".repeat(24)}`, observedState: "OPEN" }] });
    const s = fakeStore([f0]);
    const r = await ret(s.store, readers({ incident: async () => read("OPEN", "Sync failing", new Date(NOW.getTime())) }));
    check("UPDATED: same state, a later updatedAt ⇒ the UPDATED badge, not CHANGED", r.facts[0]?.shown === "UPDATED");
    const slow = await retrieveFacts({ operatorId: OP, areas: [AREA], readersFor: async () => readers({ incident: () => new Promise((res) => setTimeout(() => res(read("OPEN")), 200)) }), store: s.store, mode: "inject", budgetMs: 20 });
    check("UNVERIFIED: a read past the budget ⇒ UNVERIFIED (shown, never phrased as current)", slow.facts[0]?.shown === "UNVERIFIED");
  }
  {
    const f0 = fact();
    const s = fakeStore([f0]);
    const before = JSON.stringify([...s.rows.values()]);
    const t = buildMemoryTurn({ operatorId: OP, area: AREA, facts: (await ret(s.store, readers())).facts, question: QUESTION, historyNewestFirst: [], metricLabel: () => null, pageLabel: () => null, now: () => NOW });
    for (let i = 0; i < 100; i++) t.hooks.recall({ id: f0.id });
    check("100 recalls write nothing (expiresAt and every row unchanged)", JSON.stringify([...s.rows.values()]) === before && s.rows.get(f0.id)!.f.expiresAt.getTime() === f0.expiresAt.getTime());
    const revoked = await ret(s.store, null);
    const panelRevoked = await handleListMemory(OP, deps(s.store, readers(), []));
    check("area revoked (no readers, no held area) ⇒ injection and panel show 0, nothing invalidated here (the purge removes it)",
      revoked.facts.length === 0 && JSON.stringify(panelRevoked.body) === JSON.stringify({ areas: [] }) && s.rows.get(f0.id)?.invalidReason === null);
  }

  console.log("\n5. renew (revalidates first)");
  {
    const os = fact({ factType: "OPERATIONAL_STATE", refs: [{ t: "JOB", id: "sync-banks", observedState: "FAILED" }] });
    const s = fakeStore([os]);
    const r = await handleRenew(OP, os.id, deps(s.store, readers({ job: async () => read("SUCCEEDED") })));
    check("renew of an OPERATIONAL_STATE that CHANGED ⇒ 409 RENEW_CHANGED (audited), nothing written", r.status === 409 && (r.body as { code: string }).code === "RENEW_CHANGED" && s.refusals.includes("RENEW_CHANGED") && s.rows.size === 1);
    const g = await handleRenew(OP, os.id, deps(s.store, readers({ job: async () => null })));
    check("renew of a GONE fact ⇒ 409", g.status === 409);
    const w = fact({ factType: "WATCHING_ISSUE", refs: [{ t: "JOB", id: "sync-banks", observedState: "FAILED" }] });
    const s2 = fakeStore([w]);
    const ok = await handleRenew(OP, w.id, deps(s2.store, readers({ job: async () => read("SUCCEEDED") })));
    const renewed = [...s2.rows.values()].find((x) => x.f.supersedesId === w.id);
    check("renew of a WATCHING_ISSUE ⇒ 201: a NEW row with the CURRENT observedState, the old one SUPERSEDED", ok.status === 201 && renewed?.f.refs[0].observedState === "SUCCEEDED" && s2.rows.get(w.id)?.invalidReason === "SUPERSEDED");
  }

  console.log("\n6. the panel, the notice, the short line");
  {
    const inc = fact({ refs: [{ t: "INCIDENT", id: `c${"e".repeat(24)}`, observedState: "OPEN" }] });
    const goneF = fact({ factType: "FOLLOW_UP", note: "secret note text", refs: [{ t: "JOB", id: "sync-banks", observedState: "FAILED" }] });
    const s = fakeStore([inc, goneF]);
    let label = "Sync failing for Jane Customer";
    const rd = readers({ incident: async () => read("OPEN", label), job: async () => null });
    await handleListMemory(OP, deps(s.store, rd));
    label = "Sync failing";   // the operator's access narrowed: the reader no longer names the customer
    s.rows.get(goneF.id)!.invalidReason = null;
    const res = await handleListMemory(OP, deps(s.store, rd));
    const rows = (res.body as { areas: Array<{ facts: Array<{ id: string; subject: string | null; note: string | null; badge: string }> }> }).areas[0].facts;
    check("INCIDENT label = the reader's LIVE label: narrowed access ⇒ the customer no longer shows", rows.find((r) => r.id === inc.id)?.subject === "Sync failing" && !JSON.stringify(res.body).includes("Jane"));
    const g = rows.find((r) => r.id === goneF.id);
    check("a GONE row shows its type only (no label, no note) — and is invalidated as it is shown", g?.badge === "GONE" && g.subject === null && g.note === null && s.rows.get(goneF.id)?.invalidReason === "GONE");
    const html = renderToStaticMarkup(createElement(PlatformAiMemoryPanelView, {
      areas: [{ area: AREA, areaLabel: "Platform Operations", facts: [{ id: goneF.id, type: "FOLLOW_UP", subject: null, concern: null, note: null, noted: "noted 7 Nov 2026", expiresAt: NOW.toISOString(), badge: "GONE", canRenew: false }] }],
      error: null, busy: false, confirmAll: false, renewRefused: new Set<string>(), onDelete: () => {}, onRenew: () => {}, onAskDeleteAll: () => {}, onDeleteAll: () => {}, noticeOpen: false, onNotice: () => {},
    }));
    check("the panel: header line verbatim, the notice control, a GONE row without subject / note / link / renew", html.includes(PLATFORM_AI_MEMORY_PANEL_HEADER.replace(/'/g, "&#x27;"))
      && /data-platform-ai-memory-notice-link/.test(html) && !/data-platform-ai-memory-subject|data-platform-ai-memory-note=|<a /.test(html) && !html.includes("Still relevant: renew") && html.includes("Follow up"));
    check("§9 notice verbatim (B4) and in the DOM (collapsed)", PLATFORM_AI_MEMORY_NOTICE.startsWith("When you choose Remember, Platform AI keeps a short item about an issue:")
      && PLATFORM_AI_MEMORY_NOTICE.endsWith("Removed data may remain in backups until those backups expire.") && html.includes("Items for live status expire after 72 hours"));
  }
  check("S2 CHECKLIST: memory ON ⇒ the corrected short line, exactly",
    PLATFORM_AI_MEMORY_LINE === "Saves only items you choose to remember · Sent to OpenAI · Chats hidden after 7 days · Don’t enter personal details");
  check("…memory OFF ⇒ the original line, unchanged", PLATFORM_AI_CONVERSATIONS_LINE === "Read-only · Sent to OpenAI · Chats hidden after 7 days · Don’t enter personal details");
  const lineOn = renderToStaticMarkup(createElement(PlatformAiDisclosureLine, { saved: true, open: false, onToggle: () => {}, memory: true })).replace(/&#x2019;/g, "’");
  const lineOff = renderToStaticMarkup(createElement(PlatformAiDisclosureLine, { saved: true, open: false, onToggle: () => {} })).replace(/&#x2019;/g, "’");
  check("the rendered line: memory ⇒ the memory line (never 'Read-only'); flag off ⇒ the conversations line", lineOn.includes(PLATFORM_AI_MEMORY_LINE) && !lineOn.includes("Read-only") && lineOff.includes(PLATFORM_AI_CONVERSATIONS_LINE));
  const card = renderToStaticMarkup(createElement(PlatformAiMemoryConfirmCardView, {
    proposal: { token: "t", factType: "OPERATIONAL_STATE", concern: "DEGRADATION", subjectLabel: "Provider outcome verdict", note: null, ttlChoices: ["H72"] },
    note: "cost 5k", ttl: "H72", busy: false, problem: null, onNote: () => {}, onTtl: () => {}, onRemember: () => {}, onNotNow: () => {},
  }));
  check("confirm card: live guard shown, Remember disabled while it refuses, OPERATIONAL_STATE TTL fixed (72 hours)",
    /data-platform-ai-memory-note-guard/.test(card) && /<button type="button"[^>]*disabled=""[^>]*>Remember<\/button>/.test(card) && /<select[^>]*disabled=""/.test(card) && card.includes("72 hours"));

  console.log("\n7. the gate, the stored span, remember");
  check("isMemoryEffective: env flag AND retention ≤ 7 days", isMemoryEffective({ isPlatformAiMemoryEnabled: true }) && !isMemoryEffective({ isPlatformAiMemoryEnabled: false }) && !isMemoryEffective({ isPlatformAiMemoryEnabled: true }, 90));
  check("a stored memory span may carry ONLY 'noted <date>' (+ tail) — never a note", isStoredAnswer({ v: 1, segments: [{ kind: "memory", text: "noted 8 Nov 2026 — now changed" }], citations: [], notes: [], stop: "ANSWERED" })
    && !isStoredAnswer({ v: 1, segments: [{ kind: "memory", text: "noted 8 Nov 2026: check jane's card" }], citations: [], notes: [], stop: "ANSWERED" }));
  {
    const s = fakeStore([]);
    const ok = await handleRemember(OP, { area: AREA, kind: "INCIDENT", id: `c${"f".repeat(24)}`, factType: "WATCHING_ISSUE", ttl: "D30", note: "watch this one" }, deps(s.store));
    check("remember: 201, OPERATOR_EXPLICIT, proposalJti null, observedState from the reader", ok.status === 201 && s.inserted[0]?.origin === "OPERATOR_EXPLICIT" && s.inserted[0]?.proposalJti === null && s.inserted[0]?.refs[0].observedState === "OPEN");
    const notHeld = await handleRemember(OP, { area: "SECURITY_OPS", kind: "INCIDENT", id: `c${"f".repeat(24)}`, factType: "WATCHING_ISSUE", ttl: "D7" }, deps(s.store));
    const gone = await handleRemember(OP, { area: AREA, kind: "JOB", id: "sync-banks", factType: "WATCHING_ISSUE", ttl: "D7" }, deps(s.store, readers({ job: async () => null })));
    const amount = await handleRemember(OP, { area: AREA, kind: "PROVIDER", id: "PLAID", factType: "WATCHING_ISSUE", ttl: "D7", note: "bill was $40" }, deps(s.store));
    check("remember: an area not held / a record not visible ⇒ 404; an amount in the note ⇒ 422", notHeld.status === 404 && gone.status === 404 && amount.status === 422);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAll Platform AI memory (PR-B) checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });

export type { FactCheck };
