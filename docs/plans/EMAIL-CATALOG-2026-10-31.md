# Email catalog — 2026-10-31

This catalog lists every email-sending path in the repository, as of PR D ("Email: migrate all transactional emails to the branded design system + catalog").

## How the inventory was built

- Re-grepped `sendEmail(`, purge's injected `email(` seam, `sendNotificationEmail` (no hits), the provider layer and any direct Resend use.
- Resend is imported only in `lib/email/providers/resend.ts`; nothing else imports the SDK.
- Every send goes through `lib/email/send.ts`.
- `lib/email/catalog.test.ts` greps the same call sites and fails if a template, a sending file or a security-alert builder is missing from this document or from `previewCases()`.

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
| `email-verification` | Verify your Fourth Meridian email | `app/api/auth/register/route.ts:371` (uninvited registration only); resend `lib/email/verification.ts:76` (token resend and identifier resend) | new account | Verify email address → `/verify-email?token=` | `EMAIL_VERIFICATION_TTL_MS` 1 h. Idempotent: not cleared on use. Rotated on resend. Identifier resend is a generic 200 (unchanged). | yes (security variant) | `email-verification` |
| `email-change` | Confirm your new Fourth Meridian email | `app/api/user/email/request/route.ts:107` | the NEW address | Confirm new email → `/confirm-email-change?token=` | `EMAIL_CHANGE_TTL_MS` 1 h; not cleared on confirm (unchanged) | yes (security variant) | `email-change--confirm-new-address` |
| `security-alert` · `emailChangeRequestedAlert` | … Email change requested | `app/api/user/email/request/route.ts:113` | the OLD address | none | — | yes (still names the new address, as before) | `security-alert--email-change-old-address` |
| `security-alert` · `passwordChangedAlert` | … Your password was changed | `app/api/user/password/route.ts:87` | account | none | — | yes | `security-alert--password-changed` |
| `security-alert` · `dataExportedAlert` | … Your data was exported | `app/api/user/export/route.ts:61` | account | **Review account security → `/dashboard/settings/security`** (verified page) | — | yes; added a CTA and a labelled UTC time; never carries exported data | `security-alert--data-exported` |
| `security-alert` · `twoFactorResetAlert` | … Two-factor authentication was reset on your account | `app/api/admin/security/users/[userId]/2fa-reset/route.ts:129` | target user | none | — | yes | `security-alert--two-factor-reset` |
| `security-alert` · `accountDeactivatedAlert` | … Your account was deactivated | `app/api/user/deactivate/route.ts:92` | account | none | — | yes | `security-alert--account-deactivated` |
| `security-alert` · `accountReactivatedAlert` | … Your account was reactivated | `lib/auth.ts:483` | account | none | — | yes | `security-alert--account-reactivated` |
| `security-alert` · `accountDeletionScheduledAlert` | … Your account is scheduled for deletion | `app/api/user/delete/route.ts:117` | account | none | grace period 7 d (`lib/account-deletion/preflight.ts`) | yes | `security-alert--account-deletion-scheduled` |
| `security-alert` · `accountDeletionCancelledAlert` | … Your account deletion was cancelled | `lib/auth.ts:517` | account | none | — | yes | `security-alert--account-deletion-cancelled` |
| `security-alert` · `accountDeletedAlert` | … Your account has been deleted | `lib/account-deletion/purge.ts:520` (injected `email` seam, after commit) | account | none | — | yes | `security-alert--account-deleted` |
| `security-alert` · `ownerSignInAnomalyAlert` | … Unusual sign-in activity on your account | `lib/security/anomaly-alerts.ts:198` | resolved account owner only | Reset your password → `/forgot-password` (no token) | — | yes; the inline link became the CTA, same destination | `security-alert--owner-sign-in-anomaly` |
| `space-invite` | You've been invited to {Space} on Fourth Meridian | `app/api/spaces/[id]/invite/route.ts:165` | existing user | Review invitation → `/dashboard/spaces` | No token: acceptance is identity-gated in-app | yes | `space-invite` |
| `notification` (all notification types) | the notification title | `lib/notifications/channels/email.ts` (`sendEmail("notification", …)`), reached only via `createNotification` when EMAIL is enabled for the type's category | notification recipient | registry `href` with registry `actionLabel` (default "View in Fourth Meridian"); footer link "Manage notification settings" → `/dashboard/settings/notifications` | — | yes | see §2 and `notification--space-invite-received` |

## 2. "Institution needs attention" (`SYNC_FAILED` through `notification`)

Producer: `lib/plaid/sync-notifications.ts` `notifyItemSyncFailed`. Registry: `lib/notifications/registry.ts` `SYNC_FAILED`. Defaults: IN_APP plus EMAIL, `FINANCIAL` category, which the user can turn off, suppress-while-open. All of that is **unchanged**.

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
| Plaid webhook (`lib/plaid/webhook-receiver.ts`, `lib/plaid/webhook-health.ts`, `lib/plaid/webhook-sync.ts`) | NEEDS_REAUTH / REVOKED transitions | — | **none: the webhook does not notify** (gap, unchanged) |

### Copy and CTA by state

| State | Title | Body | CTA |
|---|---|---|---|
| `sync-failed` (the conservative default: ERROR, ACTIVE, missing or unknown) | We couldn't sync {Institution} | Your existing data is still available. Review the connection in Fourth Meridian to see what's needed. | Review connection → `/dashboard/connections` |
| `reauth-required` (NEEDS_REAUTH) | {Institution} needs you to sign in again | To keep your accounts up to date, sign in to {Institution} again from Fourth Meridian. Until then, new data from {Institution} can't sync. | Reconnect {Institution} → `/dashboard/connections` |
| `disconnected` (REVOKED) | {Institution} is disconnected | Fourth Meridian can no longer sync {Institution}. Reconnect it to resume updates. | Reconnect → `/dashboard/connections` |

### States deliberately NOT produced

- **"Temporary, we'll retry automatically."** Transient codes (ITEM_LOCKED, INSTITUTION_DOWN, PRODUCT_NOT_READY, 429 …) classify to null and never notify. An ERROR item is excluded from the cron, which selects `status: ACTIVE` only (`jobs/sync-banks.ts`). The default copy therefore makes **no** retry promise.
- **"Stale"** (no successful sync for N). No producer observes it.
- **`disconnected`**. The copy exists and is truthful, but no call site produces a REVOKED status before notifying today.

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
- **Notifying from the webhook on NEEDS_REAUTH and REVOKED.** That is a new trigger, so it is out of scope.

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
| **Welcome** / registration complete | Does not exist. Invited signups get no email at all. | `app/api/auth/register/route.ts` (verification is sent only on the uninvited path) |
| **Digest** | `DIGEST_SENT` is EMAIL-only but `status: "VOCABULARY"`, with no producer | `lib/notifications/registry.ts` `DIGEST_SENT` |
| **Platform Spaces** grants / invitations | No email: the route contains no `sendEmail` or `createNotification` | `app/api/admin/platform-grants/route.ts` |
| Wallet sync failure | No notification and no email | audit §2 row 8 |
| Plaid webhook reauth / revoked | No notification and no email (see §2) | `lib/plaid/webhook-receiver.ts` |

## 5. Known gaps (unchanged by this PR)

- **Two emails per Space invite (inferred).** The invitee gets `space-invite` (direct) plus `notification` for `SPACE_INVITE_RECEIVED`.
- **No retries or provider idempotency key.** "Sent" means accepted by the provider.
- **No Preview recipient allowlist or sandbox in `send.ts`** (audit §1.5).
