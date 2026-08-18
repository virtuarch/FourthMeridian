/**
 * lib/brief-types.ts
 *
 * Types for the Daily Brief feature.
 * All shapes are serialisable — no Date instances.
 */

// ── Tone ──────────────────────────────────────────────────────────────────────

export type BriefTone = "neutral" | "positive" | "warning" | "danger" | "info";

// ── Visit state ───────────────────────────────────────────────────────────────

/**
 * How long since the user last viewed the brief.
 * Used to tune greeting copy and section priority.
 *
 * immediate  — < 1 hour
 * short      — 1–6 hours
 * day        — 6–24 hours
 * away       — > 24 hours (or first visit after having data)
 * new_user   — no accounts/assets yet
 */
export type VisitState =
  | "immediate"
  | "short"
  | "day"
  | "away"
  | "new_user";

// ── Brief item ────────────────────────────────────────────────────────────────

// (REVIEW-3: the `BriefBasis` trust-provenance slot and `BriefItem.basis` were
// deleted — the builder never emitted a basis and the client dot that read it
// was a seam rendering nothing. Recoverable from git history if per-item
// provenance ships; it would need the Brief pipeline to emit a completeness
// envelope per insight first.)

export interface BriefItem {
  id:      string;
  label:   string;
  value?:  string;
  detail?: string;
  tone?:   BriefTone;
  href?:   string;
}

// ── Tracked account (Since Last Visit modal — "Accounts Tracked" tab) ──────────

/**
 * A distinct, privacy-safe account shown in the Daily Brief "Accounts Tracked"
 * roster. Deduplicated by `id` across eligible Spaces (shown once). Contains no
 * balance. institution/mask are present only for FULL visibility; restricted
 * visibility entries carry a generic name and omit institution/mask.
 */
export interface TrackedAccount {
  id:           string;
  name:         string;
  type:         string;
  subtype?:     string | null;
  institution?: string;
  mask?:        string | null;
  visibility:   "FULL" | "BALANCE_ONLY" | "SUMMARY_ONLY";
}

// ── Brief section ─────────────────────────────────────────────────────────────

export interface BriefSection {
  id:          string;
  // (REVIEW-3: the "opportunity" and "map" section types were deleted — no
  // builder ever emitted either on current HEAD.)
  type:
    | "since_last_visit"
    | "insight"
    | "attention"
    | "onboarding";
  priority:     number;
  title:        string;
  body?:        string;
  items?:       BriefItem[];
  actionLabel?: string;
  actionHref?:  string;
  tone?:        BriefTone;
  /**
   * Distinct account roster for the "Accounts Tracked" tab of the Since Last
   * Visit modal. Only set on the `since_last_visit` section. Deduplicated by id
   * across eligible Spaces; contains no balances.
   */
  trackedAccounts?: TrackedAccount[];
}

// ── Brief payload ─────────────────────────────────────────────────────────────
// (REVIEW-3: FinancialMapMarker / FinancialMapData and the `map` payload field
// were deleted — the route hard-coded an empty map and no client read it.)

export interface BriefPayload {
  visitState:  VisitState;
  contextLine: string;
  hasData:     boolean;
  sections:    BriefSection[];
  generatedAt: string;
}
