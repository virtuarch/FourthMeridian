/**
 * lib/platform/growth/beta-abuse-evidence.ts  (owner P2-1 · preserved abuse evidence)
 *
 * The EARLIEST verified suspicious application, preserved separately from the
 * 180-day waitlist with controlled access and an explicit deadline
 * (docs/plans/BETA-BLOCKED-IDENTIFIER-DESIGN-2026-11-01.md §7).
 *
 *   capture  fresh SYSTEM_ADMIN, reason + retainUntil (≤ 3 years) required. The
 *            request must be DENIED with a latest verdict of SUSPICIOUS; one
 *            evidence row per request. Under the request's row lock, the
 *            payload — the request's email, note, createdAt, status, its verdict
 *            history (status, reason code, time) and its advisory risk signals
 *            (codes + evidence counts) — is SEALED (lib/plaid/encryption.ts
 *            sealWithPurpose, BETA_ABUSE_EVIDENCE) and only the sealed form is
 *            stored. Audited BETA_ABUSE_EVIDENCE_PRESERVED (ids + deadline).
 *   list     metadata only — never the payload.
 *   read     opens ONE payload; EVERY read is audited BETA_ABUSE_EVIDENCE_ACCESSED
 *            first (no audit row ⇒ nothing returned).
 *   delete   before the deadline: reason required, audited. Otherwise retention
 *            (jobs/data-retention.ts) deletes it once retainUntil has passed.
 * There is no edit path (fm_system holds no UPDATE on the table).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { assertOperatorNoteSafe, recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import { EncryptionPurpose, openWithPurpose, sealWithPurpose } from "@/lib/plaid/encryption";
import { loadBetaRisk } from "./beta-risk";
import { checkRetainUntil } from "./beta-blocklist-core";

type Db = typeof systemDb;

interface Attribution {
  actor: OperatorActionInput["actor"];
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** The sealed payload's shape (version 1). */
export interface AbuseEvidencePayload {
  v: 1;
  request: { id: string; email: string; note: string | null; createdAt: string; status: string; decidedAt: string | null };
  verdicts: { status: string; reasonCode: string; at: string }[];
  /** Advisory signals at capture time (codes + evidence counts), or null when they could not be computed. */
  signals: { level: string; reasons: { code: string; evidence: Record<string, unknown> }[] } | null;
}

export interface AbuseEvidenceMeta {
  id: string;
  sourceRequestId: string;
  capturedAt: string;
  capturedById: string;
  reasonCode: string;
  note: string | null;
  retainUntil: string;
}

const meta = (r: { id: string; sourceRequestId: string; capturedAt: Date; capturedById: string; reasonCode: string; note: string | null; retainUntil: Date }): AbuseEvidenceMeta => ({
  id: r.id, sourceRequestId: r.sourceRequestId, capturedAt: r.capturedAt.toISOString(), capturedById: r.capturedById,
  reasonCode: r.reasonCode, note: r.note, retainUntil: r.retainUntil.toISOString(),
});

export type CaptureResult =
  | { ok: true; evidence: AbuseEvidenceMeta }
  | { ok: false; status: 400 | 404 | 409; code: "INVALID_RETAIN_UNTIL" | "NOT_FOUND" | "NOT_SUSPICIOUS_DENIAL" | "ALREADY_PRESERVED"; message: string };

/** Best-effort advisory signals for one request (codes + counts). Never throws. */
async function signalsFor(requestId: string, client: Db, now: Date): Promise<AbuseEvidencePayload["signals"]> {
  try {
    const r = await loadBetaRisk([requestId], { client, now });
    const risk = r.byId.get(requestId);
    if (!risk) return null;
    return { level: risk.level, reasons: risk.reasons.map((x) => ({ code: x.code, evidence: { ...x.evidence } })) };
  } catch {
    return null;
  }
}

export async function captureAbuseEvidence(
  input: Attribution & { requestId: string; reason: OperatorReason; retainUntil: unknown; note?: string | null; client?: Db; now?: Date },
): Promise<CaptureResult> {
  const client = input.client ?? systemDb;
  const now = input.now ?? new Date();
  const r = checkRetainUntil(input.retainUntil, now);
  if (!r.ok) return { ok: false, status: 400, code: "INVALID_RETAIN_UNTIL", message: r.reason };
  const note = typeof input.note === "string" && input.note.trim() !== "" ? assertOperatorNoteSafe(input.note) : null;
  // Read OUTSIDE the transaction (fleet reads, best-effort); the payload's own facts are re-read under the lock.
  const signals = await signalsFor(input.requestId, client, now);

  return client.$transaction(async (tx): Promise<CaptureResult> => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BetaAccessRequest" WHERE "id" = ${input.requestId} FOR UPDATE`;
    if (locked.length === 0) return { ok: false, status: 404, code: "NOT_FOUND", message: "Request not found." };
    const req = await tx.betaAccessRequest.findUnique({
      where: { id: input.requestId },
      select: { id: true, email: true, note: true, createdAt: true, status: true, decidedAt: true },
    });
    if (!req) return { ok: false, status: 404, code: "NOT_FOUND", message: "Request not found." };
    const verdicts = await tx.betaAccessRequestReview.findMany({
      where: { requestId: req.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { status: true, reasonCode: true, createdAt: true },
    });
    const latest = verdicts[verdicts.length - 1];
    if (req.status !== "DENIED" || latest?.status !== "SUSPICIOUS") {
      return { ok: false, status: 409, code: "NOT_SUSPICIOUS_DENIAL", message: "Evidence can only be preserved for a DENIED request whose latest verdict is Suspicious." };
    }
    if (await tx.betaAbuseEvidence.findUnique({ where: { sourceRequestId: req.id }, select: { id: true } })) {
      return { ok: false, status: 409, code: "ALREADY_PRESERVED", message: "Evidence for this request is already preserved." };
    }
    const payload: AbuseEvidencePayload = {
      v: 1,
      request: {
        id: req.id, email: req.email, note: req.note, createdAt: req.createdAt.toISOString(), status: req.status,
        decidedAt: req.decidedAt?.toISOString() ?? null,
      },
      verdicts: verdicts.map((v) => ({ status: v.status, reasonCode: v.reasonCode, at: v.createdAt.toISOString() })),
      signals,
    };
    const row = await tx.betaAbuseEvidence.create({
      data: {
        sourceRequestId: req.id, sealedPayload: sealWithPurpose(JSON.stringify(payload), EncryptionPurpose.BETA_ABUSE_EVIDENCE),
        capturedAt: now, capturedById: input.actor.userId, reasonCode: input.reason.code, note, retainUntil: r.retainUntil,
      },
    });
    await recordOperatorAction(tx, {
      actor: input.actor,
      action: AuditAction.BETA_ABUSE_EVIDENCE_PRESERVED,
      target: { kind: "BETA_ABUSE_EVIDENCE", id: row.id },
      reason: input.reason,
      result: "SUCCESS",
      detail: { evidenceId: row.id, sourceRequestId: req.id, betaRequestId: req.id, retainUntil: r.retainUntil.toISOString() },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ok: true, evidence: meta(row) };
  });
}

export const ABUSE_EVIDENCE_LIST_CAP = 200;

/** Metadata only — the sealed payload never leaves the table here. */
export async function listAbuseEvidence(opts: { client?: Db } = {}): Promise<{ evidence: AbuseEvidenceMeta[]; capped: boolean }> {
  const client = opts.client ?? systemDb;
  const rows = await client.betaAbuseEvidence.findMany({
    orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
    take: ABUSE_EVIDENCE_LIST_CAP + 1,
    select: { id: true, sourceRequestId: true, capturedAt: true, capturedById: true, reasonCode: true, note: true, retainUntil: true },
  });
  return { evidence: rows.slice(0, ABUSE_EVIDENCE_LIST_CAP).map(meta), capped: rows.length > ABUSE_EVIDENCE_LIST_CAP };
}

export type ReadResult =
  | { ok: true; evidence: AbuseEvidenceMeta; payload: AbuseEvidencePayload }
  | { ok: false; status: 404 | 500; code: "NOT_FOUND" | "UNREADABLE"; message: string };

/** Open ONE payload. The access is audited BEFORE it is opened; no audit row ⇒ nothing returned (it throws). */
export async function readAbuseEvidence(input: Attribution & { id: string; client?: Db }): Promise<ReadResult> {
  const client = input.client ?? systemDb;
  const row = await client.betaAbuseEvidence.findUnique({ where: { id: input.id } });
  if (!row) return { ok: false, status: 404, code: "NOT_FOUND", message: "Evidence not found (it may have passed its retention deadline)." };
  await recordOperatorAction(client, {
    actor: input.actor,
    action: AuditAction.BETA_ABUSE_EVIDENCE_ACCESSED,
    target: { kind: "BETA_ABUSE_EVIDENCE", id: row.id },
    result: "SUCCESS",
    detail: { evidenceId: row.id, sourceRequestId: row.sourceRequestId },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
  try {
    const payload = JSON.parse(openWithPurpose(row.sealedPayload, EncryptionPurpose.BETA_ABUSE_EVIDENCE)) as AbuseEvidencePayload;
    return { ok: true, evidence: meta(row), payload };
  } catch {
    return { ok: false, status: 500, code: "UNREADABLE", message: "The sealed evidence could not be opened (key changed or data damaged)." };
  }
}

export type DeleteResult =
  | { ok: true; id: string }
  | { ok: false; status: 404; code: "NOT_FOUND"; message: string };

/** Delete before the deadline: reason required, audited in the same transaction. */
export async function deleteAbuseEvidence(input: Attribution & { id: string; reason: OperatorReason; client?: Db }): Promise<DeleteResult> {
  const client = input.client ?? systemDb;
  return client.$transaction(async (tx): Promise<DeleteResult> => {
    const row = await tx.betaAbuseEvidence.findUnique({ where: { id: input.id }, select: { id: true, sourceRequestId: true, retainUntil: true } });
    if (!row) return { ok: false, status: 404, code: "NOT_FOUND", message: "Evidence not found (it may have passed its retention deadline)." };
    const { count } = await tx.betaAbuseEvidence.deleteMany({ where: { id: row.id } });
    if (count !== 1) return { ok: false, status: 404, code: "NOT_FOUND", message: "Evidence not found." };
    await recordOperatorAction(tx, {
      actor: input.actor,
      action: AuditAction.BETA_ABUSE_EVIDENCE_DELETED,
      target: { kind: "BETA_ABUSE_EVIDENCE", id: row.id },
      reason: input.reason,
      result: "SUCCESS",
      detail: { evidenceId: row.id, sourceRequestId: row.sourceRequestId, retainUntil: row.retainUntil.toISOString() },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ok: true, id: row.id };
  });
}
