/**
 * lib/platform/growth/bulk-approve.ts  (PR C · bulk beta approval)
 *
 * Approve many beta requests in one operator action, by calling THE issuance
 * mechanism (`issueBetaInvitation`, kind "approve") once per request. Nothing
 * here mints a token, writes a request row or sends an email itself.
 *
 * ── TWO MODES, ONE RULE ───────────────────────────────────────────────────────
 *   dryRun    reads each row + whether its address has an account and answers
 *             `approvalEligibility` (bulk-approve.core.ts) per id. Writes nothing,
 *             audits nothing, sends nothing. The Growth review step shows it.
 *   execute   for each distinct id, SEQUENTIALLY (bounded: ≤ 100 ids, one email
 *             in flight at a time): re-read the row, apply the same
 *             `approvalEligibility`; ineligible ⇒ SKIPPED with its reason and
 *             no issuance call; eligible ⇒ `issueBetaInvitation`. A row that is
 *             skipped or fails never stops the others.
 *
 * ── DOUBLE-CLICK, RETRY, CONCURRENCY ─────────────────────────────────────────
 * Duplicate-safety is the issuance function's conditional write (status read
 * PENDING → APPROVED, one winner). A second submit of the same batch — a
 * double-click, a retry after a dropped response, or two tabs at once — finds
 * every row it already approved APPROVED (skipped "already approved", no token,
 * no email) or loses the row's race inside issuance (`alreadyApproved`, also
 * skipped). No row is ever issued twice.
 *
 * ── AUDIT ─────────────────────────────────────────────────────────────────────
 * Each approval keeps its own BETA_ACCESS_APPROVED row, written by issuance in
 * the transaction that approves it. The batch adds ONE BETA_ACCESS_BULK_APPROVED
 * row, written AFTER the loop, so it carries the real counts:
 *   { batchKey, requestCount, uniqueCount, duplicateCount, counts, validityDays,
 *     validitySource, repeat, requestIds by outcome } — ids only; never an
 *   email, an email hash, a token or a link.
 * Why after: an intent row written first would have to be corrected (the audit
 * log is append-only) or would lie about the outcome. If the process dies
 * mid-batch, the per-row rows already committed are the record, and a retry
 * with the same batchKey completes the batch and writes its row.
 * A repeat with a batchKey that already has a batch row writes a second row
 * ONLY when it approved something (e.g. it retried a row that failed); a repeat
 * that issued nothing writes nothing more. The batch row is unique per key on
 * the happy path, not by constraint (no index on audit metadata; no migration):
 * two simultaneous first submits may each write one. Per-row uniqueness is the
 * hard guarantee.
 *
 * Risk is ignored (advisory, UI-only). The Beta lifecycle check, when it lands,
 * lands inside issueBetaInvitation and applies here unchanged.
 *
 * The client is a PARAMETER: authority follows the caller (RLS-13).
 */

import "server-only";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import { issueBetaInvitation, type IssueClient } from "./invitation-issue";
import { readInvitationPolicy } from "./invitation-policy";
import { expiryFor, parseValidityDays, type InviteRowFacts } from "./invitation-issue.core";
import {
  approvalEligibility, BULK_REASON, summarise,
  type BulkApproveBody, type BulkDryRunRow, type BulkFailed, type BulkSkipped, type BulkSucceeded, type BulkSummary,
  type BulkValidity, type Eligibility,
} from "./bulk-approve.core";

export interface BulkApproveInput {
  client: IssueClient;
  actor: OperatorActionInput["actor"];
  body: BulkApproveBody;
  reason?: OperatorReason;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Test seam. Each row's issuance still reads its own clock unless this is set. */
  now?: Date;
}

export type BulkApproveResult =
  | { ok: false; status: 400; error: string; code?: string }
  | ({ ok: true; dryRun: true; batchKey: string; rows: BulkDryRunRow[]; duplicates: string[];
       summary: { requested: number; unique: number; duplicates: number; eligible: number; ineligible: number } } & BulkValidity)
  | ({ ok: true; dryRun: false; batchKey: string; summary: BulkSummary; repeat: boolean; batchAudited: boolean;
       succeeded: BulkSucceeded[]; skipped: BulkSkipped[]; failed: BulkFailed[]; duplicates: string[] } & BulkValidity);

const ROW_SELECT = { id: true, email: true, status: true, inviteTokenHash: true, inviteExpiresAt: true, invitedAt: true } as const;

async function eligibilityOf(client: IssueClient, id: string): Promise<Eligibility> {
  const row = await client.betaAccessRequest.findUnique({ where: { id }, select: ROW_SELECT });
  const facts: InviteRowFacts | null = row ? { ...row, status: row.status as InviteRowFacts["status"] } : null;
  const hasAccount = facts ? (await client.user.findUnique({ where: { email: facts.email }, select: { id: true } })) != null : false;
  return approvalEligibility(facts, hasAccount);
}

async function resolveValidity(client: IssueClient, raw: unknown, now: Date): Promise<BulkValidity | { error: string }> {
  if (raw !== undefined && raw !== null) {
    const p = parseValidityDays(raw);
    if (!p.ok) return { error: p.reason };
    return { validityDays: p.days, validitySource: "override", expiresAtIfIssuedNow: expiryFor(now, p.days).toISOString() };
  }
  const days = (await readInvitationPolicy(client)).validityDays;
  return { validityDays: days, validitySource: "setting", expiresAtIfIssuedNow: expiryFor(now, days).toISOString() };
}

export async function bulkApproveBetaRequests(input: BulkApproveInput): Promise<BulkApproveResult> {
  const { client, body } = input;
  const validity = await resolveValidity(client, body.validityDays, input.now ?? new Date());
  if ("error" in validity) return { ok: false, status: 400, error: validity.error, code: "INVALID_VALIDITY" };

  if (body.dryRun) {
    const rows: BulkDryRunRow[] = [];
    for (const id of body.ids) {
      const e = await eligibilityOf(client, id);
      rows.push(e.approvable ? { id, eligible: true } : { id, eligible: false, code: e.code, reason: e.reason });
    }
    const eligible = rows.filter((r) => r.eligible).length;
    return {
      ok: true, dryRun: true, batchKey: body.batchKey, rows, duplicates: body.duplicates, ...validity,
      summary: { requested: body.requested, unique: body.ids.length, duplicates: body.duplicates.length, eligible, ineligible: rows.length - eligible },
    };
  }

  const succeeded: BulkSucceeded[] = [];
  const skipped: BulkSkipped[] = [];
  const failed: BulkFailed[] = [];
  // Only an override is passed through: absent ⇒ each issuance reads the setting
  // itself and audits validitySource "setting" truthfully.
  const validityDays = validity.validitySource === "override" ? validity.validityDays : undefined;

  for (const id of body.ids) {
    try {
      const e = await eligibilityOf(client, id);
      if (!e.approvable) { skipped.push({ id, code: e.code, reason: e.reason }); continue; }
      const r = await issueBetaInvitation({
        client, actor: input.actor, kind: "approve", requestId: id, validityDays,
        ...(input.reason ? { reason: input.reason } : {}),
        ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null,
        ...(input.now ? { now: input.now } : {}),
      });
      if (r.ok && r.outcome === "issued") {
        succeeded.push({ id, emailStatus: r.emailStatus, expiresAt: r.expiresAt.toISOString() });
      } else if (r.ok) {
        // alreadyApproved — a concurrent submit (or the first click) won this row.
        skipped.push({ id, code: "ALREADY_APPROVED", reason: BULK_REASON.ALREADY_APPROVED });
      } else if (r.code === "REDEEMED" || r.code === "ACCOUNT_EXISTS" || r.code === "NOT_FOUND") {
        skipped.push({ id, code: r.code, reason: BULK_REASON[r.code] });
      } else {
        failed.push({ id, code: "CONFLICT", reason: r.code === "CONFLICT" ? BULK_REASON.CONFLICT : r.message });
      }
    } catch (err) {
      // Never the message (it may carry driver detail); the row stays as it was
      // unless issuance had committed, in which case its own audit says so.
      console.error("[beta-bulk-approve] row failed:", err instanceof Error ? err.name : "error");
      failed.push({ id, code: "ERROR", reason: BULK_REASON.ERROR });
    }
  }

  const summary = summarise(body, { succeeded, skipped, failed });
  let repeat = false;
  let batchAudited = false;
  try {
    const prior = await client.auditLog.findFirst({
      where: { action: AuditAction.BETA_ACCESS_BULK_APPROVED, metadata: { path: ["batchKey"], equals: body.batchKey } },
      select: { id: true },
    });
    repeat = prior != null;
    if (!repeat || succeeded.length > 0) {
      await recordOperatorAction(client, {
        actor: input.actor,
        action: AuditAction.BETA_ACCESS_BULK_APPROVED,
        target: { kind: "BETA_BATCH", id: body.batchKey },
        ...(input.reason ? { reason: input.reason } : {}),
        result: failed.length > 0 ? "FAILURE" : "SUCCESS",
        detail: {
          batchKey: body.batchKey,
          requestCount: body.requested,
          uniqueCount: summary.unique,
          duplicateCount: summary.duplicates,
          counts: { succeeded: summary.succeeded, skipped: summary.skipped, failed: summary.failed },
          validityDays: validity.validityDays,
          validitySource: validity.validitySource,
          repeat,
          // Opaque request ids only — the per-row BETA_ACCESS_APPROVED rows carry the rest.
          succeededIds: succeeded.map((s) => s.id),
          skippedIds: skipped.map((s) => ({ id: s.id, code: s.code })),
          failedIds: failed.map((f) => ({ id: f.id, code: f.code })),
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });
      batchAudited = true;
    }
  } catch (err) {
    // The approvals committed with their own audits; answering 500 here would
    // invite a retry for no reason. Report it instead.
    console.error("[beta-bulk-approve] batch audit not recorded:", err instanceof Error ? err.name : "error");
  }

  return {
    ok: true, dryRun: false, batchKey: body.batchKey, summary, repeat, batchAudited,
    succeeded, skipped, failed, duplicates: body.duplicates, ...validity,
  };
}
