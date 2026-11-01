/**
 * lib/platform/growth/beta-request-list.ts  (PB-6 — the status view's READER)
 *
 * Every beta-access request by lifecycle status, paged on the server, for
 * Growth & Revenue → Beta Access. Before PB-6 the queue listed only PENDING
 * requests and APPROVED invitations; DENIED and REDEEMED were counts an
 * operator could not open.
 *
 * On fm_system (`systemDb` — lib/platform/ is the allowlisted neighbourhood):
 * the verdicts (BetaAccessRequestReview) and the blocklist
 * (BetaBlockedIdentifier) are granted to fm_system only. READ-ONLY.
 *
 *   · `verdict=SUSPICIOUS` keeps the requests whose LATEST verdict is
 *     SUSPICIOUS — the current state of an append-only history — computed
 *     from the review rows newest-first under BETA_RISK_REVIEW_READ_CAP; a
 *     capped read is reported as a note, never hidden.
 *   · each row's `block` is loadSourceRequestBlocks (beta-blocklist.ts): an
 *     ACTIVE, unexpired block whose sourceRequestId is the request — no HMAC,
 *     key version or block id.
 * The route's READ gate (requirePlatformAccess("GROWTH_REVENUE","READ")) runs first.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { BETA_RISK_REVIEW_READ_CAP, loadLatestReviews, type BetaRiskDb } from "./beta-risk";
import { blocklistAvailability, loadSourceRequestBlocks } from "./beta-blocklist";
import type { EnvSource } from "./beta-blocklist-core";
import type { BetaRequestListQuery, BetaRequestListResponse, BetaRequestStatusValue } from "./beta-request-list-types";
import type { BetaRiskReviewSummary } from "./beta-risk-types";

/** The request ids whose latest verdict is SUSPICIOUS (newest-first read; the first row per request is its state). */
async function latestSuspiciousIds(client: BetaRiskDb): Promise<{ ids: string[]; capped: boolean }> {
  const rows = await client.betaAccessRequestReview.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: BETA_RISK_REVIEW_READ_CAP + 1,
    select: { requestId: true, status: true },
  });
  const capped = rows.length > BETA_RISK_REVIEW_READ_CAP;
  const latest = new Map<string, string>();
  for (const r of rows.slice(0, BETA_RISK_REVIEW_READ_CAP)) if (!latest.has(r.requestId)) latest.set(r.requestId, r.status);
  return { ids: [...latest].filter(([, s]) => s === "SUSPICIOUS").map(([id]) => id), capped };
}

export async function listBetaRequests(
  q: BetaRequestListQuery,
  deps: { client?: BetaRiskDb; env?: EnvSource; now?: Date } = {},
): Promise<BetaRequestListResponse> {
  const client = deps.client ?? systemDb;
  const notes: string[] = [];

  const where: { status?: BetaRequestStatusValue; id?: { in: string[] } } = {};
  if (q.view !== "ALL") where.status = q.view;
  if (q.verdict === "SUSPICIOUS") {
    const s = await latestSuspiciousIds(client);
    where.id = { in: s.ids };
    if (s.capped) notes.push(`Only the newest ${BETA_RISK_REVIEW_READ_CAP.toLocaleString("en-US")} verdicts were read; older suspicious requests may be missing.`);
  }

  // Pending reads oldest first (the FIFO queue); every decided view reads newest first.
  const dir = q.view === "PENDING" ? "asc" : "desc";
  const [total, rows] = await Promise.all([
    client.betaAccessRequest.count({ where }),
    client.betaAccessRequest.findMany({
      where,
      orderBy: [{ createdAt: dir }, { id: dir }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, email: true, note: true, status: true, createdAt: true, decidedAt: true, invitedAt: true, redeemedAt: true },
    }),
  ]);

  const ids = rows.map((r) => r.id);
  let reviews = new Map<string, BetaRiskReviewSummary>();
  try {
    reviews = await loadLatestReviews(client, ids);
  } catch (e) {
    console.error("[beta-request-list] verdicts unavailable:", (e as Error).message);
    notes.push("Verdicts are unavailable right now.");
  }
  const blocks = await loadSourceRequestBlocks(client, ids, deps.now ? { now: deps.now } : {});

  return {
    view: q.view,
    verdict: q.verdict,
    page: q.page,
    pageSize: q.pageSize,
    total,
    rows: rows.map((r) => ({
      id: r.id,
      email: r.email,
      note: r.note,
      status: r.status as BetaRequestStatusValue,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      invitedAt: r.invitedAt?.toISOString() ?? null,
      redeemedAt: r.redeemedAt?.toISOString() ?? null,
      review: reviews.get(r.id) ?? null,
      block: blocks.get(r.id) ?? { state: "NOT_BLOCKED" },
    })),
    blocklist: blocklistAvailability(deps.env),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
