/**
 * lib/platform/intelligence/ai/compose/verdicts.ts — the placeholder verdict enum and its counts-only diagnoses: reason codes,
 * digit kinds, number words, list markers, label / window repeat, period mismatch and the
 * period correction text.
 *
 * P1a (Platform AI modular architecture, 2026-11-09): MOVED VERBATIM from core.ts — a pure
 * move, no behaviour change. core.ts re-exports every exported symbol (the facade), so
 * importers and tests are unchanged. compose/* never imports ../core.
 */

import type { MetricEnvelope } from "@/lib/platform/intelligence/metrics/retrieve-core";
import { quotableWindowPhrase } from "./windows";

/**
 * The verdict ENUM (the trace and the counter line carry it; never text).
 * Passing: NONE (no figure, no placeholder), RESOLVED, and RESOLVED_WITH_WINDOW_NOTE
 * (S2 ruling (d) 2026-11-04: a placed metric does not cover the window the operator
 * asked about ⇒ the answer is KEPT and a server note per affected metric is
 * prepended (S2 F-C1 2026-11-07; appended before); it replaces v1's WINDOW_UNSUPPORTED refusal). Every other code
 * replaces the answer with the generic fallback.
 */
export const PLACEHOLDER_VERDICTS = [
  "NONE", "RESOLVED", "RESOLVED_WITH_WINDOW_NOTE",
  /** A placed figure is STALE: the answer is KEPT, each stale figure carries its stale wording and a server note is prepended. */
  "RESOLVED_WITH_STALE_NOTE",
  "MALFORMED_PLACEHOLDER", "UNIT_MISMATCH", "WINDOW_MISMATCH", "UNRESOLVED_PLACEHOLDER",
  "USER_NUMERAL_COLLISION", "UNGROUNDED_DIGIT",
] as const;
export type PlaceholderVerdict = (typeof PLACEHOLDER_VERDICTS)[number];

/** Counts and a code only — never a value, a key or model text (C5). */
export interface ClaimsSummary { claims: number; resolved: number; unresolved: number; admitted: number; verdict: PlaceholderVerdict }

/**
 * WHY a well-formed placeholder did not resolve (diagnosis, 2026-11-04; trace COUNTS only —
 * never the key or part text the model wrote):
 *   UNKNOWN_KEY  — the metric id is in no registry definition
 *   VERSION      — the id is known (or was read this turn) but not at the written / an unambiguous version
 *   MISSING_PART — an object value and no |part (and it is not a one-part object, safety net 2)
 *   UNKNOWN_PART — a part the value does not have (or a part on a scalar, or a part with no declared unit)
 *   NOT_READ     — a registry key that no get_metric of THIS turn returned
 */
export const UNRESOLVED_REASONS = ["UNKNOWN_KEY", "VERSION", "MISSING_PART", "UNKNOWN_PART", "NOT_READ"] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];
/**
 * The SHAPE of a malformed placeholder (counts only):
 *   NO_PREFIX     — {{…}} without the "m:" / "l:" prefix
 *   NOT_A_KEY     — the text after "m:" / "l:" is not a metric-key shape (e.g. a label, capitals, spaces)
 *   BAD_OPTION    — the key is well-shaped but an option is unknown, repeated or badly valued
 *   STRAY_BRACES  — an unmatched "{{" or "}}"
 */
export const MALFORMED_REASONS = ["NO_PREFIX", "NOT_A_KEY", "BAD_OPTION", "STRAY_BRACES"] as const;
export type MalformedReason = (typeof MALFORMED_REASONS)[number];
/**
 * S2 2026-11-05 — what kind of digit run made an answer UNGROUNDED_DIGIT (counts only,
 * never the digits or the text): next to a time unit, a currency sign / "dollars", a
 * percent sign / "percent", or anything else. A diagnosis, never an allowance: the
 * verdict is unchanged whatever the kind.
 */
export const DIGIT_KINDS = ["WINDOW_LIKE", "MONEY_LIKE", "PERCENT_LIKE", "OTHER", "NUMBER_WORD"] as const;
export type DigitKind = (typeof DIGIT_KINDS)[number];

/** PURE — classify each leftover digit run in the model's own prose (after every allowance). */
export function classifyDigitRuns(prose: string): ReasonCounts<DigitKind> {
  const out: ReasonCounts<DigitKind> = {};
  for (const m of prose.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const before = prose.slice(Math.max(0, m.index - 3), m.index);
    const after = prose.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const kind: DigitKind = /[$€£]\s*$/.test(before) || /^\s*(?:dollars?|usd)\b/i.test(after) ? "MONEY_LIKE"
      : /^\s*(?:%|percent\b)/i.test(after) ? "PERCENT_LIKE"
      : /^\s*-?\s*(?:h|hrs?|hours?|d|days?|wks?|weeks?|mos?|months?|yrs?|years?)\b/i.test(after) ? "WINDOW_LIKE"
      : "OTHER";
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}
export type ReasonCounts<R extends string> = Partial<Record<R, number>>;

// ── Number words (S2 N1, 2026-11-08): a count written in words is a figure ──
//
// Preview briefing: "one failed domain", "two active incidents", "eight connections
// requiring reconnection" — counts the model typed in WORDS, which the digit rule never
// saw. A cardinal number word in the model's own prose (outside every placeholder, after
// the registry-label allowlist) is treated EXACTLY like a leftover digit: UNGROUNDED_DIGIT
// ⇒ the fallback, digitBy NUMBER_WORD. INCLUDED: zero … nineteen, twenty … ninety,
// hundred, thousand, million, billion, dozen, twice, thrice (each states an exact count)
// and "a single" (states exactly one). EXCLUDED, on purpose: "once" (mostly the
// conjunction "once it reconnects"), ordinals ("first", "second": order, and the prompt's
// own "most important first"), "no" / "none" (absence wording the UNAVAILABLE rule
// already governs), and vague quantifiers ("several", "few", "many", "some": no exact
// figure is asserted, so none can be wrong). Idioms exempted (a pronoun, not a count):
// "no one", "one another", "this one", "that one", "which one". "one of …" is NOT
// exempted (it asserts at least one — conservative: refuse). A number word the operator
// wrote in the question next to a time unit ("past thirty days") is admitted like
// admitUserNumerals admits digits.
const NUMBER_WORD = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|twice|thrice)\b|\ba\s+single\b/gi;
const NUMBER_WORD_IDIOM = /\b(?:no\s+one|one\s+another|(?:this|that|which)\s+one)\b/gi;
const NUMBER_WORD_TIME_UNIT = /^[\s-]+(?:hours?|days?|weeks?|months?|years?)\b/i;

/**
 * ORDERED-LIST MARKERS (Question-style briefing "…as a short bulleted list", 2026-11-08):
 * the model numbered its items ("1. …", "2) …") and the leftover-digit rule read each
 * marker as a figure ⇒ UNGROUNDED_DIGIT ⇒ the fallback. A marker is STRUCTURE: the
 * client's answerBlocks (NUMBERED) reads exactly this shape at a line start as an
 * ordered-list item and drops it — the operator never sees it as a number. Removed here
 * ONLY at a line start (the segment's start when `lineStart`, else after a newline),
 * 1–2 digits then "." or ")" then whitespace. A digit anywhere else — "2 failed", "(1)",
 * "- 2 failed", "1.5" — is still a leftover digit.
 */
export const LIST_MARKER = /(^|\n)([ \t]*)(\d{1,2})[.)](?=[ \t]+\S)/g;
/**
 * S2 L1 (#496): a marker is allowed ONLY in sequence — "1" starts a list, and each next
 * marker must be the previous + 1 ("1. 2. 3."), each followed by text. "7. incidents are
 * open", or "1. … 3. …", keeps its digit (refused as a leftover digit, as before): the
 * renderer would renumber it, but the stored text and the export would carry the "7".
 * `seq` carries the expected next marker across the answer's segments (one answer, in order).
 */
export function stripListMarkers(prose: string, lineStart = true, seq: { next: number } = { next: 1 }): string {
  return prose.replace(LIST_MARKER, (m, nl: string, ws: string, n: string, offset: number) => {
    if (offset === 0 && nl === "" && !lineStart) return m;
    const k = Number(n);
    if (k !== 1 && k !== seq.next) return m;
    seq.next = k + 1;
    return `${nl}${ws} `;
  });
}

/** PURE — how many number words the model's own prose states (idioms and the operator's own time window excepted). */
export function numberWordCount(prose: string, scrubbedQuestion = ""): number {
  return numberWordMatches(prose, scrubbedQuestion).length;
}

/** The counted number words (numberWordCount's matches) — one definition for the count and the families. */
function numberWordMatches(prose: string, scrubbedQuestion: string): string[] {
  const text = prose.replace(NUMBER_WORD_IDIOM, " ");
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_WORD)) {
    const after = text.slice(m.index! + m[0].length);
    if (NUMBER_WORD_TIME_UNIT.test(after) && new RegExp(`\\b${m[0].replace(/\s+/g, "\\s+")}\\b`, "i").test(scrubbedQuestion)) continue;
    out.push(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  return out;
}

/**
 * (i) S2 2026-11-08 — COUNTS-ONLY word-family diagnosis of the NUMBER_WORD verdict (never the
 * words themselves): one (incl. zero) · two-twenty · tens (thirty…ninety) · single ("a single") ·
 * dozen · scale (hundred / thousand / million / billion) · twice-thrice.
 */
export const NUMBER_WORD_FAMILIES = ["one", "two-twenty", "tens", "single", "dozen", "scale", "twice-thrice"] as const;
export type NumberWordFamily = (typeof NUMBER_WORD_FAMILIES)[number];
export function numberWordFamilies(prose: string, scrubbedQuestion = ""): ReasonCounts<NumberWordFamily> {
  const out: ReasonCounts<NumberWordFamily> = {};
  for (const w of numberWordMatches(prose, scrubbedQuestion)) {
    const f: NumberWordFamily = w === "one" || w === "zero" ? "one" : w === "a single" ? "single" : /^dozens?$/.test(w) ? "dozen" : /^(?:twice|thrice)$/.test(w) ? "twice-thrice"
      : /^(?:hundred|thousand|million|billion)s?$/.test(w) ? "scale" : /^(?:thirty|forty|fifty|sixty|seventy|eighty|ninety)$/.test(w) ? "tens" : "two-twenty";
    out[f] = (out[f] ?? 0) + 1;
  }
  return out;
}

// ── label_repeat / window_repeat (S2 2026-11-08): counts-only diagnoses ───────
//
// Both read the RENDERED answer with the server spans marked at render time (a span is
// the text one {{m:}} figure or one {{l:}} label rendered to). No rewrite, no verdict
// change; the trace and the HTTP grounding carry the COUNT, never text.

/** One server-rendered span in the rendered answer stream (offsets into that stream). */
export interface RenderedSpan { start: number; end: number; kind: "figure" | "label"; text: string; windowPhrase: string | null }

const insideSpan = (spans: readonly RenderedSpan[], at: number) => spans.some((sp) => at >= sp.start && at < sp.end);

/**
 * label_repeat: how many SENTENCES of the rendered answer contain the SAME rendered label
 * text from two (or more) {{l:}} placeholders (e.g. "{{l:…|part=largest…}} for
 * {{l:…|part=providers}}" ⇒ "Providers (Plaid) for Providers (Plaid)"). A sentence ends at
 * ".", "!" or "?" followed by whitespace or the end, in the model's text only (a figure's
 * "$3.30" or a label never ends one). Model-written text equal to a label is not counted.
 */
export function labelRepeatCount(text: string, spans: readonly RenderedSpan[]): number {
  const bounds: number[] = [];
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) if (!insideSpan(spans, m.index!)) bounds.push(m.index!);
  const bySentence = new Map<number, Map<string, number>>();
  for (const sp of spans) {
    if (sp.kind !== "label") continue;
    const sentence = bounds.filter((b) => b < sp.start).length;
    const seen = bySentence.get(sentence) ?? new Map<string, number>();
    seen.set(sp.text, (seen.get(sp.text) ?? 0) + 1);
    bySentence.set(sentence, seen);
  }
  return [...bySentence.values()].filter((seen) => [...seen.values()].some((c) => c >= 2)).length;
}

/** window_repeat's reach: a window_phrase that STARTS within this many characters after a figure's end. */
export const WINDOW_REPEAT_REACH = 80;

/**
 * window_repeat: how many times the model's prose quotes a window_phrase (server text from
 * this turn's get_metric results; exact text, case-insensitive) starting within
 * WINDOW_REPEAT_REACH characters after the END of a rendered figure whose qualifier carries
 * that same window (e.g. "… at least $3.30 (this UTC calendar month to date, since
 * 2026-11-01, estimated) so far this month (since 2026-11-01)"). Each quoted occurrence counts
 * once however many figures precede it; a quote inside a server span is never counted.
 */
export function windowRepeatCount(text: string, spans: readonly RenderedSpan[], windowPhrases: readonly string[]): number {
  const lower = text.toLowerCase();
  const hits = new Set<number>();
  for (const phrase of new Set(windowPhrases)) {
    const needle = phrase.toLowerCase();
    if (!needle) continue;
    const figures = spans.filter((sp) => sp.kind === "figure" && sp.windowPhrase !== null && sp.windowPhrase.toLowerCase() === needle);
    if (figures.length === 0) continue;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      if (insideSpan(spans, at)) continue;
      if (figures.some((f) => at >= f.end && at - f.end <= WINDOW_REPEAT_REACH)) hits.add(at);
    }
  }
  return hits.size;
}

// ── period_mismatch (S2 F-C1 (c), 2026-11-07): a counts-only diagnosis ────────
//
// When the window note fires (a placed metric does not cover the period the operator
// asked about), how many ASKED-PERIOD PHRASES the model's own prose contains — e.g. its
// lead "In the past 30 days, …" over a month-to-date figure. A phrase is a rolling period
//   "past / last / previous / prior / trailing [N] <unit>", or "N <unit>"
//   (N in digits or a small number word; unit hour … year; no N = one)
// whose span equals a period the question asked for (requestedWindows, in hours). A
// calendar to-date phrase ("so far this month", "this year") is not a rolling period, so
// it is never counted. A diagnosis only: no rewrite, no verdict change; the trace and the
// HTTP grounding carry the COUNT, never the phrase. Rendered figures and labels are not
// the model's prose and are never counted (they carry the server's own window words).

const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14, thirty: 30, sixty: 60, ninety: 90 };
const PERIOD_NUM = `(?:\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})`;
const PERIOD_PHRASE = new RegExp(
  `\\b(?:(?:past|last|previous|prior|trailing)\\s+(?:(${PERIOD_NUM})[\\s-]+)?|(${PERIOD_NUM})[\\s-]+)(hours?|days?|weeks?|months?|quarters?|years?)\\b`, "gi");
const PERIOD_UNIT_HOURS: Readonly<Record<string, number>> = { hour: 1, day: 24, week: 168, month: 720, quarter: 2160, year: 8760 };

export function periodMismatchCount(modelProse: string, asked: readonly { hours: number }[]): number {
  let n = 0;
  for (const m of modelProse.matchAll(PERIOD_PHRASE)) {
    const raw = (m[1] ?? m[2] ?? "one").toLowerCase();
    const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 1;
    const hours = count * PERIOD_UNIT_HOURS[m[3].toLowerCase().replace(/s$/, "")];
    if (asked.some((a) => a.hours === hours)) n++;
  }
  return n;
}

/** The verdicts that keep the answer; every other one is replaced by the fallback. */
/** "a", "a and b", "a, b and c" — server labels only. */
const listLabels = (labels: readonly string[]) => labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

/**
 * S2 F-C1 (ii), 2026-11-08 (wording per S2 on #460) — the CORRECTION text, built ONLY from server
 * data: the affected envelopes' registry labels, each one's window_phrase (quotableWindowPhrase)
 * with a leading "in " removed (here only), and the asked period as server-parsed from the
 * operator's question (requestedWindows: n + unit, pluralised; n = 1 ⇒ "the past day"). No model
 * text, no invented explanation.
 *   "Correction: the figures for AI fleet spend vs budget (24 h) cover the last 24 hours, not the past 30 days you asked about; that period cannot be measured for them."
 */
export function periodCorrectionText(affected: readonly MetricEnvelope[], asked: readonly { n: number; unit: string }[], labelOf: (metric: string) => string): string {
  const labels = [...new Set(affected.map((e) => labelOf(e.metric)))];
  const phrases = [...new Set(affected.map((e) => quotableWindowPhrase(e).replace(/^in /, "")))];
  const period = asked.map((a) => (a.n === 1 ? `past ${a.unit}` : `past ${a.n} ${a.unit}s`)).join(" / ");
  return `Correction: the figures for ${listLabels(labels)} cover ${listLabels(phrases)}, not the ${period} you asked about; that period cannot be measured for them.`;
}

export const placeholderPasses = (v: PlaceholderVerdict) => v === "RESOLVED" || v === "NONE" || v === "RESOLVED_WITH_WINDOW_NOTE" || v === "RESOLVED_WITH_STALE_NOTE";
