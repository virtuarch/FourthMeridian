/**
 * lib/platform/intelligence/ai/eval/cases/p2-boundary.ts  (E0-CI — P2: mid-turn revocation, handle binding, flag-OFF packs)
 *
 * REVOCATION_MID_TURN — through the REAL ask route: the scripted provider applies the
 *   revocation when it serves round 2, i.e. AFTER tool call N ran and BEFORE call N+1:
 *   grant revoked (an Ops and a CS operator), session revoked, 2FA disabled (enforced).
 *   Call N answered; N+1 and every later call NOT_FOUND (no post-revocation data); the turn
 *   still answers; the NEXT turn is refused before any provider request. Plus a CS tier
 *   dropped mid-turn for a CS-tier tool (unit: no registered tool is CS-tier yet).
 * HANDLE_BINDING — unit, through createTurnBoundary with a SYNTHETIC RECORD tool (test-only,
 *   never registered): a handle resolves only in its own turn for its own operator.
 * DISABLED_PACK_TOOL — the memory pack on the ask route (route), the metrics pack with its
 *   flag OFF (unit, real registry + a real Ops binding: nothing read), and every future
 *   pack getter OFF with its flag unset.
 */

import { env } from "@/lib/env";
import { createTurnBoundary } from "../../authz/boundary";
import type { FreshGuard } from "../../authz/recheck";
import type { PlatformAiBinding, ToolEvidence } from "../../core";
import type { RecordSchema } from "../../evidence/record-envelope";
import type { PlatformAiTool } from "../../tools/registry";
import type { E0Revocation } from "../scripted-model";
import { isNotFound, type RouteCase, type UnitCase, type UnitContext } from "./types";

// ── REVOCATION_MID_TURN (route) ──────────────────────────────────────────────

const midTurn = (id: string, operator: RouteCase["operator"], revoke: E0Revocation, after: { name: string; args: unknown }[]): RouteCase => ({
  kind: "route", id, pack: "boundary", gates: ["REVOCATION_MID_TURN"], operator,
  turns: [
    { question: "Which metrics can I read, and what do they say?", steps: [
      { calls: [{ name: "list_metrics", args: {} }] },
      { calls: after, revoke },
      { content: "That is all I could read." },
    ] },
    { question: "And now?", steps: [{ calls: [{ name: "list_metrics", args: {} }] }, { content: "x" }] },
  ],
  check: ([t1, t2]) => [
    ...(t1.status === 200 ? [] : [`turn 1 status ${t1.status}`]),
    ...(t1.toolResults.length === 1 + after.length ? [] : [`turn 1: ${t1.toolResults.length} tool results`]),
    ...(t1.toolResults.length > 0 && !isNotFound(t1.toolResults[0]) ? [] : ["call N (before the revocation) was not answered — the case is vacuous"]),
    ...(t1.toolResults.slice(1).every(isNotFound) ? [] : ["a call AFTER the revocation returned data"]),
    ...(t2.status === 401 || t2.status === 403 ? [] : [`the next turn was not refused (status ${t2.status})`]),
    ...(t2.requests.length === 0 ? [] : ["the next turn reached the provider"]),
  ],
});

const AFTER_OPS = [{ name: "get_metric", args: { id: "incident-broken-now@1" } }, { name: "list_metrics", args: {} }, { name: "find_page", args: { query: "incidents" } }];
const AFTER_CS = [{ name: "get_metric", args: { id: "cs-needs-help@1" } }, { name: "list_metrics", args: {} }];

// ── synthetic test-only tools (never registered) ─────────────────────────────

const AS_OF = "2026-11-09T12:00:00.000Z";
const SCHEMA: RecordSchema = { kind: "E0_PROBE", fields: { state: { type: "code", values: ["OPEN", "RESOLVED"] }, openedAt: { type: "isoTime" } } };
const base = { pack: "metrics", description: "E0 synthetic probe (test-only)", requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" }, pii: 1, cost: { toolCalls: 1 }, recordSchema: SCHEMA } as const;
const RECORD_ID = "ce0proberecord00000000001";

function syntheticRegistry(ran: string[]): PlatformAiTool[] {
  return [
    { ...base, name: "e0_probe_list", args: { properties: {} }, scope: "RECORD", customerLinkable: false,
      run: async () => ({ status: "CONFIRMED", asOf: AS_OF, records: [{ ref: { kind: "E0_PROBE", recordId: RECORD_ID, area: "PLATFORM_OPS", tier: "OPS", linkedUserIds: [] }, fields: { state: "OPEN", openedAt: AS_OF } }], truncated: false }) },
    { ...base, name: "e0_probe_detail", args: { properties: { h: { kind: "handle", recordKind: "E0_PROBE" } } }, scope: "RECORD", customerLinkable: false,
      run: async (a) => { ran.push(String(a.h)); return { status: "CONFIRMED", asOf: AS_OF, records: [], truncated: false }; } },
  ] as PlatformAiTool[];
}

const ev = (): ToolEvidence => ({ envelopes: [], hrefs: new Set(), definitions: [], labels: new Set(), trace: [], pages: new Map() });
const call = (b: { invoke: ReturnType<typeof createTurnBoundary>["invoke"] }, name: string, args: unknown) => b.invoke(name, JSON.stringify(args), { ev: ev(), paramKeys: [], asked: [] });

function turnFor(ctx: UnitContext, op: "ops" | "ops2", correlationId: string, registry: PlatformAiTool[]) {
  const part = ctx.scoped(op, "PLATFORM_OPS");
  if (!part) throw new Error("fixture operator not in scope");
  return createTurnBoundary({
    operatorId: ctx.operatorId(op), correlationId, areas: [part], binding: part.binding, recheck: ctx.recheck(op),
    packs: ["metrics", "navigation"], packEnabled: () => true, registry,
  });
}

// ── the cases ────────────────────────────────────────────────────────────────

export const P2_BOUNDARY_CASES: readonly (RouteCase | UnitCase)[] = [
  {
    kind: "unit", id: "p2.handle-binding", pack: "boundary", gates: ["HANDLE_BINDING"],
    async run(ctx) {
      const ran: string[] = [];
      const reg = syntheticRegistry(ran);
      const a = turnFor(ctx, "ops", "e0-turn-a", reg);
      const listed = await call(a, "e0_probe_list", {}) as { records?: { handle: string }[] };
      const h = listed.records?.[0]?.handle ?? "";
      const problems: string[] = [];
      if (!/^h_[A-Za-z0-9_-]{16}$/.test(h) || JSON.stringify(listed).includes(RECORD_ID)) problems.push("no handle minted, or the record id reached the model");
      await call(a, "e0_probe_detail", { h });
      if (ran.join() !== RECORD_ID) problems.push("the same turn did not resolve its own handle (vacuous)");
      const nextTurn = turnFor(ctx, "ops", "e0-turn-b", reg);
      const otherOp = turnFor(ctx, "ops2", "e0-turn-a", reg);
      for (const [why, b, args] of [
        ["another turn (correlation id)", nextTurn, { h }], ["another operator", otherOp, { h }],
        ["a guessed handle", a, { h: "h_E0E0E0E0E0E0E0E0" }], ["the record id itself", a, { h: RECORD_ID }],
      ] as const) if (!isNotFound(await call(b, "e0_probe_detail", args))) problems.push(`${why}: resolved`);
      if (ran.length !== 1) problems.push("a refused handle call ran the tool");
      return problems;
    },
  },
  {
    kind: "unit", id: "p2.disabled-pack-reads-nothing", pack: "boundary", gates: ["DISABLED_PACK_TOOL"],
    async run(ctx) {
      const part = ctx.scoped("ops", "PLATFORM_OPS");
      if (!part) return ["fixture operator not in scope"];
      let reads = 0, rechecks = 0;
      const counted: PlatformAiBinding = { ...part.binding, listMetrics: (f) => { reads++; return part.binding.listMetrics(f); }, readMetric: async (i, p) => { reads++; return part.binding.readMetric(i, p); } };
      const base0 = ctx.recheck("ops");
      const b = createTurnBoundary({
        operatorId: ctx.operatorId("ops"), correlationId: "e0-flag-off", areas: [{ scope: part.scope, binding: counted }], binding: counted,
        recheck: async (a) => { rechecks++; return base0(a); }, packs: ["metrics", "navigation"], packEnabled: (p) => p !== "metrics",
      });
      const outs = [await call(b, "get_metric", { id: "incident-broken-now@1" }), await call(b, "list_metrics", {})];
      const problems: string[] = [];
      if (!outs.every(isNotFound)) problems.push("a flag-OFF pack's tool answered");
      if (reads !== 0 || rechecks !== 0) problems.push("a flag-OFF pack's tool read something");
      const page = await call(b, "find_page", { query: "incidents" }) as { pages?: unknown[] };
      if (!Array.isArray(page.pages)) problems.push("the flag-ON navigation pack stopped working (vacuous)");
      const future = ["Customers", "Onboarding", "Connections", "Incidents", "Jobs", "Providers", "AiUsage", "AuditHistory", "Policies", "Growth", "Merchants"]
        .filter((p) => (env as unknown as Record<string, boolean>)[`isPlatformAiPack${p}Enabled`] !== false);
      if (future.length) problems.push(`future pack getters not OFF with their flags unset: ${future.join(",")}`);
      return problems;
    },
  },
  {
    kind: "route", id: "p2.memory-pack-off-on-ask-route", pack: "boundary", gates: ["DISABLED_PACK_TOOL"], operator: "ops",
    turns: [{ question: "Remember that incidents are broken.", steps: [
      { calls: [{ name: "recall_memory", args: {} }, { name: "propose_memory", args: { factType: "WATCHING_ISSUE", subjectRef: "incident-broken-now@1" } }, { name: "list_metrics", args: {} }] },
      { content: "Done." },
    ] }],
    check: ([o]) => [
      ...(o.status === 200 ? [] : [`status ${o.status}`]),
      ...(o.toolResults.length === 3 && isNotFound(o.toolResults[0]) && isNotFound(o.toolResults[1]) ? [] : ["a memory tool answered on the ask route (memory pack not routed / OFF)"]),
      ...(o.toolResults.length === 3 && !isNotFound(o.toolResults[2]) ? [] : ["the metrics pack stopped working (vacuous)"]),
    ],
  },
  {
    kind: "unit", id: "p2.cs-tier-dropped-mid-turn", pack: "boundary", gates: ["REVOCATION_MID_TURN"],
    async run(ctx) {
      const part = ctx.scoped("cs", "CUSTOMER_SUCCESS");
      if (!part) return ["fixture operator not in scope"];
      let tierDropped = false, ran = 0;
      const base0 = ctx.recheck("cs");
      const csTool = { ...base, name: "e0_probe_cs", args: { properties: {} }, scope: "AGGREGATE", customerLinkable: false, recordSchema: undefined,
        requires: { areas: ["CUSTOMER_SUCCESS"], level: "READ", tier: "CUSTOMER_SUCCESS" }, run: async () => { ran++; return { ok: true }; } } as unknown as PlatformAiTool;
      const b = createTurnBoundary({
        operatorId: ctx.operatorId("cs"), correlationId: "e0-cs-tier", areas: [part], binding: part.binding,
        recheck: async (a): Promise<FreshGuard | null> => { const g = await base0(a); return g && tierDropped ? { ...g, csTier: false } : g; },
        packs: ["metrics"], packEnabled: () => true, registry: [csTool],
      });
      const n = await call(b, "e0_probe_cs", {});
      tierDropped = true;
      const n1 = await call(b, "e0_probe_cs", {});
      return [
        ...(!isNotFound(n) && ran === 1 ? [] : ["call N (fresh CS tier) did not run — vacuous"]),
        ...(isNotFound(n1) && ran === 1 ? [] : ["call N+1 ran after the CS tier was dropped"]),
      ];
    },
  },
  midTurn("p2.revoke-grant-mid-turn.ops", "midGrant", "GRANT", AFTER_OPS),
  midTurn("p2.revoke-grant-mid-turn.cs", "midCs", "GRANT", AFTER_CS),
  midTurn("p2.revoke-session-mid-turn", "midSession", "SESSION", AFTER_OPS),
  midTurn("p2.disable-2fa-mid-turn", "midTotp", "TOTP", AFTER_OPS),
];
