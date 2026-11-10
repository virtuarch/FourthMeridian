/**
 * lib/platform/intelligence/ai/authz/record-render.test.ts  (Platform AI P4 — read-time record render, THE only T2 path)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/record-render.test.ts
 *
 * Design v2 §8.2 (I-1 / D-1), S2 ruling 4: T2 renders ONLY for a fresh CUSTOMER_SUCCESS tier
 * with the PLATFORM_AI_RECORD_VIEWED rows written FIRST (fail closed ⇒ masked); a non-CS viewer
 * sees the T1 ref / "[restricted]"; a record (or area) no longer visible is "[no longer
 * available]"; export never T2; one fresh check per area per render, nothing cached across
 * renders. Then the conversation view path (handlers) and the production wiring pins.
 * Synthetic RECORD source only (P4 registers none).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { RECORD_GONE_TEXT, RECORD_PENDING_TEXT } from "../compose/record";
import type { StoredAnswer, StoredRecordSegment } from "../conversations/answer";
import { messageDto, renderMessageRecords, type AreaAccess } from "../conversations/handlers";
import type { MessageRecord } from "../conversations/store";
import {
  PLATFORM_AI_RECORD_SOURCES, recordTextRenderer, renderRecordSegments,
  type RecordRenderSource, type RecordRenderViewer, type RecordViewedRow,
} from "./record-render";
import type { FreshGuard } from "./recheck";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}
const ROOT = process.cwd();
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const OP = "cop0000000000000000000001";
const RID = "ce0sentinelcustomer0000a1";
const RID2 = "ce0sentinelcustomer0000b2";
const T2 = "Zelda Quillfeather";
const T1 = "user #0a1b2c3d";

const seg = (f: string, over: Partial<StoredRecordSegment> = {}): StoredRecordSegment => ({ kind: "record", rk: "PROBE", rid: RID, a: "CUSTOMER_SUCCESS", f, ...over });

function world(opts: { cs?: boolean; held?: PlatformArea[]; auditFails?: boolean; noAudit?: boolean; visible?: string[]; noT1?: boolean } = {}) {
  const log: string[] = [];
  const held = new Set<PlatformArea>(opts.held ?? ["CUSTOMER_SUCCESS"]);
  const visible = new Set(opts.visible ?? [RID]);
  const rows: RecordViewedRow[] = [];
  const recheck = async (area: PlatformArea): Promise<FreshGuard | null> => {
    log.push(`recheck:${area}`);
    return held.has(area) ? { auth: { user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" } }, csTier: opts.cs ?? true } : null;
  };
  const source: RecordRenderSource = {
    t2Fields: ["name"],
    revalidate: async (rid, _a, g) => { log.push(`revalidate:${rid}`); return visible.has(rid) ? (g.csTier ? "CUSTOMER_SUCCESS" : "OPS") : null; },
    t1: async () => { log.push("t1"); return opts.noT1 ? null : T1; },
    linkedUserIds: async (rid) => [rid],
    t2: async () => { log.push("t2"); return T2; },
  };
  const audit = async (r: readonly RecordViewedRow[]) => { log.push("audit"); if (opts.auditFails) throw new Error("audit down"); rows.push(...r); };
  const viewer = (mode: RecordRenderViewer["mode"] = "history"): RecordRenderViewer => ({
    operatorId: OP, mode, recheck, sources: { PROBE: source }, ...(opts.noAudit ? {} : { audit }),
  });
  return { log, rows, viewer, held, visible };
}

async function main() {
  console.log("1. T2 only with a FRESH CS tier + the audit row written FIRST (S2 ruling 4)");
  {
    const w = world();
    const [r] = await renderRecordSegments([seg("name")], w.viewer());
    check("fresh CS + audit ⇒ the T2 value", r.text === T2 && r.outcome === "T2", r);
    check("one PLATFORM_AI_RECORD_VIEWED row per linked customer, codes only (no value, no record id in the detail)",
      w.rows.length === 1 && w.rows[0].action === AuditAction.PLATFORM_AI_RECORD_VIEWED && w.rows[0].targetUserId === RID
        && JSON.stringify(w.rows[0].detail) === JSON.stringify({ surface: "platform-ai", tool: "record-render", recordKind: "PROBE" }), w.rows);
    check("order: area recheck → revalidate → AUDIT → T2 read", w.log.join(",") === `recheck:CUSTOMER_SUCCESS,revalidate:${RID},audit,t2`, w.log);
    const again = await renderRecordSegments([seg("name")], w.viewer());
    check("nothing cached: a second render re-checks the area, revalidates and audits again", again[0].outcome === "T2" && w.log.filter((x) => x.startsWith("recheck")).length === 2 && w.rows.length === 2);

    const failing = world({ auditFails: true });
    const [m] = await renderRecordSegments([seg("name")], failing.viewer());
    check("audit write fails ⇒ MASKED (the T1 ref), the T2 value never read", m.text === T1 && m.outcome === "MASKED" && !failing.log.includes("t2"), failing.log);
    const noWriter = world({ noAudit: true });
    const [n] = await renderRecordSegments([seg("name")], noWriter.viewer());
    check("no audit writer (production until P5) ⇒ MASKED, never T2", n.outcome === "MASKED" && n.text === T1 && !noWriter.log.includes("t2"));
    const noT1 = world({ auditFails: true, noT1: true });
    check("masked with no T1 ref ⇒ \"[restricted]\"", (await renderRecordSegments([seg("name")], noT1.viewer()))[0].text === RECORD_PENDING_TEXT);
  }

  console.log("\n2. a non-CS viewer, export, gone records");
  {
    const ops = world({ cs: false, held: ["PLATFORM_OPS"] });
    const [r] = await renderRecordSegments([seg("name", { a: "PLATFORM_OPS" })], ops.viewer());
    check("non-CS viewer ⇒ no T2 (the T1 ref), no audit row, the T2 reader never called", r.text === T1 && r.outcome === "MASKED" && ops.rows.length === 0 && !ops.log.includes("t2") && !ops.log.includes("audit"), ops.log);

    const ex = world();
    const [e] = await renderRecordSegments([seg("name")], ex.viewer("export"));
    check("export mode NEVER renders T2 (even CS + audit): T1, no audit row", e.text === T1 && ex.rows.length === 0 && !ex.log.includes("t2"));

    const t1Field = world();
    const [t] = await renderRecordSegments([seg("ref")], t1Field.viewer());
    check("a T1 field renders the T1 ref, no audit", t.text === T1 && t.outcome === "T1" && t1Field.rows.length === 0);

    const revoked = world({ held: [] });
    const [g] = await renderRecordSegments([seg("name")], revoked.viewer());
    check("area no longer held (fresh check refused) ⇒ \"[no longer available]\", the source never asked", g.text === RECORD_GONE_TEXT && g.outcome === "GONE" && !revoked.log.some((x) => x.startsWith("revalidate")));
    const deleted = world({ visible: [] });
    check("record no longer visible (revalidate null) ⇒ \"[no longer available]\"", (await renderRecordSegments([seg("name")], deleted.viewer()))[0].text === RECORD_GONE_TEXT && deleted.rows.length === 0);
    const unknownKind = world();
    check("an unknown record kind / a non-area ⇒ \"[no longer available]\"",
      (await renderRecordSegments([seg("ref", { rk: "OTHER" }), seg("ref", { a: "ALL" })], unknownKind.viewer())).every((x) => x.text === RECORD_GONE_TEXT));
    check("the production registry has NO record source in P4 ⇒ every record renders gone", Object.keys(PLATFORM_AI_RECORD_SOURCES).length === 0
      && (await renderRecordSegments([seg("name")], { operatorId: OP, mode: "history", recheck: world().viewer().recheck })).every((x) => x.text === RECORD_GONE_TEXT));
    const foreign = world();
    const foreignViewer: RecordRenderViewer = { ...foreign.viewer(), operatorId: "cop0000000000000000000002" };
    check("a fresh guard for ANOTHER operator never counts ⇒ gone", (await renderRecordSegments([seg("name")], foreignViewer))[0].outcome === "GONE");
    const mixed = world();
    const out = await renderRecordSegments([seg("name"), seg("ref", { rid: RID2 }), seg("name")], mixed.viewer());
    check("one fresh check per DISTINCT area per render; a gone record does not block the others", mixed.log.filter((x) => x.startsWith("recheck")).length === 1
      && out[0].outcome === "T2" && out[1].outcome === "GONE" && out[2].outcome === "T2" && mixed.rows.length === 1, { log: mixed.log, out });
    const throwing: RecordRenderViewer = { operatorId: OP, mode: "history", recheck: async () => { throw new Error("db down"); }, sources: { PROBE: world().viewer().sources!.PROBE } };
    check("a thrown recheck ⇒ gone (never throws)", (await renderRecordSegments([seg("name")], throwing))[0].outcome === "GONE");
  }

  console.log("\n3. the conversation view (handlers) renders stored records for THIS viewer");
  {
    const w = world();
    const answer: StoredAnswer = { v: 2, segments: [{ kind: "text", text: "The customer is " }, seg("name"), { kind: "text", text: "." }], citations: [], notes: [], stop: "ANSWERED" };
    const msg: MessageRecord = { id: "m1", role: "ASSISTANT", status: "COMPLETE", createdAt: new Date(), completedAt: new Date(), content: answer, unreadable: false, failureCode: null, evidenceRefs: [] } as unknown as MessageRecord;
    const access = { resolvePage: () => null, binding: {} as never, renderRecords: recordTextRenderer(w.viewer()) } as unknown as AreaAccess;
    const recs = await renderMessageRecords([msg], access);
    const dto = JSON.stringify(messageDto(msg, access, true, recs));
    check("CS viewer: the DTO carries the rendered T2 text, never the record id or a record segment", dto.includes(T2) && !dto.includes(RID) && !dto.includes("\"record\""), dto);
    const noRenderer = JSON.stringify(messageDto(msg, { resolvePage: () => null, binding: {} as never } as unknown as AreaAccess, true, await renderMessageRecords([msg], { resolvePage: () => null } as unknown as AreaAccess)));
    check("no renderer ⇒ \"[no longer available]\" (fail closed), never the id", noRenderer.includes(RECORD_GONE_TEXT) && !noRenderer.includes(RID) && !noRenderer.includes(T2));
    const v1msg = { ...msg, content: { v: 1, segments: [{ kind: "text", text: "plain" }], citations: [], notes: [], stop: "ANSWERED" } } as unknown as MessageRecord;
    let called = 0;
    await renderMessageRecords([v1msg], { renderRecords: async () => { called++; return new Map(); } } as unknown as AreaAccess);
    check("an answer with no record segment never calls the renderer (today's answers: no extra reads)", called === 0);
  }

  console.log("\n4. production wiring pins");
  {
    const rr = code(src("lib/platform/intelligence/ai/authz/record-render.ts"));
    check("record-render: the sources registry is EMPTY in P4 (each pack PR registers its own)", /PLATFORM_AI_RECORD_SOURCES[^=]*= Object\.freeze\(\{\}\)/.test(rr));
    check("record-render: export never T2 (mode check in the T2 predicate) and the audit runs before any t2 read",
      /viewer\.mode !== "export"/.test(rr) && rr.indexOf("viewer.audit!(rows") < rr.indexOf("l.src.t2("));
    const ask = code(src("app/api/platform/ai/ask/route.ts"));
    check("ask route: records = the boundary's lookup; renderRecords = recordTextRenderer(live, platformAiProbeRecheck), no audit writer yet",
      /records: boundary\.recordRef/.test(ask) && /renderRecords: recordTextRenderer\(\{ operatorId: auth\.user\.id, mode: "live", recheck: platformAiProbeRecheck \}\)/.test(ask));
    const aa = code(src("app/api/platform/ai/conversations/area-access.ts"));
    check("conversation area access: renderRecords = recordTextRenderer(history, platformAiProbeRecheck) for THIS operator",
      /renderRecords: recordTextRenderer\(\{ operatorId, mode: "history", recheck: platformAiProbeRecheck \}\)/.test(aa));
    const tr = code(src("app/api/platform/ai/conversations/turn-runner.ts"));
    check("turn runner: records + remint from THIS turn's boundary", /records: boundary\.recordRef/.test(tr) && /remint: boundary\.remint/.test(tr));
    const rs = code(src("lib/platform/intelligence/ai/authz/recheck.server.ts"));
    check("the probe recheck is requireFreshPlatformAccess(area, \"READ\", { probe: true }) with the CS tier from its own guard",
      /requireFreshPlatformAccess\(area, "READ", \{ probe: true \}\)/.test(rs) && /incidentAudienceFor\(fresh\)/.test(rs));
    check("the boundary's per-call recheck stays NON-probe (platformAiFreshRecheck)", /export async function platformAiFreshRecheck[\s\S]*?requireFreshPlatformAccess\(area, "READ"\);/.test(rs));
    const exp = code(src("lib/platform/intelligence/ai/conversations/export.ts"));
    check("export renders a record as its kind marker only (no renderer, no T2 path)", /recordReplayMarker\(s\.rk, null\)/.test(exp) && !/record-render|renderRecord/.test(exp));
    check("no ai/** file other than record-render reads a T2 value through a source (t2( call sites)",
      ["core.ts", "conversations/handlers.ts", "conversations/history.ts", "conversations/turn.ts", "authz/boundary.ts"].every((f) => !/\.t2\(/.test(code(src(`lib/platform/intelligence/ai/${f}`)))));
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
