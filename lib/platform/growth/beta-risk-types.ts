/**
 * lib/platform/growth/beta-risk-types.ts  (Beta-request risk — THE DTO)
 *
 * The `risk` block on a beta-queue row (shape agreed with the queue UI work,
 * Session 1). Client-safe: no server import. IDENTITY-FREE by construction —
 * reason codes, neutral labels and evidence made of counts, a window length and
 * timestamps; the review carries a status, an instant and an operator display
 * label. Pinned by lib/platform/observability-privacy.test.ts.
 */

import type { BetaRiskLevel, BetaRiskReason } from "./beta-risk-core";

export type { BetaRiskLevel, BetaRiskReason, BetaRiskReasonCode, BetaRiskEvidence } from "./beta-risk-core";

export const BETA_RISK_REVIEW_STATUSES = ["UNREVIEWED", "LEGITIMATE", "SUSPICIOUS"] as const;
export type BetaRiskReviewStatusValue = (typeof BETA_RISK_REVIEW_STATUSES)[number];

/** The LATEST operator verdict on a request, or null when none was ever recorded. */
export interface BetaRiskReviewSummary {
  status: BetaRiskReviewStatusValue;
  at: string;
  /** Operator display label (username → name → opaque), or null when the operator is unknown. */
  by: string | null;
}

export interface BetaRequestRisk {
  level: BetaRiskLevel;
  reasons: BetaRiskReason[];
  review: BetaRiskReviewSummary | null;
}

/** One row of a request's review history (GET …/risk-review), newest first. */
export interface BetaRiskReviewHistoryRow {
  id: string;
  status: BetaRiskReviewStatusValue;
  reasonCode: string;
  note: string | null;
  at: string;
  by: string | null;
}

export interface BetaRiskReviewHistoryResponse {
  requestId: string;
  reviews: BetaRiskReviewHistoryRow[];
  /** True when the history was cut at BETA_RISK_REVIEW_HISTORY_CAP rows. */
  capped: boolean;
}
