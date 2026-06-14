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

export interface BriefItem {
  id:      string;
  label:   string;
  value?:  string;
  detail?: string;
  tone?:   BriefTone;
  href?:   string;
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
