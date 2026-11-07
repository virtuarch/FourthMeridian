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
 * Checked 2026-11-08 against the LIVE pages (raw HTML — the *.html.md exports
 * lag: the NO_ACCOUNTS line below is absent from errors/item/index.html.md):
 *   ITEM_LOGIN_REQUIRED  ✓ plaid.com/docs/link/update-mode/ "Resolving ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION,
 *                          or PENDING_DISCONNECT": "Receiving an ITEM_LOGIN_REQUIRED error … indicates
 *                          that the Item should be re-initialized via update mode."
 *   ACCESS_NOT_GRANTED   ✓ plaid.com/docs/errors/item/ ACCESS_NOT_GRANTED troubleshooting: "The end user
 *                          should do this during the Link flow if they were unable to successfully
 *                          complete the Link flow for the Item, or via Link's update mode if the Item
 *                          has already been added."
 *   NO_ACCOUNTS          ✓ plaid.com/docs/errors/item/ NO_ACCOUNTS troubleshooting: "If you previously
 *                          had access to the account, send your user through update mode with account
 *                          selection enabled to allow them to re-grant access to the account."
 *                          → also in ACCOUNT_SELECTION_CODES (the link token sets
 *                            update.account_selection_enabled).
 *   ITEM_LOCKED          ✗ troubleshooting: unlock at the institution, "then try to re-authenticate
 *                          using Plaid Link" — Link, not update mode, is named. Excluded; it also
 *                          stays a TRANSIENT code in errors.ts (log only, status unchanged), so it
 *                          never persists as ERROR and needs no Reconnect.
 *   USER_SETUP_REQUIRED  ✗ troubleshooting: complete setup at the institution, "Once completed, prompt
 *                          the user to re-authenticate with Plaid Link" — update mode not named. Excluded.
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
  "NO_ACCOUNTS",
]);

/**
 * The subset whose update-mode fix needs Account Select: Plaid says to send the
 * user "through update mode with account selection enabled" (NO_ACCOUNTS). The
 * Reconnect link token sets `update.account_selection_enabled` ONLY for these —
 * never for a plain re-login, because Account Select also lets the member
 * DE-select accounts (Plaid: "Any de-selected accounts will no longer be shared
 * with you"). For US OAuth institutions with their own account selection flow,
 * Plaid enables Account Select in update mode regardless (plaid-node
 * LinkTokenCreateRequestUpdate.account_selection_enabled).
 */
export const ACCOUNT_SELECTION_CODES: ReadonlySet<string> = new Set([
  "NO_ACCOUNTS",
]);

/** The `update` field of an update-mode /link/token/create request for an item with this error code. */
export function updateModeAccountSelectionFor(errorCode: string | null | undefined): { account_selection_enabled: true } | undefined {
  return errorCode != null && ACCOUNT_SELECTION_CODES.has(errorCode) && UPDATE_MODE_FIXABLE_CODES.has(errorCode)
    ? { account_selection_enabled: true }
    : undefined;
}

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
