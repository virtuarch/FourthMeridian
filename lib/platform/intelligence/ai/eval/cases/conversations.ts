/**
 * lib/platform/intelligence/ai/eval/cases/conversations.ts  (E0-CI — P4b: MULTI_AREA_CONVERSATION)
 *
 * Design v2 §8.3 / §6 / §8.2. A conversation TURN binds the areas the operator holds NOW: the
 * conversation's own area plus every other area that passes ITS OWN fresh grant read
 * (conversations/multi-area.ts widenConversationAccess — the same function the route wires, with
 * the fixture world's fresh grant read standing in for requireFreshPlatformAccess), then the REAL
 * turn boundary (per-call recheck, handles) and the REAL conversation turn (history replay,
 * re-mint) and the REAL view projection (handlers.ts messageDto / renderMessageRecords).
 *
 *   p4b.cross-area-then-revoked   ops2 is given Customer Success next to Platform Ops: turn 1 reads
 *                                 an Ops metric, a CS metric and a CS record (all served); CS is then
 *                                 revoked between turns: turn 2's CS tools are NOT_FOUND, Ops still
 *                                 answers, turn 1's answer reaches the model and the view only as
 *                                 "[no longer available]" (no prose, citation, re-minted handle or render);
 *   p4b.directory-is-not-a-grant  the Ops operator's turn told to try Customer Success (as if the
 *                                 directory listed it) binds Ops only — the CS metric NOT_FOUND;
 *   p4b.single-area-unchanged     a CS-only operator: the widened access keeps the same binding and
 *                                 scope; the stored answer and evidence refs equal the pre-P4b turn's.
 * Every provider request and view is added to the corpus (IDENTITY_LEAK). Reports are counts only.
 */

import type { PlatformArea } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { createTurnBoundary } from "../../authz/boundary";
import type { RecordRenderSource } from "../../authz/record-render";
import { RECORD_GONE_TEXT } from "../../compose/record";
import type { EvidenceRef, StoredAnswer, StoredRecordSegment } from "../../conversations/answer";
import { messageDto, renderMessageRecords, type AreaAccess } from "../../conversations/handlers";
import type { HistoryMessage } from "../../conversations/history";
import { packAreasRead, widenConversationAccess, withAreasRead } from "../../conversations/multi-area";
import { runConversationTurn } from "../../conversations/turn";
import type { PlatformAiGenerate } from "../../core";
import type { RecordSchema } from "../../evidence/record-envelope";
import { CORE_PACKS } from "../../engine/router";
import { PLATFORM_AI_TOOL_REGISTRY, type PlatformAiTool } from "../../tools/registry";
import type { MessageRecord } from "../../conversations/store";
import { E0_CUSTOMERS, E0_T2_SENTINELS, type E0_OPERATORS } from "../fixtures";
import { sentinelsIn } from "../gates";
import { isNotFound, type UnitCase, type UnitContext } from "./types";

type Op = keyof typeof E0_OPERATORS;
const OPS: PlatformArea = "PLATFORM_OPS";
const CS: PlatformArea = "CUSTOMER_SUCCESS";
const OPS_METRIC = "ops-overall-posture";
const CS_METRIC = "cs-needs-help";
/** A digit-free word only turn 1's answer carries: its presence anywhere later = the lost answer leaked. */
const TURN1_MARK = "Quietharbor";
const CONVERSATION_ID = "ce0p4bconversation0000001";

// ── the synthetic CS RECORD tool (test-only; a non-core pack so the pack provenance is exercised) ──
const RECORD_ID = "ce0p4brecord0000000000001";
const SCHEMA: RecordSchema = { kind: "E0_P4B_CASE", fields: { state: { type: "code", values: ["OPEN", "RESOLVED"] } }, t2Fields: ["name"] };
const recordTool: PlatformAiTool = {
  pack: "customers", description: "E0 P4b synthetic Customer Success record (test-only)", requires: { areas: [CS], level: "READ", tier: "OPS" }, pii: 2, cost: { toolCalls: 1 },
  name: "e0_p4b_cases", args: { properties: {} }, scope: "RECORD", customerLinkable: true, recordSchema: SCHEMA,
  audit: { action: AuditAction.PLATFORM_AI_RECORD_VIEWED, detail: { surface: "platform-ai", recordKind: "E0_P4B_CASE" } },
  run: async () => ({ status: "CONFIRMED", asOf: "2026-11-10T12:00:00.000Z", records: [{ ref: { kind: "E0_P4B_CASE", recordId: RECORD_ID, area: CS, tier: "OPS", linkedUserIds: [E0_CUSTOMERS[0].id] }, fields: { state: "OPEN" } }], truncated: false }),
} as PlatformAiTool;
const REGISTRY: readonly PlatformAiTool[] = [...PLATFORM_AI_TOOL_REGISTRY, recordTool];

function sourceWith(log: string[]): RecordRenderSource {
  return {
    t2Fields: ["name"],
    revalidate: async (rid, area) => { log.push(`revalidate:${area}`); return rid === RECORD_ID ? "OPS" : null; },
    t1: async () => "case #p4b",
    linkedUserIds: async () => [E0_CUSTOMERS[0].id],
    t2: async () => E0_CUSTOMERS[0].name,
  };
}

/** One area's access exactly as the route builds it: the fixture world's FRESH grant read first, then the route-issued scope + binding. */
async function accessFor(ctx: UnitContext, op: Op, area: PlatformArea): Promise<AreaAccess | null> {
  const fresh = await ctx.recheck(op)(area);
  if (!fresh) return null;
  const part = ctx.scoped(op, area);
  return part ? { resolvePage: part.binding.resolvePage, binding: part.binding, area, scope: part.scope } : null;
}

interface TurnRun {
  /** The own-area access (the gate) and the access the turn ran with (widened). */
  own: AreaAccess;
  access: AreaAccess;
  answer: StoredAnswer | null;
  refs: readonly EvidenceRef[];
  toolResults: unknown[];
  requests: string[];
  reminted: { a: string }[];
}

/** A model that calls `calls`, then (round 2) writes `content(handle)` with the first record handle it received. */
function model(calls: { name: string; args: unknown }[], content: (h: string) => string): { generate: PlatformAiGenerate; requests: string[] } {
  const requests: string[] = [];
  let i = 0;
  const generate: PlatformAiGenerate = async ({ messages }) => {
    requests.push(JSON.stringify(messages));
    i++;
    if (i === 1) {
      const tc = calls.map((c, n) => ({ id: `c${n}`, name: c.name, arguments: JSON.stringify(c.args) }));
      return { content: null, toolCalls: tc, raw: { role: "assistant", content: null, tool_calls: tc.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 } };
    }
    const toolText = (messages as { role: string; content?: unknown }[]).filter((x) => x.role === "tool").map((x) => String(x.content ?? "")).join("\n");
    const h = /"handle":"(h_[A-Za-z0-9_-]{16})"/.exec(toolText)?.[1] ?? "h_none000000000000";
    const text = content(h);
    return { content: text, toolCalls: [], raw: { role: "assistant", content: text }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 } };
  };
  return { generate, requests };
}

/** ONE conversation turn, wired as app/api/platform/ai/conversations/turn-runner.ts wires it (own gate → widen → boundary → turn → provenance). */
async function conversationTurn(ctx: UnitContext, op: Op, own: PlatformArea, others: readonly PlatformArea[], history: readonly HistoryMessage[],
  m: { generate: PlatformAiGenerate; requests: string[] }, log: string[], opts: { widen?: boolean } = {}): Promise<TurnRun | null> {
  const ownAccess = await accessFor(ctx, op, own);
  if (!ownAccess) return null;
  const access = opts.widen === false ? ownAccess : await widenConversationAccess(ownAccess, others, (a) => accessFor(ctx, op, a));
  const turnAreas = access.turnAreas ?? (access.scope ? [{ scope: access.scope, binding: access.binding }] : []);
  const b = createTurnBoundary({
    operatorId: ctx.operatorId(op), correlationId: `e0-p4b-${op}-${history.length}`, areas: turnAreas, binding: access.binding, recheck: ctx.recheck(op),
    packs: ["metrics", "navigation", "customers"], packEnabled: () => true, registry: REGISTRY, recordSources: { E0_P4B_CASE: sourceWith(log) },
    audit: async () => {},
  });
  const reminted: { a: string }[] = [];
  const run = await runConversationTurn({
    conversationId: CONVERSATION_ID, question: "And how does that compare?", binding: access.binding, history, generate: m.generate,
    model: "e0-scripted", classify: () => "PROVIDER", invoke: b.invoke, records: b.recordRef,
    remint: async (refs) => { reminted.push(...refs.map((r) => ({ a: r.a }))); return b.remint(refs); },
    ...(access.heldAreas ? { heldAreas: access.heldAreas } : {}),
  });
  for (const q of m.requests) ctx.collect("provider_request", q);
  const last = m.requests[m.requests.length - 1] ?? "[]";
  const toolResults = (JSON.parse(last) as { role: string; content?: unknown }[]).filter((x) => x.role === "tool").map((x) => { try { return JSON.parse(String(x.content ?? "null")); } catch { return x.content; } });
  if (run.outcome.status !== "COMPLETE") return { own: ownAccess, access, answer: null, refs: [], toolResults, requests: m.requests, reminted };
  const refs = access.turnAreas ? withAreasRead(run.outcome.evidenceRefs, packAreasRead(b.toolAreas(), CORE_PACKS)) : run.outcome.evidenceRefs;
  ctx.collect("response_evidence", JSON.stringify({ refs, answer: run.result?.answer ?? null }));
  return { own: ownAccess, access, answer: run.outcome.answer, refs, toolResults, requests: m.requests, reminted };
}

const at = new Date("2026-11-10T12:00:00.000Z");
function exchange(answer: StoredAnswer, refs: TurnRun["refs"]): { history: HistoryMessage[]; assistant: MessageRecord } {
  // A conversation MESSAGE role (the question / the reply) — not a user-population predicate.
  const message = (id: string, role: HistoryMessage["role"], replyToId: string | null, content: HistoryMessage["content"], evidenceRefs: EvidenceRef[]): HistoryMessage =>
    ({ id, conversationId: CONVERSATION_ID, role, status: "COMPLETE", createdAt: at, replyToId, content, evidenceRefs });
  const user = message("ce0p4bmessageuser00000001", "USER", null, "Posture, customers needing help and the open case?", []);
  const asst = message("ce0p4bmessageasst00000001", "ASSISTANT", user.id, answer, [...refs]);
  return { history: [user, asst], assistant: { ...asst, completedAt: at, unreadable: false, failureCode: null, evidenceRefs: [...refs] } as MessageRecord };
}

const t2Hits = (s: string) => sentinelsIn(s, E0_T2_SENTINELS).length;
const metricServed = (x: unknown, area: PlatformArea) => !isNotFound(x) && (x as { surface?: unknown } | null)?.surface === area;

async function crossAreaThenRevoked(ctx: UnitContext): Promise<string[]> {
  const problems: string[] = [];
  ctx.setGrant("ops2", CS, "ACTIVE");
  try {
    // Turn 1 — both areas held: an Ops metric, a CS metric and a CS record.
    const log1: string[] = [];
    const t1 = await conversationTurn(ctx, "ops2", OPS, [OPS, CS], [], model(
      [{ name: "get_metric", args: { id: OPS_METRIC } }, { name: "get_metric", args: { id: CS_METRIC } }, { name: "e0_p4b_cases", args: {} }],
      (h) => `The open case is {{r:${h}|ref}}. ${TURN1_MARK} is the word to remember.`), log1);
    if (!t1) return ["the own-area gate refused a held area"];
    const [r1ops, r1cs, r1rec] = t1.toolResults;
    if (!t1.access.turnAreas || t1.access.turnAreas.length !== 2 || !(t1.access.heldAreas?.has(OPS) && t1.access.heldAreas?.has(CS))) problems.push("turn 1 did not bind both held areas");
    if (!metricServed(r1ops, OPS)) problems.push("turn 1: the Ops metric was not served");
    if (!metricServed(r1cs, CS)) problems.push("turn 1: the CS metric was not served across areas");
    if (isNotFound(r1rec) || !JSON.stringify(r1rec).includes("\"handle\":\"h_")) problems.push("turn 1: the CS record tool did not run");
    if (!t1.answer || !t1.answer.segments.some((s) => s.kind === "record" && (s as StoredRecordSegment).a === CS) || !JSON.stringify(t1.answer).includes(TURN1_MARK)) return [...problems, "turn 1: no stored answer with a CS record span (vacuous)"];
    const areas1 = t1.refs.filter((r) => r.k === "a").map((r) => (r as { id: string }).id);
    if (!(areas1.includes(OPS) && areas1.includes(CS))) problems.push(`turn 1 provenance lacks an area (${areas1.join()})`);
    const { history, assistant } = exchange(t1.answer, t1.refs);
    const heldView = messageDto(assistant, t1.access, true);
    if (JSON.stringify(heldView.content) === JSON.stringify([{ kind: "text", text: RECORD_GONE_TEXT }]) || !JSON.stringify(heldView.content).includes(TURN1_MARK)) problems.push("while both areas are held, turn 1 is not shown (vacuous)");

    // CS revoked BETWEEN turns.
    ctx.setGrant("ops2", CS, "REVOKED");
    const log2: string[] = [];
    const t2 = await conversationTurn(ctx, "ops2", OPS, [OPS, CS], history, model(
      [{ name: "get_metric", args: { id: CS_METRIC } }, { name: "e0_p4b_cases", args: {} }, { name: "get_metric", args: { id: OPS_METRIC } }],
      () => "Platform posture is the only area I can read now."), log2);
    if (!t2) return [...problems, "turn 2: the own (still held) area was refused"];
    const [r2cs, r2rec, r2ops] = t2.toolResults;
    if (t2.access.turnAreas || t2.access.heldAreas?.has(CS) || !t2.access.heldAreas?.has(OPS)) problems.push("turn 2 still bound the revoked area");
    if (!isNotFound(r2cs)) problems.push("turn 2: the revoked area's metric was not NOT_FOUND");
    if (!isNotFound(r2rec)) problems.push("turn 2: the revoked area's record tool was not NOT_FOUND");
    if (!metricServed(r2ops, OPS)) problems.push("turn 2: the held area stopped answering");
    const sent = t2.requests.join("\n");
    if (sent.includes(TURN1_MARK)) problems.push("turn 2: the lost answer's prose reached the model");
    if (!sent.includes(RECORD_GONE_TEXT)) problems.push("turn 2: the lost answer was not replaced by [no longer available] in the replay");
    if (t2.reminted.length > 0 || log2.some((x) => x.startsWith("revalidate:"))) problems.push("turn 2: a span of the lost answer was re-minted / revalidated");
    // The view, as GET /conversations/[id] shows it with the access of NOW.
    let renders = 0;
    const view = { ...t2.access, renderRecords: async () => { renders++; return new Map(); } } as AreaAccess;
    const records = await renderMessageRecords([assistant], view);
    const dto = messageDto(assistant, view, true, records);
    ctx.collect("response_body", JSON.stringify(dto));
    if (JSON.stringify(dto.content) !== JSON.stringify([{ kind: "text", text: RECORD_GONE_TEXT }]) || (dto.citations as unknown[]).length !== 0 || (dto.notes as unknown[]).length !== 0) problems.push("view: the lost answer was not [no longer available] whole");
    if (renders !== 0) problems.push("view: a record of the lost answer was rendered (recheck / audit / T2 path entered)");
    if (JSON.stringify(dto).includes(TURN1_MARK)) problems.push("view: the lost answer's prose was shown");
    if (t2Hits(`${sent} ${JSON.stringify(dto)} ${JSON.stringify(t1.answer)} ${t1.requests.join(" ")}`) > 0) problems.push("a T2 sentinel reached a provider request, the stored answer or the view");
  } finally {
    ctx.setGrant("ops2", CS, null);
  }
  return problems;
}

async function directoryIsNotAGrant(ctx: UnitContext): Promise<string[]> {
  const t = await conversationTurn(ctx, "ops", OPS, [OPS, CS], [], model([{ name: "get_metric", args: { id: CS_METRIC } }, { name: "get_metric", args: { id: OPS_METRIC } }], () => "Only the platform posture."), []);
  if (!t) return ["the own-area gate refused a held area"];
  const problems: string[] = [];
  if (t.access.turnAreas || t.access.heldAreas?.has(CS)) problems.push("an area without an ACTIVE grant was bound");
  if (!isNotFound(t.toolResults[0])) problems.push("the unheld area's metric was not NOT_FOUND");
  if (!metricServed(t.toolResults[1], OPS)) problems.push("the held area did not answer (vacuous)");
  return problems;
}

async function singleAreaUnchanged(ctx: UnitContext): Promise<string[]> {
  const calls = [{ name: "get_metric", args: { id: CS_METRIC } }, { name: "get_metric", args: { id: OPS_METRIC } }];
  const text = () => "Customer Success is all I read.";
  const widened = await conversationTurn(ctx, "cs", CS, [CS], [], model(calls, text), []);
  const before = await conversationTurn(ctx, "cs", CS, [CS], [], model(calls, text), [], { widen: false });
  if (!widened || !before) return ["the own-area gate refused a held area"];
  const problems: string[] = [];
  if (widened.access.binding !== widened.own.binding || widened.access.scope !== widened.own.scope || widened.access.resolvePage !== widened.own.resolvePage || widened.access.turnAreas
    || [...(widened.access.heldAreas ?? [])].join() !== CS) problems.push("one held area: the widened access is not the own access");
  if (JSON.stringify(widened.answer) !== JSON.stringify(before.answer) || JSON.stringify(widened.refs) !== JSON.stringify(before.refs)) problems.push("one held area: the stored answer / evidence refs differ from the pre-P4b turn");
  const shape = (r: TurnRun) => r.toolResults.map((x) => (isNotFound(x) ? "NOT_FOUND" : String((x as { surface?: unknown } | null)?.surface)));
  if (JSON.stringify(shape(widened)) !== JSON.stringify(shape(before)) || JSON.stringify(shape(widened)) !== JSON.stringify([CS, "NOT_FOUND"])) problems.push("one held area: the tools differ from the pre-P4b turn (or another area's metric was served)");
  return problems;
}

export const CONVERSATION_CASES: readonly UnitCase[] = [
  { kind: "unit", id: "p4b.cross-area-then-revoked", pack: "conversations", gates: ["MULTI_AREA_CONVERSATION", "SCOPE_REFUSAL"], run: crossAreaThenRevoked },
  { kind: "unit", id: "p4b.directory-is-not-a-grant", pack: "conversations", gates: ["MULTI_AREA_CONVERSATION", "SCOPE_REFUSAL"], run: directoryIsNotAGrant },
  { kind: "unit", id: "p4b.single-area-unchanged", pack: "conversations", gates: ["MULTI_AREA_CONVERSATION"], run: singleAreaUnchanged },
];
