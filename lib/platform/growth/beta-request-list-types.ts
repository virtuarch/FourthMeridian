/**
 * lib/platform/growth/beta-request-list-types.ts  (PB-6 — the status view's DTO + query)
 *
 * GET /api/platform/growth-revenue/requests?view=…  — every beta-access request
 * by lifecycle status (Pending / Approved / Denied / Joined / All), optionally
 * only those whose LATEST operator verdict is SUSPICIOUS, paged on the server.
 *
 * Client-safe: no server import. IDENTITY: the row carries the same address the
 * queue already shows for a pending request (the queue is about deciding on an
 * address) and the applicant's note — nothing else about the requester, and
 * nothing of the blocklist beyond BLOCKED / NOT_BLOCKED with two instants
 * (beta-risk-types.ts BetaRequestBlockState). No invite token, token hash,
 * HMAC, HMAC prefix, key version, block id, IP or user agent.
 */

import type {
  BetaRequestBlockState, BetaRequestStatusValue, BetaRiskReviewSummary, BlocklistAvailability,
} from "./beta-risk-types";

export type { BetaRequestBlockState, BetaRequestStatusValue, BlocklistAvailability } from "./beta-risk-types";

/** The status view's segments. REDEEMED is labelled "Joined" in the UI. */
export const BETA_REQUEST_VIEWS = ["PENDING", "APPROVED", "DENIED", "REDEEMED", "ALL"] as const;
export type BetaRequestView = (typeof BETA_REQUEST_VIEWS)[number];

/** The only verdict filter: latest operator verdict = SUSPICIOUS. */
export const BETA_REQUEST_VERDICT_FILTERS = ["SUSPICIOUS"] as const;
export type BetaRequestVerdictFilter = (typeof BETA_REQUEST_VERDICT_FILTERS)[number];

export const BETA_REQUEST_PAGE_SIZE_DEFAULT = 25;
export const BETA_REQUEST_PAGE_SIZE_MAX = 100;

export interface BetaRequestListQuery {
  view: BetaRequestView;
  verdict: BetaRequestVerdictFilter | null;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export interface BetaRequestListRow {
  id: string;
  email: string;
  note: string | null;
  status: BetaRequestStatusValue;
  createdAt: string;
  /** When the request was last decided (approved / denied / revoked), or null. */
  decidedAt: string | null;
  invitedAt: string | null;
  redeemedAt: string | null;
  /** The latest operator verdict, or null when none was ever recorded (or the review read failed — see `notes`). */
  review: BetaRiskReviewSummary | null;
  block: BetaRequestBlockState;
}

export interface BetaRequestListResponse {
  view: BetaRequestView;
  verdict: BetaRequestVerdictFilter | null;
  page: number;
  pageSize: number;
  /** Rows matching the filter (all pages). */
  total: number;
  rows: BetaRequestListRow[];
  blocklist: BlocklistAvailability;
  /** Plain-language notes (a read cap reached). */
  notes?: string[];
}

export type ParsedBetaRequestListQuery =
  | { ok: true; query: BetaRequestListQuery }
  | { ok: false; error: string };

const POSITIVE_INT = /^[1-9]\d{0,5}$/;

/** PURE — parse the status-view query. `view` is required (its absence selects the legacy queue response). */
export function parseBetaRequestListQuery(params: URLSearchParams): ParsedBetaRequestListQuery {
  const view = params.get("view");
  if (!view || !(BETA_REQUEST_VIEWS as readonly string[]).includes(view)) {
    return { ok: false, error: `view must be one of ${BETA_REQUEST_VIEWS.join(", ")}.` };
  }
  const verdictRaw = params.get("verdict");
  if (verdictRaw !== null && verdictRaw !== "" && !(BETA_REQUEST_VERDICT_FILTERS as readonly string[]).includes(verdictRaw)) {
    return { ok: false, error: `verdict must be one of ${BETA_REQUEST_VERDICT_FILTERS.join(", ")}.` };
  }
  const pageRaw = params.get("page");
  if (pageRaw !== null && !POSITIVE_INT.test(pageRaw)) return { ok: false, error: "page must be a positive integer." };
  const sizeRaw = params.get("pageSize");
  if (sizeRaw !== null && (!POSITIVE_INT.test(sizeRaw) || Number(sizeRaw) > BETA_REQUEST_PAGE_SIZE_MAX)) {
    return { ok: false, error: `pageSize must be an integer from 1 to ${BETA_REQUEST_PAGE_SIZE_MAX}.` };
  }
  return {
    ok: true,
    query: {
      view: view as BetaRequestView,
      verdict: verdictRaw ? (verdictRaw as BetaRequestVerdictFilter) : null,
      page: pageRaw === null ? 1 : Number(pageRaw),
      pageSize: sizeRaw === null ? BETA_REQUEST_PAGE_SIZE_DEFAULT : Number(sizeRaw),
    },
  };
}

/** PURE — the query string the status view sends (the inverse of parseBetaRequestListQuery). */
export function betaRequestListSearch(q: Partial<BetaRequestListQuery> & { view: BetaRequestView }): string {
  const p = new URLSearchParams({ view: q.view });
  if (q.verdict) p.set("verdict", q.verdict);
  if (q.page && q.page > 1) p.set("page", String(q.page));
  if (q.pageSize && q.pageSize !== BETA_REQUEST_PAGE_SIZE_DEFAULT) p.set("pageSize", String(q.pageSize));
  return p.toString();
}
