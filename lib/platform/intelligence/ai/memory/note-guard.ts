/**
 * lib/platform/intelligence/ai/memory/note-guard.ts  (Platform AI operational memory — the note guard)
 *
 * Design v2 §2 "Note guard" (B6 amounts, D7 verbatim spans). PURE. The note is
 * the operator's own ≤ 140-character text on a memory fact; it is the ONLY free
 * text memory keeps, so it is held to a closed reason code:
 *
 *   NOTE_TOO_LONG      over MEMORY_NOTE_MAX_BYTES UTF-8 bytes after clipping (cipher bound)
 *   NOTE_IDENTIFIER    scrubOperatorText(note) !== note — an email, an id, a run of
 *                      4+ digits, a card / account shape
 *   NOTE_LINK          an `@`, a URL or braces
 *   NOTE_IDENTITY      the customer-identity scan (a user / operator reference, a cuid,
 *                      an email, a subject-id field name)
 *   NOTE_AMOUNT        (B6) a digit beside a currency sign; a digit + k / m / bn; any
 *                      \d[,.]\d; a percentage tied to a digit
 *   NOTE_VERBATIM      (D7) at PROPOSE time: a span of ≥ 6 words or ≥ 40 characters of
 *                      this turn's question, answer or replayed history. At CONFIRM time
 *                      the token's HMAC shingles decide (./token.ts, B5).
 *
 * Accepted residual (S2, 2026-11-08): a sub-6-word span of ≥ 40 characters in an
 * EDITED note is caught only at propose time (the token carries no plaintext).
 */

import { scrubOperatorText } from "@/lib/ai/privacy/scrub";
import { MEMORY_NOTE_MAX, MEMORY_NOTE_MAX_BYTES, MEMORY_SHINGLE_WORDS, MEMORY_VERBATIM_CHARS } from "./constants";

export const NOTE_REFUSALS = ["NOTE_TOO_LONG", "NOTE_IDENTIFIER", "NOTE_LINK", "NOTE_IDENTITY", "NOTE_AMOUNT", "NOTE_VERBATIM"] as const;
export type NoteRefusal = (typeof NOTE_REFUSALS)[number];

export type NoteVerdict = { ok: true; note: string | null } | { ok: false; reason: NoteRefusal };

/** Whitespace collapsed, trimmed, clipped to MEMORY_NOTE_MAX characters. Empty ⇒ null (no note). */
export function clipNote(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const n = Array.from(raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, MEMORY_NOTE_MAX).join("").trim();
  return n.length > 0 ? n : null;
}

const LINK = /@|[{}]|https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|app|dev|co|ai|us|uk)\b/i;
/**
 * P4 (design v2 §8.4, I-2; S2 binding ruling 1 — rejected at WRITE): also a uuid-shaped id and a
 * Platform AI record HANDLE key ("h_" + 16 base64url, authz/handles.ts) — memory never keeps a
 * customer or record ref, not even a per-turn one.
 */
const IDENTITY = [
  /subjectUserId/i, /\buser #/i, /\boperator #/i, /\bc[a-z0-9]{20,}\b/i, /[^\s@"\\]+@[^\s@"\\]+\.[a-z]{2,}/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\bh_[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/,
];
/** B6 — an amount, in any of the shapes the design names. */
export const AMOUNT_SHAPES: readonly RegExp[] = [
  /[$€£¥]\s?\d|\d\s?[$€£¥]/,
  /\d\s?(?:k|m|bn)\b/i,
  /\d[,.]\d/,
  /\d\s?%|\d\s?(?:percent|pct)\b/i,
];

export const hasAmount = (s: string): boolean => AMOUNT_SHAPES.some((r) => r.test(s));

/** Lowercase, punctuation stripped, whitespace collapsed (design v2 B5 normalisation). */
export function normaliseForShingles(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** The consecutive MEMORY_SHINGLE_WORDS-word windows of normalised text, in order. */
export function wordShingles(text: string, n = MEMORY_SHINGLE_WORDS): string[] {
  const w = normaliseForShingles(text).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" "));
  return out;
}

/**
 * The word-aligned MEMORY_VERBATIM_CHARS-character windows of normalised text: one per
 * word start (the window may run across words). The confirm-time counterpart of the
 * character rule (B5 MACs these with a "c:" tag beside the "w:" word shingles).
 */
export function charWindows(text: string, n = MEMORY_VERBATIM_CHARS): string[] {
  const t = normaliseForShingles(text);
  const out: string[] = [];
  for (let i = 0; i + n <= t.length; i++) if (i === 0 || t[i - 1] === " ") out.push(t.slice(i, i + n));
  return out;
}

/** D7 at propose time: a ≥ 6-word or ≥ MEMORY_VERBATIM_CHARS-character span of any source, in the note. */
export function hasVerbatimSpan(note: string, sources: readonly string[]): boolean {
  const normNote = normaliseForShingles(note);
  const normSources = sources.map(normaliseForShingles).filter(Boolean);
  if (normSources.length === 0) return false;
  const srcShingles = new Set(normSources.flatMap((s) => wordShingles(s)));
  if (wordShingles(note).some((s) => srcShingles.has(s))) return true;
  for (let i = 0; i + MEMORY_VERBATIM_CHARS <= normNote.length; i++) {
    const span = normNote.slice(i, i + MEMORY_VERBATIM_CHARS);
    if (normSources.some((s) => s.includes(span))) return true;
  }
  return false;
}

/** What a stored answer shows where it echoed a saved note (S2 C1). */
export const SAVED_NOTE_REDACTION = "[your saved note]";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * S2 C1 — replace every span of `note` that `text` repeats verbatim at the guard's
 * threshold (≥ 6 words or ≥ MEMORY_VERBATIM_CHARS characters, punctuation and case
 * ignored) with SAVED_NOTE_REDACTION. Whole-word runs of the note, longest first;
 * if a (mid-word) span still remains, the whole text is replaced — never stored.
 */
export function redactNoteSpans(text: string, note: string): string {
  if (!note || !hasVerbatimSpan(note, [text])) return text;
  const words = normaliseForShingles(note).split(" ").filter(Boolean);
  let out = text;
  for (let len = words.length; len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const body = words.slice(i, i + len).map(escapeRe).join("[^\\p{L}\\p{N}]+");
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
      out = out.replace(re, (m) => (len >= MEMORY_SHINGLE_WORDS || m.length >= MEMORY_VERBATIM_CHARS ? SAVED_NOTE_REDACTION : m));
    }
  }
  return hasVerbatimSpan(note, [out]) ? SAVED_NOTE_REDACTION : out;
}

/**
 * The guard. `ctx.verbatimSources` (propose time only) = this turn's question,
 * answer and replayed history. The Remember button passes none: its note is the
 * operator's own, written with no turn context.
 */
export function validateOperatorNote(raw: string | null | undefined, ctx: { verbatimSources?: readonly string[] } = {}): NoteVerdict {
  const note = clipNote(raw);
  if (note === null) return { ok: true, note: null };
  if (new TextEncoder().encode(note).length > MEMORY_NOTE_MAX_BYTES) return { ok: false, reason: "NOTE_TOO_LONG" };
  if (LINK.test(note)) return { ok: false, reason: "NOTE_LINK" };
  if (IDENTITY.some((r) => r.test(note))) return { ok: false, reason: "NOTE_IDENTITY" };
  // The scrub's one period-year exemption ("October 2026") does not apply to a stored note: any 4+ digit run is refused.
  if (scrubOperatorText(note, MEMORY_NOTE_MAX) !== note || /\d{4,}/.test(note)) return { ok: false, reason: "NOTE_IDENTIFIER" };
  if (hasAmount(note)) return { ok: false, reason: "NOTE_AMOUNT" };
  if (ctx.verbatimSources && hasVerbatimSpan(note, ctx.verbatimSources)) return { ok: false, reason: "NOTE_VERBATIM" };
  return { ok: true, note };
}
