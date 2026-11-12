/**
 * lib/platform/intelligence/ai/compose/aggregate.ts  (Platform AI — `{{a:<tool>|<resultPath>}}`, S2 09io B1–B6)
 *
 * A pack AGGREGATE tool (incident_overview, onboarding_overview, connection_health_overview) returns identity-free
 * counts the model could not state before: any digit it writes replaces the answer (the leftover-digit rule).
 * `{{a:<tool>|<resultPath>}}` lets it PLACE one of those values; the server renders it.
 *
 *   B1  filled ONLY from THIS turn's own result of that tool — `captureAggregateResult` runs in the turn boundary
 *       (authz/boundary.ts) on the result the tool just returned and keeps it in the turn's evidence (core.ts
 *       ToolEvidence.aggregates, per turn): no re-query, no cross-turn, no history. Two calls of one tool in a
 *       turn that disagree on a path ⇒ that path is unavailable (never a guess between them);
 *   B2  only a path in the tool's CLOSED allowlist (tools/contract.ts placeablePaths — counts / codes / dates,
 *       never an identity, institution text or an amount) and only a value of the path's closed type
 *       (compose/closed.ts) is captured;
 *   B3  a tool not called this turn, a path not allowed, a value absent / of the wrong shape / conflicting, a
 *       malformed placeholder or one over the cap ⇒ UNRESOLVED ⇒ the AGGREGATE_UNRESOLVED verdict: the SAME safe
 *       fallback whatever the reason (no oracle);
 *   B4  the leftover-digit rule is unchanged: a resolved placeholder becomes a private sentinel with NO digit
 *       (the index is a letter), the rendered value is put back only AFTER the verdict;
 *   B5  a filled value is stored like a get_metric figure (conversations/turn.ts storedAnswerOf: a `figure`
 *       segment, metric `agg:<tool>:<path>`, window "as of <stamp>") — a POINT-IN-TIME value, labelled so, and
 *       core.ts adds ONE code-written note naming the as-of time; history replays a marker, never the value.
 *
 * Every operator gets the same treatment: the path list is per TOOL, never per operator; whether a value exists
 * is whatever the tool returned to that operator's call (e.g. onboarding_overview's needsHelp, CS only).
 *
 * PURE: no I/O, no clock, no module state. compose/* never imports ../core.
 */

import { closedStamp, closedValueOk, formatClosedValue, type ClosedValueType } from "./closed";

/** One placeable path of a tool (= tools/contract.ts AggregatePathSpec; structural, so compose imports no tools/*). */
export interface AggregatePathRule { readonly path: string; readonly type: ClosedValueType; readonly values?: readonly string[] }

/** THIS turn's capture of one tool: its asOf, and each allowed path's value (null = conflicting between calls). */
export interface AggregateCapture {
  readonly asOf: string | null;
  readonly values: ReadonlyMap<string, { readonly type: ClosedValueType; readonly value: number | string } | null>;
}

/** The turn's captures by tool name (core.ts ToolEvidence.aggregates). */
export type AggregateCaptures = Map<string, AggregateCapture>;

const isPlain = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
};

/** The value at a dotted path of OWN keys of plain objects (never an array element, never a prototype key). */
export function ownValueAt(root: unknown, path: string): unknown {
  let x: unknown = root;
  for (const seg of path.split(".")) {
    if (!isPlain(x) || !Object.prototype.hasOwnProperty.call(x, seg)) return undefined;
    x = x[seg];
  }
  return x;
}

/**
 * B1/B2 — fold one result of `tool` (THIS call's own return value) into the turn's captures. Only the allowlisted
 * paths, only values of their closed type. An UNAVAILABLE / non-object result captures nothing (an earlier call's
 * capture stays). A path whose value differs from an earlier call's this turn becomes null (unavailable).
 */
export function captureAggregateResult(captures: AggregateCaptures, tool: string, rules: readonly AggregatePathRule[] | undefined, result: unknown): void {
  if (!rules || rules.length === 0 || !isPlain(result) || result.status === "UNAVAILABLE") return;
  const fresh = new Map<string, { type: ClosedValueType; value: number | string }>();
  for (const r of rules) {
    const v = ownValueAt(result, r.path);
    if (closedValueOk(r.type, v, r.type === "code" ? (r.values ?? []) : undefined)) fresh.set(r.path, { type: r.type, value: v });
  }
  const asOf = typeof result.asOf === "string" && closedValueOk("isoTime", result.asOf) ? result.asOf : null;
  const prev = captures.get(tool);
  if (!prev) { captures.set(tool, { asOf, values: fresh }); return; }
  const merged = new Map(prev.values);
  for (const [path, v] of fresh) {
    // A path an earlier call of this turn did not have: not proven by every call ⇒ unavailable.
    if (!merged.has(path)) { merged.set(path, null); continue; }
    const p = merged.get(path);
    if (p === null || p === undefined || p.type !== v.type || p.value !== v.value) merged.set(path, null);
  }
  // Paths an earlier call had but this one does not: no longer proven by every call of the turn ⇒ unavailable.
  for (const path of prev.values.keys()) if (!fresh.has(path)) merged.set(path, null);
  captures.set(tool, { asOf: prev.asOf ?? asOf, values: merged });
}

// ── The placeholder ──────────────────────────────────────────────────────────

/** The model's aggregate placeholder: a tool name and a dotted path. */
export const AGGREGATE_PLACEHOLDER = /\{\{\s*a:([a-z][a-z0-9_]{1,40})\|([A-Za-z0-9_.-]{1,200})\s*\}\}/g;
/** Anything else that starts like one (malformed ⇒ unresolved). */
const AGGREGATE_PLACEHOLDER_LOOSE = /\{\{\s*a:[^{}\uE006\uE007]*\}\}/g;

/** Private sentinels (the model's own copies are stripped first). The index is a LETTER: no digit for the digit rule. */
export const AGGREGATE_OPEN = "", AGGREGATE_CLOSE = "";
export const AGGREGATE_SENTINEL = /([a-t])/g;
export const AGGREGATE_PRIVATE_CHARS = /[]/g;
/** At most this many aggregate spans per answer (more ⇒ unresolved). */
export const AGGREGATE_SPANS_MAX = 20;

/** The stored metric key of an aggregate figure: `agg:<tool>:<path>` (conversations/answer.ts REF_ID_SHAPE). */
export const AGGREGATE_KEY_PREFIX = "agg:";
export const aggregateKey = (tool: string, path: string): string => `${AGGREGATE_KEY_PREFIX}${tool}:${path}`;
/** `agg:<tool>:<path>` → { tool, path }, or null for any other key (a metric key). */
export function parseAggregateKey(key: string): { tool: string; path: string } | null {
  const m = /^agg:([a-z][a-z0-9_]{1,40}):([A-Za-z0-9_.-]{1,80})$/.exec(key);
  return m ? { tool: m[1], path: m[2] } : null;
}

/** The point-in-time label a stored aggregate figure carries (its `window`). */
export const aggregateAsOfLabel = (asOf: string | null): string | null => (asOf && closedValueOk("isoTime", asOf) ? `as of ${closedStamp(asOf)}` : null);

/** A resolved aggregate span: the tool + path it was filled from (codes) and the server-rendered text. */
export interface AggregateSpan { readonly tool: string; readonly path: string; readonly text: string; readonly asOf: string | null }

export interface AggregateExtraction {
  text: string;
  spans: AggregateSpan[];
  unresolved: number;
  claims: number;
}

/**
 * Replace every `{{a:<tool>|<path>}}`: a path captured THIS turn for that tool (allowlisted, closed-typed, not
 * conflicting) ⇒ a private sentinel (rendered later); anything else ⇒ a space + one unresolved. No captures ⇒ every
 * aggregate placeholder is unresolved.
 */
export function extractAggregatePlaceholders(raw: string, captures: ReadonlyMap<string, AggregateCapture> | undefined): AggregateExtraction {
  const spans: AggregateSpan[] = [];
  let unresolved = 0, claims = 0;
  let text = raw.replace(AGGREGATE_PLACEHOLDER, (_m, tool: string, path: string) => {
    claims++;
    const cap = captures?.get(tool);
    const v = cap?.values.get(path);
    const rendered = v ? formatClosedValue(v.type, v.value) : null;
    if (!cap || !v || rendered === null || spans.length >= AGGREGATE_SPANS_MAX) { unresolved++; return " "; }
    spans.push({ tool, path, text: rendered, asOf: cap.asOf });
    return `${AGGREGATE_OPEN}${String.fromCharCode(97 + spans.length - 1)}${AGGREGATE_CLOSE}`;
  });
  text = text.replace(AGGREGATE_PLACEHOLDER_LOOSE, () => { claims++; unresolved++; return " "; });
  return { text, spans, unresolved, claims };
}

/** "connection_health_overview" → "connection health overview" (a registered tool name; code, never data). */
export const aggregateToolWords = (tool: string): string => tool.replace(/_/g, " ");

/**
 * B5 — the ONE code-written note an answer with placed aggregate figures carries: they are point-in-time reads,
 * and when. Server data only (tool names + the tools' own asOf).
 */
export function aggregateNoteText(spans: readonly AggregateSpan[]): string | null {
  if (spans.length === 0) return null;
  const byTool = new Map<string, string | null>();
  for (const s of spans) if (!byTool.has(s.tool)) byTool.set(s.tool, s.asOf);
  const parts = [...byTool].map(([tool, asOf]) => `${aggregateToolWords(tool)}${asOf && closedValueOk("isoTime", asOf) ? ` as of ${closedStamp(asOf)}` : ""}`);
  return `Overview counts are point-in-time reads (${parts.join("; ")}).`;
}
