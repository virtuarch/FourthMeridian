/**
 * lib/platform/intelligence/ai/conversations/answer.ts  (the stored message shapes — PURE)
 *
 * Design §2.5. The ASSISTANT plaintext, before encryption, is versioned JSON:
 * WHAT THE OPERATOR SAW ("stored as rendered", S2 B3) — figures stay TYPED
 * (metric key + the server-rendered text) so history assembly can mask them
 * and the UI can label them stale; links are stored as a registry PAGE ID plus
 * (string) params, never an href, and are re-resolved through the current token on
 * every read (§3.4).
 *
 * `evidenceRefs` (S2 B1, Q7) are what a turn READ: metric keys, windows and
 * page ids ONLY — never a value, status, reason, href or argument the model
 * wrote. Both shapes are validated strictly on the way IN (a malformed value
 * is never stored) and defensively on the way OUT (a value that fails to
 * parse reads as unavailable, never as text).
 *
 * P4 — StoredAnswerV2 (Platform AI design v2 §8.1, invariant I-1; S2 ruling 3):
 *   · a RECORD segment `{kind:"record", rk, rid, a, f}` — the record kind, its id, its
 *     area and a field CODE (a T2 field only as its code, e.g. f:"name"; the value is
 *     NEVER stored). Its text is rendered at READ time by authz/record-render.ts — the only
 *     T2 path. The record id lives ONLY here, inside the encrypted plaintext;
 *   · stop "COST_CAP";
 *   · `evidenceRefs` (plain JSONB) gain `{k:"a", id: area}` (the areas a turn read) and
 *     `{k:"r", t: recordKind, n: count}` — kinds and counts, NEVER a record id;
 *   · THE IDENTITY RULE (every version, on the way IN): a model-written text segment (text, a
 *     link label) carrying an identity shape (an email, a cuid / uuid-shaped id), a handle
 *     key, or any T2 value the caller knows (`t2Values`) is REFUSED — never stored
 *     (IDENTITY_LEAK; the turn's own verdict has already replaced such an answer, this is
 *     defence in depth). The opaque "user #xxxxxxxx" T1 ref is allowed.
 * VERSIONING: the writer emits the LOWEST version that can express the answer
 * (storableAnswerVersion) — an answer with no record segment and no COST_CAP stop is
 * written as V1, byte-identical to before P4, so a rollback can still read every row
 * written by today's tools. The reader accepts V1 | V2 (V1 rows stay readable as they are).
 *
 * No database, no key, no I/O.
 */

import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";
import { RECORD_FIELD_SHAPE, RECORD_ID_SHAPE, RECORD_KIND_SHAPE, hasHandleText, identityShapesIn } from "../compose/record";

/** Registry ids (metric keys like "provider-outcome@1", page ids like "PLATFORM_OPS:platform-incidents:open"). */
export const REF_ID_SHAPE = /^[A-Za-z0-9_:@.-]{1,120}$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export const STORED_ANSWER_VERSION = 1 as const;
/** P4 — the version that can carry record segments and the COST_CAP stop. */
export const STORED_ANSWER_V2 = 2 as const;
export const STORED_SEGMENTS_MAX = 200;
export const STORED_TEXT_MAX = 4_000;
export const STORED_CITATIONS_MAX = 24;
export const STORED_NOTES_MAX = 24;
export const EVIDENCE_REFS_MAX = 32;
/** P4 — at most this many record segments per stored answer (= compose/record.ts RECORD_SPANS_MAX). */
export const STORED_RECORDS_MAX = 20;

/** P4 (V2 only) — a record placed by {{r:h|field}}: kind, id, area, field CODE. Never a value; never in evidenceRefs. */
export interface StoredRecordSegment { kind: "record"; rk: string; rid: string; a: string; f: string }

export type StoredSegment =
  | { kind: "text"; text: string }
  /** A figure span: the server-rendered text plus the metric it came from (and its window). */
  | { kind: "figure"; text: string; metric: string; window: string | number | null }
  /** A link: a registry page id plus params — NEVER an href (re-resolved on every read). */
  | { kind: "link"; text: string; page: string; params: Record<string, string> }
  /** S2 F-C1 (ii): the server's code-written period CORRECTION (shown above the answer; never model text). */
  | { kind: "correction"; text: string }
  /** F-1 (S2 2026-11-08): the server's code-written WINDOW NOTE (its own segment, shown above the answer; never model text). */
  | { kind: "note"; text: string }
  /**
   * Platform AI memory (design v2 §4): a server-rendered {{mem:<id>}} span. Its text is
   * EXACTLY "noted <d Mon yyyy>" (+ " — now changed" / " — updated since") — never the
   * note, never a fact id (MEMORY_SPAN_SHAPE, enforced on store).
   */
  | { kind: "memory"; text: string }
  /** P4 — V2 only. */
  | StoredRecordSegment;

/** The only text a stored memory span may carry. */
export const MEMORY_SPAN_SHAPE = /^noted \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}( — (now changed|updated since))?$/;

export interface StoredCitation { metric: string; label: string; window: string }

/** "COST_CAP" is V2 only (P4). */
export type StoredStop = "ANSWERED" | "ROUND_LIMIT" | "TOKEN_CEILING" | "COST_CAP";

/** A stored answer, V1 or V2 (the validator enforces what each version may carry). */
export interface StoredAnswer {
  v: typeof STORED_ANSWER_VERSION | typeof STORED_ANSWER_V2;
  segments: StoredSegment[];
  citations: StoredCitation[];
  /** Deterministic, code-written notes (never model text). */
  notes: string[];
  stop: StoredStop;
}

/** The pre-P4 name (tests and V1 fixtures use it): the same shape. */
export type StoredAnswerV1 = StoredAnswer;

export type EvidenceRef =
  | { k: "m"; id: string; w: number | null }
  | { k: "p"; id: string }
  /** P4 — an area the turn read (the areasRead provenance). */
  | { k: "a"; id: string }
  /** P4 — a record KIND the answer placed and how many (never an id). */
  | { k: "r"; t: string; n: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, max = STORED_TEXT_MAX): v is string => typeof v === "string" && v.length <= max;
const isRefId = (v: unknown): v is string => typeof v === "string" && REF_ID_SHAPE.test(v);
const isArea = (v: unknown): v is string => typeof v === "string" && (ALL_PLATFORM_AREAS as readonly string[]).includes(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => k in o);

function validSegment(s: unknown, v: number): s is StoredSegment {
  if (!isObj(s)) return false;
  switch (s.kind) {
    case "text":
    case "correction":
    case "note": return exactKeys(s, ["kind", "text"]) && isText(s.text);
    case "memory": return exactKeys(s, ["kind", "text"]) && typeof s.text === "string" && MEMORY_SPAN_SHAPE.test(s.text);
    case "figure":
      return exactKeys(s, ["kind", "text", "metric", "window"]) && isText(s.text, 120) && isRefId(s.metric)
        && (s.window === null || (typeof s.window === "number" && Number.isInteger(s.window) && s.window > 0 && s.window <= 3660) || isText(s.window, 120));
    case "link": {
      if (!exactKeys(s, ["kind", "text", "page", "params"]) || !isText(s.text, 200) || !isRefId(s.page) || !isObj(s.params)) return false;
      const entries = Object.entries(s.params);
      return entries.length <= 8 && entries.every(([k, val]) => PARAM_KEY.test(k) && typeof val === "string" && val.length <= 120);
    }
    case "record":
      return v === STORED_ANSWER_V2 && exactKeys(s, ["kind", "rk", "rid", "a", "f"])
        && typeof s.rk === "string" && RECORD_KIND_SHAPE.test(s.rk)
        && typeof s.rid === "string" && RECORD_ID_SHAPE.test(s.rid)
        && isArea(s.a)
        && typeof s.f === "string" && RECORD_FIELD_SHAPE.test(s.f);
    default: return false;
  }
}

function validCitation(c: unknown): c is StoredCitation {
  return isObj(c) && exactKeys(c, ["metric", "label", "window"]) && isRefId(c.metric) && isText(c.label, 200) && isText(c.window, 200);
}

/** True when `a` is exactly a StoredAnswer of its declared version (no extra keys anywhere, every bound respected). */
export function isStoredAnswer(a: unknown): a is StoredAnswer {
  if (!isObj(a) || !exactKeys(a, ["v", "segments", "citations", "notes", "stop"])) return false;
  const v = a.v;
  if (v !== STORED_ANSWER_VERSION && v !== STORED_ANSWER_V2) return false;
  return Array.isArray(a.segments) && a.segments.length <= STORED_SEGMENTS_MAX && a.segments.every((s) => validSegment(s, v))
    && a.segments.filter((s) => (s as { kind?: unknown }).kind === "record").length <= STORED_RECORDS_MAX
    && Array.isArray(a.citations) && a.citations.length <= STORED_CITATIONS_MAX && a.citations.every(validCitation)
    && Array.isArray(a.notes) && a.notes.length <= STORED_NOTES_MAX && a.notes.every((n) => isText(n, 400))
    && (a.stop === "ANSWERED" || a.stop === "ROUND_LIMIT" || a.stop === "TOKEN_CEILING" || (v === STORED_ANSWER_V2 && a.stop === "COST_CAP"));
}

/** The lowest version that can express `a` (V2 only for a record segment or the COST_CAP stop). */
export function storableAnswerVersion(a: Pick<StoredAnswer, "segments" | "stop">): typeof STORED_ANSWER_VERSION | typeof STORED_ANSWER_V2 {
  return a.stop === "COST_CAP" || a.segments.some((s) => s.kind === "record") ? STORED_ANSWER_V2 : STORED_ANSWER_VERSION;
}

/**
 * P4 — the identity rule over the MODEL-written text of an answer (text segments and link
 * labels; server-written figures, notes, corrections and memory spans are code text): the
 * identity-shape kinds found, "HANDLE" for a handle key, "T2_VALUE" for a known T2 value.
 * Codes only — never the matched text.
 */
export function answerIdentityProblems(a: Pick<StoredAnswer, "segments">, t2Values: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const s of a.segments) {
    if (s.kind !== "text" && s.kind !== "link") continue;
    for (const k of identityShapesIn(s.text, t2Values)) out.add(k);
    if (hasHandleText(s.text)) out.add("HANDLE");
  }
  return [...out];
}

export class StoredShapeError extends Error {
  constructor(message: string) { super(message); this.name = "StoredShapeError"; }
}

/**
 * The plaintext an ASSISTANT row stores. THROWS on any shape violation — a malformed answer
 * is never stored — and on the identity rule (IDENTITY_LEAK: never stored). `t2Values` = any
 * T2 value the caller knows for this turn's records (the model never received one).
 */
export function serializeStoredAnswer(a: StoredAnswer, opts: { t2Values?: readonly string[] } = {}): string {
  if (!isStoredAnswer(a)) throw new StoredShapeError("refusing to store an answer that is not a valid StoredAnswer (V1 | V2)");
  if (a.v !== storableAnswerVersion(a)) throw new StoredShapeError("refusing to store an answer under a version other than the lowest that expresses it");
  if (answerIdentityProblems(a, opts.t2Values).length > 0) throw new StoredShapeError("refusing to store an answer whose text carries an identity (IDENTITY_LEAK)");
  return JSON.stringify(a);
}

/** Defensive read: null when the plaintext is not a valid StoredAnswer V1 | V2 (never shown as raw text). */
export function parseStoredAnswer(plaintext: string): StoredAnswer | null {
  try {
    const a: unknown = JSON.parse(plaintext);
    return isStoredAnswer(a) ? a : null;
  } catch {
    return null;
  }
}

/** The record segments of a stored answer (for the read-time renderer). */
export const storedRecordSegments = (a: StoredAnswer): StoredRecordSegment[] =>
  a.segments.filter((s): s is StoredRecordSegment => s.kind === "record");

function validRef(r: unknown): r is EvidenceRef {
  if (!isObj(r)) return false;
  if (r.k === "m") return exactKeys(r, ["k", "id", "w"]) && isRefId(r.id) && (r.w === null || (typeof r.w === "number" && Number.isInteger(r.w) && r.w > 0 && r.w <= 3660));
  if (r.k === "p") return exactKeys(r, ["k", "id"]) && isRefId(r.id);
  if (r.k === "a") return exactKeys(r, ["k", "id"]) && isArea(r.id);
  if (r.k === "r") return exactKeys(r, ["k", "t", "n"]) && typeof r.t === "string" && RECORD_KIND_SHAPE.test(r.t) && typeof r.n === "number" && Number.isInteger(r.n) && r.n >= 1 && r.n <= STORED_RECORDS_MAX;
  return false;
}

/** The evidenceRefs an ASSISTANT row stores. THROWS on any shape violation (keys + windows + page ids + areas + record kinds/counts only). */
export function validateEvidenceRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  if (!Array.isArray(refs) || refs.length > EVIDENCE_REFS_MAX || !refs.every(validRef)) {
    throw new StoredShapeError("refusing to store evidence refs that are not metric keys, windows, page ids, areas and record kinds / counts only");
  }
  return refs.map((r): EvidenceRef => {
    switch (r.k) {
      case "m": return { k: "m", id: r.id, w: r.w };
      case "p": return { k: "p", id: r.id };
      case "a": return { k: "a", id: r.id };
      case "r": return { k: "r", t: r.t, n: r.n };
    }
  });
}

/** Defensive read: the valid refs of a stored value (anything else dropped). */
export function parseEvidenceRefs(v: unknown): EvidenceRef[] {
  return Array.isArray(v) ? v.filter(validRef).slice(0, EVIDENCE_REFS_MAX) : [];
}
