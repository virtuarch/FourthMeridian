/**
 * lib/platform/intelligence/ai/evidence/record-envelope.ts  (Platform AI P2 — closed record fields, I-3 / D-3)
 *
 * What a RECORD tool may hand the model about one record. Every field is ONE of the
 * closed field types below; there is no plain-string field type, so customer- or
 * other-operator-authored free text (notes, error messages, institution names,
 * descriptors, audit detail) cannot be carried by a record:
 *
 *   Code<E>       a value from a closed code set E (the schema lists the set)
 *   IsoTime       a UTC ISO-8601 instant ("2026-11-09T12:00:00.000Z")
 *   Count         a non-negative safe integer
 *   Handle        a per-turn handle key (authz/handles.ts) minted in THIS turn
 *   OpaqueRef     the HMAC opaque user ref ("user #" + 8 hex, lib/platform/opaque-user-ref.ts)
 *   RegistryName  a name from a code-reviewed registry list (the schema lists it)
 *   BoolFlag      a boolean
 *
 * COMPILE TIME: each type is BRANDED, so a plain `string` (or number / boolean) is not
 * assignable to a record field — evidence/record-envelope.test.ts holds the
 * `@ts-expect-error` proof, which `tsc --noEmit` checks (an unused expect-error fails).
 * RUN TIME: validateRecordFields checks a reader's output against the tool's
 * RecordSchema — every key declared, every value of its declared type, every string in
 * its enum / registry list / shape. The boundary (authz/boundary.ts step 10) refuses the
 * whole call (UNAVAILABLE, no record data) on any problem.
 *
 * T2 (name / email / username) is never a field: a schema may only NAME T2 fields in
 * `t2Fields` (the model can place `{{r:h|name}}`; the value is rendered at read time,
 * P4). A schema that declares a field with a T2 name is refused (validateRecordSchema).
 *
 * Problems are CODES (field names from the code-written schema + a reason enum) —
 * never a value.
 *
 * PURE: types, constants and validators. No I/O, no clock, no module state.
 */

import { HANDLE_KEY_PATTERN, TOOL_RESULT_STATUSES, type ToolResultStatus, type ToolTier } from "../tools/contract";
import type { PlatformArea } from "@prisma/client";
import { placeableNameForbidden, type ClosedValueType } from "../compose/closed";

// ── The closed field types (branded) ─────────────────────────────────────────

declare const FIELD_BRAND: unique symbol;
type Brand<T, B extends string> = T & { readonly [FIELD_BRAND]: B };

export type Code<E extends string> = Brand<E, "Code">;
export type IsoTime = Brand<string, "IsoTime">;
export type Count = Brand<number, "Count">;
export type Handle = Brand<string, "Handle">;
export type OpaqueRef = Brand<string, "OpaqueRef">;
export type RegistryName = Brand<string, "RegistryName">;
export type BoolFlag = Brand<boolean, "BoolFlag">;

/** Every value a record field can hold. Note what is missing: a plain string / number / boolean. */
export type FieldValue = Code<string> | IsoTime | Count | Handle | OpaqueRef | RegistryName | BoolFlag;

/** A record's fields: closed values (or null = not recorded). */
export type RecordFields = { readonly [field: string]: FieldValue | null };

// ── Constructors (the only way a mapper makes a field value) ─────────────────

export class RecordFieldError extends Error {
  constructor(readonly code: string) { super(`record field refused: ${code}`); this.name = "RecordFieldError"; }
}

export const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
/** lib/platform/opaque-user-ref.ts: "user #" + the first 8 hex chars of the HMAC. */
export const OPAQUE_REF_PATTERN = /^user #[0-9a-f]{8}$/;

export function code<E extends string>(values: readonly E[], v: string): Code<E> {
  if (!(values as readonly string[]).includes(v)) throw new RecordFieldError("CODE_NOT_IN_SET");
  return v as Code<E>;
}
export function isoTime(d: Date): IsoTime {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new RecordFieldError("TIME_INVALID");
  return d.toISOString() as IsoTime;
}
export function count(n: number): Count {
  if (!Number.isSafeInteger(n) || n < 0) throw new RecordFieldError("COUNT_INVALID");
  return n as Count;
}
export function opaqueRef(s: string): OpaqueRef {
  if (!OPAQUE_REF_PATTERN.test(s)) throw new RecordFieldError("OPAQUE_REF_INVALID");
  return s as OpaqueRef;
}
export function registryName(names: readonly string[], s: string): RegistryName {
  if (!names.includes(s)) throw new RecordFieldError("NAME_NOT_IN_REGISTRY");
  return s as RegistryName;
}
export const boolFlag = (b: boolean): BoolFlag => {
  if (typeof b !== "boolean") throw new RecordFieldError("BOOL_INVALID");
  return b as BoolFlag;
};

// ── Schemas ──────────────────────────────────────────────────────────────────

/** T2 identity fields: never a record field; a schema may only NAME them in t2Fields. */
export const T2_FIELD_NAMES = ["name", "email", "username"] as const;
export type T2FieldName = (typeof T2_FIELD_NAMES)[number];

export type FieldSpec = (
  | { readonly type: "code"; readonly values: readonly string[] }
  | { readonly type: "isoTime" }
  | { readonly type: "count" }
  | { readonly type: "handle" }
  | { readonly type: "opaqueRef" }
  | { readonly type: "registryName"; readonly names: readonly string[] }
  | { readonly type: "bool" }
) & { readonly nullable?: boolean };

export const FIELD_TYPES = ["code", "isoTime", "count", "handle", "opaqueRef", "registryName", "bool"] as const;

/** A RECORD tool's declaration of what one record looks like (closed). */
export interface RecordSchema {
  /** The record kind (a code, e.g. "INCIDENT"); handles are bound to it. */
  readonly kind: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
  /** T2 fields that exist behind the record (names only — never a value here). */
  readonly t2Fields?: readonly T2FieldName[];
  /**
   * S2 09io A1 — the CLOSED T1 fields the model may place as `{{r:h|<field>}}` (the server renders the value
   * THIS turn's tool returned, under a fresh guard at render time). ONLY fields of a PLACEABLE_FIELD_TYPES type
   * (code / count / isoTime) — never "ref" (placed already), a T2 name, a bool, a registry name (institution), an
   * opaque ref or a handle, and never a field whose name carries a forbidden word (compose/closed.ts: identities,
   * free text, institution text, amounts). validateRecordSchema refuses any other entry; absent ⇒ none.
   */
  readonly placeable?: readonly string[];
}

/** The field types a `placeable` entry may have (A1: enum / code / count / server-formatted date). */
export const PLACEABLE_FIELD_TYPES = ["code", "count", "isoTime"] as const satisfies readonly ClosedValueType[];

/** The union of the schemas' placeable fields (a record KIND's render-time allowlist, authz/record-render.ts). */
export const placeableUnion = (...schemas: readonly RecordSchema[]): readonly string[] =>
  Object.freeze([...new Set(schemas.flatMap((s) => [...(s.placeable ?? [])]))].sort());

/** The closed value type of a placeable field of this schema, or null (not placeable). */
export function placeableTypeOf(s: RecordSchema, field: string): ClosedValueType | null {
  if (!(s.placeable ?? []).includes(field) || !Object.prototype.hasOwnProperty.call(s.fields, field)) return null;
  const t = s.fields[field].type;
  return (PLACEABLE_FIELD_TYPES as readonly string[]).includes(t) ? (t as ClosedValueType) : null;
}

/** Lists are bounded: at most this many records leave the boundary per call (+ truncated). */
export const RECORD_LIST_MAX = 10;

/** Every way a schema can be wrong (the registry / boundary refuse a tool with any). */
export function validateRecordSchema(s: RecordSchema): string[] {
  const out: string[] = [];
  if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(s?.kind ?? "")) out.push("kind:not_a_code");
  for (const [k, f] of Object.entries(s?.fields ?? {})) {
    if (!/^[a-z][A-Za-z0-9]{0,40}$/.test(k)) out.push(`field:${k.slice(0, 40)}:bad_name`);
    if ((T2_FIELD_NAMES as readonly string[]).includes(k)) out.push(`field:${k}:t2_name`);
    if (!(FIELD_TYPES as readonly string[]).includes((f as { type?: string })?.type ?? "")) { out.push(`field:${k}:not_a_closed_type`); continue; }
    if (f.type === "code" && (f.values.length === 0 || f.values.some((v) => typeof v !== "string"))) out.push(`field:${k}:empty_code_set`);
    if (f.type === "registryName" && (f.names.length === 0 || f.names.some((v) => typeof v !== "string"))) out.push(`field:${k}:empty_registry`);
  }
  for (const t of s?.t2Fields ?? []) if (!(T2_FIELD_NAMES as readonly string[]).includes(t)) out.push("t2Fields:unknown");
  // S2 09io A1: every placeable entry is a declared closed field (code / count / isoTime) with an allowed name.
  const placeable: readonly unknown[] = Array.isArray(s?.placeable) ? s.placeable : s?.placeable === undefined ? [] : ["?"];
  if (new Set(placeable).size !== placeable.length) out.push("placeable:duplicate");
  for (const p of placeable) {
    const f = typeof p === "string" && Object.prototype.hasOwnProperty.call(s?.fields ?? {}, p) ? s.fields[p] : null;
    if (!f) { out.push(`placeable:${String(p).slice(0, 40)}:not_a_field`); continue; }
    if (p === "ref" || (T2_FIELD_NAMES as readonly string[]).includes(p as string) || placeableNameForbidden(p as string)) out.push(`placeable:${p}:forbidden_name`);
    if (!(PLACEABLE_FIELD_TYPES as readonly string[]).includes(f.type)) out.push(`placeable:${p}:not_a_closed_type`);
  }
  return out;
}

/**
 * The runtime validator: `fields` (a reader / mapper output, untrusted shape) against the
 * schema. `ownsHandle` = the turn's handle table (a Handle field must be a key minted in
 * THIS turn). Problems are codes: `field:<schema name>:<reason>` or `unknown_field`.
 */
export function validateRecordFields(schema: RecordSchema, fields: unknown, ownsHandle: (key: string) => boolean = () => false): string[] {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return ["fields:not_an_object"];
  const proto = Object.getPrototypeOf(fields);
  if (proto !== Object.prototype && proto !== null) return ["fields:not_a_plain_object"];
  const out: string[] = [];
  const obj = fields as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(schema.fields, k)) out.push("unknown_field");
  for (const [k, f] of Object.entries(schema.fields)) {
    const v = obj[k];
    if (v === undefined || v === null) { if (!f.nullable) out.push(`field:${k}:missing`); continue; }
    if (!fieldOk(f, v, ownsHandle)) out.push(`field:${k}:${f.type}`);
  }
  return out;
}

function fieldOk(f: FieldSpec, v: unknown, ownsHandle: (key: string) => boolean): boolean {
  switch (f.type) {
    case "code": return typeof v === "string" && f.values.includes(v);
    case "isoTime": return typeof v === "string" && ISO_TIME_PATTERN.test(v) && !Number.isNaN(Date.parse(v));
    case "count": return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    case "handle": return typeof v === "string" && HANDLE_KEY_PATTERN.test(v) && ownsHandle(v);
    case "opaqueRef": return typeof v === "string" && OPAQUE_REF_PATTERN.test(v);
    case "registryName": return typeof v === "string" && f.names.includes(v);
    case "bool": return typeof v === "boolean";
  }
}

// ── What a RECORD tool's run returns, and what the model receives ────────────

/** The server-side reference to one record. NEVER sent to the model: the boundary mints a handle for it. */
export interface RecordRef {
  readonly kind: string;
  readonly recordId: string;
  readonly area: PlatformArea;
  /** CUSTOMER_SUCCESS = only a fresh CS-tier operator may receive it (the boundary's tier filter). */
  readonly tier: ToolTier;
  /** Customers this record links to (runtime linkage, §6.5): one audit row each for a customer-linkable tool. */
  readonly linkedUserIds: readonly string[];
}

export interface RawRecord {
  readonly ref: RecordRef;
  readonly fields: RecordFields;
}

/** A RECORD tool's run result, before the boundary (steps 10–12). */
export interface RecordRunResult {
  readonly status: ToolResultStatus;
  readonly asOf: IsoTime;
  readonly records: readonly RawRecord[];
  readonly truncated: boolean;
}

/** One record as the MODEL receives it: a handle, the kind, closed fields, T2 field NAMES. */
export interface ModelRecord {
  readonly handle: string;
  readonly kind: string;
  readonly fields: RecordFields;
  readonly t2Fields?: readonly T2FieldName[];
  /**
   * S2 09jr S-a — field code → the ready-to-copy `{{r:<handle>|<field>}}` for each A1-allowlisted CLOSED field this
   * record has a value for (authz/boundary.ts). Placeholder strings only: never a value, never "ref", never a T2 name.
   */
  readonly placeholders?: Readonly<Record<string, string>>;
}

export interface ModelRecordResult {
  readonly status: ToolResultStatus;
  readonly asOf: string;
  readonly records: readonly ModelRecord[];
  readonly truncated: boolean;
}

/** The run result's own shape (status, asOf, records array, truncated) — codes on failure. */
export function validateRecordRunShape(r: unknown): string[] {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return ["result:not_an_object"];
  const x = r as Record<string, unknown>;
  const out: string[] = [];
  if (!(TOOL_RESULT_STATUSES as readonly unknown[]).includes(x.status)) out.push("result:status");
  if (!(typeof x.asOf === "string" && ISO_TIME_PATTERN.test(x.asOf))) out.push("result:asOf");
  if (!Array.isArray(x.records)) out.push("result:records");
  if (typeof x.truncated !== "boolean") out.push("result:truncated");
  return out;
}
