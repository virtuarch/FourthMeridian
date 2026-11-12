/**
 * lib/platform/intelligence/ai/compose/placeholders.ts — placeholder grounding (S2 binding 4; v1 = S2 rulings C1–C5): the
 * placeholder grammar and writer, key / part / window matching, the user-numeral allowance,
 * figure and label rendering, and resolvePlaceholders.
 *
 * P1a (Platform AI modular architecture, 2026-11-09): MOVED VERBATIM from core.ts — a pure
 * move, no behaviour change. core.ts re-exports every exported symbol (the facade), so
 * importers and tests are unchanged. compose/* never imports ../core.
 */

import { daysWindowLabel, hoursWindowLabel } from "@/lib/platform/intelligence/metrics/registry";
import type { FigureUnit, MetricEnvelope, RankedCategory } from "@/lib/platform/intelligence/metrics/retrieve-core";
import { KNOWN_IDS, KNOWN_KEYS, LABEL_OF_KEY, idOfKey } from "./keys";
import { SENTINEL } from "./sanitise";
import type { AnswerSegment, TypedAnswerSegment } from "./segments";
import { isStaleEnvelope, staleQualifierOf } from "./stale";
import {
  classifyDigitRuns, labelRepeatCount, numberWordCount, numberWordFamilies, stripListMarkers, windowRepeatCount,
  type ClaimsSummary, type DigitKind, type MalformedReason, type NumberWordFamily, type PlaceholderVerdict, type ReasonCounts, type RenderedSpan, type UnresolvedReason,
} from "./verdicts";
import { envelopeWindowText, quotableWindowPhrase, requestedWindows } from "./windows";

// ── Placeholder grounding (S2 binding 4; v1 = S2 rulings C1–C5) ─────────────
//
// THE MODEL NEVER TYPES A FIGURE. It writes a placeholder where a figure goes —
//   {{m:<metricKey>}}                 a scalar metric, e.g. {{m:incident-broken-now@1}}
//   {{m:<metricKey>|part=<name>}}     one part of an object-valued metric
//   {{l:<metricKey>[|part=<name>]}}   S2 F-C2 (2026-11-07): the NAME — the metric's registry label,
//                                     a category part's declared label, or the category a ranking
//                                     part picked (renderLabel). {{m:…}} renders the FIGURE only.
//                                     Same key / part / window resolution and the same
//                                     unresolved / malformed handling as {{m:…}}.
//   … |window=N                       digits only; see matchPlaceholderEnvelope (S2 ruling 2026-11-04)
//   (options in any order, each at most once; `.part` is NOT the syntax — it reads as an email)
// — and the SERVER substitutes the value, its unit, the status wording AND the
// envelope's actual window (server text) from the envelope THIS turn returned
// for that key (C1, C3; window matching in matchPlaceholderEnvelope). No
// fresh read happens while rendering. After the placeholders are taken out, ANY
// digit left in the prose replaces the answer with the fallback (C2); the only
// exemptions are digits inside a registry label this turn's tools returned and
// an ISO date equal to an envelope's freshness date or EXACTLY its reader-supplied
// window start. A malformed placeholder, an
// unknown key, a window or part mismatch, or a model-written unit beside a
// placeholder ⇒ the fallback too (C5: no extra model round). This closes v0's
// attribution gap: a figure can only be the figure of the metric it names.

/** One well-formed placeholder. Anything else that opens `{{` or closes `}}` is MALFORMED. */
const PLACEHOLDER = /\{\{\s*([ml]):([a-z0-9][a-z0-9-]{0,80}(?:@\d{1,4})?)((?:\|[a-z]+=[A-Za-z0-9]{1,40}){0,2})\s*\}\}/g;

/**
 * THE WRITER of the grammar PLACEHOLDER parses (main fix, S2-approved 2026-11-04):
 * the exact string a get_metric result hands the model to copy. Pinned by a
 * ROUND-TRIP test: every string placeholdersFor emits is consumed whole by
 * PLACEHOLDER and resolves against its own envelope.
 */
export function formatPlaceholder(key: string, opts: { part?: string | null; window?: number | null; kind?: "m" | "l" } = {}): string {
  return `{{${opts.kind ?? "m"}:${key}${opts.part ? `|part=${opts.part}` : ""}${typeof opts.window === "number" ? `|window=${opts.window}` : ""}}}`;
}

/**
 * The placeholder strings for one envelope, server-built (so attribution stays
 * exact: each names this envelope's key, part and window):
 *   · UNAVAILABLE (or no value) or a scalar   ⇒ { placeholder } — UNAVAILABLE renders "unavailable — <reason>"
 *   · an object value                        ⇒ { placeholders: { <part>: … } } — one per part with a declared unit
 * |window=<days> is included whenever the envelope's window.days is a number (it
 * always resolves to this envelope, and keeps two windows of one key apart);
 * never when it is null (a fixed window, or none).
 */
export function placeholdersFor(e: MetricEnvelope): { placeholder: string } | { placeholders: Record<string, string> } {
  const window = e.window.days;
  const units = e.valueUnits;
  if (e.status === "UNAVAILABLE" || e.value === null || typeof e.value === "number" || units === null || typeof units === "string") {
    return { placeholder: formatPlaceholder(e.metric, { window }) };
  }
  const placeholders: Record<string, string> = {};
  for (const [part, unit] of Object.entries(units)) if (FIGURE_UNITS.includes(unit)) placeholders[part] = formatPlaceholder(e.metric, { part, window });
  return { placeholders };
}

/**
 * S2 F-C2 — the LABEL placeholder strings for one envelope, server-built like placeholdersFor:
 *   labelPlaceholder   {{l:<key>[|window=N]}} — the metric's registry label (always)
 *   labelPlaceholders  { <part>: {{l:<key>|part=<part>…}} } — one per declared CATEGORY part (its
 *                      label) and per RANKING part (the label of the category the server ranked
 *                      first) — only on an object value. Attribution stays server-side: a
 *                      ranking's name and figure both come from the envelope's ranked category.
 */
export function labelPlaceholdersFor(e: MetricEnvelope): { labelPlaceholder: string; labelPlaceholders?: Record<string, string> } {
  const window = e.window.days;
  const labelPlaceholder = formatPlaceholder(e.metric, { window, kind: "l" });
  const roles = e.partRoles ?? null;
  if (e.status === "UNAVAILABLE" || e.value === null || typeof e.value === "number" || roles === null) return { labelPlaceholder };
  const labelPlaceholders: Record<string, string> = {};
  for (const [part, role] of Object.entries(roles)) {
    if (role === "category" || role === "ranking") labelPlaceholders[part] = formatPlaceholder(e.metric, { part, window, kind: "l" });
  }
  return Object.keys(labelPlaceholders).length > 0 ? { labelPlaceholder, labelPlaceholders } : { labelPlaceholder };
}

/** The options of one placeholder, or null when malformed (unknown / repeated option, bad window). */
function placeholderOptions(raw: string): { part: string | null; window: number | null } | null {
  let part: string | null = null, window: number | null = null;
  const seen = new Set<string>();
  for (const opt of raw.split("|").slice(1)) {
    const [k, v] = opt.split("=");
    if (seen.has(k)) return null;
    seen.add(k);
    if (k === "part" && /^[A-Za-z][A-Za-z0-9]*$/.test(v)) part = v;
    else if (k === "window" && /^\d{1,3}$/.test(v)) window = Number(v);
    else return null;
  }
  return { part, window };
}
/** A unit the model wrote itself next to a placeholder — the server supplies units (C1). */
const UNIT_BEFORE = /(?:\$|\bUSD|\bUS\$)\s*$/i;
const UNIT_AFTER = /^\s*(?:%|percent\b|pct\b|[kKM]\b|bn\b|USD\b|dollars?\b|cents?\b)/i;


/**
 * The EXACT envelope key a placeholder's written key names — or why none. The key
 * match is exact: a written "<id>@N" names only that key. A BARE "<id>" (no @N) is
 * resolved only by safety net (1) (bareKeyNet). Never a fuzzy / label match.
 */
export type PlaceholderKeyMatch = { kind: "KEY"; key: string } | { kind: "UNRESOLVED"; reason: "UNKNOWN_KEY" | "VERSION" | "NOT_READ" };
export function placeholderKeyOf(envelopes: readonly MetricEnvelope[], written: string): PlaceholderKeyMatch {
  const versioned = written.includes("@");
  const id = idOfKey(written);
  const readOfId = [...new Set(envelopes.map((e) => e.metric as string))].filter((k) => idOfKey(k) === id);
  if (versioned) {
    if (readOfId.includes(written)) return { kind: "KEY", key: written };
    if (readOfId.length > 0) return { kind: "UNRESOLVED", reason: "VERSION" };
  } else {
    const net = bareKeyNet(readOfId);
    if (net !== null) return { kind: "KEY", key: net };
    if (readOfId.length > 0) return { kind: "UNRESOLVED", reason: "VERSION" };
  }
  if (versioned ? KNOWN_KEYS.has(written) : KNOWN_IDS.has(id)) return { kind: "UNRESOLVED", reason: "NOT_READ" };
  return { kind: "UNRESOLVED", reason: KNOWN_IDS.has(id) ? "VERSION" : "UNKNOWN_KEY" };
}

/**
 * SAFETY NET (1), S2-approved 2026-11-04: a BARE id (no @N) resolves iff exactly
 * ONE version of that id was read this turn — it then names that exact key. Two
 * versions read ⇒ null (VERSION: ambiguous); none read ⇒ null (NOT_READ / UNKNOWN_KEY).
 * Dropping this net = `return null`.
 */
export function bareKeyNet(readKeysOfId: readonly string[]): string | null {
  return readKeysOfId.length === 1 ? readKeysOfId[0] : null;
}

/**
 * The part a placeholder renders from ONE envelope — or why none. An UNAVAILABLE
 * envelope renders "unavailable — reason" whatever the part (no figure exists).
 */
export function placeholderPartOf(e: MetricEnvelope, part: string | null): { kind: "PART"; part: string | null } | { kind: "UNRESOLVED"; reason: "MISSING_PART" | "UNKNOWN_PART" } {
  if (e.status === "UNAVAILABLE" || e.value === null) return { kind: "PART", part };
  if (typeof e.value === "number") return part === null ? { kind: "PART", part } : { kind: "UNRESOLVED", reason: "UNKNOWN_PART" };
  const units = e.valueUnits;
  if (units === null || typeof units === "string") return { kind: "UNRESOLVED", reason: "UNKNOWN_PART" };
  if (part === null) {
    const only = onePartNet(units);
    return only !== null ? { kind: "PART", part: only } : { kind: "UNRESOLVED", reason: "MISSING_PART" };
  }
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  return own(e.value, part) && own(units, part) ? { kind: "PART", part } : { kind: "UNRESOLVED", reason: "UNKNOWN_PART" };
}

/**
 * SAFETY NET (2), S2-approved 2026-11-04: an object value with exactly ONE declared
 * numeric part (e.g. economics-ai-cost's { spendUsd }) resolves without |part — to
 * that part. Two or more declared parts ⇒ null (MISSING_PART): a part-less
 * placeholder never picks a total or a headline for the model (S2 rejected that).
 * Dropping this net = `return null`.
 */
export function onePartNet(units: Readonly<Record<string, FigureUnit>>): string | null {
  const parts = Object.entries(units).filter(([, u]) => FIGURE_UNITS.includes(u));
  return parts.length === 1 && Object.keys(units).length === 1 ? parts[0][0] : null;
}

/** The shape of each malformed placeholder left in the prose (counts only). */
export function malformedShapes(prose: string): ReasonCounts<MalformedReason> {
  const out: ReasonCounts<MalformedReason> = {};
  const add = (r: MalformedReason) => { out[r] = (out[r] ?? 0) + 1; };
  const rest = prose.replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => {
    const t = inner.trim();
    if (!/^[ml]:/.test(t)) { add("NO_PREFIX"); return " "; }
    const key = t.slice(2).split("|")[0].trim();
    add(/^[a-z0-9][a-z0-9-]{0,80}(?:@\d{1,4})?$/.test(key) ? "BAD_OPTION" : "NOT_A_KEY");
    return " ";
  });
  for (const _ of rest.matchAll(/\{\{|\}\}/g)) add("STRAY_BRACES");
  return out;
}

// ── The user-numeral allowance (S2-approved 2026-11-04; one named, pinned function) ──
//
// The operator's own window ("in the past 30 days") may be echoed. A digit run
// in the model's prose is admitted ONLY when ALL hold:
//   · the same digit run appears verbatim (as a whole digit run) in THIS turn's
//     SCRUBBED question (scrubOperatorText);
//   · it is adjacent to a time unit — h, hour(s), day(s), week(s), month(s), year(s).
//     There is NO year branch (S2 cross-impact note): the SEC-AI-005 scrub turns
//     every 4+ digit run into [number] before the model sees the question, so a
//     typed year can never match. Relaxing the scrub would need its own S2 ruling.
//   · it does NOT equal any value in this turn's envelopes (numeric compare,
//     integer rounding: |value − n| ≤ 0.5). If it does ⇒ USER_NUMERAL_COLLISION.
// It never makes a metric VALUE acceptable: values come only from placeholders.

export const USER_NUMERAL_TIME_UNIT = /^[\s-]?(?:h|hours?|days?|weeks?|months?|years?)\b/i;

function envelopeValueNumbers(envelopes: readonly MetricEnvelope[]): number[] {
  const out: number[] = [];
  for (const e of envelopes) {
    if (e.status === "UNAVAILABLE" || e.value === null) continue;
    if (typeof e.value === "number") out.push(e.value);
    else for (const v of Object.values(e.value)) {
      if (typeof v === "number" && Number.isFinite(v)) out.push(v);
      else if (v !== null && typeof v === "object" && typeof v.figure === "number" && Number.isFinite(v.figure)) out.push(v.figure); // a ranking part's figure (S2 ruling 2026-11-05)
    }
  }
  return out;
}

export function admitUserNumerals(prose: string, scrubbedQuestion: string, envelopes: readonly MetricEnvelope[]): { prose: string; admitted: number; collision: boolean } {
  let admitted = 0, collision = false;
  const values = envelopeValueNumbers(envelopes);
  const out = prose.replace(/(?<![\w.,$])\d+(?![\d.,]\d|\d)/g, (tok: string, offset: number) => {
    const after = prose.slice(offset + tok.length);
    if (/^(?:\.\d|,\d|%)/.test(after)) return tok;
    const n = Number(tok);
    if (!USER_NUMERAL_TIME_UNIT.test(after)) return tok;
    if (!new RegExp(`(?<!\\d)${tok}(?!\\d)`).test(scrubbedQuestion)) return tok;
    if (values.some((v) => Math.abs(v - n) <= 0.5)) { collision = true; return tok; }
    admitted++;
    return " ";
  });
  return { prose: out, admitted, collision };
}

/** A figure in its EXPLICIT unit (the envelope's valueUnits — never inferred from a name). */
const fmtNumber = (n: number, unit: FigureUnit): string => {
  if (unit === "usd") return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (unit === "pct") return `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
const FIGURE_UNITS: readonly FigureUnit[] = ["count", "usd", "pct"];

/**
 * The text a placeholder renders to, from ONE envelope — or null (unresolvable:
 * a part on a scalar, no part / an unknown part on an object value, or no
 * declared unit for the figure).
 * Status wording (server-written), PER FIGURE:
 *   MEASURED, or a figure that is not an estimate   "<v>"
 *   ESTIMATED and the figure is an estimate         "about <v> (estimated)"
 *   PARTIAL                                         "at least <v>"
 *   PARTIAL and the figure is an estimate           "at least <v> (estimated)"
 *   UNAVAILABLE                                     "unavailable — <reason>";  a null part ⇒ "unavailable" (never 0)
 * A figure IS an estimate (S2, binding): the metric is an estimate (status
 * ESTIMATED, basis.kind "estimated", or the definition's provenance — `estimated`)
 * AND either the part is listed in the envelope's `estimatedParts` (the source of
 * truth; it may list a derived pct), or — when the metric lists none — the
 * figure's unit is usd. A count is never an estimate unless listed.
 * A RANKING part (S2 ruling 2026-11-05; envelope partRoles "ranking", e.g.
 * largestMeasuredCategory) renders "<the figure as above>" plus "; <qualifier>" when
 * the envelope's ranking carries one — all server text; its null (no category
 * measured) renders "unavailable" like any null part. S2 F-C2 (2026-11-07): the
 * FIGURE ONLY — the ranked category's NAME is {{l:<key>|part=<ranking>}} (renderLabel).
 */
export function renderPlaceholder(e: MetricEnvelope, part: string | null, estimated = false,
  /** A1–A4 (composed briefing): `window: false` leaves the window out of the qualifier — the composed sentence states it once (quotableWindowPhrase). Wording otherwise identical (F-3).
   *  `stale: false` leaves the STALE qualifier out — only for a composed sentence that states it once itself. */
  opts: { window?: boolean; stale?: boolean } = {}): string | null {
  if (e.status === "UNAVAILABLE" || e.value === null) return `unavailable — ${e.reason ?? "no figure"}`;
  const units = e.valueUnits ?? null;
  let n: number | null;
  let unit: FigureUnit | undefined;
  let ranked: RankedCategory | null = null;
  if (typeof e.value === "number") {
    if (part !== null || typeof units !== "string") return null;
    n = e.value; unit = units;
  } else {
    if (part === null || units === null || typeof units === "string" || !Object.prototype.hasOwnProperty.call(e.value, part)) return null;
    unit = Object.prototype.hasOwnProperty.call(units, part) ? units[part] : undefined;
    const raw = e.value[part] ?? null;
    if (raw === null) return "unavailable";
    if (typeof raw === "object") {
      // Only a DECLARED ranking part may hold a ranked category (else unresolvable).
      if (e.partRoles?.[part] !== "ranking" || typeof raw.label !== "string") return null;
      ranked = raw; n = raw.figure;
    } else n = raw;
  }
  if (!unit || !FIGURE_UNITS.includes(unit) || typeof n !== "number" || !Number.isFinite(n)) return null;
  const metricIsEstimate = estimated || e.status === "ESTIMATED" || e.basis?.kind === "estimated";
  const listed = e.estimatedParts ?? null;
  const isEstimate = metricIsEstimate && (listed !== null ? part !== null && listed.includes(part) : unit === "usd");
  // A configuration part (unwindowedParts, e.g. a threshold) is not measured over the window: no window label.
  const win = opts.window === false || (part !== null && (e.unwindowedParts ?? []).includes(part)) ? null : envelopeWindowText(e);
  const notes = [...(win !== null ? [win] : []), ...(isEstimate ? ["estimated"] : [])];
  // STALE: the figure itself says it is not current (server text), so no reader can present it as now.
  const stale = opts.stale !== false && isStaleEnvelope(e) ? staleQualifierOf(e) : null;
  const qual = [...(notes.length ? [notes.join(", ")] : []), ...(stale ? [stale] : [])].join("; ");
  const fig = `${fmtNumber(n, unit)}${qual ? ` (${qual})` : ""}`;
  // F-3 (S2 2026-11-08): "at least" ONLY for a part that is truly a lower bound — a PARTIAL part the envelope does not list as exact.
  const floor = e.status === "PARTIAL" && !(part !== null && (e.exactParts ?? []).includes(part));
  const worded = floor ? `at least ${fig}` : isEstimate ? `about ${fig}` : fig;
  return ranked ? `${worded}${ranked.qualifier ? `; ${ranked.qualifier}` : ""}` : worded;
}

/** What a ranking label renders when no category was measured (never a category, never the total). */
export const NO_RANKED_CATEGORY = "no measured category";

/**
 * S2 F-C2 (2026-11-07) — the text a LABEL placeholder {{l:…}} renders, from ONE envelope —
 * or null (unresolvable ⇒ UNKNOWN_PART ⇒ the fallback). Server text only:
 *   no part                                   the metric's registry label (`metricLabel`)
 *   a RANKING part                            the ranked category's own label (from the
 *                                             envelope's ranked value); none measured /
 *                                             UNAVAILABLE ⇒ NO_RANKED_CATEGORY
 *   a CATEGORY part                           the envelope's partLabels[part]
 *   the TOTAL part                            the metric's registry label
 *   any other part / a part the value lacks   null
 */
export function renderLabel(e: MetricEnvelope, part: string | null, metricLabel: string | null): string | null {
  if (part === null) return metricLabel;
  const role = e.partRoles?.[part];
  const own = (o: object | null | undefined, k: string) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
  if (role === "ranking") {
    if (e.status === "UNAVAILABLE" || e.value === null || typeof e.value === "number") return own(e.partRoles, part) ? NO_RANKED_CATEGORY : null;
    if (!own(e.value, part)) return null;
    const raw = e.value[part];
    if (raw === null || raw === undefined) return NO_RANKED_CATEGORY;
    return typeof raw === "object" && typeof raw.label === "string" ? raw.label : null;
  }
  if (e.value !== null && typeof e.value === "object" && !own(e.value, part)) return null;
  if (role === "category") return own(e.partLabels, part) ? e.partLabels![part] : null;
  if (role === "total") return metricLabel;
  return null;
}

/**
 * WINDOW MIXING (S2 ruling 2026-11-05): the code-written note when the figures an
 * answer PLACED (the envelopes its resolved placeholders rendered from — never
 * prose) cover ≥ 2 distinct windows. Each window is its server label in the short
 * form ("this UTC calendar month to date", "the last 30 days": `in the ` ⇒ `the `,
 * no start date), in first-placed order; an envelope with no window (point in
 * time) does not count. One window, or one figure ⇒ null.
 *   "These figures cover different periods (this UTC calendar month to date vs. the last 30 days) and are not directly comparable."
 */
export function windowMixNote(placed: readonly MetricEnvelope[]): string | null {
  const windows: string[] = [];
  for (const e of placed) {
    const w = e.window;
    const label = w.label ?? (w.days !== null ? daysWindowLabel(w.days) : w.hours !== null ? hoursWindowLabel(w.hours) : null);
    if (!label) continue;
    const short = label.replace(/^in the /, "the ");
    if (!windows.includes(short)) windows.push(short);
  }
  return windows.length >= 2 ? `These figures cover different periods (${windows.join(" vs. ")}) and are not directly comparable.` : null;
}

/**
 * WHICH of THIS turn's envelopes a placeholder names (S2 ruling 2026-11-04; one
 * named function so the rule is reviewable in one place). The key match is EXACT.
 *   · (the same key + window read twice ⇒ the LAST read renders)
 *   · no envelope for the key this turn                        ⇒ UNREAD (unresolved)
 *   · NO |window: resolves iff the key was read with exactly ONE window this
 *     turn, whatever it is (the same window read twice counts once); two or more
 *     different windows of the key                             ⇒ MISMATCH (ambiguous)
 *   · |window=N: N must equal an envelope's window.days; a fixed-window metric
 *     (window.days null) takes NO |window at all               ⇒ else MISMATCH
 * The rendered figure always states the envelope's actual window (envelopeWindowText),
 * so the operator sees it whichever syntax the model used.
 */
export type PlaceholderEnvelopeMatch = { kind: "MATCH"; envelope: MetricEnvelope } | { kind: "MISMATCH" } | { kind: "UNREAD" };
export function matchPlaceholderEnvelope(envelopes: readonly MetricEnvelope[], key: string, window: number | null): PlaceholderEnvelopeMatch {
  const same = envelopes.filter((e) => e.metric === key);
  if (same.length === 0) return { kind: "UNREAD" };
  if (window !== null) {
    const e = same.filter((x) => x.window.days !== null && x.window.days === window).pop();
    return e ? { kind: "MATCH", envelope: e } : { kind: "MISMATCH" };
  }
  const windows = new Set(same.map((x) => `${x.window.days}|${x.window.hours}`));
  return windows.size === 1 ? { kind: "MATCH", envelope: same[same.length - 1] } : { kind: "MISMATCH" };
}

/**
 * QUESTION C (2026-11-08, Preview): "What's costing me the most money in the past 30 days?"
 * — the model read economics-operating-cost@1 (a FIXED window: the billing cycle) with
 * window=30 (ignored at the read: isFixedWindow), then wrote its placeholder with
 * |window=30 to match the operator's period. matchPlaceholderEnvelope (rightly) finds no
 * 30-day envelope ⇒ WINDOW_MISMATCH ⇒ the whole answer became the fallback. The read
 * already ignores a window on a fixed metric (S2 option (a)); the placeholder now does
 * the same, but ONLY when every envelope of the key this turn is fixed-window (days null)
 * AND N is a day-window the operator asked for. The figure still renders the envelope's
 * OWN window, and the asked period then drives the RESOLVED_WITH_WINDOW_NOTE note / the
 * period_mismatch correction. Any other |window=N keeps its strict match.
 */
export function fixedWindowOption(envelopes: readonly MetricEnvelope[], key: string, window: number | null, askedDays: readonly number[]): number | null {
  if (window === null || !askedDays.includes(window)) return window;
  const same = envelopes.filter((e) => e.metric === key);
  return same.length > 0 && same.every((e) => e.window.days === null) ? null : window;
}


export interface PlaceholderOutcome {
  segments: AnswerSegment[];
  /** The same answer with figures as typed spans (B11). Joining its texts gives `segments`' text. */
  typed: TypedAnswerSegment[];
  summary: ClaimsSummary;
  /** metric key → the figures rendered for it (only text that is IN the answer). */
  figures: Map<string, string[]>;
  /** The envelopes the resolved placeholders rendered from (for the requested-window check). */
  placed: MetricEnvelope[];
  /** Diagnosis (counts only): why placeholders were unresolved / malformed. */
  unresolvedBy: ReasonCounts<UnresolvedReason>;
  malformedBy: ReasonCounts<MalformedReason>;
  /** Diagnosis (counts only): the kinds of leftover digit runs behind UNGROUNDED_DIGIT. */
  digitBy: ReasonCounts<DigitKind>;
  /** (i) Counts by NumberWordFamily of the NUMBER_WORD runs (UNGROUNDED_DIGIT only). */
  wordFamilyBy: ReasonCounts<NumberWordFamily>;
  /**
   * The MODEL'S OWN prose (every rendered figure / label taken out), for counts-only
   * diagnoses (periodMismatchCount). Never traced, stored or returned to a client.
   */
  modelProse: string;
  /** Counts-only diagnoses (S2 2026-11-08): labelRepeatCount / windowRepeatCount over the rendered answer. */
  labelRepeat: number;
  windowRepeat: number;
}

/**
 * Resolve every placeholder in the sanitised segments (text and link labels;
 * hrefs are never touched) and apply the leftover-digit rule. `labels` are the
 * registry labels this turn's tools returned (the ONLY digit allowlist besides
 * envelope freshness dates and exact window-start dates).
 */
export function resolvePlaceholders(
  segments: readonly AnswerSegment[], envelopes: readonly MetricEnvelope[], labels: ReadonlySet<string>, scrubbedQuestion = "",
  /** The metric's DEFINITION is an estimate (registry provenance) — so a PARTIAL floor still says "(estimated)". */
  isEstimated: (key: string) => boolean = () => false,
  /** The metric's registry label for {{l:<key>}} (S2 F-C2) — server text; default: the registry. */
  metricLabel: (key: string) => string | null = (key) => LABEL_OF_KEY.get(key) ?? null,
): PlaceholderOutcome {
  let claims = 0, resolved = 0, unresolved = 0, admitted = 0;
  let malformed = false, unit = false, digit = false, windowMismatch = false, collision = false;
  const figures = new Map<string, string[]>();
  const placed: MetricEnvelope[] = [];
  const unresolvedBy: ReasonCounts<UnresolvedReason> = {};
  const malformedBy: ReasonCounts<MalformedReason> = {};
  const digitBy: ReasonCounts<DigitKind> = {};
  const wordFamilyBy: ReasonCounts<NumberWordFamily> = {};
  const why = (r: UnresolvedReason) => { unresolvedBy[r] = (unresolvedBy[r] ?? 0) + 1; unresolved++; return " "; };
  const asOfDays = envelopes.map((e) => e.freshness.asOf).filter((x): x is string => typeof x === "string").map((a) => a.slice(0, 10));
  // An envelope's explicit window start (reader-supplied ISO date) — allowed ONLY as that exact date token.
  const windowStarts = envelopes.map((e) => e.window.start).filter((x): x is string => typeof x === "string");
  const labelList = [...labels].filter((l) => /\d/.test(l) || numberWordCount(l) > 0).sort((a, b) => b.length - a.length);
  // The day-windows the operator asked about (the Question C rule, fixedWindowOption).
  // S2 L1: ordered-list markers must run 1, 2, 3, … across the whole answer (stripListMarkers).
  const markerSeq = { next: 1 };
  const askedDays = requestedWindows(scrubbedQuestion).filter((a) => a.hours % 24 === 0).map((a) => a.hours / 24);
  const modelProse: string[] = [];
  // The rendered answer as one stream (segments in order) with every server span marked —
  // for the counts-only labelRepeat / windowRepeat diagnoses. Never traced, stored or returned.
  const stream = { text: "", spans: [] as RenderedSpan[] };

  const resolveParts = (text: string, lineStart = true): { text: string; parts: TypedAnswerSegment[] } => {
    const meta: ({ kind: "figure"; metric: string; window: number | string | null; windowPhrase: string | null; stale: boolean; part: string | null } | { kind: "label" })[] = [];
    const out = text.replace(PLACEHOLDER, (m, kind: "m" | "l", written: string, rawOpts: string, offset: number) => {
      claims++;
      const opts = placeholderOptions(rawOpts);
      if (!opts) { malformed = true; malformedBy.BAD_OPTION = (malformedBy.BAD_OPTION ?? 0) + 1; unresolved++; return " "; }
      const before = text.slice(0, offset), after = text.slice(offset + m.length);
      // A unit beside a FIGURE is the model's (C1); a label carries no unit, so the check is figures-only.
      if (kind === "m" && (UNIT_BEFORE.test(before) || UNIT_AFTER.test(after))) { unit = true; unresolved++; return " "; }
      const k = placeholderKeyOf(envelopes, written);
      if (k.kind === "UNRESOLVED") return why(k.reason);
      const key = k.key;
      const match = matchPlaceholderEnvelope(envelopes, key, fixedWindowOption(envelopes, key, opts.window, askedDays));
      if (match.kind === "MISMATCH") { windowMismatch = true; unresolved++; return " "; }
      if (match.kind === "UNREAD") return why("NOT_READ");
      const e = match.envelope;
      if (kind === "l") {
        // S2 F-C2: the NAME, server text from this envelope (renderLabel); unknown ⇒ unresolved ⇒ the fallback.
        const label = renderLabel(e, opts.part, metricLabel(key));
        if (label === null) return why("UNKNOWN_PART");
        resolved++;
        meta.push({ kind: "label" });
        return `${SENTINEL}${label}${SENTINEL}`;
      }
      const p = placeholderPartOf(e, opts.part);
      if (p.kind === "UNRESOLVED") return why(p.reason);
      const fig = renderPlaceholder(e, p.part, isEstimated(key));
      if (fig === null) return why("UNKNOWN_PART");
      resolved++;
      if (!placed.includes(e)) placed.push(e);
      figures.set(key, [...(figures.get(key) ?? []), fig]);
      // The figure's qualifier carries its window unless the part is unwindowed (renderPlaceholder's rule).
      const windowed = !(p.part !== null && (e.unwindowedParts ?? []).includes(p.part)) && envelopeWindowText(e) !== null;
      meta.push({ kind: "figure", metric: key, window: e.window.days ?? envelopeWindowText(e), windowPhrase: windowed ? quotableWindowPhrase(e) : null, stale: isStaleEnvelope(e),
        // B1: only a part the envelope DECLARES (code); a model-written part on an UNAVAILABLE envelope is never kept.
        part: p.part !== null && e.valueUnits !== null && typeof e.valueUnits === "object" && Object.prototype.hasOwnProperty.call(e.valueUnits, p.part) ? p.part : null });
      return `${SENTINEL}${fig}${SENTINEL}`;
    });
    // The model's own prose: placeholders out, then the allowlist, then no digit may remain.
    let prose = out.replace(new RegExp(`${SENTINEL}[^${SENTINEL}]*${SENTINEL}`, "g"), " ");
    // Briefing list (2026-11-08): an ordered-list MARKER is structure, not a figure — exactly what
    // answerBlocks reads as one ("1. " / "2) " at the start of a line; the renderer drops it).
    prose = stripListMarkers(prose, lineStart, markerSeq);
    modelProse.push(prose);
    if (/\{\{|\}\}/.test(prose)) {
      malformed = true;
      for (const [r, n] of Object.entries(malformedShapes(prose)) as [MalformedReason, number][]) malformedBy[r] = (malformedBy[r] ?? 0) + n;
    }
    for (const l of labelList) prose = prose.split(l).join(" ");
    prose = prose.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, (d) => (asOfDays.includes(d.slice(0, 10)) || windowStarts.includes(d) ? " " : d));
    const u = admitUserNumerals(prose, scrubbedQuestion, envelopes);
    prose = u.prose; admitted += u.admitted; if (u.collision) collision = true;
    if (/\d/.test(prose)) {
      digit = true;
      for (const [k, n] of Object.entries(classifyDigitRuns(prose)) as [DigitKind, number][]) digitBy[k] = (digitBy[k] ?? 0) + n;
    }
    const words = numberWordCount(prose, scrubbedQuestion);
    if (words > 0) {
      digit = true; digitBy.NUMBER_WORD = (digitBy.NUMBER_WORD ?? 0) + words;
      for (const [f, n] of Object.entries(numberWordFamilies(prose, scrubbedQuestion)) as [NumberWordFamily, number][]) wordFamilyBy[f] = (wordFamilyBy[f] ?? 0) + n;
    }
    // A model-written qualifier the server already wrote ("at least at least 5", "about about $1") collapses to one.
    const pieces = out
      .replace(new RegExp(`\\b(at least|about)\\s+${SENTINEL}(?=\\1\\b)`, "gi"), SENTINEL)
      .split(SENTINEL);
    // S2 ruling 2026-11-05 (FIX 2): "at {{m:PARTIAL}}" read "at at least $X". At the text→figure JOIN only
    // (never a replace over prose): a text piece ending in the word "at" before a figure that renders
    // "at least …" loses that "at" and its trailing whitespace (the whitespace before it stays).
    // S2 ruling 2026-11-05 (ii): a dropped "At" (capital A) makes the figure's lead "At least"; otherwise unchanged.
    for (let i = 0; i + 1 < pieces.length; i += 2) {
      const at = /^at least\b/.test(pieces[i + 1]) ? /\b(at)\s+$/i.exec(pieces[i]) : null;
      if (!at) continue;
      pieces[i] = pieces[i].slice(0, at.index);
      if (at[1].startsWith("A")) pieces[i + 1] = `At${pieces[i + 1].slice(2)}`;
    }
    // Odd pieces are the figures / labels, in placeholder order (one per resolved placeholder).
    // A label is server text but not a figure: it is stored as text (B11 replays it like prose).
    const parts: TypedAnswerSegment[] = [];
    pieces.forEach((piece, i) => {
      const f = i % 2 === 1 ? meta[(i - 1) / 2] : null;
      if (f) stream.spans.push({ start: stream.text.length, end: stream.text.length + piece.length, kind: f.kind, text: piece, windowPhrase: f.kind === "figure" ? f.windowPhrase : null });
      stream.text += piece;
      // B1: the resolved PART rides on the typed figure (response-only figureSources; never stored).
      if (f?.kind === "figure") parts.push({ kind: "figure", text: piece, metric: f.metric, window: f.window, ...(f.stale ? { figureClass: "STALE" as const } : {}), ...(f.part !== null ? { part: f.part } : {}) });
      else if (piece) {
        const prev = parts[parts.length - 1];
        if (prev?.kind === "text") prev.text += piece; else parts.push({ kind: "text", text: piece });
      }
    });
    return { text: pieces.join(""), parts };
  };
  // A link label never starts a line (answerBlocks never reads a marker in a link): no marker allowance.
  const resolveText = (text: string): string => resolveParts(text, false).text;

  const typed: TypedAnswerSegment[] = [];
  const out: AnswerSegment[] = segments.map((x, i) => {
    if (x.kind === "link") { const t = resolveText(x.text); typed.push({ kind: "link", text: t, href: x.href }); return { ...x, text: t }; }
    // A text segment starts a line when it is the first, or the segment before it ended one.
    const r = resolveParts(x.text, i === 0 || /\n[ \t]*$/.test(segments[i - 1].text));
    typed.push(...r.parts);
    return { kind: "text", text: r.text };
  });
  const verdict: PlaceholderVerdict = malformed ? "MALFORMED_PLACEHOLDER" : unit ? "UNIT_MISMATCH" : windowMismatch ? "WINDOW_MISMATCH"
    : unresolved > 0 ? "UNRESOLVED_PLACEHOLDER" : collision ? "USER_NUMERAL_COLLISION" : digit ? "UNGROUNDED_DIGIT" : claims > 0 ? "RESOLVED" : "NONE";
  return { segments: out, typed, summary: { claims, resolved, unresolved, admitted, verdict }, figures, placed, unresolvedBy, malformedBy,
    // The digit diagnosis describes UNGROUNDED_DIGIT only (another verdict decided the answer first).
    digitBy: verdict === "UNGROUNDED_DIGIT" ? digitBy : {}, wordFamilyBy: verdict === "UNGROUNDED_DIGIT" ? wordFamilyBy : {}, modelProse: modelProse.join(" "),
    labelRepeat: labelRepeatCount(stream.text, stream.spans),
    windowRepeat: windowRepeatCount(stream.text, stream.spans, envelopes.map(quotableWindowPhrase)) };
}
