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
 *
 * P3 — ROUTING (engine/router.ts, injected as `router`): the routed packs are per-turn state
 * here. They start as `packs` (the pre-question routing: core packs only); `tools.route(q)`
 * (called by core.ts once, with the SCRUBBED question, before any tool call) re-routes with
 * the keyword rules; `tools.schemas(paramKeys)` is what each model call is offered — routed
 * packs' tools callable in the LIVE scope, plus `more_tools` while a pack is expandable.
 * `more_tools` is dispatched HERE like any tool: 1 offered (some pack expandable, the
 * expansion bound not reached), 2 strict parse (pack ∈ the closed enum of expandable packs),
 * the pack flag re-read, 3 a tool of the pack callable in the live scope, 4 the per-call
 * recheck of those areas — then the pack joins the routed set. Any refusal is the same
 * NOT_FOUND. Without a router (tests), `packs` is fixed and `more_tools` is UNKNOWN_TOOL.
 *
 * P4 — RECORDS FOR COMPOSE AND REPLAY (design v2 §6.3, §8.2):
 *   · `recordRef(handle)` — THIS turn's handle → {rk, rid, a, fields}: the only thing a
 *     {{r:h|field}} placeholder resolves against (compose/record.ts). Fields = "ref" + the
 *     record schema's t2Fields (names only). Closure state, never serialised or logged.
 *   · `remint(refs)` — replay re-authz: a prior answer's record span gets a handle of THIS
 *     turn ONLY when its area is in the turn's live scope and passes the per-call recheck
 *     (the boundary's own recheck: a refusal removes the area, as for a tool call) AND its
 *     kind's source re-validates the record for that fresh guard (authz/record-render.ts
 *     RecordRenderSource.revalidate). Anything else ⇒ null (the replay shows the bare kind
 *     marker). History grants nothing.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import type { AuditActionType } from "@/lib/audit-actions";
import {
  NOT_FOUND, composePlatformAiBindings,
  type PlatformAiBinding, type PlatformAiToolInvoker, type PlatformAiTraceStep, type PlatformAiTurnTools,
} from "../core";
import {
  RECORD_LIST_MAX, T2_FIELD_NAMES, validateRecordFields, validateRecordRunShape, validateRecordSchema,
  type ModelRecord, type RawRecord, type RecordFields, type RecordRunResult,
} from "../evidence/record-envelope";
import { MORE_TOOLS_NAME, toolCallableIn, type PlatformAiTurnRouter } from "../engine/router";
import { GUARDED_TEXT_ALLOWLIST, TOOL_TIERS, parseClosedArgs, type ToolPack, type ToolTier } from "../tools/contract";
import { PLATFORM_AI_TOOL_REGISTRY, type LegacyToolContext, type PlatformAiTool } from "../tools/registry";
import { createHandleTable } from "./handles";
import { PLATFORM_AI_RECORD_SOURCES, type RecordRenderSource } from "./record-render";
import { RECORD_REF_FIELD, type TurnRecordRef } from "../compose/record";
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
  /** The router's packs for this turn (engine/router.ts routePlatformAiPacks) — with a `router`, the pre-question packs. */
  readonly packs: readonly ToolPack[];
  /** P3 — the turn router (engine/router.ts platformAiTurnRouter): question routing, schemas, more_tools. */
  readonly router?: PlatformAiTurnRouter;
  /** The pack's server flag, re-read on every call (engine/router.ts platformAiPackEnabled). */
  packEnabled(pack: ToolPack): boolean;
  /** P5 (authz/audit.ts). Absent ⇒ every customer-linkable tool is UNAVAILABLE (fail closed). */
  readonly audit?: BoundaryAuditWriter;
  /** One row per identical denial per turn (codes only). */
  onDenial?(row: DenialRow): void;
  /** Tests only: a registry other than the real one. */
  readonly registry?: readonly PlatformAiTool[];
  /** P4 — the RECORD kinds' read-time sources (replay re-authz). Absent ⇒ PLATFORM_AI_RECORD_SOURCES (empty in P4). */
  readonly recordSources?: Readonly<Record<string, RecordRenderSource>>;
}

export interface TurnBoundary {
  /** THE dispatcher handed to core.ts (runPlatformAiTurn / handlePlatformAiAsk `invoke`). */
  readonly invoke: PlatformAiToolInvoker;
  /** Step-13 trace of this turn (codes and counts). */
  trace(): readonly BoundaryTraceStep[];
  /** The areas still in scope. */
  scopeAreas(): PlatformArea[];
  /**
   * P4b — the areas each PACK ran over this turn (the call's surviving, freshly rechecked areas, recorded
   * when the tool ran): the conversations' provenance for pack tools (metric reads have envelope surfaces).
   */
  toolAreas(): ReadonlyMap<ToolPack, readonly PlatformArea[]>;
  /** P3 — the packs routed now (grows with more_tools). */
  routedPacks(): ToolPack[];
  /** P3 — handed to core.ts (`tools`) when a router is injected: question routing + the schemas each model call is offered. */
  readonly tools?: PlatformAiTurnTools;
  /** P4 — THIS turn's handle → record (compose's {{r:h|field}} lookup). null for any key this turn did not mint. */
  recordRef(handle: string): TurnRecordRef | null;
  /** P4 — replay re-authz: one handle of THIS turn (or null) per prior record ref, in order. */
  remint(refs: readonly { rk: string; rid: string; a: string }[]): Promise<(string | null)[]>;
  /**
   * P5 — subject resolution (authz/subject.ts): a FRESH decision for the subject's eligibility —
   * the CUSTOMER_SUCCESS area first (its CS tier), else any other area still in scope (the audit
   * actor; csTier false). Each is a per-call recheck (a refusal removes the area). null ⇒ none survives.
   */
  subjectEligibility(): Promise<{ csTier: boolean; area: PlatformArea } | null>;
  /**
   * P5 — a handle of THIS turn for a subject the server resolved (never for model input): the
   * kind's source must exist, the area be in scope and pass a FRESH recheck with the CS tier, and
   * the source must re-validate the record for that guard. Anything else ⇒ null.
   */
  adoptSubject(subject: { rk: string; rid: string; area: PlatformArea }): Promise<string | null>;
  /**
   * P8 — a handle of THIS turn for a record the server resolved (an exact incident id): the first of `areas`
   * in scope whose FRESH recheck passes and whose source re-validates it (OPS, or CS with the CS tier). null otherwise.
   */
  adoptRecord(subject: { rk: string; rid: string }, areas: readonly PlatformArea[]): Promise<string | null>;
}

/**
 * S2 09hu G1 — the metadata `refused` flag for a denial: every reason except UNKNOWN_TOOL (no such
 * tool ⇒ "not_found") and ARGS_INVALID (already the INVALID_ARGS outcome). Never the reason itself.
 */
const refusedFlag = (reason: BoundaryDenialReason): { refused?: true } =>
  (reason === "UNKNOWN_TOOL" || reason === "ARGS_INVALID" ? {} : { refused: true });

const UNAVAILABLE_RESULT = Object.freeze({ status: "UNAVAILABLE" as const, records: Object.freeze([]) as readonly ModelRecord[], truncated: false });

export function createTurnBoundary(opts: TurnBoundaryOptions): TurnBoundary {
  const registry = opts.registry ?? PLATFORM_AI_TOOL_REGISTRY;
  const parts = opts.areas.filter((p) => isScopedArea(p.scope) && p.scope.operatorId === opts.operatorId);
  const scope = createTurnScope({ operatorId: opts.operatorId, scopes: parts.map((p) => p.scope), recheck: opts.recheck });
  // Per turn, in this closure only: never module state, never serialised (handles.ts).
  const handles = createHandleTable({ operatorId: opts.operatorId, correlationId: opts.correlationId });
  // P4: handle → record, for compose and replay (this closure only; never serialised).
  const recordRefs = new Map<string, TurnRecordRef>();
  const recordSources = opts.recordSources ?? PLATFORM_AI_RECORD_SOURCES;
  const denials = createDenialLog(opts.onDenial);
  const trace: BoundaryTraceStep[] = [];
  // P3 — routing state, per turn (this closure only).
  const router = opts.router;
  let routed: ToolPack[] = [...opts.packs];
  let routedByQuestion = false, expansions = 0, calls = 0;
  // P4b — pack → the areas its tools ran over this turn (this closure only; codes, never ids).
  const ranOver = new Map<ToolPack, Set<PlatformArea>>();
  const noteRan = (pack: ToolPack, areas: readonly PlatformArea[]) => { const s = ranOver.get(pack) ?? new Set<PlatformArea>(); for (const a of areas) s.add(a); ranOver.set(pack, s); };

  /** The binding over exactly these areas: the turn's own while nothing was removed, else recomposed from the surviving parts. */
  const bindingFor = (areas: readonly PlatformArea[]): PlatformAiBinding | null => {
    const live = parts.filter((p) => areas.includes(p.scope.area));
    if (live.length === 0) return null;
    if (live.length === parts.length) return opts.binding;
    return composePlatformAiBindings(live.map((p) => ({ area: p.scope.area, binding: p.binding })));
  };

  const invoke: PlatformAiToolInvoker = async (name, rawArgs, c) => {
    calls++;
    if (router && name === MORE_TOOLS_NAME) return invokeMoreTools(rawArgs, c);
    const tool = registry.find((t) => t.name === name) ?? null;
    const isRouted = !!tool && routed.includes(tool.pack) && (tool.pack !== "memory" || !!c.memory);
    const toolCode = tool ? tool.name : "unknown";
    const packCode = tool ? tool.pack : "none";

    const refuse = (reason: BoundaryDenialReason): unknown => {
      denials.emit({ tool: toolCode, pack: packCode, reason });
      // The executor's own trace codes: the tool's name only when the executor would have known it.
      // S2 09hu G1: a scope / pack / tier / handle refusal is flagged `refused` (metadata only; the model sees the same NOT_FOUND).
      c.ev.trace.push({ tool: (isRouted ? tool!.name : "unknown") as PlatformAiTraceStep["tool"], outcome: reason === "ARGS_INVALID" ? "INVALID_ARGS" : "NOT_FOUND", refs: [], ...refusedFlag(reason) });
      trace.push({ tool: toolCode, pack: packCode, outcome: reason });
      return NOT_FOUND;
    };

    // 1. registered, routed, flag ON.
    if (!tool) return refuse("UNKNOWN_TOOL");
    if (!isRouted) return refuse("PACK_NOT_ROUTED");
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
    // P5: a RECORD tool reads through THIS call's fresh guards (the token minted from them); never kept past the call.
    // P8: so does a pack AGGREGATE tool (incident_overview reads the incident module with its token); the six core
    // tools (the executor) ignore it.
    const ctx: LegacyToolContext = { binding, ev: c.ev, paramKeys: c.paramKeys, asked: c.asked, ...(c.memory ? { memory: c.memory } : {}), fresh };

    // 7. record-level revalidation.
    if (tool.revalidate) {
      for (const id of resolved) {
        let visible = false;
        try { visible = (await tool.revalidate(id, ctx)) === true; } catch { visible = false; }
        if (!visible) return refuse("REVALIDATE_REFUSED");
      }
    }

    // 9. run — an AGGREGATE tool is the executor, unchanged (its own trace step, its own result).
    noteRan(tool.pack, surviving);
    if (tool.scope === "AGGREGATE") {
      const out = await tool.run(runArgs, ctx);
      trace.push({ tool: tool.name, pack: tool.pack, outcome: "OK" });
      return out;
    }
    return runRecordTool(tool, runArgs, ctx, surviving, csFresh, fresh);
  };

  /**
   * P3 — `more_tools` (engine/router.ts): steps 1–4 for the meta-tool, then the pack joins the
   * routed set for the rest of the turn. Reads no data; one tool call (core.ts counts it).
   */
  async function invokeMoreTools(rawArgs: string, c: Parameters<PlatformAiToolInvoker>[2]): Promise<unknown> {
    const refuse = (reason: BoundaryDenialReason): unknown => {
      denials.emit({ tool: MORE_TOOLS_NAME, pack: "router", reason });
      c.ev.trace.push({ tool: "unknown", outcome: reason === "ARGS_INVALID" ? "INVALID_ARGS" : "NOT_FOUND", refs: [], ...refusedFlag(reason) });
      trace.push({ tool: MORE_TOOLS_NAME, pack: "router", outcome: reason });
      return NOT_FOUND;
    };
    // 1. offered: some pack is expandable now (flag ON, in scope, under both bounds).
    const expandable = [...router!.expandable(routed, scope.areas(), expansions)];
    if (expandable.length === 0) return refuse("PACK_NOT_ROUTED");
    // 2. strict parse: the pack is one of exactly those (a closed enum).
    const args = parseClosedArgs({ properties: { pack: { kind: "enum", values: expandable } } }, rawArgs);
    if (!args) return refuse("ARGS_INVALID");
    const pack = args.pack as ToolPack;
    let packOn = false;
    try { packOn = opts.packEnabled(pack) === true; } catch { packOn = false; }
    if (!packOn) return refuse("PACK_DISABLED");
    // 3. a tool of the pack callable in the live scope.
    const packTools = registry.filter((t) => t.pack === pack);
    const areas = scope.areas().filter((a) => packTools.some((t) => t.requires.areas.includes(a)));
    if (!packTools.some((t) => toolCallableIn(t, scope.areas()))) return refuse("AREA_NOT_IN_SCOPE");
    // 4. the per-call recheck of those areas (a refused area leaves the scope).
    for (const a of areas) await scope.recheck(a);
    const live = scope.areas();
    const callable = packTools.filter((t) => toolCallableIn(t, live)).map((t) => t.name);
    if (callable.length === 0) return refuse("RECHECK_REFUSED");
    routed = [...routed, pack];
    expansions++;
    trace.push({ tool: MORE_TOOLS_NAME, pack: "router", outcome: "OK" });
    // S2 09hu G1: the meta-tool's own metadata step (no ref, no argument), so the response trace counts it.
    c.ev.trace.push({ tool: (MORE_TOOLS_NAME as string) as PlatformAiTraceStep["tool"], outcome: "OK", refs: [] });
    return { added: pack, tools: callable };
  }

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
    const records: ModelRecord[] = kept.map((r) => {
      const handle = handles.mint({ kind: r.ref.kind, area: r.ref.area, tier: r.ref.tier, recordId: r.ref.recordId });
      // P8: the record's CLOSED field values ride with the handle (compose/causal.ts reads a placed incident's causeStatus / cause).
      recordRefs.set(handle, Object.freeze({
        rk: r.ref.kind, rid: r.ref.recordId, a: r.ref.area, fields: Object.freeze([RECORD_REF_FIELD, ...(schema.t2Fields ?? [])]),
        facts: Object.freeze({ ...withoutT2(r.fields) }),
      }));
      return {
        handle,
        kind: schema.kind,
        fields: withoutT2(r.fields),
        ...(schema.t2Fields?.length ? { t2Fields: [...schema.t2Fields] } : {}),
      };
    });

    // 13. evidence + trace: codes and counts.
    ctx.ev.trace.push({ tool: tool.name as PlatformAiTraceStep["tool"], outcome: "OK", refs: [], count: records.length });
    trace.push({ tool: tool.name, pack: tool.pack, outcome: "OK", records: records.length, dropped });
    return { status: run.status, asOf: run.asOf, records, truncated };
  }

  const tools: PlatformAiTurnTools | undefined = router ? {
    route(question) {
      // Once, before any tool call (core.ts calls it right after scrubbing); later calls change nothing.
      if (routedByQuestion || calls > 0) return;
      routedByQuestion = true;
      routed = [...router.route(question, scope.areas())];
    },
    schemas(paramKeys) {
      const areas = scope.areas();
      return router.schemas({ packs: routed, areas, paramKeys, expandable: router.expandable(routed, areas, expansions) });
    },
  } : undefined;

  /** P4 — replay re-authz (see the header). Never throws; every refusal is null. */
  async function remint(refs: readonly { rk: string; rid: string; a: string }[]): Promise<(string | null)[]> {
    const guards = new Map<string, FreshGuard | null>();
    for (const a of new Set(refs.map((r) => r.a))) {
      const area = a as PlatformArea;
      guards.set(a, scope.has(area) ? await scope.recheck(area) : null);
    }
    const out: (string | null)[] = [];
    for (const r of refs) {
      const guard = guards.get(r.a) ?? null;
      const src = Object.prototype.hasOwnProperty.call(recordSources, r.rk) ? recordSources[r.rk] : undefined;
      if (!guard || !src || typeof r.rid !== "string" || r.rid.length === 0) { out.push(null); continue; }
      let tier: ToolTier | null = null;
      try { tier = await src.revalidate(r.rid, r.a as PlatformArea, guard); } catch { tier = null; }
      if (!(tier === "OPS" || (tier === "CUSTOMER_SUCCESS" && guard.csTier))) { out.push(null); continue; }
      const handle = handles.mint({ kind: r.rk, area: r.a as PlatformArea, tier, recordId: r.rid });
      recordRefs.set(handle, Object.freeze({ rk: r.rk, rid: r.rid, a: r.a, fields: Object.freeze([RECORD_REF_FIELD, ...src.t2Fields]) }));
      out.push(handle);
    }
    return out;
  }

  async function subjectEligibility(): Promise<{ csTier: boolean; area: PlatformArea } | null> {
    const order = [...scope.areas()].sort((a, b) => (a === "CUSTOMER_SUCCESS" ? -1 : b === "CUSTOMER_SUCCESS" ? 1 : 0));
    for (const a of order) {
      const g = await scope.recheck(a);
      if (g) return { csTier: a === "CUSTOMER_SUCCESS" && g.csTier === true, area: a };
    }
    return null;
  }

  /**
   * P8 — a handle of THIS turn for a record the SERVER resolved from an exact identifier (never model input):
   * the first of `areas` (in order) that is in scope, passes a FRESH per-call recheck (a refusal removes the
   * area) and whose kind's source re-validates the record for that guard — OPS tier, or CUSTOMER_SUCCESS with
   * the guard's CS tier. Anything else ⇒ null. (The incident id of a question: authz/subject.ts.)
   */
  async function adoptRecord(subject: { rk: string; rid: string }, areas: readonly PlatformArea[]): Promise<string | null> {
    const src = Object.prototype.hasOwnProperty.call(recordSources, subject.rk) ? recordSources[subject.rk] : undefined;
    if (!src || typeof subject.rid !== "string" || subject.rid.length === 0) return null;
    for (const area of areas) {
      if (!scope.has(area)) continue;
      const guard = await scope.recheck(area);
      if (!guard) continue;
      let tier: ToolTier | null = null;
      try { tier = await src.revalidate(subject.rid, area, guard); } catch { tier = null; }
      if (!(tier === "OPS" || (tier === "CUSTOMER_SUCCESS" && guard.csTier === true))) continue;
      const handle = handles.mint({ kind: subject.rk, area, tier, recordId: subject.rid });
      recordRefs.set(handle, Object.freeze({ rk: subject.rk, rid: subject.rid, a: area, fields: Object.freeze([RECORD_REF_FIELD, ...src.t2Fields]) }));
      return handle;
    }
    return null;
  }

  async function adoptSubject(subject: { rk: string; rid: string; area: PlatformArea }): Promise<string | null> {
    const src = Object.prototype.hasOwnProperty.call(recordSources, subject.rk) ? recordSources[subject.rk] : undefined;
    if (!src || typeof subject.rid !== "string" || subject.rid.length === 0 || !scope.has(subject.area)) return null;
    const guard = await scope.recheck(subject.area);
    if (!guard || guard.csTier !== true) return null;
    let tier: ToolTier | null = null;
    try { tier = await src.revalidate(subject.rid, subject.area, guard); } catch { tier = null; }
    if (tier !== "CUSTOMER_SUCCESS" && tier !== "OPS") return null;
    const handle = handles.mint({ kind: subject.rk, area: subject.area, tier, recordId: subject.rid });
    recordRefs.set(handle, Object.freeze({ rk: subject.rk, rid: subject.rid, a: subject.area, fields: Object.freeze([RECORD_REF_FIELD, ...src.t2Fields]) }));
    return handle;
  }

  return {
    invoke,
    subjectEligibility,
    adoptSubject,
    adoptRecord,
    recordRef: (handle) => (typeof handle === "string" && handles.owns(handle) ? recordRefs.get(handle) ?? null : null),
    remint,
    trace: () => [...trace],
    scopeAreas: () => scope.areas(),
    toolAreas: () => new Map([...ranOver].map(([p, s]) => [p, [...s]] as const)),
    routedPacks: () => [...routed],
    ...(tools ? { tools } : {}),
  };
}

/** Step 11 (defence in depth): no field named like a T2 identity ever leaves (the schema validator already refuses one). */
function withoutT2(fields: RecordFields): RecordFields {
  const out: Record<string, RecordFields[string]> = {};
  for (const [k, v] of Object.entries(fields)) if (!(T2_FIELD_NAMES as readonly string[]).includes(k)) out[k] = v;
  return out;
}
