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
 *
 * OPERATIONALIZATION P0 (2026-10-07) — two DERIVED facts per row, no new store:
 *   · pending rows carry `requestCount` / `lastRequestedAt` (COUNT / MAX over
 *     BetaAccessRequestEvent by email — ONE grouped query for the listed
 *     addresses) and the FIRST submission's bounded acquisition `source`;
 *   · invitation rows carry `inviteEmail` — the outcome of the LAST invite
 *     email attempt, read from the AuditLog row the approve / direct-invite /
 *     resend routes already write (`metadata.emailStatus`, the OPS-1
 *     EmailResult verbatim). "sent" means the provider ACCEPTED the message;
 *     Fourth Meridian holds no delivery receipt, and the widget says so.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { BetaAccessRequestStatus } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import type { AcquisitionSource } from "@/lib/marketing/acquisition";

export const runtime = "nodejs";

export interface BetaRequestRow {
  id:        string;
  email:     string;
  note:      string | null;
  status:    BetaAccessRequestStatus;
  createdAt: string;
  invitedAt: string | null;
  decidedAt: string | null;
  /** Submissions of the public form for this address (≥ 1 once events exist; 0 for rows that predate the event ledger). */
  requestCount: number;
  lastRequestedAt: string | null;
  /** The FIRST submission's bounded acquisition context, or null. */
  acquisition: AcquisitionSource | null;
}

/** The last invite EMAIL attempt for an invitation — the OPS-1 EmailResult
 *  status verbatim. "sent" = handed to the provider, NOT delivery-confirmed. */
export interface InviteEmailOutcome {
  status: "sent" | "captured" | "skipped" | "error" | null;
  at: string | null;
}

/** PO-3B — an APPROVED, un-redeemed invitation, for the invitation-management panel. */
export interface BetaInvitationRow {
  id:              string;
  email:           string;
  invitedAt:       string | null; // when the invite was (last) sent
  inviteExpiresAt: string | null;
  expired:         boolean;       // inviteExpiresAt < now (derived at read time)
  inviteEmail:     InviteEmailOutcome;
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

  // ── Derived: submission counts + first source (pending), last invite email (invitations)
  const pendingEmails = pending.map((r) => r.email);
  const [eventStats, firstEvents, inviteAudits] = await Promise.all([
    pendingEmails.length === 0 ? Promise.resolve([]) : db.betaAccessRequestEvent.groupBy({
      by:     ["email"],
      where:  { email: { in: pendingEmails } },
      _count: { _all: true },
      _max:   { receivedAt: true },
    }),
    pendingEmails.length === 0 ? Promise.resolve([]) : db.betaAccessRequestEvent.findMany({
      where:    { email: { in: pendingEmails } },
      orderBy:  { receivedAt: "asc" },
      distinct: ["email"],
      select:   { email: true, source: true },
    }),
    invitations.length === 0 ? Promise.resolve([]) : db.auditLog.findMany({
      where:   { action: { in: [AuditAction.BETA_ACCESS_APPROVED, AuditAction.BETA_INVITATION_CREATED, AuditAction.BETA_INVITATION_RESENT] } },
      orderBy: { createdAt: "desc" },
      take:    500, // newest first; the first row per betaRequestId wins below
      select:  { createdAt: true, metadata: true },
    }),
  ]);
  const statsByEmail = new Map(eventStats.map((g) => [g.email, { count: g._count._all, last: g._max.receivedAt }] as const));
  const firstSourceByEmail = new Map(firstEvents.map((e) => [e.email, (e.source as AcquisitionSource | null) ?? null] as const));
  const inviteEmailById = new Map<string, InviteEmailOutcome>();
  for (const a of inviteAudits) {
    const meta = (a.metadata ?? {}) as { betaRequestId?: unknown; emailStatus?: unknown };
    if (typeof meta.betaRequestId !== "string" || inviteEmailById.has(meta.betaRequestId)) continue;
    const st = meta.emailStatus;
    inviteEmailById.set(meta.betaRequestId, {
      status: st === "sent" || st === "captured" || st === "skipped" || st === "error" ? st : null,
      at: a.createdAt.toISOString(),
    });
  }

  return NextResponse.json({
    pending: pending.map((r) => ({
      id:        r.id,
      email:     r.email,
      note:      r.note,
      status:    r.status,
      createdAt: r.createdAt.toISOString(),
      invitedAt: r.invitedAt?.toISOString() ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      requestCount:    statsByEmail.get(r.email)?.count ?? 0,
      lastRequestedAt: statsByEmail.get(r.email)?.last?.toISOString() ?? null,
      acquisition:     firstSourceByEmail.get(r.email) ?? null,
    })),
    invitations: invitations.map((r) => ({
      id:              r.id,
      email:           r.email,
      invitedAt:       r.invitedAt?.toISOString() ?? null,
      inviteExpiresAt: r.inviteExpiresAt?.toISOString() ?? null,
      expired:         r.inviteExpiresAt != null && r.inviteExpiresAt < now,
      inviteEmail:     inviteEmailById.get(r.id) ?? { status: null, at: null },
    })),
    counts: {
      pending:  pendingCount,
      approved: approvedCount,
      denied:   deniedCount,
      redeemed: redeemedCount,
    },
  } satisfies BetaRequestsResponse);
}
