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
  /** PB-6 — the request's current lifecycle state (re-read with the history, so a panel is never stale after an action). */
  request: { status: BetaRequestStatusValue; decidedAt: string | null };
  /** PB-6 — is this request's mailbox currently blocked BY THIS REQUEST (BetaBlockedIdentifier.sourceRequestId)? */
  block: BetaRequestBlockState;
  /** PB-6 — what the blocklist can do in this environment (never a key, an HMAC or an address). */
  blocklist: BlocklistAvailability;
}

// ── PB-6 — request lifecycle + block state (client-safe, identity-free) ──────

export const BETA_REQUEST_STATUSES = ["PENDING", "APPROVED", "DENIED", "REDEEMED"] as const;
export type BetaRequestStatusValue = (typeof BETA_REQUEST_STATUSES)[number];

/**
 * Whether an ACTIVE, unexpired BetaBlockedIdentifier row names this request as
 * its source. Derived from the soft `sourceRequestId` link only: an instant
 * and an expiry — no block id, key version, HMAC (or prefix) or address. A
 * block caused by a DIFFERENT request for an alias of the same mailbox is not
 * this request's block and reads NOT_BLOCKED here (the Blocked identifiers
 * console is where every block is listed).
 *
 * UNKNOWN — the blocklist read failed (the table missing before its migration,
 * a transient error). Never shown as "not blocked": the page still answers,
 * with BLOCK_STATUS_UNAVAILABLE_NOTE.
 */
export type BetaRequestBlockState =
  | { state: "BLOCKED"; since: string; expiresAt: string }
  | { state: "NOT_BLOCKED" }
  | { state: "UNKNOWN" };

/** The note (list) / line (panel) when the block state could not be read. */
export const BLOCK_STATUS_UNAVAILABLE_NOTE = "Block status is unavailable right now.";

/**
 * ENFORCED — a usable key: SUSPICIOUS denials block. NOT_CONFIGURED — outside
 * Production with no key: verdicts record, blocks are skipped. UNAVAILABLE —
 * Production with no usable key: a verdict or deny that must block is refused
 * (409 BLOCKLIST_UNAVAILABLE).
 */
export type BlocklistAvailability = "ENFORCED" | "NOT_CONFIGURED" | "UNAVAILABLE";
