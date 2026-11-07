/**
 * lib/plaid/reauth-codes.ts
 *
 * THE single source of truth for which Plaid Item error codes the member can
 * fix themselves through Plaid Link UPDATE MODE (the existing Reconnect button —
 * components/dashboard/ReconnectAccountButton.tsx → /api/plaid/link-token?plaidItemId=…).
 *
 * Consumers (none may keep a literal copy of these codes):
 *   - lib/plaid/errors.ts               classifyPlaidErrorForHealth: a code here → NEEDS_REAUTH
 *   - lib/plaid/webhook-receiver.ts     ITEM/ERROR with a code here → NEEDS_REAUTH
 *   - lib/platform/verdicts/provider-connection.ts  CUSTOMER_REAUTH_CODES ⊇ this set
 *   - lib/connections/connection-summary.ts  offersReconnect (member Connections UI):
 *                                       Reconnect on NEEDS_REAUTH, or on an ERROR item
 *                                       whose code is in this set
 *
 * ── MEMBERSHIP RULE ─────────────────────────────────────────────────────────
 * A code is in UPDATE_MODE_FIXABLE_CODES only when Plaid's OWN documentation says
 * Link update mode resolves it. Each entry cites the line. A code we merely
 * believe update mode fixes stays out — offering a Reconnect that cannot work
 * sends the member round a loop with no exit, which is worse than the honest
 * "Sync issue".
 *
 * Checked 2026-11-08 against plaid.com/docs/errors/item/ and
 * plaid.com/docs/link/update-mode/:
 *   ITEM_LOGIN_REQUIRED  ✓ update-mode guide, "Resolving ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION,
 *                          or PENDING_DISCONNECT": "Receiving an ITEM_LOGIN_REQUIRED error … indicates
 *                          that the Item should be re-initialized via update mode."
 *   ACCESS_NOT_GRANTED   ✓ update-mode guide, "Resolving ACCESS_NOT_GRANTED or NO_AUTH_ACCOUNTS
 *                          errors via Product Validations": UMPV gives "higher conversion than
 *                          resolving these errors via regular update mode" — i.e. regular update
 *                          mode resolves it; UMPV is an optional improvement.
 *   NO_ACCOUNTS          ✗ NOT documented as update-mode-fixable (item-errors page: Link sends the
 *                          user to Institution Select; troubleshooting = support ticket). Excluded.
 *   ITEM_LOCKED          ✗ NOT documented (user unlocks at the institution's site). Excluded; it
 *                          also stays a TRANSIENT code in errors.ts (log only, status unchanged),
 *                          so it never persists as ERROR and needs no Reconnect.
 *   USER_SETUP_REQUIRED  ✗ NOT documented (user completes setup at the institution). Excluded.
 *
 * Deliberately NOT here (S2 ruling): USER_PERMISSION_REVOKED (the webhook maps
 * it to REVOKED); PENDING_EXPIRATION / PENDING_DISCONNECT (webhooks, not item
 * errors — they move no health state); link-time credential codes
 * (INVALID_CREDENTIALS, INVALID_MFA, INSUFFICIENT_CREDENTIALS, MFA_NOT_SUPPORTED).
 *
 * PURE: no Prisma, no I/O — importable from client components and tsx tests.
 */

/** Plaid documents Link update mode as the fix for these Item error codes. */
export const UPDATE_MODE_FIXABLE_CODES: ReadonlySet<string> = new Set([
  "ITEM_LOGIN_REQUIRED",
  "ACCESS_NOT_GRANTED",
]);

/**
 * Every code that maps a PlaidItem to NEEDS_REAUTH: the update-mode-fixable set
 * plus INVALID_ACCESS_TOKEN, which has always been NEEDS_REAUTH here (the stored
 * credential is dead; it is kept as-is and is not claimed to be update-mode-fixable).
 */
export const NEEDS_REAUTH_CODES: ReadonlySet<string> = new Set([
  ...UPDATE_MODE_FIXABLE_CODES,
  "INVALID_ACCESS_TOKEN",
]);

export function isUpdateModeFixable(code: string | null | undefined): boolean {
  return code != null && UPDATE_MODE_FIXABLE_CODES.has(code);
}

export function isNeedsReauthCode(code: string | null | undefined): boolean {
  return code != null && NEEDS_REAUTH_CODES.has(code);
}

/**
 * Whether the member should be offered Reconnect (Link update mode) for a Plaid
 * item. NEEDS_REAUTH always; ERROR only when its code is update-mode-fixable —
 * which is what heals items persisted as ERROR before their code moved into
 * NEEDS_REAUTH, on deploy, with no data change. Any other ERROR (e.g. an
 * institution outage) gets no Reconnect: relinking cannot fix it.
 */
export function canReconnectViaUpdateMode(status: string, errorCode: string | null | undefined): boolean {
  if (status === "NEEDS_REAUTH") return true;
  return status === "ERROR" && isUpdateModeFixable(errorCode);
}
