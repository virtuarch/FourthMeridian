/**
 * lib/platform/intelligence/ai/authz/boundary.test.ts  (Platform AI P2 — invokeTool, the single enforcement point)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/boundary.test.ts
 *
 * Exercises every step of createTurnBoundary().invoke against the REAL registry (the six
 * existing tools) and against SYNTHETIC test-only tools (a RECORD tool, a handle-taking tool,
 * a CS-tier tool, a customer-linkable tool — none of them registered anywhere): order,
 * the one NOT_FOUND, per-call recheck, scope narrowing, handles, tier, revalidate, the
 * fail-closed audit, the envelope validator, the tier filter, handle minting, denial rows
 * and the codes-only trace. Then the production wiring pins (ask route + turn runner).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { UserRole, type PlatformArea } from "@prisma/client";
import { NOT_FOUND, executePlatformAiTool, type PlatformAiBinding, type ToolEvidence } from "../core";
import type { RecordSchema } from "../evidence/record-envelope";
import type { PlatformAiTool } from "../tools/registry";
import { createTurnBoundary, type BoundaryAuditRow, type TurnBoundaryOptions } from "./boundary";
import type { DenialRow, FreshGuard } from "./recheck";
import { scopeFromGuard, type ScopedArea } from "./scope";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}

const ROOT = process.cwd();
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const OP = "cop0000000000000000000001";
const OTHER = "cop0000000000000000000002";
const AS_OF = "2026-11-09T12:00:00.000Z";
const SECRET_ID = "crec0000secretrecordid0001";

const scopeOf = (area: PlatformArea, op = OP): ScopedArea => scopeFromGuard({ user: { id: op, role: UserRole.USER }, grant: { area, level: "READ" } }, area, op)!;
const binding = (label: string): PlatformAiBinding => ({
  surfaceLabel: label, listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null,
});
const ev = (): ToolEvidence => ({ envelopes: [], hrefs: new Set(), definitions: [], labels: new Set(), trace: [], pages: new Map() });
const ctx = (e = ev()) => ({ ev: e, paramKeys: [] as string[], asked: [] as { hours: number }[] });

/** A recheck over a mutable set of held areas; counts every (authoritative) read. */
function fakeRecheck(held: Set<PlatformArea>, opts: { cs?: boolean; userId?: string; role?: UserRole } = {}) {
  const calls: PlatformArea[] = [];
  const fn = async (area: PlatformArea): Promise<FreshGuard | null> => {
    calls.push(area);
    if (!held.has(area)) return null;
    return { auth: { user: { id: opts.userId ?? OP, role: opts.role ?? UserRole.USER }, grant: opts.role === UserRole.SYSTEM_ADMIN ? null : { area, level: "READ" } }, csTier: opts.cs ?? area === "CUSTOMER_SUCCESS" };
  };
  return { fn, calls };
}

// ── synthetic test-only tools (never registered) ────────────────────────────

const SCHEMA: RecordSchema = {
  kind: "PROBE",
  fields: { state: { type: "code", values: ["OPEN", "RESOLVED"] }, openedAt: { type: "isoTime" }, attempts: { type: "count" }, retried: { type: "bool", nullable: true } },
  t2Fields: ["name"],
};
const rec = (id: string, over: Record<string, unknown> = {}, ref: Record<string, unknown> = {}) => ({
  ref: { kind: "PROBE", recordId: id, area: "PLATFORM_OPS", tier: "OPS", linkedUserIds: [], ...ref },
  fields: { state: "OPEN", openedAt: AS_OF, attempts: 2, ...over },
});
const base = { pack: "metrics", description: "test", requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" }, pii: 1, cost: { toolCalls: 1 } } as const;

let runs: { tool: string; args: Record<string, unknown>; label: string }[] = [];
const recordsTool = (records: () => unknown[], over: Partial<Record<string, unknown>> = {}): PlatformAiTool => ({
  ...base, name: "probe_list", args: { properties: {} }, scope: "RECORD", customerLinkable: false, recordSchema: SCHEMA,
  run: async (a, c) => { runs.push({ tool: "probe_list", args: { ...a }, label: c.binding.surfaceLabel }); return { status: "CONFIRMED", asOf: AS_OF, records: records(), truncated: false }; },
  ...over,
} as PlatformAiTool);
const detailTool = (over: Partial<Record<string, unknown>> = {}): PlatformAiTool => ({
  ...base, name: "probe_detail", args: { properties: { h: { kind: "handle", recordKind: "PROBE" } } }, scope: "RECORD", customerLinkable: false, recordSchema: SCHEMA,
  run: async (a) => { runs.push({ tool: "probe_detail", args: { ...a }, label: "" }); return { status: "CONFIRMED", asOf: AS_OF, records: [rec(String(a.h))], truncated: false }; },
  ...over,
} as PlatformAiTool);
const aggTool = (over: Partial<Record<string, unknown>> = {}): PlatformAiTool => ({
  ...base, name: "probe_agg", args: { properties: { n: { kind: "int", min: 1, max: 5 } } }, scope: "AGGREGATE", customerLinkable: false, pii: 0,
  requires: { areas: ["PLATFORM_OPS", "CUSTOMER_SUCCESS"], level: "READ", tier: "OPS" },
  run: async (a, c) => { runs.push({ tool: "probe_agg", args: { ...a }, label: c.binding.surfaceLabel }); return { ok: true, label: c.binding.surfaceLabel }; },
  ...over,
} as PlatformAiTool);

function boundary(o: Partial<TurnBoundaryOptions> & { held?: Set<PlatformArea> } = {}) {
  const held = o.held ?? new Set<PlatformArea>(["PLATFORM_OPS"]);
  const rc = fakeRecheck(held);
  const denials: DenialRow[] = [];
  const areas = o.areas ?? [{ scope: scopeOf("PLATFORM_OPS"), binding: binding("Ops") }];
  const b = createTurnBoundary({
    operatorId: OP, correlationId: "corr-1", areas, binding: o.binding ?? binding("FULL"),
    recheck: o.recheck ?? rc.fn, packs: o.packs ?? ["metrics", "navigation"], packEnabled: o.packEnabled ?? (() => true),
    onDenial: (r) => denials.push(r), ...(o.registry ? { registry: o.registry } : {}), ...(o.audit ? { audit: o.audit } : {}),
    ...(o.correlationId ? { correlationId: o.correlationId } : {}), ...(o.operatorId ? { operatorId: o.operatorId } : {}),
  });
  return { b, rc, denials, held };
}
const call = (b: { invoke: ReturnType<typeof createTurnBoundary>["invoke"] }, name: string, args: unknown, e = ev(), memory?: never) =>
  b.invoke(name, JSON.stringify(args), { ...ctx(e), ...(memory ? { memory } : {}) });

async function main() {
  console.log("1. steps 1–3: registered, routed, flag ON, strict args, in scope — refused BEFORE any recheck or run");
  {
    runs = [];
    const { b, rc, denials } = boundary({ registry: [aggTool(), recordsTool(() => [rec("r1")], { requires: { areas: ["CUSTOMER_SUCCESS"], level: "READ", tier: "OPS" } })] });
    const e = ev();
    const outs = [
      await call(b, "get_customer", {}, e),                 // unknown
      await call(b, "probe_agg", { n: 9 }, e),               // args out of range
      await call(b, "probe_agg", { n: 1, area: "SECURITY_OPS" }, e), // undeclared (scope) argument
      await call(b, "probe_list", {}, e),                    // RECORD tool: an area not in scope
    ];
    check("every refusal is THE one NOT_FOUND object (identical to the model)", outs.every((x) => x === NOT_FOUND));
    check("no recheck read and no run happened for any of them", rc.calls.length === 0 && runs.length === 0, { rc: rc.calls, runs });
    check("metadata trace: unknown tool ⇒ unknown/NOT_FOUND, bad args ⇒ <tool>/INVALID_ARGS (the executor's own codes)",
      JSON.stringify(e.trace.map((t) => `${t.tool}:${t.outcome}`)) === JSON.stringify(["unknown:NOT_FOUND", "probe_agg:INVALID_ARGS", "probe_agg:INVALID_ARGS", "probe_list:NOT_FOUND"]), e.trace);
    check("denial rows are codes only: tool / pack / reason (the bad-args row twice ⇒ ONE row: deduped per turn)",
      JSON.stringify(denials) === JSON.stringify([
        { tool: "unknown", pack: "none", reason: "UNKNOWN_TOOL" }, { tool: "probe_agg", pack: "metrics", reason: "ARGS_INVALID" },
        { tool: "probe_list", pack: "metrics", reason: "AREA_NOT_IN_SCOPE" },
      ]), denials);
    check("the trace never carries an argument value or the model's tool name", !/SECURITY_OPS|get_customer|"n"/.test(JSON.stringify(b.trace())), b.trace());
  }
  {
    runs = [];
    const off = boundary({ registry: [aggTool()], packEnabled: (p) => p !== "metrics" });
    const notRouted = boundary({ registry: [aggTool()], packs: ["navigation"] });
    check("a tool of a pack whose flag is OFF ⇒ NOT_FOUND (PACK_DISABLED), nothing read or run",
      (await call(off.b, "probe_agg", { n: 1 })) === NOT_FOUND && off.rc.calls.length === 0 && runs.length === 0 && off.denials[0]?.reason === "PACK_DISABLED");
    check("a tool of a pack the router did not route ⇒ NOT_FOUND (PACK_NOT_ROUTED)",
      (await call(notRouted.b, "probe_agg", { n: 1 })) === NOT_FOUND && notRouted.denials[0]?.reason === "PACK_NOT_ROUTED");
    const mem = boundary({ packs: ["metrics", "navigation", "memory"] });
    const e = ev();
    check("a memory tool without the turn's memory hooks ⇒ NOT_FOUND, traced as `unknown` exactly as the executor does",
      (await call(mem.b, "recall_memory", {}, e)) === NOT_FOUND && e.trace[0]?.tool === "unknown" && e.trace[0]?.outcome === "NOT_FOUND");
    const throwing = boundary({ registry: [aggTool()], packEnabled: () => { throw new Error("flag read failed"); } });
    check("a pack-flag read that throws ⇒ OFF (fail closed)", (await call(throwing.b, "probe_agg", { n: 1 })) === NOT_FOUND && throwing.denials[0]?.reason === "PACK_DISABLED");
  }
  {
    const guarded = boundary({ registry: [{ ...aggTool(), name: "probe_text", args: { properties: { q: { kind: "guardedText", sink: "REGISTRY_LABEL_MATCH", maxLength: 20 } } } } as PlatformAiTool] });
    check("guardedText on any tool/arg outside the S2 allowlist ⇒ NOT_FOUND (ARGS_INVALID)", (await call(guarded.b, "probe_text", { q: "x" })) === NOT_FOUND && guarded.denials[0]?.reason === "ARGS_INVALID");
    const real = boundary();
    const e = ev();
    await call(real.b, "find_page", { query: "incidents" }, e);
    check("…find_page.query (allowlisted) passes the boundary to the executor", e.trace[0]?.tool === "find_page" && e.trace[0]?.outcome === "OK", e.trace);
  }

  console.log("\n2. step 4: the per-call recheck — every call, no memo; a refusal drops the area for the rest of the turn");
  {
    runs = [];
    const { b, rc, held, denials } = boundary({ registry: [aggTool({ requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" } })] });
    for (let i = 0; i < 4; i++) await call(b, "probe_agg", { n: 1 });
    check("4 tool calls ⇒ 4 authoritative recheck reads (no memoisation)", rc.calls.length === 4 && runs.length === 4, rc.calls);
    held.delete("PLATFORM_OPS"); // the grant is revoked between call 4 and call 5
    const fifth = await call(b, "probe_agg", { n: 1 });
    const sixth = await call(b, "probe_agg", { n: 1 });
    check("call 5 (after revocation) ⇒ NOT_FOUND, no run", fifth === NOT_FOUND && runs.length === 4);
    check("the area left the scope: call 6 is NOT_FOUND without another read", sixth === NOT_FOUND && rc.calls.length === 5 && b.scopeAreas().length === 0, rc.calls);
    check("denial rows: RECHECK_REFUSED once, then AREA_NOT_IN_SCOPE", denials.map((d) => d.reason).join() === "RECHECK_REFUSED,AREA_NOT_IN_SCOPE", denials);
  }
  {
    runs = [];
    const held = new Set<PlatformArea>(["PLATFORM_OPS", "CUSTOMER_SUCCESS"]);
    const { b, rc } = boundary({
      held, registry: [aggTool()],
      areas: [{ scope: scopeOf("PLATFORM_OPS"), binding: binding("OPS-ONLY") }, { scope: scopeOf("CUSTOMER_SUCCESS"), binding: binding("CS-ONLY") }],
      binding: binding("BOTH"),
    });
    await call(b, "probe_agg", { n: 1 });
    held.delete("CUSTOMER_SUCCESS");
    const out = await call(b, "probe_agg", { n: 2 }) as { label?: string };
    check("multi-area: both areas rechecked on every call", rc.calls.join() === "PLATFORM_OPS,CUSTOMER_SUCCESS,PLATFORM_OPS,CUSTOMER_SUCCESS", rc.calls);
    check("intact scope ⇒ the turn's own binding (behaviour unchanged)", runs[0]?.label === "BOTH");
    check("CS revoked mid-turn ⇒ the call continues on Ops ONLY, through a binding recomposed from Ops' own part", out.label === "Platform Operations" && b.scopeAreas().join() === "PLATFORM_OPS", out);
  }
  {
    const sa = fakeRecheck(new Set(["PLATFORM_OPS"]), { role: UserRole.SYSTEM_ADMIN });
    const other = fakeRecheck(new Set(["PLATFORM_OPS"]), { userId: OTHER });
    const boom = async (): Promise<FreshGuard | null> => { throw new Error("db down"); };
    for (const [why, recheck] of [["break-glass SYSTEM_ADMIN (grant null)", sa.fn], ["a different session user", other.fn], ["a recheck that throws", boom]] as const) {
      const { b } = boundary({ recheck, registry: [aggTool({ requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" } })] });
      check(`a fresh guard from ${why} ⇒ NOT_FOUND (the same I-7 rule as the route)`, (await call(b, "probe_agg", { n: 1 })) === NOT_FOUND && b.scopeAreas().length === 0);
    }
    const forged = { area: "PLATFORM_OPS", operatorId: OP } as unknown as ScopedArea;
    const f = boundary({ areas: [{ scope: forged, binding: binding("x") }], registry: [aggTool()] });
    const foreign = boundary({ areas: [{ scope: scopeOf("PLATFORM_OPS", OTHER), binding: binding("x") }], registry: [aggTool()] });
    check("a forged ScopedArea or another operator's scope is never in scope", (await call(f.b, "probe_agg", { n: 1 })) === NOT_FOUND && (await call(foreign.b, "probe_agg", { n: 1 })) === NOT_FOUND
      && f.rc.calls.length === 0 && foreign.rc.calls.length === 0);
  }

  console.log("\n3. steps 5, 12: handles — minted per record, resolved only in THIS turn for THIS operator");
  {
    runs = [];
    const reg = [recordsTool(() => [rec(SECRET_ID)]), detailTool()];
    const turnA = boundary({ registry: reg });
    const listed = await call(turnA.b, "probe_list", {}) as { records: { handle: string; kind: string; fields: Record<string, unknown>; t2Fields?: string[] }[] };
    const h = listed.records[0]?.handle;
    check("a RECORD result carries a handle (h_ + 16 base64url), the kind, closed fields, T2 field NAMES — never the record id",
      /^h_[A-Za-z0-9_-]{16}$/.test(h ?? "") && listed.records[0].kind === "PROBE" && JSON.stringify(listed.records[0].t2Fields) === `["name"]` && !JSON.stringify(listed).includes(SECRET_ID), listed);
    await call(turnA.b, "probe_detail", { h });
    check("the same turn resolves it: the tool receives the RECORD ID, never the key", runs[1]?.args.h === SECRET_ID, runs[1]);
    const turnB = boundary({ registry: reg, correlationId: "corr-2" });
    const otherOp = boundary({ registry: reg, operatorId: OTHER, areas: [{ scope: scopeOf("PLATFORM_OPS", OTHER), binding: binding("x") }], recheck: fakeRecheck(new Set(["PLATFORM_OPS"]), { userId: OTHER }).fn });
    const detailRuns = () => runs.filter((r) => r.tool === "probe_detail").length;
    const n = detailRuns();
    check("a handle from another turn (another correlation id) ⇒ NOT_FOUND", (await call(turnB.b, "probe_detail", { h })) === NOT_FOUND && turnB.denials[0]?.reason === "HANDLE_UNRESOLVED");
    check("a handle from another operator ⇒ NOT_FOUND", (await call(otherOp.b, "probe_detail", { h })) === NOT_FOUND);
    check("a well-formed guessed handle ⇒ NOT_FOUND", (await call(turnA.b, "probe_detail", { h: "h_AAAAAAAAAAAAAAAA" })) === NOT_FOUND);
    const wrongKind = boundary({ registry: [recordsTool(() => [rec("r9")]), detailTool({ args: { properties: { h: { kind: "handle", recordKind: "OTHER_KIND" } } } })] });
    const l2 = await call(wrongKind.b, "probe_list", {}) as { records: { handle: string }[] };
    check("a handle of another record kind ⇒ NOT_FOUND", (await call(wrongKind.b, "probe_detail", { h: l2.records[0].handle })) === NOT_FOUND);
    const noKind = boundary({ registry: [recordsTool(() => [rec("r9")]), detailTool({ args: { properties: { h: { kind: "handle" } } } })] });
    const l3 = await call(noKind.b, "probe_list", {}) as { records: { handle: string }[] };
    check("a handle argument that declares no record kind ⇒ NOT_FOUND (fail closed)", (await call(noKind.b, "probe_detail", { h: l3.records[0].handle })) === NOT_FOUND);
    check("none of the refused handle calls ran the tool", detailRuns() === n);
    check("the denial rows never carry a handle", ![...turnA.denials, ...turnB.denials, ...otherOp.denials].some((d) => JSON.stringify(d).includes("h_")));
  }

  console.log("\n4. steps 6, 7, 11: tier and record-level revalidation");
  {
    const csTool = aggTool({ name: "probe_cs", requires: { areas: ["CUSTOMER_SUCCESS"], level: "READ", tier: "CUSTOMER_SUCCESS" } });
    const csAreas = [{ scope: scopeOf("CUSTOMER_SUCCESS"), binding: binding("CS") }];
    const noTier = boundary({ registry: [csTool], areas: csAreas, held: new Set(["CUSTOMER_SUCCESS"]), recheck: fakeRecheck(new Set(["CUSTOMER_SUCCESS"]), { cs: false }).fn });
    const tier = boundary({ registry: [csTool], areas: csAreas, held: new Set(["CUSTOMER_SUCCESS"]) });
    check("a CS-tier tool without a FRESH CS audience ⇒ NOT_FOUND (TIER_REFUSED)", (await call(noTier.b, "probe_cs", { n: 1 })) === NOT_FOUND && noTier.denials[0]?.reason === "TIER_REFUSED");
    check("…with one ⇒ runs", (await call(tier.b, "probe_cs", { n: 1 }) as { ok?: boolean }).ok === true);
    const mixed = () => [rec("ops1"), rec("cs1", {}, { tier: "CUSTOMER_SUCCESS" })];
    const opsCall = boundary({ registry: [recordsTool(mixed)] });
    const out = await call(opsCall.b, "probe_list", {}) as { records: unknown[] };
    check("tier filter: a CS-tier record never reaches a call without a fresh CS audience", out.records.length === 1 && opsCall.b.trace().at(-1)?.dropped === 1, opsCall.b.trace());
    runs = [];
    let revalidated: string[] = [];
    const reg = (ok: boolean | "throw") => [recordsTool(() => [rec("rv1")]), detailTool({ revalidate: async (id: string) => { revalidated.push(id); if (ok === "throw") throw new Error("x"); return ok; } })];
    for (const [why, ok] of [["false", false], ["a throw", "throw"]] as const) {
      revalidated = [];
      const t = boundary({ registry: reg(ok) });
      const l = await call(t.b, "probe_list", {}) as { records: { handle: string }[] };
      const n = runs.length;
      check(`revalidate ⇒ ${why} ⇒ NOT_FOUND, the tool never runs`, (await call(t.b, "probe_detail", { h: l.records[0].handle })) === NOT_FOUND && runs.length === n && revalidated.join() === "rv1" && t.denials.at(-1)?.reason === "REVALIDATE_REFUSED");
    }
  }

  console.log("\n5. steps 8, 10: fail-closed audit and the envelope validator (UNAVAILABLE, no record data)");
  {
    const linked = (over: Partial<Record<string, unknown>> = {}) => recordsTool(() => [rec(SECRET_ID, {}, { linkedUserIds: ["cust-1", "cust-2"] }), rec("r2", {}, { linkedUserIds: ["cust-1"] })], {
      customerLinkable: true, audit: { action: "PLATFORM_INCIDENT_TRANSITION", detail: { surface: "platform-ai", recordKind: "probe" } }, ...over,
    });
    const noWriter = boundary({ registry: [linked()] });
    const r1 = await call(noWriter.b, "probe_list", {});
    check("a customer-linkable tool with NO audit writer ⇒ UNAVAILABLE, no records", JSON.stringify(r1) === `{"status":"UNAVAILABLE","records":[],"truncated":false}`, r1);
    const failing = boundary({ registry: [linked()], audit: async () => { throw new Error("audit write failed"); } });
    const r2 = await call(failing.b, "probe_list", {});
    check("an audit write failure ⇒ UNAVAILABLE, no record data, no handle minted", JSON.stringify(r2) === `{"status":"UNAVAILABLE","records":[],"truncated":false}` && failing.b.trace().at(-1)?.outcome === "UNAVAILABLE_AUDIT");
    const order: string[] = [];
    let written: readonly BoundaryAuditRow[] = [];
    let actorAreas: PlatformArea[] = [];
    const ok = boundary({ registry: [linked()], audit: async (rows, fresh) => { order.push("audit"); written = rows; actorAreas = [...fresh.keys()]; } });
    const r3 = await call(ok.b, "probe_list", {}) as { records: unknown[] };
    order.push("returned");
    check("audit rows written BEFORE the result is returned: one per linked customer per area (deduped), codes only, actor = this call's fresh guard",
      order.join() === "audit,returned" && written.length === 2 && written.every((w) => w.detail.surface === "platform-ai" && w.detail.tool === "probe_list" && w.area === "PLATFORM_OPS")
      && !JSON.stringify(written).includes(SECRET_ID) && actorAreas.join() === "PLATFORM_OPS" && r3.records.length === 2, written);

    const bad: [string, () => unknown[], Partial<Record<string, unknown>>?][] = [
      ["a free-text string in a code field", () => [rec("x", { state: "Customer said: call me at 555-0100" })]],
      ["an unknown field", () => [rec("x", { note: "free text" })]],
      ["a negative / fractional count", () => [rec("x", { attempts: 1.5 })]],
      ["a non-ISO time", () => [rec("x", { openedAt: "yesterday" })]],
      ["a missing non-nullable field", () => [{ ...rec("x"), fields: { state: "OPEN", attempts: 1 } }]],
      ["a ref of another kind", () => [rec("x", {}, { kind: "OTHER" })]],
      ["a ref in an area the call may not read", () => [rec("x", {}, { area: "SECURITY_OPS" })]],
      ["linked customers on a tool declared NOT customer-linkable", () => [rec("x", {}, { linkedUserIds: ["cust-1"] })]],
      ["a schema that declares a T2 field (email)", () => [rec("x")], { recordSchema: { kind: "PROBE", fields: { email: { type: "code", values: ["x"] } } } }],
      ["no record schema", () => [rec("x")], { recordSchema: undefined }],
    ];
    for (const [why, records, over] of bad) {
      const t = boundary({ registry: [recordsTool(records, over ?? {})] });
      const out = await call(t.b, "probe_list", {});
      check(`envelope: ${why} ⇒ UNAVAILABLE, no record data`, JSON.stringify(out) === `{"status":"UNAVAILABLE","records":[],"truncated":false}` && !JSON.stringify(out).includes("555-0100"), out);
    }
    const reader = boundary({ registry: [recordsTool(() => { throw new Error(`reader failed for ${SECRET_ID}`); })] });
    const ro = await call(reader.b, "probe_list", {});
    check("a reader that throws ⇒ UNAVAILABLE (its message never surfaces)", JSON.stringify(ro) === `{"status":"UNAVAILABLE","records":[],"truncated":false}`);
    const many = boundary({ registry: [recordsTool(() => Array.from({ length: 14 }, (_, i) => rec(`r${i}`)))] });
    const m = await call(many.b, "probe_list", {}) as { records: unknown[]; truncated: boolean };
    check("lists are bounded: ≤ 10 records + truncated", m.records.length === 10 && m.truncated === true);
  }

  console.log("\n6. the existing six tools through the boundary — behaviour unchanged");
  {
    const e1 = ev(), e2 = ev();
    const { b } = boundary();
    const via = await call(b, "get_metric", { id: "incident-broken-now@1", window: 7 }, e1);
    const direct = await executePlatformAiTool("get_metric", JSON.stringify({ id: "incident-broken-now@1", window: 7 }), binding("FULL"), e2, [], []);
    check("get_metric: same result and same trace as the executor directly", JSON.stringify(via) === JSON.stringify(direct) && JSON.stringify(e1.trace) === JSON.stringify(e2.trace), { via, trace: e1.trace });
    const e3 = ev(), e4 = ev();
    await call(b, "open_page", { id: "x", params: { rid: "c1" } }, e3);
    await executePlatformAiTool("open_page", JSON.stringify({ id: "x", params: { rid: "c1" } }), binding("FULL"), e4, [], []);
    check("open_page with a param key that is not offered: the same INVALID_ARGS trace", JSON.stringify(e3.trace) === JSON.stringify(e4.trace), e3.trace);
  }

  console.log("\n6b. P4b — toolAreas(): the areas each pack ran over (the call's surviving, freshly rechecked areas)");
  {
    runs = [];
    const two = [{ scope: scopeOf("PLATFORM_OPS"), binding: binding("Ops") }, { scope: scopeOf("CUSTOMER_SUCCESS"), binding: binding("CS") }];
    const { b } = boundary({ registry: [aggTool(), recordsTool(() => [rec("r1")], { requires: { areas: ["SECURITY_OPS"], level: "READ", tier: "OPS" } })], areas: two, held: new Set<PlatformArea>(["PLATFORM_OPS"]) });
    check("nothing ran ⇒ no pack areas", b.toolAreas().size === 0);
    await call(b, "probe_list", {});
    check("a refused call records nothing", b.toolAreas().size === 0);
    await call(b, "probe_agg", { n: 1 });
    check("an AGGREGATE call over Ops + CS where only Ops passes its recheck ⇒ metrics: [PLATFORM_OPS] (the refused area is not recorded)",
      JSON.stringify([...b.toolAreas()]) === JSON.stringify([["metrics", ["PLATFORM_OPS"]]]), [...b.toolAreas()]);
  }

  console.log("\n7. static — one boundary, wired by both production callers, no module state");
  {
    const bsrc = code(src("lib/platform/intelligence/ai/authz/boundary.ts"));
    const route = code(src("app/api/platform/ai/ask/route.ts"));
    const runner = code(src("app/api/platform/ai/conversations/turn-runner.ts"));
    check("boundary.ts is server-only", /^import "server-only";/m.test(src("lib/platform/intelligence/ai/authz/boundary.ts")));
    check("boundary.ts keeps no module-level mutable state (everything lives in the createTurnBoundary closure)",
      !/^(?:let|var) /m.test(bsrc) && !/^const \w+ = new (?:Map|Set|WeakMap)/m.test(bsrc));
    check("boundary.ts never reads a guard, env or db itself (the recheck and flags are injected)",
      !/require(?:Fresh)?PlatformAccess\(|@\/lib\/env|@\/lib\/db|systemDb|incidentAudienceFor\(|metricAccessFor\(/.test(bsrc));
    for (const [name, s] of [["the ask route", route], ["the conversations turn runner", runner]] as const) {
      check(`${name}: creates the turn boundary with the injected fresh recheck, the router's packs and the pack flags, and hands its invoke to the turn`,
        /createTurnBoundary\(/.test(s) && /recheck: platformAiFreshRecheck/.test(s) && /routePlatformAiPacks\(/.test(s) && /platformAiPackEnabled\(p\)/.test(s) && /invoke: boundary\.invoke/.test(s)
          && /makePlatformAiGenerate\(\{[^}]*turnId: correlationId[^}]*\}\)/.test(s) && /const correlationId = randomUUID\(\);/.test(s));
    }
    check("the denial log line carries codes only (tool, pack, reason)", [route, runner].every((s) => /tool refused: tool=\$\{r\.tool\} pack=\$\{r\.pack\} reason=\$\{r\.reason\}/.test(s)));
    check("core.ts never imports the boundary (the loop receives it injected)", !/from "[^"]*authz\/boundary"/.test(src("lib/platform/intelligence/ai/core.ts")));
  }

  console.log("\n8. the handle table is never serialised");
  {
    const { b } = boundary({ registry: [recordsTool(() => [rec(SECRET_ID)])] });
    await call(b, "probe_list", {});
    const dumped = `${JSON.stringify(b)} ${inspect(b, { depth: 5, showHidden: true })}`;
    check("JSON / util.inspect of the boundary carry no record id", !dumped.includes(SECRET_ID));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
