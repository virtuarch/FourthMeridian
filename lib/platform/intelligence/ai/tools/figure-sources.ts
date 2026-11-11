/**
 * lib/platform/intelligence/ai/tools/figure-sources.ts  (Platform AI — the RESPONSE's metadata-only figure sources, B1)
 *
 * Every answered turn's response (POST /api/platform/ai/ask, and the conversations' create / append
 * turn) carries `figureSources`: for each SERVER-PLACED span of the answer — a record field the model
 * placed with {{r:<handle>|<field>}}, or a metric figure it placed with {{m:<key>[|part=<name>]}} —
 * WHERE that span sits in the response and WHICH closed source it was filled from:
 *
 *   { segment, start, end, source: "record", recordKind, fieldCode }     — a record span
 *   { segment, start, end, source: "metric", metricKey, resultPath }     — a metric figure span
 *
 *   THE CLOSED KEY SET: FIGURE_SOURCE_KEYS (each entry carries exactly the record or the metric subset;
 *   pinned by figure-sources.test.ts).
 *
 *   segment     the index of the segment in the response's OWN rendered answer array that holds the span:
 *               /ask ⇒ body.answer; conversations ⇒ body.assistantMessage.content.
 *   start, end  UTF-16 offsets of the span inside that segment's text (segment.text.slice(start, end) is
 *               exactly the text the server rendered for the span). In a conversation every placed span is
 *               its own segment (start 0, end = its length).
 *   recordKind  a record kind DECLARED by a registered RECORD tool's schema (tools/registry.ts).
 *   fieldCode   "ref", a T2 field NAME a schema of that kind declares (t2Fields) or a field the schemas of that
 *               kind declare — the field CODE the placeholder named, never its value.
 *   metricKey   a registered metric key (metrics/registry.ts).
 *   resultPath  the JSON path of the figure inside get_metric's result for that key: "value" (a scalar) or
 *               "value.<part>" with <part> one of the parts that metric's retrieval contract declares
 *               (metrics/retrieve-core.ts RETRIEVAL[key].valueUnits).
 *
 * S2 conditions (B1): (i) DERIVED FROM CODE ONLY — the source is the placeholder FILL (compose/record.ts
 * extractRecordPlaceholders' typed span; compose/placeholders.ts / briefing.ts typed figure), never inferred
 * from model text; (ii) never a record id, ref value, handle, area, rendered value or any customer data — a
 * span whose kind / field / key / part is outside the closed sets is simply NOT annotated; (iii) the same
 * projection for EVERY operator (no operator / synthetic branch; only the rendered text the viewer already
 * sees sets the offsets); (iv) response only — the conversations handler splits it off BEFORE the settle,
 * so it is never stored and never on a replay; (v) closed key set + fuzz (figure-sources.test.ts).
 *
 * POSITIONING IS FAIL-CLOSED: the spans are aligned against the very segments the response carries; if the
 * typed answer and the rendered answer disagree anywhere (a stored figure turned into text, a memory
 * redaction, a lost area, a cap), the whole annotation is [] — never a guessed position.
 *
 * Imports the registry (server code): call it from the routes / turn runner / handlers only, never from core.ts.
 */

import { METRICS, metricKey } from "@/lib/platform/intelligence/metrics/registry";
import { RETRIEVAL } from "@/lib/platform/intelligence/metrics/retrieve-core";
import type { TypedAnswerSegment } from "../compose/segments";
import { RECORD_REF_FIELD } from "../compose/record";
import { T2_FIELD_NAMES } from "../evidence/record-envelope";
import { PLATFORM_AI_TOOL_REGISTRY } from "./registry";

/** THE closed key set (a record entry carries the first six minus the metric pair; a metric entry the reverse). */
export const FIGURE_SOURCE_KEYS = ["segment", "start", "end", "source", "recordKind", "fieldCode", "metricKey", "resultPath"] as const;
export const FIGURE_SOURCE_RECORD_KEYS = ["segment", "start", "end", "source", "recordKind", "fieldCode"] as const;
export const FIGURE_SOURCE_METRIC_KEYS = ["segment", "start", "end", "source", "metricKey", "resultPath"] as const;
export const FIGURE_SOURCE_KINDS = ["record", "metric"] as const;

/** A placed span's closed source (no position yet). */
export type PlacedFigureSource =
  | { readonly source: "record"; readonly recordKind: string; readonly fieldCode: string }
  | { readonly source: "metric"; readonly metricKey: string; readonly resultPath: string };

/** One response entry. */
export type FigureSourceEntry = { readonly segment: number; readonly start: number; readonly end: number } & PlacedFigureSource;

/**
 * One placed span of the typed answer, in answer order: its span kind and its closed source (null when the
 * span is outside the closed sets — kept so positions stay aligned, never annotated). Metadata only.
 */
export interface PlacedSpan { readonly span: "figure" | "record"; readonly entry: PlacedFigureSource | null }

type RegistryView = readonly { readonly recordSchema?: { readonly kind: string; readonly fields: Readonly<Record<string, unknown>>; readonly t2Fields?: readonly string[] } }[];

/** recordKind → its closed field codes ("ref" + the T2 NAMES its schemas declare + every schema field of that kind). */
export function recordFieldCodes(registry: RegistryView = PLATFORM_AI_TOOL_REGISTRY): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of registry) {
    const s = t.recordSchema;
    if (!s || typeof s.kind !== "string") continue;
    const set = out.get(s.kind) ?? new Set<string>([RECORD_REF_FIELD]);
    for (const f of s.t2Fields ?? []) if ((T2_FIELD_NAMES as readonly string[]).includes(f)) set.add(f);
    for (const f of Object.keys(s.fields ?? {})) set.add(f);
    out.set(s.kind, set);
  }
  return out;
}

type FieldCodes = ReadonlyMap<string, ReadonlySet<string>>;

const RECORD_FIELDS = recordFieldCodes();
const METRIC_KEYS: ReadonlySet<string> = new Set(METRICS.map(metricKey));

/** The declared parts of a metric's value (empty for a scalar / not retrievable / unknown key). */
export function metricParts(key: string): readonly string[] {
  const r = Object.prototype.hasOwnProperty.call(RETRIEVAL, key) ? RETRIEVAL[key] : null;
  if (!r || r.kind !== "RETRIEVABLE" || r.valueUnits === null || typeof r.valueUnits !== "object") return [];
  return Object.keys(r.valueUnits);
}

/** One typed span → its closed source, or null (outside the closed sets). Reads ONLY rk / f / metric / part. */
export function placedSourceOf(t: TypedAnswerSegment, fields: FieldCodes = RECORD_FIELDS): PlacedFigureSource | null {
  if (t.kind === "record") {
    const rk: unknown = t.rk, f: unknown = t.f;
    if (typeof rk !== "string" || typeof f !== "string") return null;
    const allowed = fields.get(rk);
    return allowed && allowed.has(f) ? { source: "record", recordKind: rk, fieldCode: f } : null;
  }
  if (t.kind === "figure") {
    const key: unknown = t.metric, part: unknown = t.part;
    if (typeof key !== "string" || !METRIC_KEYS.has(key)) return null;
    if (part === undefined || part === null) return { source: "metric", metricKey: key, resultPath: "value" };
    return typeof part === "string" && metricParts(key).includes(part) ? { source: "metric", metricKey: key, resultPath: `value.${part}` } : null;
  }
  return null;
}

/** The typed answer's placed spans, in order (figures and records only). */
export function placedSpansOf(typed: readonly TypedAnswerSegment[], fields: FieldCodes = RECORD_FIELDS): PlacedSpan[] {
  const out: PlacedSpan[] = [];
  for (const t of Array.isArray(typed) ? typed : []) {
    if (t?.kind === "figure" || t?.kind === "record") out.push(Object.freeze({ span: t.kind, entry: placedSourceOf(t, fields) }));
  }
  return out;
}

const entryOf = (segment: number, start: number, end: number, e: PlacedFigureSource): FigureSourceEntry =>
  Object.freeze(e.source === "record"
    ? { segment, start, end, source: "record" as const, recordKind: e.recordKind, fieldCode: e.fieldCode }
    : { segment, start, end, source: "metric" as const, metricKey: e.metricKey, resultPath: e.resultPath });

type Rendered = { readonly kind: string; readonly text: string };

/**
 * /ask — the typed answer aligned with the DISPLAY answer the response carries (`answer`): every typed element
 * is walked over the display text in order (text may span merged segments; a figure / record span must sit
 * inside ONE text segment; a link / note / correction must be the same segment). `recordText` is the text the
 * display shows for a record span (rendered for this viewer, or its fail-closed marker). Any disagreement ⇒ [].
 */
export function alignedFigureSources(typed: readonly TypedAnswerSegment[], answer: readonly Rendered[], recordText: (t: Extract<TypedAnswerSegment, { kind: "record" }>) => string,
  fields: FieldCodes = RECORD_FIELDS): FigureSourceEntry[] {
  if (!Array.isArray(typed) || !Array.isArray(answer)) return [];
  const out: FigureSourceEntry[] = [];
  let i = 0, off = 0;
  // Past the end of a text segment ⇒ the next segment (an empty text segment is passed over).
  const settle = () => { while (i < answer.length && answer[i].kind === "text" && off >= answer[i].text.length) { i++; off = 0; } };
  for (const t of typed) {
    if (t.kind === "link" || t.kind === "note" || t.kind === "correction") {
      settle();
      if (off !== 0 || i >= answer.length || answer[i].kind !== t.kind || answer[i].text !== t.text) return [];
      i++; off = 0;
      continue;
    }
    if (t.kind === "figure" || t.kind === "record") {
      const text = t.kind === "record" ? recordText(t) : t.text;
      settle();
      const seg = answer[i];
      if (!seg || seg.kind !== "text" || !seg.text.startsWith(text, off)) return [];
      const e = placedSourceOf(t, fields);
      if (e) out.push(entryOf(i, off, off + text.length, e));
      off += text.length;
      continue;
    }
    // text / memory: plain display text, possibly across merged text segments.
    let rest = t.text;
    while (rest.length > 0) {
      settle();
      const seg = answer[i];
      if (!seg || seg.kind !== "text") return [];
      const n = Math.min(rest.length, seg.text.length - off);
      if (n <= 0 || seg.text.slice(off, off + n) !== rest.slice(0, n)) return [];
      off += n; rest = rest.slice(n);
    }
  }
  settle();
  // Everything the response shows must have been walked (no unexplained trailing text).
  return i === answer.length ? out : [];
}

type StoredView = { readonly kind: string; readonly metric?: unknown; readonly rk?: unknown; readonly f?: unknown };

/**
 * Conversations — the turn's placed spans aligned with the STORED answer's segments (1:1 with the response's
 * `assistantMessage.content`, conversations/handlers.ts renderStoredAnswer): the n-th placed span must be the
 * n-th stored figure / record segment, of the same span kind and (for an annotated span) the same metric key /
 * record kind + field code. Counts or codes differ, or the content is not 1:1 ⇒ [].
 */
export function storedFigureSources(placed: readonly PlacedSpan[], stored: readonly StoredView[], content: readonly Rendered[]): FigureSourceEntry[] {
  if (!Array.isArray(placed) || !Array.isArray(stored) || !Array.isArray(content) || stored.length !== content.length) return [];
  const out: FigureSourceEntry[] = [];
  let n = 0;
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i];
    if (s.kind !== "figure" && s.kind !== "record") continue;
    const p = placed[n++];
    if (!p || p.span !== s.kind) return [];
    const e = p.entry;
    if (e) {
      const same = e.source === "metric" ? s.kind === "figure" && s.metric === e.metricKey : s.kind === "record" && s.rk === e.recordKind && s.f === e.fieldCode;
      if (!same) return [];
      const c = content[i];
      if (!c || typeof c.text !== "string") return [];
      out.push(entryOf(i, 0, c.text.length, e));
    }
  }
  return n === placed.length ? out : [];
}
