/**
 * lib/ai/conversation/provenance.ts
 *
 * WHAT THE PREVIOUS ANSWER ACTUALLY RESTED ON — carried to the next turn so an
 * explanation describes the computation that happened, not a plausible one.
 *
 * ⚠️ THE DEFECT, MEASURED. A browser turn sees only the PROSE of earlier turns;
 * which tools ran and what they returned is gone. Asked "how did you get that
 * number?" after an answer that had called `get_baselines`, the model said "I
 * also didn't actually run the get_baselines tool" and described a 90-day-window
 * mistake it never made. Told "you suck" after a tool-computed answer, it
 * confessed "I made numbers up". With no record, a retrospective is invention in
 * both directions — false confidence and false confession.
 *
 * ⚠️ WHAT IS CARRIED, AND WHY IT IS ENOUGH.
 *   · CALLS — each tool the answer ran, with its arguments. Every tool is
 *     deterministic for a given Space and date, so re-running a call reproduces
 *     the figure AND its derivation fields (numerator, denominator, window,
 *     basis). The record is the index; the tool is still the authority.
 *   · FIGURES — each figure the answer stated, with WHERE it came from: a field
 *     of a tool result (by path), the orientation, the user's own words, or
 *     NOWHERE — "unsourced", i.e. computed in the answer's prose. That last tag
 *     is what makes "I subtracted $5,000 from your cash myself" sayable.
 * It never carries a tool RESULT: results are evidence and evidence is re-read,
 * never cached (runtime-state.ts).
 *
 * ⚠️ IT IS DATA ABOUT A TURN, NEVER AUTHORITY. It is built server-side from the
 * turn record, sealed with the rest of the runtime state, bound to the digest of
 * the answer it describes, and injected as a system message. A replayed call
 * runs with the CURRENT context's authority, exactly like a model-chosen call —
 * the record grants nothing a model could not already ask for.
 *
 * Pure. No I/O.
 */

/** A figure as stated, and where it came from. */
export interface FigureSource {
  /** The figure as it appeared in the answer ("$15,925.25", "2.93", "52.5%"). */
  said:   string;
  /** `tool:<name> <path>` | `orientation <path>` | `you said it` | `unsourced`. */
  source: string;
}

export interface AnswerProvenance {
  calls:   { tool: string; args: unknown; failed?: true }[];
  figures: FigureSource[];
  /** True when more calls or figures existed than are carried. */
  clipped?: true;
}

/** Ceilings — what one cookie can afford beside a scenario. */
export const MAX_CALLS = 6;
export const MAX_FIGURES = 14;
export const MAX_ARGS_CHARS = 220;
export const MAX_PATH_CHARS = 60;

// ── Figures ──────────────────────────────────────────────────────────────────

/**
 * The figures an answer states: money, percentages, and decimals or counts big
 * enough to be a result. Dates, years and list numbering are not figures.
 */
const FIGURE = /(?<![\w.-])(-?\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?|\d[\d,]*\.\d+%?|\d[\d,]*\s?%|\d{1,3}(?:,\d{3})+)(?![\w-]|\.\d)/g;

export interface StatedFigure { said: string; value: number; tolerance: number; percent: boolean }

export function statedFigures(text: string): StatedFigure[] {
  const out: StatedFigure[] = [];
  const seen = new Set<string>();
  // Dates first: "2026-09-30", "2026‑10‑06" are not figures.
  const masked = text.replace(/\d{4}[-‑]\d{2}[-‑]\d{2}/g, ' ');
  for (const m of masked.matchAll(FIGURE)) {
    const said = m[0].trim();
    if (seen.has(said)) continue;
    const percent = said.endsWith('%');
    const mult = /[kK]$/.test(said) ? 1_000 : /[mM]$/.test(said) ? 1_000_000 : 1;
    const digits = said.replace(/[$,%kKmM\s]/g, '');
    const value = Number(digits) * mult;
    if (!Number.isFinite(value)) continue;
    // A bare integer under 100 with no unit is a count or list number, not a figure.
    if (!said.includes('$') && !percent && !digits.includes('.') && Math.abs(value) < 100) continue;
    if (!said.includes('$') && !percent && /^(19|20)\d{2}$/.test(digits)) continue;
    const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
    // As precise as it was stated: "$41.3k" covers 41,250–41,350; "$5,438" covers ±0.5.
    const tolerance = (0.5 / 10 ** decimals) * mult;
    seen.add(said);
    out.push({ said, value, tolerance, percent });
  }
  return out;
}

/** Every number in a JSON value, with its path. Strings are parsed when they are plain numbers. */
export function numericLeaves(value: unknown, path = '', out: { path: string; value: number }[] = []):
  { path: string; value: number }[] {
  if (out.length > 5_000) return out;
  if (typeof value === 'number' && Number.isFinite(value)) out.push({ path, value });
  else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) out.push({ path, value: Number(value) });
  else if (Array.isArray(value)) value.forEach((v, i) => numericLeaves(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) numericLeaves(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

const matches = (f: StatedFigure, v: number) =>
  Math.abs(Math.abs(f.value) - Math.abs(v)) <= f.tolerance
  || (f.percent && Math.abs(Math.abs(f.value) - Math.abs(v * 100)) <= f.tolerance);

/** Numbers in free text (the user's own words, the orientation's prose). */
function textNumbers(text: string): number[] {
  return statedFigures(text).map((f) => f.value)
    .concat([...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))));
}

// ── The record ───────────────────────────────────────────────────────────────

/**
 * Build the record of one answer. PURE.
 *
 * Sources are tried in authority order: a tool result (the computation), then
 * the orientation (the evidence the turn opened with), then the user's words.
 * A figure none of them contains is `unsourced` — said, not computed by code.
 */
export function buildProvenance(args: {
  answer: string;
  toolCalls: readonly { name: string; arguments: unknown; result: unknown; error?: string }[];
  orientation: string | null;
  userTexts: readonly string[];
}): AnswerProvenance {
  const leavesByCall = args.toolCalls.map((c) => ({ name: c.name, leaves: c.error ? [] : numericLeaves(c.result) }));
  let orientationLeaves: { path: string; value: number }[] = [];
  if (args.orientation) {
    const json = args.orientation.slice(args.orientation.indexOf('{'));
    try { orientationLeaves = numericLeaves(JSON.parse(json)); } catch { orientationLeaves = textNumbers(args.orientation).map((v) => ({ path: '', value: v })); }
  }
  const userNumbers = args.userTexts.flatMap(textNumbers);

  const figures: FigureSource[] = [];
  const all = statedFigures(args.answer);
  for (const f of all.slice(0, MAX_FIGURES)) {
    let source = 'unsourced';
    for (const c of leavesByCall) {
      const hit = c.leaves.find((l) => matches(f, l.value));
      if (hit) { source = `tool:${c.name} ${hit.path.slice(0, MAX_PATH_CHARS)}`.trim(); break; }
    }
    if (source === 'unsourced') {
      const hit = orientationLeaves.find((l) => matches(f, l.value));
      if (hit) source = `orientation ${hit.path.slice(0, MAX_PATH_CHARS)}`.trim();
    }
    if (source === 'unsourced' && userNumbers.some((v) => matches(f, v))) source = 'you said it';
    figures.push({ said: f.said, source });
  }
  const calls = args.toolCalls.slice(0, MAX_CALLS).map((c) => {
    const json = JSON.stringify(c.arguments ?? {});
    return { tool: c.name, args: json.length <= MAX_ARGS_CHARS ? c.arguments ?? {} : `${json.slice(0, MAX_ARGS_CHARS)}…`,
      ...(c.error ? { failed: true as const } : {}) };
  });
  return { calls, figures,
    ...(args.toolCalls.length > MAX_CALLS || all.length > MAX_FIGURES ? { clipped: true as const } : {}) };
}

/** Narrow an unknown (a sealed payload) to a record, or null. */
export function readProvenance(value: unknown): AnswerProvenance | 'NOT_CARRIED' | null {
  if (value === 'NOT_CARRIED') return 'NOT_CARRIED';
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.calls) || !Array.isArray(v.figures)) return null;
  const calls = v.calls.filter((c): c is AnswerProvenance['calls'][number] =>
    !!c && typeof c === 'object' && typeof (c as { tool?: unknown }).tool === 'string').slice(0, MAX_CALLS);
  const figures = v.figures.filter((f): f is FigureSource =>
    !!f && typeof f === 'object' && typeof (f as FigureSource).said === 'string' && typeof (f as FigureSource).source === 'string')
    .slice(0, MAX_FIGURES);
  return { calls, figures, ...(v.clipped === true ? { clipped: true } : {}) };
}

// ── Into the next turn ───────────────────────────────────────────────────────

export const PROVENANCE_MARKER = 'PREVIOUS ANSWER — WHAT IT RESTED ON';

/**
 * The trailing system message for the next turn. Empty provenance (an answer
 * that stated no figure and ran no tool) is still said, because "I ran nothing"
 * is exactly the fact a later "how did you calculate that?" needs.
 */
export function provenanceMessage(p: AnswerProvenance | 'NOT_CARRIED'): string {
  if (p === 'NOT_CARRIED') {
    return `${PROVENANCE_MARKER}\nThe record of what the previous answer rested on could not be carried. `
      + 'If asked how it was derived, re-derive it with the tools and say that you re-derived it.';
  }
  return `${PROVENANCE_MARKER}\n${JSON.stringify({
    toolsRun: p.calls.length ? p.calls : 'none — it ran no tool',
    figures: p.figures,
    ...(p.clipped ? { clipped: 'more calls or figures existed than are listed' } : {}),
  })}\n`
    + 'This is the record of the previous answer, made by the system, not by you. To explain how a '
    + 'figure was derived, re-run the listed call and quote its own derivation; a figure marked '
    + '"unsourced" was worked out in the answer\'s own words, so say so. Never describe a different '
    + 'derivation, and never claim a tool did or did not run against this record.';
}

/** Splice the record in as the trailing system message, replacing any earlier one. */
export function injectProvenance(messages: unknown[], p: AnswerProvenance | 'NOT_CARRIED' | null): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(PROVENANCE_MARKER)) messages.splice(i, 1);
  }
  if (p) messages.push({ role: 'system', content: provenanceMessage(p) });
}
