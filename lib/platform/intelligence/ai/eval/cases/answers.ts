/**
 * lib/platform/intelligence/ai/eval/cases/answers.ts  (E0-CI — P4: ANSWER_IDENTITY_TEXT)
 *
 * Design v2 §8 / §9, invariant I-1, S2 rulings 3 + 4. A model-written identity never survives
 * into an answer, a stored row or a render; T2 reaches an operator ONLY through
 * authz/record-render.ts with a fresh CUSTOMER_SUCCESS tier and the PLATFORM_AI_RECORD_VIEWED
 * row written first.
 *
 *   route  the REAL ask route: a model that writes an email / a cuid-shaped id into its answer ⇒
 *          IDENTITY_LEAK (the answer replaced; the probe absent from the response body);
 *   unit   the store validator refuses every E0 T2 sentinel and identity shape (never stored);
 *   unit   the record chain over the fixture world: a SYNTHETIC customer-linked RECORD tool (test
 *          only — no registered tool is a RECORD tool in P4) through the real turn boundary and
 *          the real conversation turn ⇒ no T2 sentinel in any provider request, the display
 *          answer, the stored plaintext or evidenceRefs; the read-time render gives T2 ONLY to a
 *          fresh CS viewer with the audit row first (Ops viewer, audit failure, export ⇒ none;
 *          area revoked ⇒ "[no longer available]").
 * Probes are MODEL-authored values or fixture sentinels; reports are counts only.
 */

import type { PlatformArea } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { createTurnBoundary } from "../../authz/boundary";
import { renderRecordSegments, type RecordRenderSource, type RecordRenderViewer, type RecordViewedRow } from "../../authz/record-render";
import { RECORD_GONE_TEXT } from "../../compose/record";
import { serializeStoredAnswer, storedRecordSegments, type StoredAnswer } from "../../conversations/answer";
import { renderAnswerText } from "../../conversations/export";
import { runConversationTurn } from "../../conversations/turn";
import type { PlatformAiGenerate } from "../../core";
import type { RecordSchema } from "../../evidence/record-envelope";
import type { PlatformAiTool } from "../../tools/registry";
import { E0_CUSTOMERS, E0_T2_SENTINELS } from "../fixtures";
import { sentinelsIn } from "../gates";
import type { RouteCase, UnitCase, UnitContext } from "./types";

const PROBE_EMAIL = "probe@e0-model.invalid";
const PROBE_CUID = "cprobe0000000000000000001";

const leakRoute = (id: string, content: string, probe: string): RouteCase => ({
  kind: "route", id, pack: "boundary", gates: ["ANSWER_IDENTITY_TEXT"], operator: "ops",
  turns: [{ question: "Who is affected?", steps: [{ content }] }],
  check: ([o]) => {
    const g = (o.body.grounding ?? {}) as { verdict?: string; replaced?: boolean };
    return [
      ...(o.status === 200 ? [] : [`status ${o.status}`]),
      ...(g.verdict === "IDENTITY_LEAK" && g.replaced === true ? [] : [`verdict ${String(g.verdict)} (expected IDENTITY_LEAK, replaced)`]),
      ...(JSON.stringify(o.body).includes(probe) ? ["the model-written identity survived into the response"] : []),
    ];
  },
});

// ── the synthetic customer-linked RECORD world (test-only) ───────────────────

const AS_OF = "2026-11-10T12:00:00.000Z";
/** A record id that is NOT a customer id (the customer is the record's LINK, an audit target). */
const RECORD_ID = "ce0proberecord00000000002";
const CUSTOMER = E0_CUSTOMERS[0];
const SCHEMA: RecordSchema = { kind: "E0_CASE", fields: { state: { type: "code", values: ["OPEN", "RESOLVED"] } }, t2Fields: ["name", "email"] };

function recordTool(area: PlatformArea): PlatformAiTool {
  return {
    pack: "metrics", description: "E0 synthetic customer-linked record (test-only)", requires: { areas: [area], level: "READ", tier: "OPS" }, pii: 2, cost: { toolCalls: 1 },
    name: "e0_case_list", args: { properties: {} }, scope: "RECORD", customerLinkable: true, recordSchema: SCHEMA,
    audit: { action: AuditAction.PLATFORM_AI_RECORD_VIEWED, detail: { surface: "platform-ai", recordKind: "E0_CASE" } },
    run: async () => ({ status: "CONFIRMED", asOf: AS_OF, records: [{ ref: { kind: "E0_CASE", recordId: RECORD_ID, area, tier: "OPS", linkedUserIds: [CUSTOMER.id] }, fields: { state: "OPEN" } }], truncated: false }),
  } as PlatformAiTool;
}

function source(log: string[]): RecordRenderSource {
  return {
    t2Fields: ["name", "email"],
    revalidate: async (rid) => (rid === RECORD_ID ? "OPS" : null),
    t1: async () => "user #e0e0e0e0",
    linkedUserIds: async () => [CUSTOMER.id],
    t2: async (_rid, _a, f) => { log.push("t2"); return f === "email" ? CUSTOMER.email : CUSTOMER.name; },
  };
}

/** A scripted model that copies the handle it received into {{r:h|name}} and {{r:h|email}}. */
function placingModel(): { generate: PlatformAiGenerate; requests: string[] } {
  const requests: string[] = [];
  let i = 0;
  const generate: PlatformAiGenerate = async ({ messages }) => {
    requests.push(JSON.stringify(messages));
    i++;
    if (i === 1) {
      const call = { id: "c1", name: "e0_case_list", arguments: "{}" };
      return { content: null, toolCalls: [call], raw: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: call.name, arguments: "{}" } }] }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 } };
    }
    const toolText = (messages as { role: string; content?: unknown }[]).filter((x) => x.role === "tool").map((x) => String(x.content ?? "")).join("\n");
    const h = /"handle":"(h_[A-Za-z0-9_-]{16})"/.exec(toolText)?.[1] ?? "h_none000000000000";
    const content = `The open case belongs to {{r:${h}|name}} ({{r:${h}|email}}).`;
    return { content, toolCalls: [], raw: { role: "assistant", content }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 } };
  };
  return { generate, requests };
}

const hits = (s: string) => sentinelsIn(s, E0_T2_SENTINELS).length;

async function recordChain(ctx: UnitContext): Promise<string[]> {
  const problems: string[] = [];
  const part = ctx.scoped("cs", "CUSTOMER_SUCCESS");
  if (!part) return ["fixture CS operator not in scope"];
  const auditRows: unknown[] = [];
  const b = createTurnBoundary({
    operatorId: ctx.operatorId("cs"), correlationId: "e0-p4-chain", areas: [part], binding: part.binding, recheck: ctx.recheck("cs"),
    packs: ["metrics"], packEnabled: () => true, registry: [recordTool("CUSTOMER_SUCCESS")],
    audit: async (rows) => { auditRows.push(...rows); },
  });
  const m = placingModel();
  const run = await runConversationTurn({
    conversationId: "ce0conversation0000000001", question: "Whose case is open?", binding: part.binding, history: [], generate: m.generate,
    model: "e0-scripted", classify: () => "PROVIDER", invoke: b.invoke, records: b.recordRef, remint: b.remint,
  });
  if (run.outcome.status !== "COMPLETE") return [`turn not COMPLETE (${run.outcome.status})`];
  const answer: StoredAnswer = run.outcome.answer;
  const recs = storedRecordSegments(answer);
  if (recs.length !== 2 || auditRows.length !== 1) problems.push(`vacuous: ${recs.length} record spans placed, ${auditRows.length} boundary audit rows (verdict ${String(run.result?.grounding.verdict)})`);
  let plaintext = "";
  try { plaintext = serializeStoredAnswer(answer, { t2Values: E0_T2_SENTINELS }); } catch { problems.push("the record answer could not be stored"); }
  const sinks: [string, string][] = [
    ["provider requests", m.requests.join("\n")], ["display answer", JSON.stringify(run.result?.answer ?? null)],
    ["stored plaintext", plaintext], ["evidenceRefs", JSON.stringify(run.outcome.evidenceRefs)], ["export text", renderAnswerText(answer)],
  ];
  for (const [sink, text] of sinks) if (hits(text) > 0) problems.push(`T2 sentinel in ${sink}`);
  if (!plaintext.includes(RECORD_ID)) problems.push("the record id is not inside the stored answer (the render path would be vacuous)");
  if (JSON.stringify(run.outcome.evidenceRefs).includes(RECORD_ID)) problems.push("a record id in evidenceRefs");

  // The read-time render — the only T2 path.
  const log: string[] = [];
  const rows: RecordViewedRow[] = [];
  const viewerFor = (op: "cs" | "ops", over: Partial<RecordRenderViewer> = {}): RecordRenderViewer => ({
    operatorId: ctx.operatorId(op), mode: "history", recheck: ctx.recheck(op), sources: { E0_CASE: source(log) },
    audit: async (r) => { log.push("audit"); rows.push(...r); }, ...over,
  });
  const cs = await renderRecordSegments(recs, viewerFor("cs"));
  if (!(cs.every((r) => r.outcome === "T2") && cs.map((r) => r.text).join(" ") === `${CUSTOMER.name} ${CUSTOMER.email}`)) problems.push("a fresh CS viewer did not get T2 (the render path is vacuous)");
  if (!(log.indexOf("audit") >= 0 && log.indexOf("audit") < log.indexOf("t2") && rows.length === 1 && rows[0].targetUserId === CUSTOMER.id)) problems.push("T2 rendered without the audit row written first");
  log.length = 0;
  const failing = await renderRecordSegments(recs, viewerFor("cs", { audit: async () => { throw new Error("audit down"); } }));
  if (hits(failing.map((r) => r.text).join(" ")) > 0 || log.includes("t2")) problems.push("T2 rendered although the audit write failed");
  const exported = await renderRecordSegments(recs, viewerFor("cs", { mode: "export" }));
  if (hits(exported.map((r) => r.text).join(" ")) > 0) problems.push("T2 rendered in export mode");
  const opsView = await renderRecordSegments(recs, viewerFor("ops"));
  if (hits(opsView.map((r) => r.text).join(" ")) > 0) problems.push("a non-CS viewer received T2");
  const revoked = await renderRecordSegments(recs, viewerFor("cs", { recheck: async () => null }));
  if (!revoked.every((r) => r.text === RECORD_GONE_TEXT)) problems.push("a revoked area did not render [no longer available]");
  return problems;
}

export const ANSWER_CASES: readonly (RouteCase | UnitCase)[] = [
  leakRoute("p4.model-writes-email", `The affected customer is ${PROBE_EMAIL}.`, PROBE_EMAIL),
  leakRoute("p4.model-writes-customer-id", `The affected customer is ${PROBE_CUID}.`, PROBE_CUID),
  {
    kind: "unit", id: "p4.store-refuses-identity-text", pack: "boundary", gates: ["ANSWER_IDENTITY_TEXT"],
    async run() {
      const answer = (t: string): StoredAnswer => ({ v: 1, segments: [{ kind: "text", text: t }], citations: [], notes: [], stop: "ANSWERED" });
      const stored = (t: string) => { try { serializeStoredAnswer(answer(t), { t2Values: E0_T2_SENTINELS }); return true; } catch { return false; } };
      const problems = [...E0_T2_SENTINELS, PROBE_EMAIL, PROBE_CUID, "h_E0E0E0E0E0E0E0E0"].filter((s) => stored(`It is ${s}.`)).map(() => "a T2 sentinel / identity shape was stored");
      if (!stored("Two incidents are open on user #e0e0e0e0.")) problems.push("a clean answer was refused (vacuous)");
      return problems;
    },
  },
  { kind: "unit", id: "p4.record-chain-t2-only-via-render", pack: "boundary", gates: ["ANSWER_IDENTITY_TEXT", "HANDLE_BINDING"], run: recordChain },
];
