# Email catalog — 2026-10-31

This catalog lists every email-sending path in the repository, as of PR D ("Email: migrate all transactional emails to the branded design system + catalog").

## How the inventory was built

- Re-grepped `sendEmail(`, purge's injected `email(` seam, `sendNotificationEmail` (no hits), the provider layer and any direct Resend use.
- Resend is imported only in `lib/email/providers/resend.ts`; nothing else imports the SDK.
- Every send goes through `lib/email/send.ts`, and its non-production recipient guard (next section) runs immediately before the provider is called.
- `lib/email/catalog.test.ts` greps the same call sites and fails if a template, a sending file or a security-alert builder is missing from this document or from `previewCases()`.

## Non-production recipient guard (2026-10-31)

**Owner requirement:** Preview must never email an unauthorized recipient. Preview carries a real `RESEND_API_KEY`. This guard implements Comms Center contract v1 §O-4 / §5.6 step 1 ("Environment guard").

- **Where.** One chokepoint, `lib/email/send.ts`. The pure decision lives in `lib/email/recipient-guard.ts`. It runs after test mode (always capture) and after the no-key case (capture), and immediately before the real provider is called. It is the only place that calls the provider.
- **Which environment sends freely.** Only Production, meaning a Vercel deployment with `VERCEL=1` and `VERCEL_ENV=production`. Everything else is non-production and fails closed:
  - Preview;
  - Vercel development;
  - a Vercel runtime with an unexpected or unset `VERCEL_ENV`;
  - anything off Vercel (local `next start`, CI, scripts), even with `NODE_ENV=production`.
- **Allowlist.** `EMAIL_NONPROD_ALLOWLIST` holds comma-separated exact addresses, trimmed and lower-cased on both sides. It has no wildcards or domains. If it is unset or empty, everything is captured. Production ignores it.
- **ASCII only, and the matched entry is sent** (from the #166 review). `toLowerCase()` folds some non-ASCII characters into ASCII (the Kelvin sign U+212A becomes `k`). So outside Production:
  - a `to` containing any non-ASCII character is captured;
  - a non-ASCII allowlist entry (checked before lower-casing) is ignored;
  - an allowed send is addressed to the **matched allowlist entry**, never the caller's raw string.

  Production still sends the caller's address verbatim.
- **Unknown Vercel environment is loud.** If `VERCEL=1` and `VERCEL_ENV` is not exactly `production`, `preview` or `development`, the capture is logged at `console.warn` with the fixed text "email guard: unknown Vercel environment, capturing", so a misconfigured Production is visible. Any other capture logs at `console.info`.
- **Captured result.** `{ status: "captured", provider: "none", reason: "ENVIRONMENT_GUARD" }`. The provider is never called, and the message is not put in the in-memory capture buffer either.
  - "captured" is a non-failure. Routes only log `status === "error"`.
  - The notification channel records the row as `captured`.
  - `jobs/retry-notifications.ts` selects `status: "error"` rows only, so a captured delivery is never retried. A retry that the guard captures closes the row as `captured`.
- **Log line.** One line per guarded send (`console.info`, or `console.warn` for an unknown Vercel environment): `template=<name> environment=<env> domain=<domain> hash=<12 hex of sha256>`. The full address and its local part are never logged.
- **Paths verified to reach the provider only through it:**
  - every direct `sendEmail` caller in §1 and §3;
  - `sendSecurityAlert`;
  - the purge's injected `sendEmail` seam;
  - `lib/alerts/run.ts`;
  - the notification EMAIL channel (`lib/notifications/channels/email.ts`), both at creation and when re-delivered by the retry job;
  - `scripts/email-preview.ts`.

  `lib/email/recipient-guard.test.ts` source-scans these paths. The Resend SDK is imported only by the adapter, the adapter only by `send.ts`, nothing calls `api.resend.com`, and `send.ts` calls the provider exactly once, after the guard.
- **Two gates for the preview script.** `EMAIL_PREVIEW_ALLOWED_TO` stays as the script's own first gate: it requires an exact match with `--to`, and the script refuses before rendering or sending otherwise. The chokepoint guard is the second gate. A local run is never Production, so the address must be in **both** variables. If it is in the first only, the script logs `sent <slug>: captured`.
- **Email health.** `getEmailDeliveryHealth().counts.captured` is its own category, separate from `error`. `describeDirectSendCoverage().recipientGuard` reports `{ environment, active, allowlistCount }`, a count only and never the addresses, and the note says when recipients are captured.
  - **Follow-up:** `components/platform/widgets/OpsEmailDeliveryWidget.tsx` belongs to Session 2, so it is untouched. It does not display `recipientGuard` yet.
  - **Follow-up:** `lib/alerts/run.ts` still reports a guard capture of the platform-alert email as `NO_EMAIL_TRANSPORT`, which is retried next cycle. A distinct `CAPTURED_NONPROD` reason, without retry, would touch the alert reason union, `latest-evaluation.ts` and the Session 2 alerts widget, so it was deferred.
- **Configuration.** `EMAIL_NONPROD_ALLOWLIST` was set on Vercel Preview on 2026-10-31 by Session 1, at the owner's request. It takes effect on the next Preview deploy after merge. It is documented in `.env.example`, and its value is never committed.

## Shared design

Every template below renders through `lib/email/design` (`renderEmail`), which provides:
- one block list for both the HTML part and the plain-text part;
- the logo and wordmark header, and the brass rule;
- a CTA with the fallback link printed under it;
- a footer with the reason line, support contact and legal links (Privacy, Terms, AI & data use);
- dark mode and mobile layouts.

## Previews

- Preview files are `<slug>.html` and `<slug>.txt`, produced by:

  ```
  npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/email-preview.ts --out <dir> [--only <prefixes>]
  ```

- Links carry the non-redeemable token `preview-not-redeemable`.
- Every preview subject starts with `[PREVIEW]`.

## Common links

- **App links** are built from `env.NEXT_PUBLIC_APP_URL` through `lib/email/app-link.ts` or the existing URL builders. They are validated as http(s) and never derived from the request Host.
- **Security page:** `/dashboard/settings/security` is `app/(shell)/dashboard/settings/security/page.tsx`. It covers the password, active sessions and recent activity.
- **Connections page:** `/dashboard/connections` is `app/(shell)/dashboard/connections/page.tsx`. Reconnecting through Plaid Link update mode happens there. There is no per-item reconnect deep link.
- **Notification settings:** `/dashboard/settings/notifications` is `app/(shell)/dashboard/settings/notifications/page.tsx`.

## Token lifetimes

Token lifetimes are single constants in `lib/email/token-ttl.ts`. Each one is read by the route that writes the expiry and by the template copy:
- `PASSWORD_RESET_TTL_MS` (1 h);
- `EMAIL_VERIFICATION_TTL_MS` (1 h);
- `EMAIL_CHANGE_TTL_MS` (1 h).

## 1. Customer-facing emails

| Template | Subject | Trigger (file:line) | Audience | CTA → destination | Token / TTL | Migrated | Preview file |
|---|---|---|---|---|---|---|---|
| `beta-invite` (origin `request`) | Your Fourth Meridian beta access is approved | `lib/platform/growth/invitation-issue.ts:274` via `app/api/platform/growth-revenue/requests/[id]/approve/route.ts` and `…/requests/[id]/resend/route.ts` | applicant | Get Started → `/register?invite=<raw>` | Hashed invite token. Validity comes from the Growth invitation setting (PR #158) and is rendered from `issuedAt`/`expiresAt`. Single-use on redeem. `extend` sends no email. | yes (PR #157, unchanged) | `beta-invite--request--{named,unnamed}--{1,7,14,30}d` |
| `beta-invite` (origin `direct`) | You're invited to the Fourth Meridian beta | `lib/platform/growth/invitation-issue.ts:274` via `app/api/platform/growth-revenue/invitations/route.ts` | any address (operator-entered) | same | same | yes (PR #157) | `beta-invite--direct--…` |
| `password-reset` | Reset your Fourth Meridian password | `app/api/auth/forgot-password/route.ts:82` | account email | Reset password → `/reset-password?token=` | `PASSWORD_RESET_TTL_MS` 1 h. Single-use (conditional consume, `reset-password/route.ts`). Unknown accounts get an identical 200 (unchanged). | yes (security variant) | `password-reset` |
| `security-alert` · `passwordResetCompletedAlert` | Fourth Meridian security alert: Your password was reset | `app/api/auth/reset-password/route.ts:84` | account | none | — | yes | `security-alert--password-reset-completed` |
| `email-verification` | Verify your Fourth Meridian email | `app/api/auth/register/route.ts:372` (uninvited registration only); resend `lib/email/verification.ts:76` (token resend and identifier resend) | new account | Verify email address → `/verify-email?token=` | `EMAIL_VERIFICATION_TTL_MS` 1 h. Idempotent: not cleared on use. Rotated on resend. Identifier resend is a generic 200 (unchanged). | yes (security variant) | `email-verification` |
| `email-change` | Confirm your new Fourth Meridian email | `app/api/user/email/request/route.ts:107` | the NEW address | Confirm new email → `/confirm-email-change?token=` | `EMAIL_CHANGE_TTL_MS` 1 h; not cleared on confirm (unchanged) | yes (security variant) | `email-change--confirm-new-address` |
| `security-alert` · `emailChangeRequestedAlert` | … Email change requested | `app/api/user/email/request/route.ts:113` | the OLD address | none | — | yes (still names the new address, as before) | `security-alert--email-change-old-address` |
| `security-alert` · `passwordChangedAlert` | … Your password was changed | `app/api/user/password/route.ts:87` | account | none | — | yes | `security-alert--password-changed` |
| `security-alert` · `dataExportedAlert` | … Your data was exported | `app/api/user/export/route.ts:63` via `lib/email/send-security-alert.ts` (`sendSecurityAlert` builds the alert inside the non-throwing send) | account | **Review account security → `/dashboard/settings/security`** (verified page) | — | yes; added a CTA and a labelled UTC time; never carries exported data. A malformed app base gives an error result with a fixed message, and the export and its audit row (`emailStatus: "error"`) still complete. | `security-alert--data-exported` |
| `security-alert` · `twoFactorResetAlert` | … Two-factor authentication was reset on your account | `app/api/admin/security/users/[userId]/2fa-reset/route.ts:129` | target user | none | — | yes | `security-alert--two-factor-reset` |
| `security-alert` · `accountDeactivatedAlert` | … Your account was deactivated | `app/api/user/deactivate/route.ts:92` | account | none | — | yes | `security-alert--account-deactivated` |
| `security-alert` · `accountReactivatedAlert` | … Your account was reactivated | `lib/auth.ts:483` | account | none | — | yes | `security-alert--account-reactivated` |
| `security-alert` · `accountDeletionScheduledAlert` | … Your account is scheduled for deletion | `app/api/user/delete/route.ts:117` | account | none | grace period 7 d (`lib/account-deletion/preflight.ts`) | yes | `security-alert--account-deletion-scheduled` |
| `security-alert` · `accountDeletionCancelledAlert` | … Your account deletion was cancelled | `lib/auth.ts:517` | account | none | — | yes | `security-alert--account-deletion-cancelled` |
| `security-alert` · `accountDeletedAlert` | … Your account has been deleted | `lib/account-deletion/purge.ts:520` (injected `email` seam, after commit) | account | none | — | yes | `security-alert--account-deleted` |
| `security-alert` · `ownerSignInAnomalyAlert` | … Unusual sign-in activity on your account | `lib/security/anomaly-alerts.ts:198` | resolved account owner only | Reset your password → `/forgot-password` (no token) | — | yes; the inline link became the CTA, same destination | `security-alert--owner-sign-in-anomaly` |
| `welcome` (new 2026-10-31) | Welcome to Fourth Meridian | `lib/notifications/welcome.ts:68` (`sendWelcome`), called ONCE per account: invited signup at `app/api/auth/register/route.ts:385` (after commit; the account is pre-verified, so no verification email exists); uninvited signup at `app/api/auth/verify-email/route.ts:92` (after the FIRST successful verification; never beside the verification email) | the new account | Open Fourth Meridian → `/dashboard` (no token). Next steps name only real features: Connections (banks, crypto wallets) and shared Spaces (invite by username) | — | design system (default variant); one CTA; footer "one-time email because you created a Fourth Meridian account" | `welcome--named`, `welcome--unnamed` |
| `security-alert` · `platformAccessGrantedAlert` (new 2026-10-31) | … You were given access to {area} / … Your {area} access changed | `lib/notifications/platform-access.ts:94`, called after commit by `app/api/admin/platform-grants/route.ts:185` (create · reinstate · level change; the same-level no-op sends nothing) | the grantee | Open {area} → `/dashboard/platform/{AREA}` | — | security variant; names the area, the level and the grantor's ROLE ("a Fourth Meridian system administrator"), never the grantor's name or address | `security-alert--platform-access-granted`, `security-alert--platform-access-changed` |
| `security-alert` · `platformAccessRemovedAlert` (new 2026-10-31) | … Your access to {area} was removed | `lib/notifications/platform-access.ts:86`, called after commit by `app/api/admin/platform-grants/[grantId]/route.ts:88` (revoke; a non-ACTIVE grant is a 400 and sends nothing) | the former grantee | none | — | security variant | `security-alert--platform-access-removed` |
| `digest` (BUILT, OFF) | Your Fourth Meridian digest: {period} | `lib/notifications/digest.ts:45`, behind `DIGEST_ENABLED = false` (`lib/notifications/digest.ts:24`). **Never sent**: nothing imports or schedules the producer (pinned by `lib/notifications/new-notifications.test.ts` §5) | — | Open Fourth Meridian → `/dashboard`; footer link "Manage notification settings" | — | design system skeleton, pending the owner's digest proposal (O-14) | `digest` |
| `space-invite` | You've been invited to {Space} on Fourth Meridian | `app/api/spaces/[id]/invite/route.ts:165` | existing user | Review invitation → `/dashboard/spaces` | No token: acceptance is identity-gated in-app | yes | `space-invite` |

**One email per Space invite (2026-10-31).** `space-invite` is the invitation's **only** email. The `SPACE_INVITE_RECEIVED` notification, produced by `lib/events/handlers/space-invite-notification.ts` on `MemberInvited` (its only producer), is now **IN_APP only**: registry `defaultChannels: ["IN_APP"]` plus `excludedChannels: ["EMAIL"]`. The dedicated email and when it is sent are unchanged.
- **Preferences cannot bring the duplicate back.** The exclusion beats a `SPACES`/`EMAIL` opt-in in `resolveChannelEnabled` and `isChannelEnabledForUser`.
- **The same opt-in still enables email for the other `SPACES` types.** Those are `SPACE_INVITE_ACCEPTED`, `MEMBER_REMOVED` and the rest; none of them defaults to email.
- **The matrix default for `SPACES`/`EMAIL` is now off.** No `SPACES` type defaults to email.
- **Retry job.** `jobs/retry-notifications.ts` closes a legacy failed `SPACE_INVITE_RECEIVED` EMAIL delivery as `skipped` instead of re-sending it.
- **Preview case removed.** The `notification--space-invite-received` preview case is gone, since that email no longer exists.
- **Tests.** The pinned `t.known` J-D4 in `app/api/spaces/[id]/invite/route.test.ts` is now a check: exactly one email (`space-invite`), one in-app notification and no `NotificationDelivery` row.
| `notification` (all notification types) | the notification title | `lib/notifications/channels/email.ts` (`sendEmail("notification", …)`), reached via `lib/notifications/create.ts` (`adapter.deliver`, at creation, when EMAIL is enabled for the type's category) and **re-delivered** by `jobs/retry-notifications.ts` (`adapter.deliver`, up to 3 attempts total). The retry selects the persisted `metadata` (read only) and recomputes the email-only CTA label through the same registry render (`lib/notifications/action-label.ts`). | notification recipient | registry `href` with registry `actionLabel` (default "View in Fourth Meridian"); footer link "Manage notification settings" → `/dashboard/settings/notifications` | — | yes | see §2 (`SPACE_INVITE_RECEIVED` no longer emails; see `space-invite` above) |

## 2. "Institution needs attention" (`SYNC_FAILED` through `notification`)

Producer: `lib/plaid/sync-notifications.ts` `notifyItemSyncFailed`. Registry: `lib/notifications/registry.ts` `SYNC_FAILED`. Defaults: IN_APP plus EMAIL, `FINANCIAL` category, which the user can turn off, suppress-while-open. All of that is **unchanged**.

**Plaid webhook trigger (new 2026-10-31).** When a verified Plaid webhook moves an item to `NEEDS_REAUTH` (ITEM/ERROR `ITEM_LOGIN_REQUIRED` | `INVALID_ACCESS_TOKEN`) or `REVOKED` (`USER_PERMISSION_REVOKED` | `USER_ACCOUNT_REVOKED`), `lib/plaid/webhook-health.ts:50` calls the same `notifyItemSyncFailed` right after the health write (`lib/plaid/webhook-receiver.ts:246` → `applyWebhookHealthTransition`). No new type and no new email:
- the state is read back from the status the webhook just wrote: `reauth-required` ("{Institution} needs you to sign in again") or `disconnected`;
- the key is the shared `SYNC_FAILED:item:{plaidItemId}:open`, so a webhook, the cron and an interactive sync of the same outage produce ONE notice and ONE email; recovery retires it as before;
- the removed-by-user rule applies: a connection the user removed gets nothing; an item already `REVOKED` is never re-notified (the receiver skips the transition);
- **Escalation (review fix).** When the item is REVOKED while its "sign in again" (or "couldn't sync") notice is still open, the shared key suppresses a new notice, so the open notice is re-rendered IN PLACE to `disconnected` (`lib/notifications/resolve.ts` `refreshOpenNotification`, called from `lib/plaid/sync-notifications.ts`). **No second email** (decision): the email leg ships only when a row is created, an escalation email would need a new delivery path, and the outage's one email already points at the same Connections reconnect. An archived email anchor is never rewritten. The removed-by-user rule runs first, so a removal never escalates.
- `PENDING_EXPIRATION` / `PENDING_DISCONNECT` still move no state and send nothing (catalogued as BUILD: `PLAID_ITEM_PENDING_EXPIRATION`). The two v1 catalog keys `PLAID_ITEM_REAUTH_REQUIRED` and `PLAID_ITEM_REVOKED` are RETIRED tombstones: the notice records under `SYNC_FAILED`.

### How the state is derived

- Every call site writes the health-classified `PlaidItem.status` (`setPlaidItemHealth`) before calling the producer.
- The producer now reads that `status` back from the row it already reads, and adds a typed `connectionState` to the payload (`lib/notifications/connection-attention.ts`).
- **No call site was edited.**

| Call site | What it observes | Status written | `connectionState` it can produce |
|---|---|---|---|
| `jobs/sync-banks.ts:333` (cron) | `classifyPlaidErrorForHealth(e)` ≠ null | NEEDS_REAUTH (ITEM_LOGIN_REQUIRED, INVALID_ACCESS_TOKEN) or ERROR (any other non-transient code) | `reauth-required`, `sync-failed` |
| `lib/plaid/refresh.ts:807` (refreshAllActiveItemsForUser) | same | same | `reauth-required`, `sync-failed` |
| `lib/plaid/backgroundHistorySync.ts:657` (deferred history) | same | same | `reauth-required`, `sync-failed` |
| `app/api/plaid/refresh/route.ts:150` | same | same | `reauth-required`, `sync-failed` |
| `app/api/plaid/investments/enable/route.ts:153` | same | same | `reauth-required`, `sync-failed` |
| `app/api/platform/platform-ops/connections/[id]/resync/route.ts:175` | same | same | `reauth-required`, `sync-failed` |
| `app/api/platform/platform-ops/connections/[id]/request-reauth/route.ts:71` | operator request; REVOKED items are refused (409) | NEEDS_REAUTH | `reauth-required` |
| Any call site above, when the user removed the connection while that sync was in flight | late failure for an already-REVOKED item; its ERROR write is dropped (`lib/connections/health-transitions.ts`) | REVOKED, or ERROR / NEEDS_REAUTH if the sync failed between the soft-delete and the REVOKED write; every AccountConnection soft-deleted | **none: suppressed in every state** (owner decision 2026-10-31, below) |
| Any call site above, after a provider-side revocation | late failure for an item the webhook marked REVOKED (USER_PERMISSION_REVOKED / USER_ACCOUNT_REVOKED); connections stay live | REVOKED | `disconnected` |
| Plaid webhook (`lib/plaid/webhook-receiver.ts`, `lib/plaid/webhook-health.ts`, `lib/plaid/webhook-sync.ts`) | NEEDS_REAUTH / REVOKED transitions | — | **none: the webhook itself does not notify** (gap, unchanged) |

### Copy and CTA by state

| State | Title | Body | CTA |
|---|---|---|---|
| `sync-failed` (the conservative default: ERROR, ACTIVE, missing or unknown) | We couldn't sync {Institution} | Your existing data is still available. Review the connection in Fourth Meridian to see what's needed. | Review connection → `/dashboard/connections` |
| `reauth-required` (NEEDS_REAUTH) | {Institution} needs you to sign in again | To keep your accounts up to date, sign in to {Institution} again from Fourth Meridian. Until then, new data from {Institution} can't sync. | Reconnect {Institution} → `/dashboard/connections` |
| `disconnected` (REVOKED) | {Institution} is disconnected | Fourth Meridian can no longer sync {Institution}. Reconnect it to resume updates. | Reconnect → `/dashboard/connections` |

### States deliberately NOT produced

- **"Temporary, we'll retry automatically."** Transient codes (ITEM_LOCKED, INSTITUTION_DOWN, PRODUCT_NOT_READY, 429 …) classify to null and never notify. An ERROR item is excluded from the cron, which selects `status: ACTIVE` only (`jobs/sync-banks.ts`). The default copy therefore makes **no** retry promise.
- **"Stale"** (no successful sync for N). No producer observes it.
- **`disconnected` is produced only after a provider-side revocation.** The user-initiated removal race is suppressed (next section).

### Owner decision 2026-10-31: a connection the user removed sends no sync-failure notification of any kind

If a user removes a connection themselves, a failing sync for it sends **no** email and **no** in-app notification, **in any state**. That covers both "{Institution} is disconnected" and "We couldn't sync {Institution}".

`disconnectPlaidItemIfOrphaned` soft-deletes the connections, then calls `itemRemove`, then writes REVOKED. A sync failing inside that window writes ERROR or NEEDS_REAUTH, so the check runs for every status.

REVOKED has two live writers:
- **`lib/plaid/disconnect.ts` `disconnectPlaidItemIfOrphaned`: removal on our side.** It runs only once every AccountConnection on the item has `deletedAt` set. That covers the user's account removal (`lib/accounts/disconnect.ts`) and the cleanup, self-heal and supersede paths that act on an already-orphaned item.
- **The Plaid webhook `USER_PERMISSION_REVOKED` / `USER_ACCOUNT_REVOKED` (`lib/plaid/webhook-receiver.ts`): provider-side revocation.** It leaves the connections live.

`lib/account-deletion/purge.ts` also writes REVOKED, but the user row is deleted at the end of the purge.

**Rule** (`removedByUser` in `lib/plaid/sync-notifications.ts`, before `createNotification`):
- **Suppressed:** any status with **zero live and at least one soft-deleted** AccountConnection. This marker already exists, so no migration is needed.
- **Recording:** the suppression is a log line with the item id, the status and the reason, and no PII. Nothing is created, so dedupe and retire are unaffected.
- **Fails open:** if the connection count throws, the notification **still goes out**. The warning logs only the item id and the error class.

**Still notifies, with its normal state copy:**
- any status with at least one live connection, including a provider revocation, which gets the `disconnected` copy;
- any status with no connection rows at all (no evidence of a removal).

**Residual (conservative by design):** a removal path might orphan an item without soft-deleting its connection rows, for example by re-pointing them to a replacement item. I have not verified whether any path does. Such an item has no connection rows, so a late failure on it would still notify `disconnected`.

### Retry path

- `jobs/retry-notifications.ts` re-sends a failed EMAIL delivery from the persisted row: title, body and href.
- The CTA label is email-only and never persisted, so the retry recomputes it with `recomputeActionLabel(type, metadata)`. That function runs the same registry render over the persisted `metadata` (the producer's data, including `connectionState`).
- If no state can be derived (legacy rows, unknown value, null metadata), the label is the conservative "Review connection".
- Nothing new is written.

### Dedupe keeps the first copy (by design)

- Suppress-while-open dedupe (`SYNC_FAILED:item:{id}:open`) can keep the generic copy when a later reauth occurs. An item first notified as `sync-failed` (ERROR) that later needs reauth produces no second notification while the first is open, so the live row and any retry keep the `sync-failed` copy.
- This behaviour is unchanged by design: no new trigger, no dedupe change.

### Fallback and preview cases

- Rows written before this PR carry no state, and so does any unknown value. Both render `sync-failed`, never `disconnected`.
- The footer reads: "You're receiving this connection notification because email is turned on for Financial notifications. You can change this in notification settings." It is followed by the settings link.
- There are no account numbers or balances.
- Previews:
  - `notification--connection-sync-failed`
  - `notification--connection-reauth-required`
  - `notification--connection-disconnected`
  - `notification--connection-legacy-no-state`

### Follow-ups (payload changes NOT made here)

- **Distinguishing "institution no longer supported" from other ERROR codes.** `PlaidItem.errorCode` is on the row, so the producer could read it later without touching call sites.
- **Closed 2026-10-31: notifying from the webhook on NEEDS_REAUTH and REVOKED** (see "Plaid webhook trigger" above).

## 2b. Wallet sync failure (`WALLET_SYNC_FAILED` through `notification`, new 2026-10-31)

Producer: `lib/crypto/wallet-sync-notifications.ts:172` (`evaluateWalletSyncAttention`), called once per real attempt from `lib/crypto/wallet-sync-dispatch.ts:698` (`syncWalletByChain`, after `runFullRefresh`) — scheduled sweep, manual sync, Refresh All and wallet create alike. Registry `WALLET_SYNC_FAILED`, `FINANCIAL`, consent SERVICE.
- **Sustained only.** Notifies when this attempt failed AND it belongs to an unbroken run of FAILED sync attempts whose first failed attempt started at least 24 h ago (`WALLET_SYNC_SUSTAINED_HOURS`). The run comes from the per-attempt ledger every wallet sync writes (`RefreshExecution`, `sourceKind` WALLET, `sourceRef` = the account): the first FAILED attempt after the latest SUCCEEDED / PARTIAL one. Any successful attempt resets it, including one that leaves a Connection code (BTC `NO_USED_ADDRESSES`); SKIPPED attempts are neither. (Review fix: the Connection's DEGRADED-since time was the wrong clock — a degraded period can consist of successful syncs.) No failed attempt on record ⇒ no notice.
- **Real states** (`lib/notifications/wallet-attention.ts`, from this attempt's code and the Connection's, where BTC keeps `INVALID_XPUB`): `temporary` ("We haven't been able to update {wallet}" — still connected, retrying) or `needs-attention` (invalid address / extended key). Never "disconnected". Platform-side codes (`PROVIDER_NOT_CONFIGURED`, `CHAIN_UNSUPPORTED`) never notify.
- **Suppressed** for a wallet the user removed (`FinancialAccount.deletedAt`, re-read at notify time) and under the global Cost Freeze (re-read; unreadable = frozen). A freeze or plan SKIP never reaches the producer at all: every gate runs before `syncWalletByChain`.
- **Dedupe / release:** `WALLET_SYNC_FAILED:account:{financialAccountId}:open`; a clean successful sync retires it (`lib/crypto/wallet-sync-notifications.ts:161`).
- **Channels:** IN_APP by default; EMAIL is opt-in via the FINANCIAL email preference and, as for `SYNC_FAILED` (O-7), follows only that preference. Email default is off because a provider outage hits every wallet on a chain at once.
- Previews: `notification--wallet-temporary`, `notification--wallet-needs-attention`. The notice carries the account label and network name, never the address.

## 3. Operator / internal emails (minimal internal variant: same shell, no customer guidance)

| Template | Subject | Trigger (file:line) | Audience | CTA → destination | Token / TTL | Migrated | Preview file |
|---|---|---|---|---|---|---|---|
| `beta-request` | New beta access request: {email} | `app/api/access-request/route.ts:151` (skipped when `BETA_REQUESTS_EMAIL` is unset) | `BETA_REQUESTS_EMAIL` | Open Beta Access queue → `/dashboard/platform/GROWTH_REVENUE` | — | yes; the same PII as before (applicant email plus note). `cleanText` stops the note from forging lines. | `beta-request--with-note`, `beta-request--no-note` |
| `platform-alert` | Fourth Meridian platform alert: N issue(s) (…) | `lib/alerts/run.ts:170` | `PLATFORM_ALERTS_EMAIL` | none (copy names Platform Operations → Alerts, as before) | — | yes; the evaluation time is now labelled UTC | `platform-alert` |
| `security-alert` · `securityOpsAnomalyAlert` (audience `internal`) | Fourth Meridian security alert: {anomaly title} | `lib/security/anomaly-alerts.ts:190` | `SECURITY_ALERTS_EMAIL` | none | — | yes. **The raw login identifier or IP was removed** from the `Signal:` line, which now shows only the signal kind. The value stays on the audit row (`metadata.key`) and the in-app Security Ops notification (`anomalyKey`). | `security-alert--security-ops-anomaly` |
| `smoke` | Fourth Meridian email pipeline check | **no production caller** (grep) | — | none | — | yes | `smoke` |

## 4. Emails that do NOT exist (no trigger invented)

| Email | Status | Evidence |
|---|---|---|
| Beta **denial** | Does not exist, deliberately (silent denial) | `app/api/platform/growth-revenue/requests/[id]/deny/route.ts` header |
| Plaid webhook **PENDING_EXPIRATION** / PENDING_DISCONNECT | Approved, not built (`PLAID_ITEM_PENDING_EXPIRATION`, BUILD): the item still syncs until the date, so the shared `SYNC_FAILED` open key would be retired by the next successful sync | `lib/plaid/webhook-receiver.ts` FIN-007 header |

Removed from this list on 2026-10-31 (now built): the welcome (`welcome`, §1), the digest (`digest`, built OFF, §1), Platform access granted / removed (§1), wallet sync failure (§2b) and the Plaid webhook reauth / revoked notice (§2).

## 5. Known gaps

- Suppress-while-open dedupe can keep the generic copy when a later reauth occurs (§2).
- `scripts/email-preview.ts` passes a variable template name to `sendEmail`. It sends only the preview cases, only to the exact `EMAIL_PREVIEW_ALLOWED_TO` address, and only with `--send`. `lib/email/catalog.test.ts` declares it in `VARIABLE_NAME_SENDERS`.

- **No provider idempotency key.** "Sent" means accepted by the provider. Retries exist only for notification EMAIL deliveries (`jobs/retry-notifications.ts`).
- **Closed 2026-10-31: two emails per Space invite.** See "One email per Space invite" under `space-invite` in §1.
- **Closed 2026-10-31: no Preview recipient allowlist in `send.ts`** (audit §1.5). See "Non-production recipient guard".
