/**
 * lib/platform/intelligence/ai/compose/record.ts  (Platform AI P4 — record + inferred placeholders, identity shapes)
 *
 * Design v2 §9 / §8.1. PURE: no I/O, no clock, no module state. compose/* never imports ../core.
 *
 * RECORD PLACEHOLDERS — `{{r:<handle>|<field>}}`. The model never sees a record id or a T2
 * value: a RECORD tool's result carries a per-turn handle and (for T2) only the field NAMES
 * (`t2Fields`). The model places a record by copying `{{r:h_…|ref}}` (the record's T1
 * reference) or `{{r:h_…|name}}` (a T2 field it was told exists). Resolution is ONLY
 * against THIS turn's handles (the turn boundary's record lookup): a handle from another
 * turn / operator, a forged key or a field the record does not declare is UNRESOLVED ⇒ the
 * RECORD_UNRESOLVED verdict (the safe fallback). A resolved placeholder becomes a TYPED
 * record span `{rk, rid, a, f}` — the record kind, its id, its area and the field CODE.
 * The VALUE is never written here: the stored answer keeps the span (rid only inside the
 * encrypted answer, conversations/answer.ts), and the text is rendered at READ time by
 * authz/record-render.ts — the only T2 path.
 *
 * INFERRED — `{{inferred}}…{{/inferred}}` (paired, not nested) renders as "Likely: …". The
 * inner prose is still the model's own prose (every digit / number-word rule applies). An
 * unpaired marker stays in the prose and is MALFORMED (the existing rule for stray braces).
 * The UNMARKED_CAUSAL verdict (causal wording outside a marker) belongs to the incidents
 * pack's inferred-cause contract (P8) and is not decided here.
 *
 * IDENTITY SHAPES — fixture-independent shapes a model-written text must never carry into an
 * answer: an email address, a cuid / uuid-shaped id. (The opaque "user #xxxxxxxx" T1 ref is
 * allowed.) A hit is the IDENTITY_LEAK verdict: a hard fail, the answer replaced and counted
 * (E0 gate ANSWER_IDENTITY_TEXT). A bare HANDLE key written as prose is not an identity but a
 * record the model failed to place: RECORD_UNRESOLVED (a key is never stored or shown).
 */

import { T2_FIELD_NAMES, type T2FieldName } from "../evidence/record-envelope";
import { closedTypeOf, closedValueOk, formatClosedValue, type ClosedValue } from "./closed";

// ── Private sentinels (the model's own copies are stripped before parsing) ──

/** Record span:  + an index letter (a–t) + . No digit, so the leftover-digit rule never sees it. */
export const RECORD_OPEN = "", RECORD_CLOSE = "";
export const RECORD_SENTINEL = /([a-t])/g;
/** Inferred span markers (paired). */
export const INFERRED_OPEN = "", INFERRED_CLOSE = "";
/** Every private sentinel this module owns — removed from the model's raw text first. */
export const RECORD_PRIVATE_CHARS = /[-]/g;

/** At most this many record spans per answer (more ⇒ unresolved). */
export const RECORD_SPANS_MAX = 20;

/** The model's record placeholder. Handle = the contract's HANDLE_KEY_PATTERN body; field = a field-name code. */
export const RECORD_PLACEHOLDER = /\{\{\s*r:(h_[A-Za-z0-9_-]{16})\|([a-z][A-Za-z0-9]{0,40})\s*\}\}/g;
/** Anything else that starts like a record placeholder (a malformed one). */
const RECORD_PLACEHOLDER_LOOSE = /\{\{\s*r:[^{}]*\}\}/g;
/** A paired inferred span (not nested; shortest match). */
const INFERRED_PAIR = /\{\{\s*inferred\s*\}\}([\s\S]*?)\{\{\s*\/inferred\s*\}\}/g;

/** The words a rendered inferred span starts with. */
export const INFERRED_LEAD = "Likely: ";

/**
 * The rendered outcomes that are not a value (authz/record-render.ts):
 *   RECORD_PENDING_TEXT — a T2 field this viewer may not see (no fresh CS tier, audit failed,
 *     export) and no T1 reference to fall back on; also the live display text of a record span
 *     BEFORE it is rendered (fail closed: never a value);
 *   RECORD_GONE_TEXT — the record (or its area) is no longer visible to this viewer.
 */
export const RECORD_PENDING_TEXT = "[restricted]";
export const RECORD_GONE_TEXT = "[no longer available]";

/** The T1 field every record has: its reference (opaque ref / code-derived label), rendered at read time. */
export const RECORD_REF_FIELD = "ref";

/** A record kind code (= evidence/record-envelope.ts RecordSchema.kind). */
export const RECORD_KIND_SHAPE = /^[A-Z][A-Z0-9_]{1,40}$/;
/** A record id as stored (cuid / uuid / provider ids): bounded, no whitespace, no braces. */
export const RECORD_ID_SHAPE = /^[A-Za-z0-9_:-]{1,64}$/;
/** A field code (= the record-envelope field-name shape; T2 names included). */
export const RECORD_FIELD_SHAPE = /^[a-z][A-Za-z0-9]{0,40}$/;

/** What the turn boundary knows about ONE handle of THIS turn (never serialised, never sent to the model). */
export interface TurnRecordRef {
  readonly rk: string;
  readonly rid: string;
  readonly a: string;
  /**
   * The field codes `{{r:h|f}}` may name for this record: "ref" + the schema's t2Fields + (S2 09io A1) the
   * schema's `placeable` CLOSED fields that THIS turn's tool returned a non-null value for (keys of `closed`).
   */
  readonly fields: readonly string[];
  /**
   * S2 09io A1/A2 — the values of those placeable closed fields EXACTLY as the tool returned them to the model this
   * turn (code / count / isoTime only). Absent for a re-minted / adopted record (no tool returned it this turn) ⇒
   * no closed field is placeable for it. Never serialised to the model; a placed one rides on the span (`v`).
   */
  readonly closed?: Readonly<Record<string, ClosedValue>>;
  /**
   * P8 — the record's CLOSED field values as the model received them (codes / counts / times / flags; never a T2
   * value). Present for records a tool returned this turn; absent for a re-minted / adopted record (unknown).
   * compose/causal.ts reads a placed incident's causeStatus / cause from here.
   */
  readonly facts?: Readonly<Record<string, unknown>>;
}

/** The turn's handle → record lookup (authz/boundary.ts `recordRef`). */
export type TurnRecordLookup = (handle: string) => TurnRecordRef | null;

/** A resolved record span (stored typed; its text is rendered at read time). */
/** `text` is ALWAYS RECORD_PENDING_TEXT (the fail-closed display marker) — never a value; the stored segment drops it. */
export interface RecordSpan {
  kind: "record"; text: typeof RECORD_PENDING_TEXT; rk: string; rid: string; a: string; f: string;
  /**
   * S2 09io A1/A2 — a CLOSED T1 field's value as THIS turn's tool returned it (code / count / isoTime; never T2,
   * never "ref"). Rendered only by authz/record-render.ts, after the same fresh area check + record revalidation +
   * tier as every record span (else the uniform "[no longer available]"). Absent for "ref" and T2 fields.
   */
  v?: number | string;
}

export const isT2Field = (f: string): f is T2FieldName => (T2_FIELD_NAMES as readonly string[]).includes(f);

/** S2 09io A1 — a placeable closed field: not "ref", not a T2 name (the record-envelope schema rule decides the rest). */
export const isClosedField = (f: string): boolean => f !== RECORD_REF_FIELD && !isT2Field(f) && RECORD_FIELD_SHAPE.test(f);

/** A stored / span closed value → its server text, or null (not a closed value: the renderer shows "unavailable"). */
export function renderClosedValue(v: unknown): string | null {
  const t = closedTypeOf(v);
  return t ? formatClosedValue(t, v) : null;
}

export interface RecordExtraction {
  /** The text with every resolved placeholder replaced by a private sentinel, every unresolved one by a space. */
  text: string;
  /** The resolved spans, in sentinel-index order. */
  spans: RecordSpan[];
  /** Placeholders that did not resolve (a foreign / forged handle, an undeclared field, a malformed one, over the cap). */
  unresolved: number;
  /** Well-formed record placeholders the model wrote (claims). */
  claims: number;
  /** P8 — per span (same index): the record's closed facts (TurnRecordRef.facts) or null. Never stored. */
  facts: (Readonly<Record<string, unknown>> | null)[];
}

/**
 * Replace every `{{r:h|f}}` the model wrote. `lookup` absent ⇒ the turn has no records: every
 * record placeholder is unresolved (today's six tools return none).
 */
export function extractRecordPlaceholders(raw: string, lookup: TurnRecordLookup | undefined): RecordExtraction {
  const spans: RecordSpan[] = [];
  const facts: (Readonly<Record<string, unknown>> | null)[] = [];
  let unresolved = 0, claims = 0;
  let text = raw.replace(RECORD_PLACEHOLDER, (_m, handle: string, field: string) => {
    claims++;
    let ref: TurnRecordRef | null = null;
    try { ref = lookup ? lookup(handle) : null; } catch { ref = null; }
    // S2 09io A1/A3: a closed field resolves ONLY with a value this turn's tool returned for this handle (the
    // boundary's `closed`), of a closed shape; anything else is the same unresolved as an unknown field.
    const closed = ref && isClosedField(field) && ref.closed && Object.prototype.hasOwnProperty.call(ref.closed, field) ? ref.closed[field] : null;
    const closedOk = !!closed && closedValueOk(closed.type, closed.value) && closedTypeOf(closed.value) === closed.type;
    const ok = !!ref && ref.fields.includes(field) && RECORD_KIND_SHAPE.test(ref.rk) && RECORD_ID_SHAPE.test(ref.rid) && RECORD_FIELD_SHAPE.test(field)
      && (!isClosedField(field) || closedOk)
      && spans.length < RECORD_SPANS_MAX;
    if (!ok) { unresolved++; return " "; }
    spans.push({ kind: "record", text: RECORD_PENDING_TEXT, rk: ref!.rk, rid: ref!.rid, a: ref!.a, f: field, ...(closedOk ? { v: closed!.value } : {}) });
    facts.push(ref!.facts ?? null);
    return `${RECORD_OPEN}${String.fromCharCode(97 + spans.length - 1)}${RECORD_CLOSE}`;
  });
  text = text.replace(RECORD_PLACEHOLDER_LOOSE, () => { unresolved++; return " "; });
  return { text, spans, unresolved, claims, facts };
}

/** Mark every paired `{{inferred}}…{{/inferred}}` with private sentinels (rendered "Likely: …" later). */
export function markInferred(raw: string): { text: string; spans: number } {
  let spans = 0;
  const text = raw.replace(INFERRED_PAIR, (_m, inner: string) => { spans++; return `${INFERRED_OPEN}${inner}${INFERRED_CLOSE}`; });
  return { text, spans };
}

/** The inferred sentinels → "Likely: " + the inner prose (the close marker vanishes). */
export const renderInferred = (t: string): string => t.replace(/\s*/g, INFERRED_LEAD).replace(//g, "");

// ── Identity shapes (fixture-independent) ────────────────────────────────────

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** A cuid (c + 24 lowercase alphanumerics, with at least one digit — so an ordinary long word is not one). */
const CUID = /\bc(?=[a-z0-9]{24}\b)(?=[a-z]*\d)[a-z0-9]{24}\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
/** A per-turn handle key written as prose. */
const HANDLE_TEXT = /\bh_[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/;

export const IDENTITY_SHAPE_KINDS = ["EMAIL", "CUID", "UUID"] as const;
export type IdentityShapeKind = (typeof IDENTITY_SHAPE_KINDS)[number];

/**
 * The identity shapes in a text (codes only — never the matched text), plus any of
 * `t2Values` (case-insensitive substring; a caller that knows the T2 values of the turn's
 * records — e.g. the E0 sentinels — passes them; the model never received one).
 */
export function identityShapesIn(text: string, t2Values: readonly string[] = []): (IdentityShapeKind | "T2_VALUE")[] {
  const lower = text.toLowerCase();
  if (t2Values.some((v) => v.length >= 3 && lower.includes(v.toLowerCase()))) return ["T2_VALUE"];
  const out: IdentityShapeKind[] = [];
  if (EMAIL.test(text)) out.push("EMAIL");
  if (CUID.test(text)) out.push("CUID");
  if (UUID.test(text)) out.push("UUID");
  return out;
}

/** True when a handle key appears as plain prose (a record the model did not place). */
export const hasHandleText = (text: string): boolean => HANDLE_TEXT.test(text);

// ── Replay markers (history → the model) ─────────────────────────────────────

/** "CUSTOMER" ⇒ "customer", "SYNC_INCIDENT" ⇒ "sync incident" — a closed code, never data. */
export const recordKindWord = (rk: string): string => (RECORD_KIND_SHAPE.test(rk) ? rk.toLowerCase().replace(/_/g, " ") : "record");

/**
 * A prior answer's record span as the model sees it in replay: `[customer]`, or
 * `[customer h_…]` when THIS turn re-minted a handle for it (area recheck + revalidate passed).
 * Never an id, never a value.
 */
export const recordReplayMarker = (rk: string, handle: string | null): string =>
  handle ? `[${recordKindWord(rk)} ${handle}]` : `[${recordKindWord(rk)}]`;
