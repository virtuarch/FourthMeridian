/**
 * lib/platform/growth/invitation-issue.core.ts  (PR B · one issuance mechanism)
 *
 * PURE DECISIONS for beta-invitation issuance, extension and the validity
 * policy. No I/O, no clock reads, no Prisma client: every input is a fact the
 * I/O layer (invitation-issue.ts, invitation-policy.ts) already read, so each
 * rule here is unit-testable and there is exactly one place it is written down.
 *
 * ── THE ONE EXPIRY POLICY ─────────────────────────────────────────────────────
 * Every NEW invitation, from every path (queue approve, direct invite, resend /
 * reissue), expires `validityDays × 24 h` after the instant it was issued. The
 * days come from the operator's per-invitation override (bounded 1–30, refused
 * outside) or the `beta_invitation_validity_days` platform setting (default 7).
 * The arithmetic is epoch milliseconds, i.e. UTC by construction: no calendar,
 * no local zone, no DST. Changing the setting never touches an invitation that
 * was already issued; changing one of those is the explicit, audited Extend.
 *
 * ── WHAT EACH KIND MAY DO ─────────────────────────────────────────────────────
 *   approve   PENDING | DENIED → APPROVED. Already APPROVED is idempotent (no new
 *             token, no email). REDEEMED, or an address that already has an
 *             account, is refused.
 *   reissue   APPROVED only: rotate the token, conditional on the hash observed,
 *             so two concurrent reissues have one winner and one email.
 *   direct    no row → create. PENDING → the approve path. APPROVED but expired
 *             → the reissue path. DENIED, REDEEMED, a live APPROVED invite or an
 *             existing account are refused — never a silent status flip.
 *   extend    APPROVED only: move the expiry, KEEP the token, send nothing.
 */

// ── The validity bounds (the platform-setting descriptor reads these) ─────────

export const INVITATION_VALIDITY_MIN_DAYS = 1;
export const INVITATION_VALIDITY_MAX_DAYS = 30;
export const INVITATION_VALIDITY_DEFAULT_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type ValidityParse = { ok: true; days: number } | { ok: false; reason: string };

const BOUNDS_REASON =
  `Invitation validity must be a whole number of days from ${INVITATION_VALIDITY_MIN_DAYS} to ${INVITATION_VALIDITY_MAX_DAYS}.`;

/**
 * Parse an UNTRUSTED validity (a request body field or a stored row value).
 * Accepts an integer number or a string of digits; refuses everything else —
 * fractions, negatives, out-of-range values and junk are refused, never clamped.
 */
export function parseValidityDays(raw: unknown): ValidityParse {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^\s*\d+\s*$/.test(raw)) n = Number.parseInt(raw, 10);
  else return { ok: false, reason: BOUNDS_REASON };
  if (!Number.isInteger(n) || n < INVITATION_VALIDITY_MIN_DAYS || n > INVITATION_VALIDITY_MAX_DAYS) {
    return { ok: false, reason: BOUNDS_REASON };
  }
  return { ok: true, days: n };
}

/** The setting row's value → days. Missing or unreadable ⇒ the default (FALLBACK_TO_DEFAULT). */
export function validityFromSettingValue(value: string | null | undefined): number {
  const p = parseValidityDays(value ?? undefined);
  return p.ok ? p.days : INVITATION_VALIDITY_DEFAULT_DAYS;
}

/** The expiry of an invitation issued at `issuedAt` for `days` — UTC epoch arithmetic. */
export function expiryFor(issuedAt: Date, days: number): Date {
  return new Date(issuedAt.getTime() + days * DAY_MS);
}

// ── The validity policy read model (GET/PUT invitation-policy) ───────────────

export interface InvitationPolicyReadModel {
  /** The validity every NEW invitation gets unless the operator overrides it. */
  validityDays: number;
  min: number;
  max: number;
  default: number;
  /** The setting row's updatedAt (ISO) — the optimistic version token; null = no row (the default is in force). */
  version: string | null;
  origin: "DEFAULT" | "CONFIGURED";
}

/** Same instant to the millisecond, or both absent. */
export function versionMatches(expected: string | null, row: { updatedAt: Date } | null): boolean {
  if (expected === null) return row === null;
  if (row === null) return false;
  const t = Date.parse(expected);
  return Number.isFinite(t) && t === row.updatedAt.getTime();
}

// ── Issuance plans ────────────────────────────────────────────────────────────

export type InviteStatus = "PENDING" | "APPROVED" | "DENIED" | "REDEEMED";

export interface InviteRowFacts {
  id: string;
  email: string;
  status: InviteStatus;
  inviteTokenHash: string | null;
  inviteExpiresAt: Date | null;
  /** When the current token was last sent (the reissue double-click token). */
  invitedAt?: Date | null;
}

export type IssueKind = "approve" | "reissue" | "direct";

export type IssueRefusalCode =
  | "NOT_FOUND"
  | "REDEEMED"
  | "ACCOUNT_EXISTS"
  | "NOT_APPROVED"
  | "DENIED"
  | "LIVE_INVITE"
  | "INVALID_VALIDITY"
  | "INVALID_EMAIL"
  | "CONFLICT"
  | "WOULD_SHORTEN";

export interface IssueRefusal {
  code: IssueRefusalCode;
  message: string;
  /** The HTTP status a route answers with. */
  status: 400 | 404 | 409;
}

const STATUS_OF: Record<IssueRefusalCode, IssueRefusal["status"]> = {
  NOT_FOUND: 404, INVALID_VALIDITY: 400, INVALID_EMAIL: 400,
  REDEEMED: 409, ACCOUNT_EXISTS: 409, NOT_APPROVED: 409, DENIED: 409, LIVE_INVITE: 409, CONFLICT: 409, WOULD_SHORTEN: 409,
};

export function refusal(code: IssueRefusalCode, message?: string): IssueRefusal {
  return { code, status: STATUS_OF[code], message: message ?? DEFAULT_MESSAGE[code] };
}

const DEFAULT_MESSAGE: Record<IssueRefusalCode, string> = {
  NOT_FOUND:        "Request not found.",
  REDEEMED:         "This invitation was already redeemed — an account was created from it.",
  ACCOUNT_EXISTS:   "That email already has a Fourth Meridian account.",
  NOT_APPROVED:     "Only an approved, un-redeemed invitation can be resent.",
  DENIED:           "That address was denied or its invitation was revoked. A direct invite does not overturn that decision.",
  LIVE_INVITE:      "That address already has a live invitation. Use Resend to send a new link or Extend to change its expiry.",
  INVALID_VALIDITY: BOUNDS_REASON,
  INVALID_EMAIL:    "A valid email is required.",
  CONFLICT:         "This invitation changed while your action was being saved. Reload and try again.",
  WOULD_SHORTEN:    "That would shorten this invitation. Extend only lengthens it — use Revoke to end an invitation early.",
};

/** What the I/O layer must do. `expectedHash` is the optimistic token for a rotation. */
export type IssuePlan =
  | { action: "create" }
  | { action: "approve"; row: InviteRowFacts }
  | { action: "reissue"; row: InviteRowFacts; expectedHash: string | null }
  | { action: "alreadyApproved"; row: InviteRowFacts }
  | { action: "refuse"; refusal: IssueRefusal };

export function planApprove(row: InviteRowFacts | null, accountExists: boolean): IssuePlan {
  if (!row) return { action: "refuse", refusal: refusal("NOT_FOUND") };
  if (row.status === "REDEEMED") return { action: "refuse", refusal: refusal("REDEEMED") };
  // I4 — a repeat or a concurrent second click on an APPROVED row sends nothing.
  if (row.status === "APPROVED") return { action: "alreadyApproved", row };
  // E-6 — an invite for an address that already has an account can never be redeemed.
  if (accountExists) return { action: "refuse", refusal: refusal("ACCOUNT_EXISTS") };
  return { action: "approve", row };
}

export function planReissue(row: InviteRowFacts | null, accountExists: boolean): IssuePlan {
  if (!row) return { action: "refuse", refusal: refusal("NOT_FOUND") };
  if (row.status !== "APPROVED") return { action: "refuse", refusal: refusal("NOT_APPROVED") };
  if (accountExists) return { action: "refuse", refusal: refusal("ACCOUNT_EXISTS") };
  return { action: "reissue", row, expectedHash: row.inviteTokenHash };
}

export function planDirect(row: InviteRowFacts | null, accountExists: boolean, now: Date): IssuePlan {
  if (accountExists) return { action: "refuse", refusal: refusal("ACCOUNT_EXISTS") };
  if (!row) return { action: "create" };
  switch (row.status) {
    case "PENDING":  return { action: "approve", row };
    case "DENIED":   return { action: "refuse", refusal: refusal("DENIED") };
    case "REDEEMED": return { action: "refuse", refusal: refusal("REDEEMED") };
    case "APPROVED":
      if (isLive(row, now)) return { action: "refuse", refusal: refusal("LIVE_INVITE") };
      return { action: "reissue", row, expectedHash: row.inviteTokenHash };
  }
}

/** A live invitation: APPROVED with an expiry still in the future (strictly, as validateInvite). */
export function isLive(row: Pick<InviteRowFacts, "status" | "inviteExpiresAt">, now: Date): boolean {
  return row.status === "APPROVED" && row.inviteExpiresAt != null && row.inviteExpiresAt.getTime() > now.getTime();
}

export type ExtendPlan =
  | { action: "extend"; row: InviteRowFacts }
  | { action: "refuse"; refusal: IssueRefusal };

/**
 * Extend NEVER shortens: the new expiry must be strictly later than the current
 * one (ending an invitation early is Revoke). An expired invitation may be
 * revived. An address that already has an account cannot be extended (as approve).
 */
export function planExtend(row: InviteRowFacts | null, accountExists: boolean, newExpiresAt: Date): ExtendPlan {
  if (!row) return { action: "refuse", refusal: refusal("NOT_FOUND") };
  if (row.status !== "APPROVED") {
    return { action: "refuse", refusal: refusal("NOT_APPROVED", "Only an approved, un-redeemed invitation can be extended.") };
  }
  if (accountExists) return { action: "refuse", refusal: refusal("ACCOUNT_EXISTS") };
  if (row.inviteExpiresAt && newExpiresAt.getTime() <= row.inviteExpiresAt.getTime()) {
    return { action: "refuse", refusal: refusal("WOULD_SHORTEN") };
  }
  return { action: "extend", row };
}

/** RFC-lite email check (the direct-invite route's historical rule). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseInviteEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}
