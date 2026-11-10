/**
 * lib/platform/intelligence/ai/authz/boundary.ts  (Platform AI P2 — `invokeTool`, THE single enforcement point)
 *
 * Every Platform AI tool call of a turn goes through ONE boundary created per turn
 * (createTurnBoundary) by the caller that holds the guard: the ask route and the
 * conversations' turn runner. core.ts's loop receives `boundary.invoke` (it never imports
 * this file). The steps, in the design's order (design v2 §6):
 *
 *    1  the tool is registered, its pack is ROUTED this turn (engine/router.ts) and the
 *       pack's server flag is ON (re-checked here on every call, I-8);
 *    2  strict argument parse against the contract's ClosedSchema (tools/contract.ts
 *       parseClosedArgs) — guardedText only for the S2-approved find_page.query and
 *       propose_memory.note (GUARDED_TEXT_ALLOWLIST);
 *    3  the call's areas are in this turn's live scope (I-7): a RECORD tool needs EVERY
 *       requires.area in scope; an AGGREGATE tool runs over requires.areas ∩ scope (each
 *       area's binding scopes what it can see — the existing six tools list every area);
 *    4  the PER-CALL RECHECK of each of those areas (authz/recheck.ts; injected
 *       requireFreshPlatformAccess, non-probe; no memo). A refused area leaves the scope
 *       for the rest of the turn; an AGGREGATE call continues on the areas that pass,
 *       through a binding recomposed from their own parts only;
 *    5  handle arguments resolve from THIS turn's table only (authz/handles.ts: kind,
 *       area, tier, operator, correlation id must all match);
 *    6  tier: a CUSTOMER_SUCCESS-tier tool needs a FRESH CS incident audience (step 4's guard);
 *    7  record-level `revalidate` of each resolved record, when the tool defines it;
 *    8  audit (customer-linkable RECORD tools, §6.5): linkage is runtime (the reader returns
 *       linkedUserIds per record), so the rows are written after the reader returns — for
 *       exactly the records that passed 10–11 — and BEFORE any byte of its result leaves
 *       this function (execution order for a RECORD tool: 9 → 10 → 11 → 8 → 12 → 13);
 *       no writer / a write failure ⇒ UNAVAILABLE with NO record data (over-recording on
 *       partial failure accepted, under-recording impossible);
 *    9  run;
 *   10  envelope validator (evidence/record-envelope.ts): the run shape, every record's
 *       closed fields against the tool's RecordSchema, every ref's kind / area / linkage —
 *       any problem ⇒ UNAVAILABLE, no record data;
 *   11  tier filter: a CS-tier record reaches only a fresh-CS call; T2 field NAMES stay
 *       (t2Fields), no T2 value exists in a record (a field with a T2 name is dropped too);
 *   12  a handle is minted for every returned record (the model never sees a record id);
 *   13  evidence + trace: codes and counts only (tool, pack, outcome, record counts).
 *
 * ANY refusal before `run` (steps 1–7) returns the ONE NOT_FOUND the model already knows
 * (core.ts `{ found: false }`) — the same object whatever the reason, so the model cannot
 * tell "no such tool" from "revoked" — plus a metadata-only trace step (the executor's
 * own codes: INVALID_ARGS for a step-2 refusal, else NOT_FOUND; tool = its name only when
 * the executor would have known it, else "unknown") and ONE denial log row per identical
 * (tool, pack, reason) per turn (S2 ruling 2: codes only, never arguments or handles).
 *
 * AGGREGATE tools (the six existing ones) run the executor unchanged (tools/registry.ts
 * `run`); their result is returned as before. Steps 10–12 apply to RECORD tools; no
 * RECORD tool is registered in P2 (the boundary tests use a synthetic one).
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import type { AuditActionType } from "@/lib/audit-actions";
import {
  NOT_FOUND, composePlatformAiBindings,
  type PlatformAiBinding, type PlatformAiToolInvoker, type PlatformAiTraceStep,
} from "../core";
import {
  RECORD_LIST_MAX, T2_FIELD_NAMES, validateRecordFields, validateRecordRunShape, validateRecordSchema,
  type ModelRecord, type RawRecord, type RecordFields, type RecordRunResult,
} from "../evidence/record-envelope";
import { GUARDED_TEXT_ALLOWLIST, TOOL_TIERS, parseClosedArgs, type ToolPack } from "../tools/contract";
import { PLATFORM_AI_TOOL_REGISTRY, type LegacyToolContext, type PlatformAiTool } from "../tools/registry";
import { createHandleTable } from "./handles";
import {
  createDenialLog, createTurnScope,
  type BoundaryDenialReason, type DenialRow, type FreshGuard, type PlatformAiRecheck,
} from "./recheck";
import { isScopedArea, type ScopedArea } from "./scope";

export type { ScopedArea };

/** One audit row a customer-linkable RECORD call writes (codes + the linked customer; never a value). */
export interface BoundaryAuditRow {
  readonly action: AuditActionType;
  readonly area: PlatformArea;
  readonly targetUserId: string;
  readonly detail: { readonly surface: "platform-ai"; readonly tool: string; readonly recordKind: string };
}

/** The fail-closed audit writer (authz/audit.ts, P5). `fresh` = this call's fresh guard per area (the actor). */
export type BoundaryAuditWriter = (rows: readonly BoundaryAuditRow[], fresh: ReadonlyMap<PlatformArea, FreshGuard>) => Promise<void>;

export type BoundaryOutcome = BoundaryDenialReason | "OK" | "UNAVAILABLE_AUDIT" | "UNAVAILABLE_ENVELOPE" | "UNAVAILABLE_READER";

/** Step 13 — metadata only. `tool` is a registered name or "unknown"; never an argument, id or handle. */
export interface BoundaryTraceStep {
  readonly tool: string;
  readonly pack: string;
  readonly outcome: BoundaryOutcome;
  /** RECORD calls: records returned / dropped by the tier filter. */
  readonly records?: number;
  readonly dropped?: number;
}

export interface TurnBoundaryOptions {
  readonly operatorId: string;
  /** THIS turn's correlation id (the ledger's turn id) — handles are bound to it. */
  readonly correlationId: string;
  /** Each in-scope area with its own binding — route-issued ScopedAreas only (others are dropped). */
  readonly areas: readonly { readonly scope: ScopedArea; readonly binding: PlatformAiBinding }[];
  /** The turn's binding over ALL of `areas` (what core.ts was given) — used while no area has been removed. */
  readonly binding: PlatformAiBinding;
  readonly recheck: PlatformAiRecheck;
  /** The router's packs for this turn (engine/router.ts routePlatformAiPacks). */
  readonly packs: readonly ToolPack[];
  /** The pack's server flag, re-read on every call (engine/router.ts platformAiPackEnabled). */
  packEnabled(pack: ToolPack): boolean;
  /** P5 (authz/audit.ts). Absent ⇒ every customer-linkable tool is UNAVAILABLE (fail closed). */
  readonly audit?: BoundaryAuditWriter;
  /** One row per identical denial per turn (codes only). */
  onDenial?(row: DenialRow): void;
  /** Tests only: a registry other than the real one. */
  readonly registry?: readonly PlatformAiTool[];
}

export interface TurnBoundary {
  /** THE dispatcher handed to core.ts (runPlatformAiTurn / handlePlatformAiAsk `invoke`). */
  readonly invoke: PlatformAiToolInvoker;
  /** Step-13 trace of this turn (codes and counts). */
  trace(): readonly BoundaryTraceStep[];
  /** The areas still in scope. */
  scopeAreas(): PlatformArea[];
}

const UNAVAILABLE_RESULT = Object.freeze({ status: "UNAVAILABLE" as const, records: Object.freeze([]) as readonly ModelRecord[], truncated: false });

export function createTurnBoundary(opts: TurnBoundaryOptions): TurnBoundary {
  const registry = opts.registry ?? PLATFORM_AI_TOOL_REGISTRY;
  const parts = opts.areas.filter((p) => isScopedArea(p.scope) && p.scope.operatorId === opts.operatorId);
  const scope = createTurnScope({ operatorId: opts.operatorId, scopes: parts.map((p) => p.scope), recheck: opts.recheck });
  // Per turn, in this closure only: never module state, never serialised (handles.ts).
  const handles = createHandleTable({ operatorId: opts.operatorId, correlationId: opts.correlationId });
  const denials = createDenialLog(opts.onDenial);
  const trace: BoundaryTraceStep[] = [];

  /** The binding over exactly these areas: the turn's own while nothing was removed, else recomposed from the surviving parts. */
  const bindingFor = (areas: readonly PlatformArea[]): PlatformAiBinding | null => {
    const live = parts.filter((p) => areas.includes(p.scope.area));
    if (live.length === 0) return null;
    if (live.length === parts.length) return opts.binding;
    return composePlatformAiBindings(live.map((p) => ({ area: p.scope.area, binding: p.binding })));
  };

  const invoke: PlatformAiToolInvoker = async (name, rawArgs, c) => {
    const tool = registry.find((t) => t.name === name) ?? null;
    const routed = !!tool && opts.packs.includes(tool.pack) && (tool.pack !== "memory" || !!c.memory);
    const toolCode = tool ? tool.name : "unknown";
    const packCode = tool ? tool.pack : "none";

    const refuse = (reason: BoundaryDenialReason): unknown => {
      denials.emit({ tool: toolCode, pack: packCode, reason });
      // The executor's own trace codes: the tool's name only when the executor would have known it.
      c.ev.trace.push({ tool: (routed ? tool!.name : "unknown") as PlatformAiTraceStep["tool"], outcome: reason === "ARGS_INVALID" ? "INVALID_ARGS" : "NOT_FOUND", refs: [] });
      trace.push({ tool: toolCode, pack: packCode, outcome: reason });
      return NOT_FOUND;
    };

    // 1. registered, routed, flag ON.
    if (!tool) return refuse("UNKNOWN_TOOL");
    if (!routed) return refuse("PACK_NOT_ROUTED");
    let packOn = false;
    try { packOn = opts.packEnabled(tool.pack) === true; } catch { packOn = false; }
    if (!packOn) return refuse("PACK_DISABLED");

    // 2. strict parse (guardedText only where S2 approved it).
    const args = parseClosedArgs(tool.args, rawArgs, { paramKeys: c.paramKeys });
    if (!args) return refuse("ARGS_INVALID");
    for (const [k, spec] of Object.entries(tool.args.properties)) {
      if (spec.kind === "guardedText" && !GUARDED_TEXT_ALLOWLIST.includes(`${tool.name}.${k}`)) return refuse("ARGS_INVALID");
    }

    // 3. the call's areas, in this turn's live scope (I-7).
    const required = [...tool.requires.areas];
    const inScopeNow = required.filter((a) => scope.has(a));
    if (tool.scope === "RECORD" ? inScopeNow.length !== required.length : inScopeNow.length === 0) return refuse("AREA_NOT_IN_SCOPE");

    // 4. the per-call recheck — authoritative reads for every area of this call, every call.
    const fresh = new Map<PlatformArea, FreshGuard>();
    for (const a of inScopeNow) {
      const g = await scope.recheck(a);
      if (g) fresh.set(a, g);
    }
    const surviving = inScopeNow.filter((a) => fresh.has(a));
    if (surviving.length === 0 || (tool.scope === "RECORD" && surviving.length !== required.length)) return refuse("RECHECK_REFUSED");
    const csFresh = [...fresh.values()].some((g) => g.csTier);
    if (!TOOL_TIERS.includes(tool.requires.tier)) return refuse("TIER_REFUSED");

    // 5. handles: this turn's table only, every bound field matching.
    const runArgs: Record<string, unknown> = { ...args };
    const resolved: string[] = [];
    for (const [k, spec] of Object.entries(tool.args.properties)) {
      if (spec.kind !== "handle" || args[k] === undefined) continue;
      const id = spec.recordKind
        ? handles.resolve(String(args[k]), { kind: spec.recordKind, areas: surviving, tier: tool.requires.tier, operatorId: opts.operatorId, correlationId: opts.correlationId })
        : null;
      if (id === null) return refuse("HANDLE_UNRESOLVED");
      runArgs[k] = id;
      resolved.push(id);
    }

    // 6. tier: a CS-tier tool needs a FRESH CS audience.
    if (tool.requires.tier === "CUSTOMER_SUCCESS" && !csFresh) return refuse("TIER_REFUSED");

    const binding = bindingFor(surviving);
    if (!binding) return refuse("RECHECK_REFUSED");
    const ctx: LegacyToolContext = { binding, ev: c.ev, paramKeys: c.paramKeys, asked: c.asked, ...(c.memory ? { memory: c.memory } : {}) };

    // 7. record-level revalidation.
    if (tool.revalidate) {
      for (const id of resolved) {
        let visible = false;
        try { visible = (await tool.revalidate(id, ctx)) === true; } catch { visible = false; }
        if (!visible) return refuse("REVALIDATE_REFUSED");
      }
    }

    // 9. run — an AGGREGATE tool is the executor, unchanged (its own trace step, its own result).
    if (tool.scope === "AGGREGATE") {
      const out = await tool.run(runArgs, ctx);
      trace.push({ tool: tool.name, pack: tool.pack, outcome: "OK" });
      return out;
    }
    return runRecordTool(tool, runArgs, ctx, surviving, csFresh, fresh);
  };

  /** Steps 8–13 for a RECORD tool. Nothing of the reader's output leaves unless every step passed. */
  async function runRecordTool(tool: PlatformAiTool, runArgs: Record<string, unknown>, ctx: LegacyToolContext,
    areas: readonly PlatformArea[], csFresh: boolean, fresh: ReadonlyMap<PlatformArea, FreshGuard>): Promise<unknown> {
    const unavailable = (outcome: "UNAVAILABLE_AUDIT" | "UNAVAILABLE_ENVELOPE" | "UNAVAILABLE_READER") => {
      ctx.ev.trace.push({ tool: tool.name as PlatformAiTraceStep["tool"], outcome: "UNAVAILABLE", refs: [] });
      trace.push({ tool: tool.name, pack: tool.pack, outcome });
      return UNAVAILABLE_RESULT;
    };
    const schema = tool.recordSchema;
    if (!schema || validateRecordSchema(schema).length > 0) return unavailable("UNAVAILABLE_ENVELOPE");

    let raw: unknown;
    try { raw = await tool.run(runArgs, ctx); } catch { return unavailable("UNAVAILABLE_READER"); }

    // 10. the envelope validator — the whole call fails closed on any problem.
    if (validateRecordRunShape(raw).length > 0) return unavailable("UNAVAILABLE_ENVELOPE");
    const run = raw as RecordRunResult;
    for (const r of run.records as readonly RawRecord[]) {
      const ref = r?.ref;
      const refOk = !!ref && ref.kind === schema.kind && typeof ref.recordId === "string" && ref.recordId.length > 0
        && areas.includes(ref.area) && (TOOL_TIERS as readonly string[]).includes(ref.tier)
        && Array.isArray(ref.linkedUserIds) && ref.linkedUserIds.every((u) => typeof u === "string" && u.length > 0)
        && (tool.customerLinkable || ref.linkedUserIds.length === 0);
      if (!refOk || validateRecordFields(schema, r.fields, handles.owns).length > 0) return unavailable("UNAVAILABLE_ENVELOPE");
    }

    // 11. tier filter: CS-tier records only to a fresh-CS call.
    const visible = run.records.filter((r) => r.ref.tier === "OPS" || csFresh);
    const dropped = run.records.length - visible.length;
    const kept = visible.slice(0, RECORD_LIST_MAX);
    const truncated = run.truncated || visible.length > kept.length;

    // 8. audit BEFORE anything leaves: one row per linked customer per area (fail closed).
    if (tool.customerLinkable) {
      if (!opts.audit || !tool.audit) return unavailable("UNAVAILABLE_AUDIT");
      const seen = new Set<string>();
      const rows: BoundaryAuditRow[] = [];
      for (const r of kept) for (const u of r.ref.linkedUserIds) {
        const k = `${r.ref.area}|${u}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({ action: tool.audit.action, area: r.ref.area, targetUserId: u, detail: { surface: "platform-ai", tool: tool.name, recordKind: tool.audit.detail.recordKind } });
      }
      if (rows.length > 0) {
        try { await opts.audit(rows, fresh); } catch { return unavailable("UNAVAILABLE_AUDIT"); }
      }
    }

    // 12. handles minted; the record id stays here.
    const records: ModelRecord[] = kept.map((r) => ({
      handle: handles.mint({ kind: r.ref.kind, area: r.ref.area, tier: r.ref.tier, recordId: r.ref.recordId }),
      kind: schema.kind,
      fields: withoutT2(r.fields),
      ...(schema.t2Fields?.length ? { t2Fields: [...schema.t2Fields] } : {}),
    }));

    // 13. evidence + trace: codes and counts.
    ctx.ev.trace.push({ tool: tool.name as PlatformAiTraceStep["tool"], outcome: "OK", refs: [], count: records.length });
    trace.push({ tool: tool.name, pack: tool.pack, outcome: "OK", records: records.length, dropped });
    return { status: run.status, asOf: run.asOf, records, truncated };
  }

  return {
    invoke,
    trace: () => [...trace],
    scopeAreas: () => scope.areas(),
  };
}

/** Step 11 (defence in depth): no field named like a T2 identity ever leaves (the schema validator already refuses one). */
function withoutT2(fields: RecordFields): RecordFields {
  const out: Record<string, RecordFields[string]> = {};
  for (const [k, v] of Object.entries(fields)) if (!(T2_FIELD_NAMES as readonly string[]).includes(k)) out[k] = v;
  return out;
}
