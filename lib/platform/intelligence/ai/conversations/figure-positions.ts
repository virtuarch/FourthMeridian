/**
 * lib/platform/intelligence/ai/conversations/figure-positions.ts  (Platform AI B1 — figureSources shapes + the conversations positioning)
 *
 * The PURE half of the response's metadata-only `figureSources` (the registry half — closed codes, /ask
 * alignment — is tools/figure-sources.ts, which re-exports everything here). Split out so the conversations
 * handler positions the turn's placed spans without importing the tool registry. No imports, no I/O.
 *
 *   { segment, start, end, source: "record", recordKind, fieldCode }      — {{r:h|<field>}} (ref / T2 / closed field)
 *   { segment, start, end, source: "metric", metricKey, resultPath }      — {{m:<key>[|part=…]}}
 *   { segment, start, end, source: "aggregate", tool, resultPath }        — {{a:<tool>|<path>}} (S2 09io B1–B6)
 *                                                                           THE CLOSED KEY SET (FIGURE_SOURCE_KEYS)
 */

/** The stored metric key of an aggregate figure (= compose/aggregate.ts aggregateKey; pinned by figure-sources.test.ts). */
const aggregateStoredKey = (tool: string, path: string): string => `agg:${tool}:${path}`;

/** THE closed key set (each entry carries exactly its kind's subset below). */
export const FIGURE_SOURCE_KEYS = ["segment", "start", "end", "source", "recordKind", "fieldCode", "metricKey", "resultPath", "tool"] as const;
export const FIGURE_SOURCE_RECORD_KEYS = ["segment", "start", "end", "source", "recordKind", "fieldCode"] as const;
export const FIGURE_SOURCE_METRIC_KEYS = ["segment", "start", "end", "source", "metricKey", "resultPath"] as const;
export const FIGURE_SOURCE_AGGREGATE_KEYS = ["segment", "start", "end", "source", "tool", "resultPath"] as const;
export const FIGURE_SOURCE_KINDS = ["record", "metric", "aggregate"] as const;

/** A placed span's closed source (no position yet). */
export type PlacedFigureSource =
  | { readonly source: "record"; readonly recordKind: string; readonly fieldCode: string }
  | { readonly source: "metric"; readonly metricKey: string; readonly resultPath: string }
  | { readonly source: "aggregate"; readonly tool: string; readonly resultPath: string };

/** One response entry. */
export type FigureSourceEntry = { readonly segment: number; readonly start: number; readonly end: number } & PlacedFigureSource;

/**
 * One placed span of the typed answer, in answer order: its span kind and its closed source (null when the
 * span is outside the closed sets — kept so positions stay aligned, never annotated). Metadata only.
 */
export interface PlacedSpan { readonly span: "figure" | "record"; readonly entry: PlacedFigureSource | null }

/** A frozen entry with exactly the record or the metric key subset (never a spread of the input). */
export const figureSourceEntry = (segment: number, start: number, end: number, e: PlacedFigureSource): FigureSourceEntry =>
  Object.freeze(e.source === "record"
    ? { segment, start, end, source: "record" as const, recordKind: e.recordKind, fieldCode: e.fieldCode }
    : e.source === "aggregate"
      ? { segment, start, end, source: "aggregate" as const, tool: e.tool, resultPath: e.resultPath }
      : { segment, start, end, source: "metric" as const, metricKey: e.metricKey, resultPath: e.resultPath });

type Rendered = { readonly kind: string; readonly text: string };
type StoredView = { readonly kind: string; readonly metric?: unknown; readonly rk?: unknown; readonly f?: unknown };

/**
 * Conversations — the turn's placed spans aligned with the STORED answer's segments (1:1 with the response's
 * `assistantMessage.content`, handlers.ts renderStoredAnswer): the n-th placed span must be the n-th stored
 * figure / record segment, of the same span kind and (for an annotated span) the same metric key (an aggregate:
 * `agg:<tool>:<path>`, as conversations/turn.ts storedAnswerOf writes it) / record kind + field code. Counts or codes differ, or the content is not 1:1 ⇒ [] (fail closed, never a guess).
 */
export function storedFigureSources(placed: readonly PlacedSpan[], stored: readonly StoredView[], content: readonly Rendered[]): FigureSourceEntry[] {
  if (!Array.isArray(placed) || !Array.isArray(stored) || !Array.isArray(content) || stored.length !== content.length) return [];
  const out: FigureSourceEntry[] = [];
  let n = 0;
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i];
    if (s.kind !== "figure" && s.kind !== "record") continue;
    const p = placed[n++];
    if (!p || p.span !== s.kind) return [];
    const e = p.entry;
    if (e) {
      const same = e.source === "metric" ? s.kind === "figure" && s.metric === e.metricKey
        : e.source === "aggregate" ? s.kind === "figure" && s.metric === aggregateStoredKey(e.tool, e.resultPath)
          : s.kind === "record" && s.rk === e.recordKind && s.f === e.fieldCode;
      if (!same) return [];
      const c = content[i];
      if (!c || typeof c.text !== "string") return [];
      out.push(figureSourceEntry(i, 0, c.text.length, e));
    }
  }
  return n === placed.length ? out : [];
}
