/**
 * lib/platform/intelligence/ai/compose/window-disclosure.ts — G1b-1 (S2 P2, 2026-11-10): the
 * code-written WINDOW DISCLOSURE. When the period the operator ASKED for differs from the
 * window a placed figure was SERVED with, the answer says so explicitly, in one note,
 * before the figures:
 *   "Note: You asked about the past 30 days; Estimated operating cost this cycle (by category) covers 1–10 Nov 2026 (month to date, UTC) instead."
 *
 * PURE (no I/O, no clock): the asked period is a DETERMINISTIC parse of the (scrubbed)
 * question; the served window is read ONLY from the envelope (window.days / hours / label /
 * start, and freshness.asOf for the to-date end) — never model text, never inferred. A
 * served window the server cannot classify is said as "couldn't be confirmed", never
 * guessed. No asked period in the question ⇒ nothing to disclose (null).
 *
 * compose/* never imports ../core.
 */

import type { MetricEnvelope } from "@/lib/platform/intelligence/metrics/retrieve-core";
import { envelopeHours, requestedWindows } from "./windows";

// ── The period the operator asked for ───────────────────────────────────────

/** The calendar periods a question can name ("this month", "yesterday", …). */
export type CalendarPeriod = "TODAY" | "YESTERDAY" | "WEEK_TO_DATE" | "MONTH_TO_DATE" | "YEAR_TO_DATE" | "PREVIOUS_WEEK" | "PREVIOUS_MONTH" | "PREVIOUS_YEAR";

export type AskedPeriod =
  /** A trailing span ("past 30 days", "24h", "past week"), in hours. */
  | { kind: "ROLLING"; hours: number; phrase: string }
  | { kind: "CALENDAR"; period: CalendarPeriod; phrase: string };

const CALENDAR_PHRASE: Readonly<Record<CalendarPeriod, string>> = {
  TODAY: "today", YESTERDAY: "yesterday", WEEK_TO_DATE: "this week", MONTH_TO_DATE: "this month",
  YEAR_TO_DATE: "this year to date", PREVIOUS_WEEK: "last week", PREVIOUS_MONTH: "last month", PREVIOUS_YEAR: "last year",
};

/** Calendar phrasings, in the order they are reported. Each is word-bounded; matching is case-insensitive. */
const CALENDAR_PATTERNS: readonly { period: CalendarPeriod; re: RegExp }[] = [
  { period: "TODAY", re: /\btoday\b/ },
  { period: "YESTERDAY", re: /\byesterday\b/ },
  { period: "WEEK_TO_DATE", re: /\b(?:this\s+week|week[\s-]to[\s-]date|wtd)\b/ },
  { period: "MONTH_TO_DATE", re: /\b(?:this\s+month|month[\s-]to[\s-]date|mtd|this\s+(?:billing\s+)?cycle)\b/ },
  { period: "YEAR_TO_DATE", re: /\b(?:this\s+year|year[\s-]to[\s-]date|ytd)\b/ },
  { period: "PREVIOUS_WEEK", re: /\b(?:last|previous|prior)\s+week\b/ },
  { period: "PREVIOUS_MONTH", re: /\b(?:last|previous|prior)\s+month\b/ },
  { period: "PREVIOUS_YEAR", re: /\b(?:last|previous|prior)\s+year\b/ },
];

/** "past / trailing <unit>" with no number = one unit, rolling ("past week" = the last 7 days). */
const ROLLING_WORD = /\b(?:past|trailing)\s+(day|week|month|year)\b/g;
const WORD_UNIT_HOURS: Readonly<Record<string, number>> = { day: 24, week: 168, month: 720, year: 8760 };

/**
 * The period(s) the operator's (scrubbed) question asks about, deduplicated, [] when none.
 *   numeric ("past 30 days", "last 7 days", "24h", "30-day")   ⇒ ROLLING (requestedWindows: the same parse the tool contract uses)
 *   "past / trailing week|month|year|day"                       ⇒ ROLLING one unit
 *   "today", "yesterday", "this week|month|year", "month to date", "MTD", "YTD",
 *   "last / previous week|month|year"                           ⇒ CALENDAR
 */
export function parseAskedPeriods(scrubbedQuestion: string): AskedPeriod[] {
  const q = String(scrubbedQuestion ?? "").toLowerCase().replace(/[‘’]/g, "'");
  const out: AskedPeriod[] = [];
  const seen = new Set<string>();
  const add = (p: AskedPeriod) => {
    const key = p.kind === "ROLLING" ? `R${p.hours}` : `C${p.period}`;
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  };
  for (const w of requestedWindows(q)) add({ kind: "ROLLING", hours: w.hours, phrase: w.n === 1 ? `the past ${w.unit}` : `the past ${w.n} ${w.unit}s` });
  for (const m of q.matchAll(ROLLING_WORD)) add({ kind: "ROLLING", hours: WORD_UNIT_HOURS[m[1]], phrase: `the past ${m[1]}` });
  for (const { period, re } of CALENDAR_PATTERNS) if (re.test(q)) add({ kind: "CALENDAR", period, phrase: CALENDAR_PHRASE[period] });
  return out;
}

// ── The window a figure was served with (envelope data only) ─────────────────

export type ServedWindow =
  | { kind: "ROLLING"; hours: number; text: string }
  | { kind: "MONTH_TO_DATE"; text: string }
  /** A point-in-time figure (no window). */
  | { kind: "POINT"; text: string }
  /** A server label this module does not classify: stated verbatim, never equated with an asked period. */
  | { kind: "LABELLED"; text: string }
  /** The envelope carries no usable window: it is said as unconfirmed, never guessed. */
  | { kind: "UNKNOWN" };

const MTD_LABEL = "this UTC calendar month to date";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isoDay = (s: string | null | undefined): { y: number; m: number; d: number } | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { y, m: mo, d } : null;
};

/**
 * The month-to-date span from the reader's own start (window.start) and the figure's as-of
 * (freshness.asOf, the reader's clock — its UTC date). "1–10 Nov 2026"; same day ⇒ "1 Nov 2026";
 * no usable as-of (missing, unparseable, before the start) ⇒ "since 1 Nov 2026"; no start ⇒ null.
 */
export function monthToDateSpan(start: string | null, asOf: string | null): string | null {
  const s = isoDay(start);
  if (!s) return null;
  const startText = `${s.d} ${MONTHS[s.m - 1]} ${s.y}`;
  const asOfMs = asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(asOfMs)) return `since ${startText}`;
  const e = new Date(asOfMs);
  const ey = e.getUTCFullYear(), em = e.getUTCMonth() + 1, ed = e.getUTCDate();
  if (ey * 10000 + em * 100 + ed < s.y * 10000 + s.m * 100 + s.d) return `since ${startText}`;
  if (ey === s.y && em === s.m) return ed === s.d ? startText : `${s.d}–${ed} ${MONTHS[s.m - 1]} ${s.y}`;
  return `${startText} – ${ed} ${MONTHS[em - 1]} ${ey}`;
}

/** The window an envelope was served with — server data only. */
export function servedWindow(e: MetricEnvelope): ServedWindow {
  const w = e.window;
  const h = envelopeHours(e);
  if (h !== null) {
    const text = h % 24 === 0 && h !== 24 ? `the last ${h / 24} days` : h === 24 ? "the last 24 hours" : `the last ${h} hour${h === 1 ? "" : "s"}`;
    return { kind: "ROLLING", hours: h, text };
  }
  if (w.label === MTD_LABEL) {
    const span = monthToDateSpan(w.start, e.freshness?.asOf ?? null);
    return { kind: "MONTH_TO_DATE", text: span ? `${span} (month to date, UTC)` : "this month to date (UTC)" };
  }
  if (typeof w.label === "string" && w.label.trim().length > 0) return { kind: "LABELLED", text: w.label.trim() };
  if (w.kind === "POINT_IN_TIME") return { kind: "POINT", text: "the current state (no time window)" };
  return { kind: "UNKNOWN" };
}

/**
 * Does a served window answer the asked period? Only these equivalences; everything else is disclosed:
 *   rolling N h        ⇔ rolling N h (same span)
 *   "this month"       ⇔ the month-to-date window
 *   "today"            ⇔ a current-state (point-in-time) figure, or the trailing 24 hours (the
 *                        server's daily operating window — "how are we looking today?")
 */
export function windowMatches(asked: AskedPeriod, served: ServedWindow): boolean {
  if (asked.kind === "ROLLING") return served.kind === "ROLLING" && served.hours === asked.hours;
  if (asked.period === "MONTH_TO_DATE") return served.kind === "MONTH_TO_DATE";
  if (asked.period === "TODAY") return served.kind === "POINT" || (served.kind === "ROLLING" && served.hours === 24);
  return false;
}

// ── The disclosure ──────────────────────────────────────────────────────────

/** "a", "a and b", "a, b and c". */
const listOf = (xs: readonly string[]) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * The ONE disclosure note for an answer, or null when there is nothing to disclose (no asked
 * period, no placed figure, or every placed figure's window covers every asked period).
 * Lists each affected metric once (first-placed order) with its served window; metrics whose
 * window matches are not listed. Deterministic text, server data only:
 *   one window   "Note: You asked about the past 30 days; Alpha covers 1–10 Nov 2026 (month to date, UTC) instead."
 *                "Note: You asked about the past 30 days; Alpha and Beta cover the last 24 hours instead."
 *   mixed        "Note: You asked about the past 30 days; these figures cover other periods instead: Alpha covers 1–10 Nov 2026 (month to date, UTC); Beta covers the last 24 hours."
 *   unknown      "Note: You asked about the past 30 days; the period Alpha covers couldn't be confirmed, so it may not match what you asked."
 */
export function windowDisclosureText(asked: readonly AskedPeriod[], placed: readonly MetricEnvelope[], labelOf: (metric: string) => string): string | null {
  if (asked.length === 0 || placed.length === 0) return null;
  const affected: { label: string; served: ServedWindow }[] = [];
  const seen = new Set<string>();
  for (const e of placed) {
    if (seen.has(e.metric)) continue;
    seen.add(e.metric);
    const served = servedWindow(e);
    if (served.kind !== "UNKNOWN" && asked.every((a) => windowMatches(a, served))) continue;
    affected.push({ label: labelOf(e.metric), served });
  }
  if (affected.length === 0) return null;
  const lead = `Note: You asked about ${listOf(asked.map((a) => a.phrase))};`;
  const known = affected.filter((a) => a.served.kind !== "UNKNOWN");
  const unknown = affected.filter((a) => a.served.kind === "UNKNOWN").map((a) => a.label);
  const unknownClause = unknown.length > 0
    ? `the period ${listOf(unknown)} ${unknown.length === 1 ? "covers" : "cover"} couldn't be confirmed, so ${unknown.length === 1 ? "it" : "they"} may not match what you asked`
    : null;
  const texts = [...new Set(known.map((a) => (a.served as { text: string }).text))];
  if (known.length === 0) return `${lead} ${unknownClause}.`;
  if (texts.length === 1) {
    const labels = known.map((a) => a.label);
    const main = `${listOf(labels)} ${labels.length === 1 ? "covers" : "cover"} ${texts[0]} instead`;
    return `${lead} ${main}${unknownClause ? `; ${unknownClause}` : ""}.`;
  }
  const items = known.map((a) => `${a.label} covers ${(a.served as { text: string }).text}`);
  return `${lead} these figures cover other periods instead: ${items.join("; ")}${unknownClause ? `; ${unknownClause}` : ""}.`;
}
