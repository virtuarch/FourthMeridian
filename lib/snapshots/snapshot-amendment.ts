/**
 * lib/snapshots/snapshot-amendment.ts
 *
 * Wealth-timeline amendment system — Phase 2 (personal-space flow).
 *
 * A SnapshotAmendment is the ONLY sanctioned way to deliberately rewrite an
 * already-written historical SpaceSnapshot range. Automatic A9 regen never
 * touches a frozen (observed) row or a membership-changed day
 * (regenerate-history.core.ts's guards); an amendment is exempt from both "by
 * construction" and is gated by explicit CONSENT rather than the
 * WEALTH_REGENERATION_ENABLED operational kill switch.
 *
 * Two entry points:
 *   previewAmendment(...)  — READ-ONLY. Runs the regen in amendment+dry-run mode
 *                            and returns the per-day before→after diff so a
 *                            caller can show it before committing. No writes.
 *   applyAmendment(...)    — the consented commit. PERSONAL-space only in Phase 2
 *                            (SHARED-space approval is Phase 3). Creates the
 *                            SnapshotAmendment (PENDING), rewrites the affected
 *                            SpaceSnapshot rows in place (tagged with the
 *                            amendment id, isEstimated→true), stores the per-day
 *                            before/after breakdown (NOT recompute-on-read — a
 *                            stored value stays true even after the account is
 *                            hard-deleted), writes one AuditLog row with the
 *                            quantified delta, and flips the amendment to APPLIED.
 *
 * The `financialAccountId` records WHICH account motivated the rebuild; the
 * recompute itself uses the Space's current active-account set (SpaceSnapshot is
 * a space-level aggregate — you cannot subtract one account's slice, see
 * proposal §2), so a REMOVED account is naturally excluded and a newly-ADDED one
 * naturally included.
 */

import { db } from "@/lib/db";
import {
  SpaceType,
  type SnapshotAmendmentKind,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { regenerateWealthHistory, type WealthHistoryDiff } from "@/lib/snapshots/regenerate-history";

type Client = PrismaClient | Prisma.TransactionClient;

export interface AmendmentRequest {
  spaceId: string;
  financialAccountId: string;
  kind: SnapshotAmendmentKind;
  fromDate: string; // YYYY-MM-DD inclusive
  toDate: string; // YYYY-MM-DD inclusive (≤ yesterday — today's live row is frozen)
  requestedByUserId: string;
  now?: Date;
  client?: Client;
}

/** The quantified, human-facing delta a preview/apply reports. */
export interface AmendmentSummary {
  consideredDays: number; // days evaluated
  changedDays: number; // days that actually change (action === "write")
  // Net worth at the most-recent changed day (the representative "revised
  // $X → $Y" figure). null when nothing changed or that day had no prior row.
  netWorthBefore: number | null;
  netWorthAfter: number | null;
  netWorthDelta: number | null; // after − before (null when either side is null)
}

export interface AmendmentPreview {
  spaceId: string;
  financialAccountId: string;
  kind: SnapshotAmendmentKind;
  fromDate: string;
  toDate: string;
  /** Every considered day, in date order, with per-component before/after. */
  days: WealthHistoryDiff[];
  /** Only the days that actually change (action === "write"). */
  changed: WealthHistoryDiff[];
  summary: AmendmentSummary;
}

export interface AmendmentResult extends AmendmentPreview {
  amendmentId: string;
  status: "APPLIED";
  auditLogId: string;
}

/** Error thrown when a Phase-2 amendment is attempted on a SHARED space. */
export class SharedSpaceAmendmentError extends Error {
  constructor() {
    super("Snapshot amendments are personal-space only in Phase 2; shared-space approval is Phase 3.");
    this.name = "SharedSpaceAmendmentError";
  }
}

function summarize(diffs: WealthHistoryDiff[]): { changed: WealthHistoryDiff[]; summary: AmendmentSummary } {
  const changed = diffs.filter((d) => d.action === "write");
  // The most-recent changed day is the representative before→after figure.
  const last = changed.length > 0 ? changed[changed.length - 1] : null;
  const netWorthBefore = last ? last.netWorthBefore : null;
  const netWorthAfter = last ? last.netWorthAfter : null;
  const netWorthDelta = netWorthBefore != null && netWorthAfter != null ? netWorthAfter - netWorthBefore : null;
  return {
    changed,
    summary: { consideredDays: diffs.length, changedDays: changed.length, netWorthBefore, netWorthAfter, netWorthDelta },
  };
}

/** Assert the account exists and is (or was) linked to this Space. */
async function assertAccountInSpace(client: Client, spaceId: string, financialAccountId: string): Promise<void> {
  const link = await client.spaceAccountLink.findFirst({
    where: { spaceId, financialAccountId },
    select: { id: true },
  });
  if (!link) {
    throw new Error(`Account ${financialAccountId} has no SpaceAccountLink (any status) in space ${spaceId}.`);
  }
}

/**
 * READ-ONLY preview of an amendment: the per-day before→after diff, guards
 * bypassed, nothing written. Safe to call repeatedly.
 */
export async function previewAmendment(req: AmendmentRequest): Promise<AmendmentPreview> {
  const client = req.client ?? db;
  const space = await client.space.findUnique({ where: { id: req.spaceId }, select: { type: true } });
  if (!space) throw new Error(`Space ${req.spaceId} not found.`);
  if (space.type !== SpaceType.PERSONAL) throw new SharedSpaceAmendmentError();
  await assertAccountInSpace(client, req.spaceId, req.financialAccountId);

  const res = await regenerateWealthHistory({
    spaceId: req.spaceId,
    fromDate: req.fromDate,
    toDate: req.toDate,
    isAmendment: true,
    dryRun: true, // preview — compute the plan, write nothing
    now: req.now,
    client,
  });
  const { changed, summary } = summarize(res.diffs);
  return {
    spaceId: req.spaceId,
    financialAccountId: req.financialAccountId,
    kind: req.kind,
    fromDate: req.fromDate,
    toDate: req.toDate,
    days: res.diffs,
    changed,
    summary,
  };
}

/**
 * Apply an amendment: the consented commit (PERSONAL space only in Phase 2).
 *
 * Sequencing (deliberately not one giant transaction — the regen does network
 * I/O, so wrapping it in an interactive transaction would risk a timeout):
 *   1. create the SnapshotAmendment (PENDING) — its id is needed as an FK target
 *      before any SpaceSnapshot row can point at it;
 *   2. run the regen in amendment mode — rewrites the affected SpaceSnapshot rows
 *      in place, tagged with the amendment id and isEstimated→true. Idempotent
 *      (deterministic upserts), so a retry is safe;
 *   3. in ONE transaction: store the per-day breakdown, write the AuditLog row,
 *      and flip the amendment to APPLIED.
 *
 * A crash between (2) and (3) leaves a recoverable PENDING amendment whose rows
 * are already correct; re-applying converges (the breakdown upserts by
 * [amendmentId, date]).
 */
export async function applyAmendment(req: AmendmentRequest): Promise<AmendmentResult> {
  // Apply needs an interactive transaction (step 3), so the root must be a full
  // PrismaClient — a nested transaction client cannot open one.
  const rootClient = (req.client ?? db) as PrismaClient;
  const now = req.now ?? new Date();

  const space = await rootClient.space.findUnique({ where: { id: req.spaceId }, select: { type: true } });
  if (!space) throw new Error(`Space ${req.spaceId} not found.`);
  if (space.type !== SpaceType.PERSONAL) throw new SharedSpaceAmendmentError();
  await assertAccountInSpace(rootClient, req.spaceId, req.financialAccountId);

  // 1. PENDING amendment (the FK target for the rows about to be rewritten).
  const amendment = await rootClient.snapshotAmendment.create({
    data: {
      spaceId: req.spaceId,
      financialAccountId: req.financialAccountId,
      kind: req.kind,
      fromDate: new Date(`${req.fromDate}T00:00:00Z`),
      toDate: new Date(`${req.toDate}T00:00:00Z`),
      requestedByUserId: req.requestedByUserId,
      status: "PENDING",
    },
    select: { id: true },
  });

  // 2. Rewrite the affected rows (guards bypassed, kill switch bypassed, tagged).
  const res = await regenerateWealthHistory({
    spaceId: req.spaceId,
    fromDate: req.fromDate,
    toDate: req.toDate,
    isAmendment: true,
    amendedByAmendmentId: amendment.id,
    now: req.now,
    client: rootClient,
  });
  const { changed, summary } = summarize(res.diffs);

  // 3. Breakdown + AuditLog + flip to APPLIED, atomically.
  const auditLogId = await rootClient.$transaction(async (tx) => {
    if (changed.length > 0) {
      await tx.snapshotAmendmentDay.createMany({
        data: changed.map((d) => ({
          amendmentId: amendment.id,
          date: new Date(`${d.date}T00:00:00Z`),
          stocksBefore: d.stocksBefore,
          stocksAfter: d.stocksAfter,
          cryptoBefore: d.cryptoBefore,
          cryptoAfter: d.cryptoAfter,
          cashBefore: d.cashBefore,
          cashAfter: d.cashAfter,
          savingsBefore: d.savingsBefore,
          savingsAfter: d.savingsAfter,
          debtBefore: d.debtBefore,
          debtAfter: d.debtAfter,
          netWorthBefore: d.netWorthBefore,
          netWorthAfter: d.netWorthAfter,
        })),
        skipDuplicates: true, // idempotent re-apply
      });
    }

    const audit = await tx.auditLog.create({
      data: {
        userId: req.requestedByUserId,
        spaceId: req.spaceId,
        action: AuditAction.SNAPSHOT_AMENDMENT_APPLIED,
        metadata: {
          amendmentId: amendment.id,
          financialAccountId: req.financialAccountId,
          kind: req.kind,
          fromDate: req.fromDate,
          toDate: req.toDate,
          changedDays: summary.changedDays,
          netWorthBefore: summary.netWorthBefore,
          netWorthAfter: summary.netWorthAfter,
        },
      },
      select: { id: true },
    });

    await tx.snapshotAmendment.update({
      where: { id: amendment.id },
      data: { status: "APPLIED", appliedAt: now, consentedAt: now, auditLogId: audit.id },
    });

    return audit.id;
  });

  return {
    amendmentId: amendment.id,
    status: "APPLIED",
    auditLogId,
    spaceId: req.spaceId,
    financialAccountId: req.financialAccountId,
    kind: req.kind,
    fromDate: req.fromDate,
    toDate: req.toDate,
    days: res.diffs,
    changed,
    summary,
  };
}
