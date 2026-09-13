/**
 * lib/brief-types.ts
 *
 * THE DAILY BRIEF AS THE BROWSER SEES IT — the client-safe response contract.
 * All shapes are serialisable (no Date instances) and importable from client code.
 *
 * ⚠️ WHAT NEVER CROSSES. The artifact's cache machinery (source watermark,
 * material digest, claim timestamps, failure reasons), generation internals
 * (model, prompt version, correlation id), observation evidence paths, the
 * evidence package, and memory payloads all stay on the server. What arrives is
 * the narration, when it was written, what its balances were last checked at, and
 * what the page should do next. lib/ai/brief/view-model.ts builds this field by
 * field and a test walks the result for anything else.
 *
 * (REVIEW-3 history: the earlier rule-based Brief's sections, tracked-account
 * roster and visit states lived here. The AI-generated Brief replaced that engine;
 * see lib/ai/brief/.)
 */

// ── Tone ──────────────────────────────────────────────────────────────────────
// Shared presentation vocabulary (components/atlas/tones.ts, perspective-engine).

export type BriefTone = "neutral" | "positive" | "warning" | "danger" | "info";

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * FRESH           today's Brief, current                                show it
 * CHECK_REQUIRED  today's Brief, sources moved                          show it, ask the server to check
 * STALE           no Brief for today, a safe earlier one exists         show it (dated), generate
 * ABSENT          nothing safe to show                                  skeleton, generate
 * IN_PROGRESS     another request holds the generation                  show what exists, poll
 * FAILED          generation failed recently; retry after retryAfterMs  show what exists, or an error
 * NO_DATA         the Space has no connected accounts                   onboarding
 */
export type BriefState =
  | "FRESH"
  | "CHECK_REQUIRED"
  | "STALE"
  | "ABSENT"
  | "IN_PROGRESS"
  | "FAILED"
  | "NO_DATA";

export interface BriefObservationView {
  kind:       string;
  title:      string;
  body:       string;
  importance: "NOTABLE" | "CONTEXT";
}

export interface BriefArtifactView {
  /** The UTC calendar day the Brief was written for (beta: UTC days). */
  briefDay:     string;
  /** True when this is an earlier day's Brief standing in while today's is prepared. */
  fromPriorDay: boolean;
  /** When the narration was generated. ISO-8601. */
  generatedAt:  string;
  /** The oldest balance observation the Brief was written over, when known. ISO-8601. */
  balancesAsOf: string | null;
  /** Those balances have aged into STALE or worse by now. */
  balancesMayBeStale: boolean;
  headline:     string;
  quiet:        boolean;
  observations: BriefObservationView[];
}

/**
 * Deterministic figures for the metric row — from the Space's snapshot series
 * (the Spaces launcher's authority), never parsed out of the narration.
 */
export interface BriefMetricsView {
  currency:  string;
  netWorth:  number;
  /** The snapshot day the figure is for. */
  asOf:      string;
  estimated: boolean;
  /** The product's one-month window; null when history does not reach it. */
  monthChange: { abs: number; pct: number | null; fromDate: string } | null;
}

export interface BriefResponse {
  /** Echoed so a response for a Space the page has left can be ignored. */
  spaceId: string;
  state:   BriefState;
  /** The Brief to show — today's, or a safe dated fallback — or null. */
  brief:   BriefArtifactView | null;
  /** The page should ask the server to generate (or check) now. */
  needsGeneration: boolean;
  /** FAILED only: how long before generation may be attempted again. */
  retryAfterMs?: number;
  /** Present on page and GET responses; absent from generation responses. */
  metrics?: BriefMetricsView | null;
  /** When the server evaluated this state. ISO-8601. */
  checkedAt: string;
}
