/**
 * lib/platform/intelligence/ai/conversations/multi-area.test.ts  (Platform AI P4b — multi-area conversations)
 *
 * Design v2 §8.3. The pure widening + lost-area rule (multi-area.ts), the handlers' wiring
 * (handlers.ts: the turn and the view use the access of NOW; a dep that is absent ⇒ the pre-P4b
 * behaviour; a throwing dep ⇒ the own area only), the history replay (history.ts / turn.ts), and
 * the route / runner pins. The real-boundary chain over the fixture world is E0
 * (eval/cases/conversations.ts, gate MULTI_AREA_CONVERSATION).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/conversations/multi-area.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformArea } from "@prisma/client";
import type { PlatformAiBinding } from "../core";
import type { ScopedArea } from "../authz/boundary";
import { RECORD_GONE_TEXT } from "../compose/record";
import { EVIDENCE_REFS_MAX, type EvidenceRef, type StoredAnswer } from "./answer";
import {
  handleAppendMessage, handleGetConversation, type AreaAccess, type ConversationDeps, type ConversationStoreSeam, type ConversationTurnStoreSeam,
  type TurnAdmissionDeps, type TurnRunDeps,
} from "./handlers";
import { assemblePlatformAiHistory, type HistoryMessage } from "./history";
import { answerAreas, answerReadable, packAreasRead, widenConversationAccess, withAreasRead } from "./multi-area";
import type { ConversationRecord, MessageRecord, TurnPair } from "./store";
import { runConversationTurn } from "./turn";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const OP = "cop0000000000000000000001";
const OPS: PlatformArea = "PLATFORM_OPS";
const CS: PlatformArea = "CUSTOMER_SUCCESS";
const T0 = new Date("2026-11-10T10:00:00.000Z");
const CID = "cconversation00000000001";

/** A one-area binding whose metric / page ids are prefixed by its area (so composition is observable). */
function bindingOf(area: PlatformArea): PlatformAiBinding {
  const metric = `${area.toLowerCase()}-metric@1`;
  return {
    surfaceLabel: area,
    listMetrics: () => [],
    describeMetric: (id) => (id === metric ? ({ id: metric, label: area } as unknown as ReturnType<PlatformAiBinding["describeMetric"]>) : null),
    readMetric: async () => null,
    listPages: () => [],
    resolvePage: (id) => (id.startsWith(`${area}:`) ? { href: `/p/${area}` } : null),
  };
}
const scopeOf = (area: PlatformArea, operatorId = OP) => ({ area, operatorId }) as unknown as ScopedArea;
const accessOf = (area: PlatformArea, operatorId = OP): AreaAccess => {
  const binding = bindingOf(area);
  return { resolvePage: (p) => binding.resolvePage(p), binding, area, scope: scopeOf(area, operatorId) };
};
const ans = (text: string, extra: Partial<StoredAnswer> = {}): StoredAnswer => ({ v: 1, segments: [{ kind: "text", text }], citations: [], notes: [], stop: "ANSWERED", ...extra });

async function main() {
  console.log("1. widenConversationAccess (pure)");
  {
    const own = accessOf(OPS);
    let asked = 0;
    const one = await widenConversationAccess(own, [OPS], async () => { asked++; return accessOf(CS); });
    check("one held area ⇒ the own access unchanged (same binding, resolvePage, scope; no turnAreas) + heldAreas = {own}; no other guard runs",
      one.binding === own.binding && one.resolvePage === own.resolvePage && one.scope === own.scope && one.turnAreas === undefined && [...(one.heldAreas ?? [])].join() === OPS && asked === 0);
    const two = await widenConversationAccess(own, [OPS, CS], async (a) => (a === CS ? accessOf(CS) : null));
    check("two held areas ⇒ the turn binds both (own first), heldAreas both, a composed binding over both",
      two.turnAreas?.map((p) => p.scope.area).join() === `${OPS},${CS}` && two.heldAreas?.has(OPS) === true && two.heldAreas?.has(CS) === true
        && two.binding !== own.binding && two.binding.describeMetric("customer_success-metric@1") !== null && two.binding.describeMetric("platform_ops-metric@1") !== null);
    check("…stored links re-resolve through every held area (CS page ⇒ href; an unheld area's page ⇒ null)",
      two.resolvePage("CUSTOMER_SUCCESS:x", {})?.href === "/p/CUSTOMER_SUCCESS" && two.resolvePage("PLATFORM_OPS:x", {})?.href === "/p/PLATFORM_OPS" && two.resolvePage("SECURITY_OPS:x", {}) === null);
    const refusals: [string, (a: PlatformArea) => Promise<AreaAccess | null>][] = [
      ["the other area's fresh guard refuses (null)", async () => null],
      ["the other area's guard throws", async () => { throw new Error("db down"); }],
      ["an access for ANOTHER area", async () => accessOf(OPS)],
      ["an access for ANOTHER operator", async () => accessOf(CS, "cother000000000000000001")],
      ["an access with no route-issued scope", async () => { const a = accessOf(CS); delete a.scope; return a; }],
    ];
    for (const [label, f] of refusals) {
      const w = await widenConversationAccess(own, [OPS, CS], f);
      check(`${label} ⇒ that area is NOT bound (own only, heldAreas = {own})`, w.binding === own.binding && w.turnAreas === undefined && [...(w.heldAreas ?? [])].join() === OPS);
    }
    const noScope = { ...own };
    delete noScope.scope;
    check("an own access without a scope is returned as is (no widening, no heldAreas)", (await widenConversationAccess(noScope, [OPS, CS], async () => accessOf(CS))) === noScope);
  }

  console.log("\n2. the lost-area rule (answerAreas / answerReadable / provenance)");
  {
    const rec = ans("x", { v: 2, segments: [{ kind: "text", text: "Case " }, { kind: "record", rk: "CUSTOMER", rid: "ref", a: CS, f: "ref" }] } as Partial<StoredAnswer>);
    check("areas = {k:a} refs ∪ record spans' own areas", answerAreas([{ k: "a", id: OPS }], rec).sort().join() === `${CS},${OPS}`);
    check("no held set ⇒ readable (pre-P4b)", answerReadable([{ k: "a", id: CS }], null, undefined));
    check("every area held ⇒ readable", answerReadable([{ k: "a", id: OPS }, { k: "a", id: CS }], null, new Set([OPS, CS])));
    check("one area lost (a ref) ⇒ NOT readable", !answerReadable([{ k: "a", id: OPS }, { k: "a", id: CS }], null, new Set([OPS])));
    check("one area lost (only a record span names it) ⇒ NOT readable", !answerReadable([{ k: "a", id: OPS }], rec, new Set([OPS])));
    check("a legacy answer with no area refs ⇒ readable", answerReadable([{ k: "m", id: "x@1", w: null }], ans("old"), new Set([OPS])));
    const refs: EvidenceRef[] = [{ k: "m", id: "a@1", w: null }, { k: "a", id: OPS }, { k: "r", t: "CUSTOMER", n: 1 }];
    check("withAreasRead: an area already present ⇒ the refs unchanged", JSON.stringify(withAreasRead(refs, [OPS])) === JSON.stringify(refs));
    const added = withAreasRead(refs, [CS]);
    check("withAreasRead: a pack area is added as {k:a} (registry order), every other ref kept",
      added.filter((r) => r.k === "a").map((r) => (r as { id: string }).id).join() === `${OPS},${CS}` && added.length === 4 && added.some((r) => r.k === "r") && added.some((r) => r.k === "m"));
    const full: EvidenceRef[] = [...Array.from({ length: EVIDENCE_REFS_MAX - 1 }, (_, i) => ({ k: "m" as const, id: `m${i}@1`, w: null })), { k: "a", id: OPS }];
    const capped = withAreasRead(full, [CS]);
    check("withAreasRead: at the cap the area refs survive whole and the total stays ≤ EVIDENCE_REFS_MAX",
      capped.length === EVIDENCE_REFS_MAX && capped.filter((r) => r.k === "a").length === 2);
    check("packAreasRead: core packs (metric reads carry envelope surfaces) excluded; pack areas kept",
      packAreasRead(new Map([["metrics", [OPS, CS]], ["incidents", [CS]], ["navigation", [CS]]]), ["metrics", "navigation", "memory"]).join() === CS);
  }

  console.log("\n3. handlers — the view and the turn use the access of NOW");
  {
    const conv: ConversationRecord = { id: CID, area: OPS, createdAt: T0, lastActivityAt: T0 } as ConversationRecord;
    let seq = 0;
    const msg = (role: "USER" | "ASSISTANT", content: MessageRecord["content"], evidenceRefs: EvidenceRef[] = [], replyToId: string | null = null): MessageRecord => ({
      id: `m${String(++seq).padStart(24, "0")}`, conversationId: CID, role, status: "COMPLETE", createdAt: T0, completedAt: T0, replyToId, content, unreadable: false, failureCode: null, evidenceRefs,
    });
    const u1 = msg("USER", "Ops posture?");
    const a1 = msg("ASSISTANT", ans("Alpha posture.", { citations: [{ metric: "platform_ops-metric@1", label: "Ops", window: "now" }], notes: ["ops note"] }), [{ k: "a", id: OPS }], u1.id);
    const u2 = msg("USER", "And customers?");
    const a2 = msg("ASSISTANT", ans("x", { v: 2, segments: [{ kind: "text", text: "Bravo customers: " }, { kind: "record", rk: "CUSTOMER", rid: "kref", a: CS, f: "ref" }], citations: [{ metric: "customer_success-metric@1", label: "CS", window: "now" }], notes: ["cs note"] } as Partial<StoredAnswer>), [{ k: "a", id: OPS }, { k: "a", id: CS }], u2.id);
    const messages = [u1, a1, u2, a2];
    const store = {
      findLiveConversation: async () => conv,
      readConversation: async () => ({ conversation: conv, messages }),
    } as unknown as ConversationStoreSeam;
    const rendered: number[] = [];
    const own = (): AreaAccess => ({ ...accessOf(OPS), renderRecords: async (segs) => { rendered.push(segs.length); return new Map(segs.map((s) => [s, "case #ref"])); } });
    const base: ConversationDeps = { areaAccess: async () => own(), store, now: () => T0 };
    const v = { operatorId: OP, area: OPS };
    const content = (r: { body: Record<string, unknown> | null }, i: number) => JSON.stringify(((r.body?.messages as Record<string, unknown>[])[i]).content);

    const pre = await handleGetConversation(v, CID, base);
    check("no heldAccess dep ⇒ the pre-P4b view: every answer shown (the CS answer too), its record rendered",
      content(pre, 3).includes("Bravo") && content(pre, 1).includes("Alpha") && rendered.join() === "1");
    rendered.length = 0;
    const lost = await handleGetConversation(v, CID, { ...base, heldAccess: async (o) => ({ ...o, heldAreas: new Set([OPS]) }) });
    const m3 = (lost.body?.messages as Record<string, unknown>[])[3];
    check("CS lost ⇒ the answer that read CS is \"[no longer available]\" whole — no prose, citation or note",
      JSON.stringify(m3.content) === JSON.stringify([{ kind: "text", text: RECORD_GONE_TEXT }]) && (m3.citations as unknown[]).length === 0 && (m3.notes as unknown[]).length === 0 && !JSON.stringify(lost.body).includes("Bravo"), m3);
    check("…its record is never rendered (no recheck / audit / T2 path entered); the Ops answer and both questions are unchanged",
      rendered.length === 0 && content(lost, 1) === content(pre, 1) && content(lost, 2) === content(pre, 2) && content(lost, 0) === content(pre, 0));
    const thrown = await handleGetConversation(v, CID, { ...base, heldAccess: async () => { throw new Error("guard down"); } });
    check("a throwing heldAccess ⇒ fail closed to the own area: the CS answer is \"[no longer available]\"", content(thrown, 3) === JSON.stringify([{ kind: "text", text: RECORD_GONE_TEXT }]));
    // An operator holding ONE area (the route's real widening over the own area only): byte-identical to the pre-P4b view.
    const opsOnlyConv = [u1, a1];
    const store1 = { ...store, readConversation: async () => ({ conversation: conv, messages: opsOnlyConv }) } as unknown as ConversationStoreSeam;
    const pre1 = await handleGetConversation(v, CID, { ...base, store: store1 });
    const p4b1 = await handleGetConversation(v, CID, { ...base, store: store1, heldAccess: (o) => widenConversationAccess(o, [OPS], async () => null) });
    check("one held area: the P4b view is byte-identical to the pre-P4b view", JSON.stringify(pre1) === JSON.stringify(p4b1));
  }

  console.log("\n4. handlers — the APPEND turn runs with the widened access (fresh at turn time)");
  {
    const conv = { id: CID, area: OPS, createdAt: T0, lastActivityAt: T0 } as ConversationRecord;
    const pair: TurnPair = {
      user: { id: "m000000000000000000000101", conversationId: CID, role: "USER", status: "COMPLETE", createdAt: T0, completedAt: T0, replyToId: null, content: "q", unreadable: false, failureCode: null, evidenceRefs: [] },
      assistant: { id: "m000000000000000000000102", conversationId: CID, role: "ASSISTANT", status: "PENDING", createdAt: T0, completedAt: null, replyToId: "m000000000000000000000101", content: null, unreadable: false, failureCode: null, evidenceRefs: [] },
    };
    const order: string[] = [];
    const store = {
      findLiveConversation: async () => conv,
      findTurnPair: async () => (order.includes("settle") ? { ...pair, assistant: { ...pair.assistant, status: "COMPLETE", content: ans("ok"), completedAt: T0 } } : null),
      appendTurn: async () => { order.push("append"); return { kind: "APPENDED", pair }; },
      settleTurn: async () => { order.push("settle"); return true; },
    } as unknown as ConversationStoreSeam & ConversationTurnStoreSeam;
    const adm: TurnAdmissionDeps = { admission: async () => ({ paused: false }), freeze: async () => ({ frozen: false }), turns: async () => ({ allowed: true }) };
    let seen: AreaAccess | null = null;
    const runTurn: TurnRunDeps["runTurn"] = async ({ access }) => { order.push("turn"); seen = access; return { status: "COMPLETE", answer: ans("ok"), evidenceRefs: [] }; };
    const body = { clientRequestId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", question: "And customers?" };
    const deps = { areaAccess: async () => accessOf(OPS), store, now: () => T0, ...adm, runTurn };
    const r = await handleAppendMessage({ operatorId: OP, area: OPS }, CID, body, {
      ...deps, heldAccess: (o) => { order.push("widen"); return widenConversationAccess(o, [OPS, CS], async (a) => (a === CS ? accessOf(CS) : null)); },
    });
    const s = seen as AreaAccess | null;
    check("the turn gets BOTH held areas (turnAreas own-first) — widened after the append, right before the turn",
      r.status === 200 && s?.turnAreas?.map((p) => p.scope.area).join() === `${OPS},${CS}` && order.join() === "append,widen,turn,settle", order);
    order.length = 0; seen = null;
    await handleAppendMessage({ operatorId: OP, area: OPS }, CID, body, deps);
    const s2 = seen as AreaAccess | null;
    check("no heldAccess dep ⇒ the pre-P4b turn (own area only, no turnAreas, no heldAreas)", s2?.turnAreas === undefined && s2?.heldAreas === undefined && s2?.area === OPS);
    order.length = 0; seen = null;
    await handleAppendMessage({ operatorId: OP, area: OPS }, CID, body, { ...deps, heldAccess: async () => { throw new Error("x"); } });
    const s3 = seen as AreaAccess | null;
    check("a throwing heldAccess ⇒ the turn binds the own area only and holds {own} (lost answers hidden)", s3?.turnAreas === undefined && [...(s3?.heldAreas ?? [])].join() === OPS);
  }

  console.log("\n5. history — a lost answer reaches the model as the marker only");
  {
    const u: HistoryMessage = { id: "u1", conversationId: CID, role: "USER", status: "COMPLETE", createdAt: T0, replyToId: null, content: "Customers?", evidenceRefs: [] };
    const a: HistoryMessage = { id: "a1", conversationId: CID, role: "ASSISTANT", status: "COMPLETE", createdAt: T0, replyToId: "u1",
      content: { v: 2, segments: [{ kind: "text", text: "Charlie says " }, { kind: "record", rk: "CUSTOMER", rid: "kref", a: CS, f: "ref" }], citations: [], notes: [], stop: "ANSWERED" } as StoredAnswer,
      evidenceRefs: [{ k: "a", id: CS }, { k: "m", id: "customer_success-metric@1", w: null }] };
    const scope = { describeMetric: () => ({}), pageVisible: () => true };
    const hidden = assemblePlatformAiHistory({ conversationId: CID, messages: [u, a], scope: { ...scope, answerVisible: () => false } });
    const shown = assemblePlatformAiHistory({ conversationId: CID, messages: [u, a], scope });
    check("answerVisible false ⇒ the reply is \"[no longer available]\" only; its evidence pointers are not listed; the question stays",
      hidden.messages[1]?.content === RECORD_GONE_TEXT && hidden.earlierEvidence === null && hidden.messages[0]?.content === "Customers?");
    check("…absent ⇒ the pre-P4b replay", shown.messages[1]?.content.includes("Charlie") === true && shown.earlierEvidence !== null);
    const sent: string[] = [];
    let reminted = 0;
    const generate = async ({ messages }: { messages: unknown[] }) => { sent.push(JSON.stringify(messages)); return { content: "Nothing more.", toolCalls: [], raw: { role: "assistant", content: "Nothing more." }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 1, reasoningTokens: 0 } }; };
    const run = await runConversationTurn({ conversationId: CID, question: "And now?", binding: bindingOf(OPS), history: [u, a], generate: generate as never, model: "m", classify: () => "PROVIDER",
      remint: async (refs) => { reminted += refs.length; return refs.map(() => null); }, heldAreas: new Set([OPS]) });
    check("runConversationTurn with heldAreas = {Ops}: the CS answer is never re-minted and never reaches the model",
      run.outcome.status === "COMPLETE" && reminted === 0 && sent.length > 0 && !sent.join().includes("Charlie") && sent.join().includes(RECORD_GONE_TEXT));
    sent.length = 0; reminted = 0;
    await runConversationTurn({ conversationId: CID, question: "And now?", binding: bindingOf(OPS), history: [u, a], generate: generate as never, model: "m", classify: () => "PROVIDER",
      remint: async (refs) => { reminted += refs.length; return refs.map(() => null); } });
    check("…without heldAreas ⇒ the pre-P4b replay (re-mint attempted; prose replayed)", reminted === 1 && sent.join().includes("Charlie"));
  }

  console.log("\n6. static pins — the wiring");
  {
    const create = code(read("app/api/platform/ai/conversations/route.ts"));
    const messages = code(read("app/api/platform/ai/conversations/[id]/messages/route.ts"));
    const one = code(read("app/api/platform/ai/conversations/[id]/route.ts"));
    const post = create.slice(create.indexOf("export async function POST"));
    check("create + append routes: heldAccess = conversationHeldAccess(rows) over the SAME directory read that picked the gate's area",
      [post, messages].every((s) => /const rows = await loadPlatformDirectory\(user\.id\);\s*const area = platformAiAreaFor\(rows\);/.test(s) && /heldAccess: conversationHeldAccess\(rows\),/.test(s)));
    const get = one.slice(one.indexOf("export async function GET"), one.indexOf("export async function DELETE"));
    const del = one.slice(one.indexOf("export async function DELETE"));
    check("GET [id]: the view uses conversationHeldAccess(rows); DELETE does not widen (its own-area gate only)",
      /heldAccess: conversationHeldAccess\(rows\)/.test(get) && !/heldAccess|conversationHeldAccess/.test(del));
    const list = create.slice(create.indexOf("export async function GET"), create.indexOf("export async function POST"));
    check("the LIST route does not widen (no per-area fresh guard there — S2 NOTED #424)", !/heldAccess|conversationHeldAccess|requireFreshPlatformAccess\([^)]*probe/.test(list));
    const runner = code(read("app/api/platform/ai/conversations/turn-runner.ts"));
    check("turn runner: the boundary's areas = access.turnAreas (else the own scope); heldAreas passed to the turn; the pack provenance only on a multi-area turn",
      /const turnAreas = access\.turnAreas \?\? \(access\.scope \? \[\{ scope: access\.scope, binding: access\.binding \}\] : \[\]\);/.test(runner) && /areas: turnAreas,/.test(runner)
        && /routePlatformAiPacks\(\{ question: null, areas: turnAreas\.map\(\(p\) => p\.scope\.area\), memory: !!memory \}\)/.test(runner)
        && /heldAreas: access\.heldAreas/.test(runner) && /access\.turnAreas && run\.outcome\.status === "COMPLETE"/.test(runner) && /withAreasRead\(run\.outcome\.evidenceRefs, packAreasRead\(boundary\.toolAreas\(\), CORE_PACKS\)\)/.test(runner));
    const ma = code(read("lib/platform/intelligence/ai/conversations/multi-area.ts"));
    check("multi-area.ts is pure (no db, env, guard, clock or provider)", !/@\/lib\/db|@\/lib\/env|require(?:Fresh)?PlatformAccess|new Date\(|Date\.now|generateWithTools|systemDb|withTenantDb/.test(ma));
    const h = code(read("lib/platform/intelligence/ai/conversations/handlers.ts"));
    const ap = h.slice(h.indexOf("export async function handleAppendMessage"));
    check("handlers APPEND: the own-area gate (step 6) still runs before the body; widening only after it (replay) or after the append (turn)",
      ap.indexOf("deps.areaAccess(meta.area, v.operatorId)") < ap.indexOf("parseTurnBody(body)") && ap.indexOf("deps.store.appendTurn(") < ap.indexOf("const turnAccess = await heldAccessFor(deps, access, v.operatorId);")
        && ap.indexOf("const turnAccess = await heldAccessFor(deps, access, v.operatorId);") < ap.indexOf("runAndSettle("));
    check("handlers DELETE never widens", !/heldAccessFor/.test(h.slice(h.indexOf("export async function handleDeleteConversation"))));
    const bsrc = code(read("lib/platform/intelligence/ai/authz/boundary.ts"));
    check("boundary: a pack's areas are recorded from the call's SURVIVING (freshly rechecked) areas, right before it runs",
      /noteRan\(tool\.pack, surviving\);\s*if \(tool\.scope === "AGGREGATE"\)/.test(bsrc));
    const exp = code(read("lib/platform/intelligence/ai/conversations/export.ts"));
    check("export unchanged by P4b (conversation-level held / lost areas, counts only for lost)", !/multi-area|answerReadable|widenConversationAccess/.test(exp));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
