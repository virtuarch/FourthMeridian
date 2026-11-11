/**
 * lib/platform/intelligence/ai/tools/contract.ts  (Platform AI P1b — the typed tool contract)
 *
 * Every Platform AI tool is DECLARED through this contract: what the model may
 * send (a closed argument schema), which Platform areas and tier it needs, whether
 * it returns aggregates or records, whether those records can link to a customer
 * (and, if so, the audit it must write), its PII class and its cost against the
 * per-turn tool budget. P1b declares the EXISTING tools only (tools/registry.ts);
 * the single enforcement point that consumes these declarations (invokeTool, the
 * per-call recheck, handles, the fail-closed audit) is authz/boundary.ts (P2).
 *
 * THE RULES THE TYPES MAKE STRUCTURAL
 *   · ClosedSchema args: enums, bounded integers, registry ids (a fixed shape the
 *     owning registry resolves), per-turn handle keys (HANDLE_KEY_PATTERN) and the
 *     page-filter map the navigation registry validates. There is NO plain-string
 *     argument kind. The two pre-existing text arguments (find_page.query, matched
 *     only against registry labels; propose_memory.note, the operator's own note
 *     behind memory/note-guard.ts) are the `guardedText` kind, allowed ONLY for the
 *     (tool, arg) pairs in GUARDED_TEXT_ALLOWLIST — a new tool cannot use it.
 *   · requires.areas: an explicit, NON-EMPTY tuple of real PlatformArea values. No
 *     "ALL" / wildcard value exists in any type here (I-7); validateContract also
 *     refuses duplicates and anything that is not a registry area.
 *   · scope RECORD ⇒ customerLinkable is REQUIRED; customerLinkable true ⇒ an
 *     AuditSpec is REQUIRED (I-5, enforced at runtime by authz/audit.ts in P2+).
 *   · results carry one of TOOL_RESULT_STATUSES (MISSING = the reader ran and
 *     nothing exists; UNAVAILABLE = the reader / audit failed or is not permitted;
 *     an invisible record is the boundary's NOT_FOUND, never MISSING).
 *
 * PURE: types, constants and validators. No I/O, no clock, no module state.
 */

import type { PlatformArea } from "@prisma/client";
import type { AuditActionType } from "@/lib/audit-actions";
import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";
import type { RecordSchema } from "../evidence/record-envelope";

// ── Result status ────────────────────────────────────────────────────────────

export const TOOL_RESULT_STATUSES = ["CONFIRMED", "CALCULATED", "ESTIMATED", "PARTIAL", "MISSING", "UNAVAILABLE", "STALE"] as const;
export type ToolResultStatus = (typeof TOOL_RESULT_STATUSES)[number];

// ── Packs, tiers, levels ─────────────────────────────────────────────────────

/** The packs declared so far. A pack is added WITH its PR (P5+), never ahead of it. P5: customers. P8: incidents. P6: onboarding. P7: connections. */
export const TOOL_PACKS = ["metrics", "navigation", "memory", "customers", "incidents", "onboarding", "connections"] as const;
export type ToolPack = (typeof TOOL_PACKS)[number];

export const TOOL_TIERS = ["OPS", "CUSTOMER_SUCCESS"] as const;
export type ToolTier = (typeof TOOL_TIERS)[number];

/** Platform AI is read-only: READ is the only level a tool can require. */
export type ToolLevel = "READ";

/** A real Platform area, at least one. There is no wildcard member to name. */
export type ToolAreas = readonly [PlatformArea, ...PlatformArea[]];

export interface ToolRequires {
  readonly areas: ToolAreas;
  readonly level: ToolLevel;
  readonly tier: ToolTier;
}

// ── Closed argument schema ───────────────────────────────────────────────────

/** A per-turn record handle key (design §6.3): "h_" + 16 base64url chars. */
export const HANDLE_KEY_PATTERN = /^h_[A-Za-z0-9_-]{16}$/;

/** Which registry resolves a registry-id argument (the id is only ever looked up, never interpreted). */
export const REGISTRY_ID_KINDS = ["METRIC", "PAGE", "MEMORY_FACT", "MEMORY_SUBJECT"] as const;
export type RegistryIdKind = (typeof REGISTRY_ID_KINDS)[number];

/** Where a guardedText argument goes — the only two sinks, each with its own guard. */
export const GUARDED_TEXT_SINKS = ["REGISTRY_LABEL_MATCH", "MEMORY_NOTE_GUARD"] as const;
export type GuardedTextSink = (typeof GUARDED_TEXT_SINKS)[number];

/**
 * The ONLY (tool, argument) pairs that may declare guardedText — the pre-existing
 * arguments, stated: find_page.query is matched against registry labels and never
 * reaches a reader; propose_memory.note is the operator's own note, guarded at write
 * (memory/note-guard.ts, S2 binding ruling 1). A change here is an S2 review item.
 */
export const GUARDED_TEXT_ALLOWLIST: readonly string[] = ["find_page.query", "propose_memory.note"];

interface ArgBase {
  /** Absent (or JSON null) is accepted only when true. */
  readonly optional?: boolean;
  readonly description?: string;
}
export interface EnumArg extends ArgBase { readonly kind: "enum"; readonly values: readonly string[] }
/** A bounded integer; `offered` is the schema hint the model sees (each tool still accepts only its own). */
export interface IntArg extends ArgBase { readonly kind: "int"; readonly min: number; readonly max: number; readonly offered?: readonly number[] }
export interface RegistryIdArg extends ArgBase { readonly kind: "registryId"; readonly registry: RegistryIdKind; readonly pattern: RegExp; readonly maxLength: number }
/**
 * A per-turn record handle (authz/handles.ts). `recordKind` = the record kind the handle
 * must have been minted for (P2: the boundary refuses a handle argument without one).
 */
export interface HandleArg extends ArgBase { readonly kind: "handle"; readonly recordKind?: string }
/** The page-filter map: keys from the visible pages' registry params (denied keys removed); values validated by the owning parser. */
export interface RegistryParamsArg extends ArgBase { readonly kind: "registryParams"; readonly maxValueLength: number }
export interface GuardedTextArg extends ArgBase { readonly kind: "guardedText"; readonly sink: GuardedTextSink; readonly maxLength: number }

/** Every argument kind there is. Note what is missing: a plain, unguarded string. */
export type ArgSpec = EnumArg | IntArg | RegistryIdArg | HandleArg | RegistryParamsArg | GuardedTextArg;
export type ArgKind = ArgSpec["kind"];
export const ARG_KINDS: readonly ArgKind[] = ["enum", "int", "registryId", "handle", "registryParams", "guardedText"];

export interface ClosedSchema {
  readonly properties: Readonly<Record<string, ArgSpec>>;
}

// ── Scope, linkage, audit ────────────────────────────────────────────────────

/** The audit a customer-linkable RECORD tool writes BEFORE its result leaves the boundary (§6.5). */
export interface AuditSpec {
  readonly action: AuditActionType;
  /** One row per linked customer per call; the detail is these codes only. */
  readonly detail: { readonly surface: "platform-ai"; readonly recordKind: string };
}

export type ToolScopeSpec =
  | { readonly scope: "AGGREGATE"; readonly customerLinkable: false; readonly audit?: undefined }
  | { readonly scope: "RECORD"; readonly customerLinkable: false; readonly audit?: AuditSpec }
  | { readonly scope: "RECORD"; readonly customerLinkable: true; readonly audit: AuditSpec };

/** 0 = no personal data; 1 = opaque refs / codes / timestamps; 2 = names or emails exist behind the tool (never sent to the model). */
export type PiiClass = 0 | 1 | 2;

export interface ToolCost {
  /** Calls charged against PLATFORM_AI_MAX_TOOL_CALLS (a composite tool charges per part). */
  readonly toolCalls: number | ((args: Readonly<Record<string, unknown>>) => number);
}

// ── The contract ─────────────────────────────────────────────────────────────

export type PlatformAiToolContract<Ctx = unknown> = {
  readonly name: string;
  readonly pack: ToolPack;
  /** The schema description the model sees (pinned by the schema snapshot). */
  readonly description: string;
  readonly args: ClosedSchema;
  readonly requires: ToolRequires;
  readonly pii: PiiClass;
  readonly cost: ToolCost;
  /**
   * Runs the tool over already-parsed args. P1b: the registry facade delegates to the
   * existing executor unchanged (core.ts executePlatformAiTool); the result is that
   * executor's own shape until the P2 boundary wraps it.
   */
  readonly run: (args: Readonly<Record<string, unknown>>, ctx: Ctx) => Promise<unknown>;
  /** Record-level visibility re-check (P2+ RECORD tools): the resolved record id of each handle argument. */
  readonly revalidate?: (ref: string, ctx: Ctx) => Promise<boolean>;
  /** P2 — a RECORD tool's closed record shape (evidence/record-envelope.ts); required when scope = RECORD. */
  readonly recordSchema?: RecordSchema;
} & ToolScopeSpec;

// ── Runtime validation ──────────────────────────────────────────────────────

/** Every way a declaration can be wrong — the registry test requires none. */
export function contractProblems(c: PlatformAiToolContract<never>): string[] {
  const out: string[] = [];
  const areas = c.requires?.areas as readonly unknown[] | undefined;
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(c.name)) out.push("name: not a tool name");
  if (!(TOOL_PACKS as readonly string[]).includes(c.pack)) out.push("pack: unknown");
  if (typeof c.description !== "string" || c.description.length === 0) out.push("description: empty");
  if (!Array.isArray(areas) || areas.length === 0) out.push("requires.areas: empty");
  else {
    if (new Set(areas).size !== areas.length) out.push("requires.areas: duplicate");
    for (const a of areas) if (!(ALL_PLATFORM_AREAS as readonly unknown[]).includes(a)) out.push(`requires.areas: ${String(a)} is not a Platform area`);
  }
  if (c.requires?.level !== "READ") out.push("requires.level: not READ");
  if (!(TOOL_TIERS as readonly string[]).includes(c.requires?.tier)) out.push("requires.tier: unknown");
  if (c.scope !== "AGGREGATE" && c.scope !== "RECORD") out.push("scope: unknown");
  if (typeof c.customerLinkable !== "boolean") out.push("customerLinkable: not declared");
  if (c.scope === "AGGREGATE" && c.customerLinkable !== false) out.push("customerLinkable: an AGGREGATE tool cannot link to a customer");
  if (c.customerLinkable === true && !(c.audit && typeof c.audit.action === "string" && c.audit.detail?.surface === "platform-ai")) out.push("audit: required for a customer-linkable tool");
  if (c.scope === "RECORD" && !(c.recordSchema && typeof c.recordSchema.kind === "string")) out.push("recordSchema: required for a RECORD tool");
  if (![0, 1, 2].includes(c.pii)) out.push("pii: not 0 | 1 | 2");
  const tc = c.cost?.toolCalls;
  if (!(typeof tc === "function" || (typeof tc === "number" && Number.isInteger(tc) && tc >= 1))) out.push("cost.toolCalls: not a positive integer or function");
  if (typeof c.run !== "function") out.push("run: missing");
  for (const [k, a] of Object.entries(c.args?.properties ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) out.push(`args.${k}: not an argument name`);
    if (!(ARG_KINDS as readonly string[]).includes(a.kind)) { out.push(`args.${k}: kind ${String((a as { kind?: unknown }).kind)} is not a closed kind`); continue; }
    if (a.kind === "enum" && (a.values.length === 0 || a.values.some((v) => typeof v !== "string"))) out.push(`args.${k}: empty or non-string enum`);
    if (a.kind === "int" && !(Number.isInteger(a.min) && Number.isInteger(a.max) && a.min <= a.max)) out.push(`args.${k}: unbounded int`);
    if (a.kind === "registryId" && !((REGISTRY_ID_KINDS as readonly string[]).includes(a.registry) && a.pattern instanceof RegExp && a.maxLength > 0 && a.maxLength <= 120)) out.push(`args.${k}: bad registry id`);
    if (a.kind === "handle" && !(typeof a.recordKind === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(a.recordKind))) out.push(`args.${k}: handle without a record kind`);
    if (a.kind === "guardedText" && (!GUARDED_TEXT_ALLOWLIST.includes(`${c.name}.${k}`) || !(GUARDED_TEXT_SINKS as readonly string[]).includes(a.sink) || !(a.maxLength > 0 && a.maxLength <= 200))) out.push(`args.${k}: guardedText outside the allowlist`);
  }
  return out;
}

/** null and undefined both mean "not given" for an OPTIONAL argument (models often send null). */
const given = (v: unknown) => v !== undefined && v !== null;

/**
 * The strict parse of a model's raw argument JSON against a ClosedSchema: a plain
 * object, no unknown key, every required argument present, every value of its
 * declared kind. null on any failure (the boundary turns that into NOT_FOUND).
 * `ctx.paramKeys` is the turn's allowed page-filter keys (registryParams).
 */
export function parseClosedArgs(schema: ClosedSchema, raw: string, ctx: { paramKeys?: readonly string[] } = {}): Record<string, unknown> | null {
  let v: unknown;
  try { v = JSON.parse(raw || "{}"); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  const obj = v as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(schema.properties)) {
    const x = obj[k];
    if (!given(x)) { if (spec.optional) continue; return null; }
    if (!argOk(spec, x, ctx)) return null;
    out[k] = x;
  }
  return out;
}

function argOk(spec: ArgSpec, x: unknown, ctx: { paramKeys?: readonly string[] }): boolean {
  switch (spec.kind) {
    case "enum": return typeof x === "string" && spec.values.includes(x);
    case "int": return typeof x === "number" && Number.isInteger(x) && x >= spec.min && x <= spec.max;
    case "registryId": return typeof x === "string" && x.length <= spec.maxLength && spec.pattern.test(x);
    case "handle": return typeof x === "string" && HANDLE_KEY_PATTERN.test(x);
    case "guardedText": return typeof x === "string" && x.length <= spec.maxLength;
    case "registryParams": {
      if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
      const keys = ctx.paramKeys ?? [];
      return Object.entries(x).every(([k, val]) => keys.includes(k) && typeof val === "string");
    }
  }
}

/** The calls a tool charges for these args (a function cost is clamped to ≥ 1). */
export function toolCallCost(c: Pick<PlatformAiToolContract<never>, "cost">, args: Readonly<Record<string, unknown>>): number {
  const tc = c.cost.toolCalls;
  const n = typeof tc === "function" ? tc(args) : tc;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * P3 — the JSON function schema the model is sent for a contract-declared tool (P5+ packs; the
 * six existing tools keep core.ts's own serialisation, pinned by the schema snapshot). Every
 * argument is closed: enum values, integer bounds, a registry id's max length, a handle's key
 * pattern, the turn's page-filter keys, a guardedText max length. additionalProperties false.
 */
export function contractToolSchema(c: Pick<PlatformAiToolContract<never>, "name" | "description" | "args">, paramKeys: readonly string[] = []): unknown {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, a] of Object.entries(c.args.properties)) {
    const d = a.description ? { description: a.description } : {};
    switch (a.kind) {
      case "enum": properties[k] = { type: "string", enum: [...a.values], ...d }; break;
      case "int": properties[k] = { type: "integer", ...(a.offered ? { enum: [...a.offered] } : { minimum: a.min, maximum: a.max }), ...d }; break;
      case "registryId": properties[k] = { type: "string", maxLength: a.maxLength, ...d }; break;
      case "handle": properties[k] = { type: "string", pattern: HANDLE_KEY_PATTERN.source, ...d }; break;
      case "guardedText": properties[k] = { type: "string", maxLength: a.maxLength, ...d }; break;
      case "registryParams": properties[k] = { type: "object", properties: Object.fromEntries(paramKeys.map((p) => [p, { type: "string", maxLength: a.maxValueLength }])), additionalProperties: false, ...d }; break;
    }
    if (!a.optional) required.push(k);
  }
  return { type: "function", function: { name: c.name, description: c.description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
