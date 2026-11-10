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
 * No database, no key, no I/O.
 */

/** Registry ids (metric keys like "provider-outcome@1", page ids like "PLATFORM_OPS:platform-incidents:open"). */
export const REF_ID_SHAPE = /^[A-Za-z0-9_:@.-]{1,120}$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export const STORED_ANSWER_VERSION = 1 as const;
export const STORED_SEGMENTS_MAX = 200;
export const STORED_TEXT_MAX = 4_000;
export const STORED_CITATIONS_MAX = 24;
export const STORED_NOTES_MAX = 24;
export const EVIDENCE_REFS_MAX = 32;

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
  | { kind: "memory"; text: string };

/** The only text a stored memory span may carry. */
export const MEMORY_SPAN_SHAPE = /^noted \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}( — (now changed|updated since))?$/;

export interface StoredCitation { metric: string; label: string; window: string }

export type StoredStop = "ANSWERED" | "ROUND_LIMIT" | "TOKEN_CEILING";

export interface StoredAnswerV1 {
  v: typeof STORED_ANSWER_VERSION;
  segments: StoredSegment[];
  citations: StoredCitation[];
  /** Deterministic, code-written notes (never model text). */
  notes: string[];
  stop: StoredStop;
}

export type EvidenceRef =
  | { k: "m"; id: string; w: number | null }
  | { k: "p"; id: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, max = STORED_TEXT_MAX): v is string => typeof v === "string" && v.length <= max;
const isRefId = (v: unknown): v is string => typeof v === "string" && REF_ID_SHAPE.test(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => k in o);

function validSegment(s: unknown): s is StoredSegment {
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
      return entries.length <= 8 && entries.every(([k, v]) => PARAM_KEY.test(k) && typeof v === "string" && v.length <= 120);
    }
    default: return false;
  }
}

function validCitation(c: unknown): c is StoredCitation {
  return isObj(c) && exactKeys(c, ["metric", "label", "window"]) && isRefId(c.metric) && isText(c.label, 200) && isText(c.window, 200);
}

/** True when `a` is exactly a StoredAnswerV1 (no extra keys anywhere, every bound respected). */
export function isStoredAnswer(a: unknown): a is StoredAnswerV1 {
  return isObj(a) && exactKeys(a, ["v", "segments", "citations", "notes", "stop"]) && a.v === STORED_ANSWER_VERSION
    && Array.isArray(a.segments) && a.segments.length <= STORED_SEGMENTS_MAX && a.segments.every(validSegment)
    && Array.isArray(a.citations) && a.citations.length <= STORED_CITATIONS_MAX && a.citations.every(validCitation)
    && Array.isArray(a.notes) && a.notes.length <= STORED_NOTES_MAX && a.notes.every((n) => isText(n, 400))
    && (a.stop === "ANSWERED" || a.stop === "ROUND_LIMIT" || a.stop === "TOKEN_CEILING");
}

export class StoredShapeError extends Error {
  constructor(message: string) { super(message); this.name = "StoredShapeError"; }
}

/** The plaintext an ASSISTANT row stores. THROWS on any shape violation — a malformed answer is never stored. */
export function serializeStoredAnswer(a: StoredAnswerV1): string {
  if (!isStoredAnswer(a)) throw new StoredShapeError("refusing to store an answer that is not a valid StoredAnswerV1");
  return JSON.stringify(a);
}

/** Defensive read: null when the plaintext is not a valid StoredAnswerV1 (never shown as raw text). */
export function parseStoredAnswer(plaintext: string): StoredAnswerV1 | null {
  try {
    const a: unknown = JSON.parse(plaintext);
    return isStoredAnswer(a) ? a : null;
  } catch {
    return null;
  }
}

function validRef(r: unknown): r is EvidenceRef {
  if (!isObj(r)) return false;
  if (r.k === "m") return exactKeys(r, ["k", "id", "w"]) && isRefId(r.id) && (r.w === null || (typeof r.w === "number" && Number.isInteger(r.w) && r.w > 0 && r.w <= 3660));
  if (r.k === "p") return exactKeys(r, ["k", "id"]) && isRefId(r.id);
  return false;
}

/** The evidenceRefs an ASSISTANT row stores. THROWS on any shape violation (keys + windows + page ids only). */
export function validateEvidenceRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  if (!Array.isArray(refs) || refs.length > EVIDENCE_REFS_MAX || !refs.every(validRef)) {
    throw new StoredShapeError("refusing to store evidence refs that are not metric keys, windows and page ids only");
  }
  return refs.map((r) => (r.k === "m" ? { k: "m", id: r.id, w: r.w } : { k: "p", id: r.id }));
}

/** Defensive read: the valid refs of a stored value (anything else dropped). */
export function parseEvidenceRefs(v: unknown): EvidenceRef[] {
  return Array.isArray(v) ? v.filter(validRef).slice(0, EVIDENCE_REFS_MAX) : [];
}
