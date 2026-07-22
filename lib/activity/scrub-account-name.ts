/**
 * lib/activity/scrub-account-name.ts  (P1 closeout — AuditLog activity-name scrub)
 *
 * Pure decision logic for the one-time scrub that removes historically-persisted
 * REAL account names from non-FULL account-sharing activity metadata
 * (ACCOUNT_SHARED / ACCOUNT_REVOKED AuditLog rows written before P1-3 added the
 * write-time redaction). Kept pure + DB-free so it is unit-testable in isolation;
 * the DB harness lives in scripts/scrub-activity-account-names.ts.
 *
 * Doctrine (identical to the P1-3 write/read helpers — no new privacy model):
 *   - FULL rows retain their real account name (never a candidate).
 *   - BALANCE_ONLY / SUMMARY_ONLY rows are redacted to genericAccountName(hint).
 *   - Rows with NO visibility marker (legacy revoke rows) fail closed — treated
 *     as non-FULL and redacted (matching the read-time displayActivityAccountName
 *     doctrine, which renders the generic label when the marker is absent).
 *   - When the account can no longer supply a type hint (deleted / missing), the
 *     safe value falls back to the generic label constant.
 *
 * Idempotent by construction: the safe value is deterministic, so once a row has
 * been scrubbed to it, re-running finds stored === safe and skips the row. (The
 * one exception is a row whose account is deleted BETWEEN runs — its safe value
 * shifts from a typed generic to the constant; it re-scrubs once and then
 * stabilises. Both values are generic, so no real name is ever re-exposed.)
 */

import { VisibilityLevel } from "@prisma/client";
import { genericAccountName, type AccountTypeHint } from "@/lib/account-privacy";
import { GENERIC_ACCOUNT_LABEL } from "@/lib/activity/account-name-privacy";

export interface ScrubDecision {
  /** True when the stored name must be rewritten (a non-FULL row whose stored
   *  name differs from the safe value — i.e. still carries a possibly-real name). */
  isCandidate: boolean;
  /** The display-safe value to persist (only written when isCandidate). */
  safeName: string;
}

/**
 * Decide the display-safe stored `accountName` for a persisted share/revoke
 * payload, and whether the row is a scrub candidate.
 */
export function decideScrub(params: {
  visibilityLevel: string | null | undefined;
  storedName: string | null | undefined;
  /** FinancialAccount type hint (from a lookup by financialAccountId); null when
   *  the account is deleted/missing and cannot supply type/debtSubtype. */
  hint: AccountTypeHint | null;
}): ScrubDecision {
  const { visibilityLevel, storedName, hint } = params;

  // FULL retains the real name — never a candidate.
  if (visibilityLevel === VisibilityLevel.FULL) {
    return { isCandidate: false, safeName: storedName ?? "" };
  }

  // Non-FULL or absent marker → fail closed to a generic identity.
  const safeName = hint ? genericAccountName(hint) : GENERIC_ACCOUNT_LABEL;
  const isCandidate =
    typeof storedName === "string" && storedName.length > 0 && storedName !== safeName;
  return { isCandidate, safeName };
}
