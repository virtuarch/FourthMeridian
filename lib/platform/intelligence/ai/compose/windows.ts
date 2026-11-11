/**
 * lib/platform/intelligence/ai/compose/windows.ts — the window the operator asked for and the window an envelope covers
 * (requestedWindows, envelopeWindowText, quotableWindowPhrase).
 *
 * P1a (Platform AI modular architecture, 2026-11-09): MOVED VERBATIM from core.ts — a pure
 * move, no behaviour change. core.ts re-exports every exported symbol (the facade), so
 * importers and tests are unchanged. compose/* never imports ../core.
 */

import { daysWindowLabel, hoursWindowLabel } from "@/lib/platform/intelligence/metrics/registry";
import type { MetricEnvelope } from "@/lib/platform/intelligence/metrics/retrieve-core";

// ── The window the operator asked for (unsupported window ⇒ stated, never substituted) ──

const UNIT_HOURS: Record<string, number> = { h: 1, hour: 1, day: 24, week: 168, month: 720, year: 8760 };

/** The windows the scrubbed question names ("past 30 days", "24h"), in hours; [] when none. */
export function requestedWindows(scrubbedQuestion: string): { n: number; unit: string; hours: number }[] {
  const out: { n: number; unit: string; hours: number }[] = [];
  for (const m of scrubbedQuestion.matchAll(/(?<![\w.])(\d{1,3})[\s-]?(h|hours?|days?|weeks?|months?|years?)\b/gi)) {
    const unit = m[2].toLowerCase().replace(/s$/, "");
    const n = Number(m[1]);
    out.push({ n, unit: unit === "h" ? "hour" : unit, hours: n * UNIT_HOURS[unit] });
  }
  return out;
}

/** The span an envelope covers, in hours: days / hours, else the "in the last N days|hours" of its server label (pinned consistent). */
const envelopeHours = (e: MetricEnvelope): number | null => {
  if (e.window.days !== null) return e.window.days * 24;
  if (e.window.hours !== null) return e.window.hours;
  const m = /^in the last (\d+) (day|hour)s?$/.exec(e.window.label ?? "");
  return m ? Number(m[1]) * (m[2] === "day" ? 24 : 1) : null;
};

/**
 * The window an envelope ACTUALLY covers, as the short SERVER phrase stated beside
 * its figures (S2 rulings 2026-11-04): the envelope's `window.label` — built by
 * retrieval from days / hours, else the registry's window.label — never the
 * description, never model text. A date is added ONLY when the reader gave an
 * explicit window start (`window.start`); nothing is inferred. null = point in time.
 *   "in the last 30 days" · "in the last 24 hours" · "this UTC calendar month to date" ("…, since 2026-11-01" with a reader start)
 */
export function envelopeWindowText(e: MetricEnvelope): string | null {
  const w = e.window;
  const label = w.label ?? (w.days !== null ? daysWindowLabel(w.days) : w.hours !== null ? hoursWindowLabel(w.hours) : null);
  if (!label) return null;
  return w.start ? `${label}, since ${w.start}` : label;
}

/** What an envelope's window covers, as the object of "covers …" in a server note. */
function windowPhrase(e: MetricEnvelope): string {
  const t = envelopeWindowText(e);
  if (t === null) return "the current state (no time window)";
  return t.replace(/^in the /, "the ");
}

/**
 * S2 F-C1 (2026-11-07) — the envelope's window as a phrase the model may QUOTE (the
 * get_metric result's `window_phrase`): server text only, from the envelope's label
 * and its reader-supplied start (never inferred). The billing-cycle label reads
 * "so far this month"; every other label is used as is; a point in time ⇒ "right now".
 *   "so far this month (since 2026-11-01)" · "in the last 30 days" · "in the last 24 hours"
 */
export function quotableWindowPhrase(e: MetricEnvelope): string {
  const w = e.window;
  const label = w.label ?? (w.days !== null ? daysWindowLabel(w.days) : w.hours !== null ? hoursWindowLabel(w.hours) : null);
  if (!label) return "right now";
  const base = label === "this UTC calendar month to date" ? "so far this month" : label;
  return w.start ? `${base} (since ${w.start})` : base;
}

/** Module-internal to compose/* (not part of core.ts's facade). */
export { envelopeHours, windowPhrase };
