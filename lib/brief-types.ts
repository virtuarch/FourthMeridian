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

/**
 * Trust provenance for a Brief item — how well we know the claim.
 * Presentational slot (v2.6): the editorial Brief renders a trust dot ONLY when
 * an item carries a `basis`. The current /api/brief builder does NOT emit this
 * yet, so no dot is shown — the field is a seam, not fabricated data. Wiring
 * per-item provenance requires the Brief pipeline to emit a completeness
 * envelope per insight (see components/space/trust/TrustIndicator + the
 * PerspectiveEnvelope model).
 */
export type BriefBasis = "observed" | "reconstructed" | "mixed";

export interface BriefItem {
  id:      string;
  label:   string;
  value?:  string;
  detail?: string;
  tone?:   BriefTone;
  href?:   string;
  /** Reserved presentational slot — see BriefBasis. Not emitted by /api/brief. */
  basis?:  BriefBasis;
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
  type:
    | "since_last_visit"
    | "insight"
    | "attention"
    | "opportunity"
    | "onboarding"
    | "map";
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

// ── Financial map ─────────────────────────────────────────────────────────────

export interface FinancialMapMarker {
  id:            string;
  label:         string;
  type:
    | "bank"
    | "investment"
    | "crypto"
    | "property"
    | "vehicle"
    | "business"
    | "asset"
    | "other";
  lat?:          number;
  lng?:          number;
  region?:       string;
  value?:        number;
  privacyLevel?: "hidden" | "summary" | "full";
}

export interface FinancialMapData {
  markers:      FinancialMapMarker[];
  hasLocations: boolean;
}

// ── Brief payload ─────────────────────────────────────────────────────────────

export interface BriefPayload {
  visitState:  VisitState;
  contextLine: string;
  hasData:     boolean;
  sections:    BriefSection[];
  map?:        FinancialMapData;
  generatedAt: string;
}
