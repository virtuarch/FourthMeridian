/**
 * lib/platform/growth/bulk-approve.core.ts  (PR C · bulk beta approval)
 *
 * PURE DECISIONS for approving many beta requests at once. No I/O, no clock, no
 * Prisma client — the I/O layer (bulk-approve.ts) and the Growth list route hand
 * in the facts they already read.
 *
 * ── ONE ELIGIBILITY RULE ──────────────────────────────────────────────────────
 * `approvalEligibility` IS `planApprove` (invitation-issue.core.ts), the rule
 * `issueBetaInvitation({ kind: "approve" })` applies, read as a yes/no plus a
 * reason, with ONE bulk-only narrowing:
 *
 *   A bulk batch approves PENDING requests only. A request that is DENIED by the
 *   time the batch reads it was denied or revoked after the operator selected it
 *   on a screen that showed it pending; the single-row Approve may deliberately
 *   reverse a denial (planApprove allows it), a batch must not do so silently.
 *
 * The list route (`eligibility` on each pending row), the dry run (the preview)
 * and the execution all call this one function, so the preview cannot promise
 * what the execution refuses.
 *
 * RISK-BLIND: an advisory `risk` field may sit on a row elsewhere; nothing here
 * reads it. Eligibility is the issuance rule and nothing else.
 */

import { planApprove, type InviteRowFacts, type IssueRefusalCode } from "./invitation-issue.core";

/** Hard cap on ids per request — one page of the Growth list (the route's `take: 100`). */
export const BULK_APPROVE_MAX_IDS = 100;

/** Why a request cannot be approved in a batch (an issuance refusal code, or a bulk-only one). */
export type BulkIneligibleCode =
  | Extract<IssueRefusalCode, "NOT_FOUND" | "REDEEMED" | "ACCOUNT_EXISTS" | "DENIED">
  | "ALREADY_APPROVED"
  | "DUPLICATE"
  /** Issuance read a different status than the batch did (denied / revoked / re-queued in between). */
  | "STATUS_CHANGED"
  /** The batch's time budget ran out before this row was reached; a retry with the same batchKey finishes it. */
  | "NOT_ATTEMPTED";

export type BulkFailureCode = "REFUSED" | "ERROR";

export const BULK_REASON: Record<BulkIneligibleCode | BulkFailureCode, string> = {
  NOT_FOUND:        "Request not found.",
  REDEEMED:         "Already redeemed — an account was created from this invitation.",
  ACCOUNT_EXISTS:   "That email already has a Fourth Meridian account.",
  DENIED:           "Denied or revoked since it was selected.",
  ALREADY_APPROVED: "Already approved — no new invitation was sent.",
  DUPLICATE:        "Listed more than once in this batch — counted once.",
  STATUS_CHANGED:   "Status changed since it was selected (denied, revoked or re-queued) — not approved, nothing sent.",
  NOT_ATTEMPTED:    "Not attempted — the batch hit its time limit. Use Finish remaining; nothing is sent twice.",
  REFUSED:          "Refused by the issuance rules.",
  ERROR:            "May or may not have been approved (unexpected error) — check the Invited tab.",
};

export type Eligibility =
  | { approvable: true }
  | { approvable: false; code: Exclude<BulkIneligibleCode, "DUPLICATE" | "STATUS_CHANGED" | "NOT_ATTEMPTED">; reason: string };

/** The ONE decision: may this row be approved by a batch right now? */
export function approvalEligibility(row: InviteRowFacts | null, accountExists: boolean): Eligibility {
  // The bulk-only narrowing (header) is planApprove's own `expectedStatus`, the
  // same one the execution hands to issueBetaInvitation.
  const plan = planApprove(row, accountExists, BULK_EXPECTED_STATUS);
  if (plan.action === "alreadyApproved") return no("ALREADY_APPROVED");
  if (plan.action === "refuse") {
    const code = plan.refusal.code;
    if (code === "NOT_FOUND" || code === "REDEEMED" || code === "ACCOUNT_EXISTS") return no(code);
    if (code === "STATUS_CHANGED") return no("DENIED"); // only PENDING passes; the one other un-approved status is DENIED
    // planApprove refuses nothing else today; anything new is surfaced, never approved.
    return { approvable: false, code: "NOT_FOUND", reason: plan.refusal.message };
  }
  if (plan.action !== "approve") return no("NOT_FOUND");
  return { approvable: true };
}

/** A batch approves PENDING requests only — passed to planApprove and to issueBetaInvitation. */
export const BULK_EXPECTED_STATUS = "PENDING" as const;

function no(code: Exclude<BulkIneligibleCode, "DUPLICATE" | "STATUS_CHANGED" | "NOT_ATTEMPTED">): Eligibility {
  return { approvable: false, code, reason: BULK_REASON[code] };
}

// ── The request body ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface BulkApproveBody {
  /** Unique ids, first occurrence order. */
  ids: string[];
  /** Ids that appeared again after their first occurrence (one entry per extra occurrence). */
  duplicates: string[];
  requested: number;
  batchKey: string;
  dryRun: boolean;
  /** Absent ⇒ the configured validity (validated by issueBetaInvitation's parser upstream). */
  validityDays?: unknown;
  reason?: unknown;
}

export type BodyParse = { ok: true; body: BulkApproveBody } | { ok: false; error: string };

/** Parse an UNTRUSTED body. Refuses (never clamps or truncates) an oversize or malformed batch. */
export function parseBulkApproveBody(raw: unknown): BodyParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "A JSON body is required." };
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.requestIds) || b.requestIds.length === 0) return { ok: false, error: "requestIds must be a non-empty array." };
  if (b.requestIds.length > BULK_APPROVE_MAX_IDS) {
    return { ok: false, error: `At most ${BULK_APPROVE_MAX_IDS} requests can be approved at once (one page).` };
  }
  if (!b.requestIds.every((x) => typeof x === "string" && ID_RE.test(x))) return { ok: false, error: "Every request id must be a string id." };
  if (typeof b.batchKey !== "string" || !UUID_RE.test(b.batchKey)) return { ok: false, error: "batchKey must be a UUID generated for this review." };
  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") return { ok: false, error: "dryRun must be a boolean." };
  const { ids, duplicates } = dedupeIds(b.requestIds as string[]);
  return {
    ok: true,
    body: {
      ids, duplicates, requested: b.requestIds.length, batchKey: b.batchKey.toLowerCase(), dryRun: b.dryRun === true,
      ...(b.validityDays !== undefined && b.validityDays !== null ? { validityDays: b.validityDays } : {}),
      ...(b.reason !== undefined ? { reason: b.reason } : {}),
    },
  };
}

export function dedupeIds(raw: readonly string[]): { ids: string[]; duplicates: string[] } {
  const seen = new Set<string>();
  const ids: string[] = [];
  const duplicates: string[] = [];
  for (const id of raw) {
    if (seen.has(id)) duplicates.push(id);
    else { seen.add(id); ids.push(id); }
  }
  return { ids, duplicates };
}

// ── Results ──────────────────────────────────────────────────────────────────

export interface BulkValidity {
  validityDays: number;
  validitySource: "override" | "setting";
  /** The expiry an invitation issued at the moment of the read would get (UTC). */
  expiresAtIfIssuedNow: string;
}

export type BulkDryRunRow = { id: string; eligible: true } | { id: string; eligible: false; code: string; reason: string };

export interface BulkSucceeded { id: string; emailStatus: "sent" | "captured" | "skipped" | "error"; expiresAt: string }
export interface BulkSkipped { id: string; code: Exclude<BulkIneligibleCode, "DUPLICATE">; reason: string }
/** Approved (the invitation stands) but the email hand-off failed — Resend it from Invited. */
export interface BulkEmailFailed { id: string; reason: string }
export const EMAIL_FAILED_REASON = "Approved, email not sent — use Resend from the Invited tab.";
export interface BulkFailed { id: string; code: BulkFailureCode; reason: string }

export interface BulkSummary {
  /** Ids in the request body, duplicates included. */
  requested: number;
  /** Distinct ids — succeeded + skipped + failed always equals this. */
  unique: number;
  /** Extra occurrences of an id already listed (each counted once, in `unique`). */
  duplicates: number;
  /** Approved, invitation stands (emailFailed included). */
  succeeded: number;
  /** Of `succeeded`: the invite email failed to hand off. */
  emailFailed: number;
  skipped: number;
  failed: number;
}

export function summarise(
  body: Pick<BulkApproveBody, "requested" | "ids" | "duplicates">,
  r: { succeeded: unknown[]; emailFailed: unknown[]; skipped: unknown[]; failed: unknown[] },
): BulkSummary {
  return {
    requested: body.requested, unique: body.ids.length, duplicates: body.duplicates.length,
    succeeded: r.succeeded.length, emailFailed: r.emailFailed.length, skipped: r.skipped.length, failed: r.failed.length,
  };
}
