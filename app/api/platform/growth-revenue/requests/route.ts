/**
 * GET /api/platform/growth-revenue/requests  (Wave 1 S3)
 *
 * The beta-access queue for the `growth_beta_requests` widget: the pending
 * requests awaiting a decision, plus lifecycle counts.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ") — the READ
 * gate lists; the approve/deny mutations use the fresh WRITE variant.
 *
 * Minimal PII: returns the email (the queue is inherently about deciding on an
 * address) and the optional applicant note, nothing else about the requester.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { BetaAccessRequestStatus } from "@prisma/client";

export const runtime = "nodejs";

export interface BetaRequestRow {
  id:        string;
  email:     string;
  note:      string | null;
  status:    BetaAccessRequestStatus;
  createdAt: string;
  invitedAt: string | null;
  decidedAt: string | null;
}

/** PO-3B — an APPROVED, un-redeemed invitation, for the invitation-management panel. */
export interface BetaInvitationRow {
  id:              string;
  email:           string;
  invitedAt:       string | null; // when the invite was (last) sent
  inviteExpiresAt: string | null;
  expired:         boolean;       // inviteExpiresAt < now (derived at read time)
}

export interface BetaRequestsResponse {
  pending:     BetaRequestRow[];
  invitations: BetaInvitationRow[];
  counts:      { pending: number; approved: number; denied: number; redeemed: number };
}

export async function GET() {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;

  const now = new Date();
  const [pending, invitations, pendingCount, approvedCount, deniedCount, redeemedCount] = await Promise.all([
    db.betaAccessRequest.findMany({
      where:   { status: BetaAccessRequestStatus.PENDING },
      orderBy: { createdAt: "asc" }, // oldest first — FIFO queue
      take:    100,
      select:  { id: true, email: true, note: true, status: true, createdAt: true, invitedAt: true, decidedAt: true },
    }),
    db.betaAccessRequest.findMany({
      where:   { status: BetaAccessRequestStatus.APPROVED },
      orderBy: { invitedAt: "desc" }, // most-recently invited first
      take:    100,
      select:  { id: true, email: true, invitedAt: true, inviteExpiresAt: true },
    }),
    db.betaAccessRequest.count({ where: { status: BetaAccessRequestStatus.PENDING } }),
    db.betaAccessRequest.count({ where: { status: BetaAccessRequestStatus.APPROVED } }),
    db.betaAccessRequest.count({ where: { status: BetaAccessRequestStatus.DENIED } }),
    db.betaAccessRequest.count({ where: { status: BetaAccessRequestStatus.REDEEMED } }),
  ]);

  return NextResponse.json({
    pending: pending.map((r) => ({
      id:        r.id,
      email:     r.email,
      note:      r.note,
      status:    r.status,
      createdAt: r.createdAt.toISOString(),
      invitedAt: r.invitedAt?.toISOString() ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
    })),
    invitations: invitations.map((r) => ({
      id:              r.id,
      email:           r.email,
      invitedAt:       r.invitedAt?.toISOString() ?? null,
      inviteExpiresAt: r.inviteExpiresAt?.toISOString() ?? null,
      expired:         r.inviteExpiresAt != null && r.inviteExpiresAt < now,
    })),
    counts: {
      pending:  pendingCount,
      approved: approvedCount,
      denied:   deniedCount,
      redeemed: redeemedCount,
    },
  } satisfies BetaRequestsResponse);
}
