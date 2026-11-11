/**
 * lib/platform/intelligence/ai/compose/segments.ts — the answer's segment shapes: text / link / server note / correction,
 * the typed (B11) segments a conversation stores, and segmentsText.
 *
 * P1a (Platform AI modular architecture, 2026-11-09): MOVED VERBATIM from core.ts — a pure
 * move, no behaviour change. core.ts re-exports every exported symbol (the facade), so
 * importers and tests are unchanged. compose/* never imports ../core.
 */

import type { FigureClass } from "./stale";

/**
 * S2 F-C1 (ii), 2026-11-08 — a code-written CORRECTION (never model text): replaces the plain
 * window note when the model's prose restates the asked period (period_mismatch > 0). Built only
 * from server data (window_phrase, the requestedWindows period, registry labels); a DISTINCT
 * segment the renderers show prominently ABOVE the answer, and stored typed (B11).
 */
export type CorrectionSegment = { kind: "correction"; text: string };
/**
 * F-1 (S2, 2026-11-08) — the code-written WINDOW NOTE (RESOLVED_WITH_WINDOW_NOTE with no
 * period restated). Since G1b-1 (S2 P2, 2026-11-10) its text is compose/window-disclosure.ts:
 * "Note: You asked about <asked>; <metric> covers <served window> instead." (one note per answer).
 * Its OWN segment (it used to be merged into the first text segment, so it read as model
 * prose): stored typed (B11), replayed as its own segment, rendered in a quiet role="note"
 * callout ABOVE the answer. Never model text.
 */
export type NoteSegment = { kind: "note"; text: string };
/** The server-written segments that render ABOVE the answer, never in its body. */
export type ServerNoteSegment = CorrectionSegment | NoteSegment;

export type AnswerSegment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string } | ServerNoteSegment;

/** The answer as one string; a server note / correction (its own block on screen) is followed by a separating space. */
export const segmentsText = (segs: readonly AnswerSegment[]) => segs.map((x) => (x.kind === "note" ? `${x.text} ` : x.text)).join("");

/**
 * B11 — the answer with every server-rendered FIGURE kept as its own span
 * (metric key + the window it was read with), so a conversation can store it
 * typed (conversations/answer.ts StoredSegment) and mask it in history. Text and
 * links are exactly `segments`; a link's label is flattened (figures inside a
 * link label stay text).
 */
export type TypedAnswerSegment =
  | { kind: "text"; text: string }
  /** `figureClass: "STALE"` ⇔ the envelope's figure is not current (its text carries the stale wording; absent = current). */
  | { kind: "figure"; text: string; metric: string; window: number | string | null; figureClass?: FigureClass }
  | { kind: "link"; text: string; href: string }
  | ServerNoteSegment
  /** Platform AI memory (design v2 §4): a server-rendered {{mem:<id>}} span — "noted <date>" (+ tail), never the note. */
  | { kind: "memory"; text: string };
