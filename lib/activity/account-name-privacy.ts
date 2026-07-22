/**
 * lib/activity/account-name-privacy.ts  (P1-3)
 *
 * Privacy-conservative account-name policy for the Space activity feed
 * (ACCOUNT_SHARED / ACCOUNT_REVOKED events sourced from AuditLog metadata).
 *
 * Founder ruling for this slice:
 *   - FULL              → may surface the real account name.
 *   - BALANCE_ONLY /
 *     SUMMARY_ONLY      → must use a generic/redacted account identity.
 *   - REVOKED / deleted → must not surface stale detail.
 *
 * Defense in depth — two layers, both reusing canonical vocabulary
 * (grantsAccountDetail from lib/ai/visibility; genericAccountName from
 * lib/account-privacy), never a new privacy model:
 *
 *   storedActivityAccountName  — WRITE time. Applied at the share/revoke write
 *     sites so a real account name is NEVER newly persisted into AuditLog
 *     metadata for a non-FULL share. Even a consumer that bypasses the renderer
 *     (export, admin, a future feature) reads only a generic label.
 *
 *   displayActivityAccountName — READ time. Applied at the activity renderer so
 *     a LEGACY payload that already persisted a real BALANCE_ONLY name (written
 *     before this slice) is still redacted on render. Fails closed: only a
 *     FULL-marked payload surfaces its persisted name; a payload with a non-FULL
 *     marker, or none at all (e.g. legacy revoke rows that never stored a
 *     visibility marker), renders the generic identity.
 */

import { VisibilityLevel } from "@prisma/client";
import { grantsAccountDetail } from "@/lib/ai/visibility";
import { genericAccountName, type AccountTypeHint } from "@/lib/account-privacy";

/**
 * The generic label rendered in place of a redacted account name. Deliberately
 * matches the pre-existing fallback the activity renderer already used when no
 * name was present, so redacted copy reads naturally ("Someone shared an
 * account (balance only)").
 */
export const GENERIC_ACCOUNT_LABEL = "an account";

/**
 * WRITE time — the account name that is safe to PERSIST in an activity/audit
 * payload for a share/revoke at the given visibility tier. FULL yields the real
 * name (falling back to a generic typed label if the real name is unknown);
 * every non-FULL tier yields a generic typed label — the real name never
 * reaches storage.
 */
export function storedActivityAccountName(
  visibilityLevel: VisibilityLevel,
  realName: string | null,
  hint: AccountTypeHint,
): string {
  if (grantsAccountDetail(visibilityLevel)) return realName ?? genericAccountName(hint);
  return genericAccountName(hint);
}

/**
 * READ time — the account name that is safe to DISPLAY from a persisted payload.
 * Only a payload explicitly marked FULL surfaces its persisted name; any other
 * marker (non-FULL) or the absence of a marker (legacy rows) falls back to the
 * generic label. This is a display-side backstop for rows written before the
 * write-time redaction existed; it does not purge stale names from storage
 * (that would require a DB scrub — see the P1-3 report).
 */
export function displayActivityAccountName(
  persistedName: string | null | undefined,
  visibilityLevel: string | null | undefined,
): string {
  if (visibilityLevel === VisibilityLevel.FULL) return persistedName || GENERIC_ACCOUNT_LABEL;
  return GENERIC_ACCOUNT_LABEL;
}
