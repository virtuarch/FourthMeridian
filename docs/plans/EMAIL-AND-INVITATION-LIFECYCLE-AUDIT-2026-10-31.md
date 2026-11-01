# Email and Beta Invitation Lifecycle Audit (2026-10-31)

**Scope.** This is a read-only audit of Fourth Meridian's transactional email system and beta invitation lifecycle. It covers the worktree `/Users/chrstn/dev/FM-email` at `develop` `bf6b797` (branch `feat/email-invite-audit`).
**Method.** The findings come from static reading of the code. No code was edited, no database or network was touched, no email was sent, and no tsc, test suite or build was run. Every fact cites `file:line`. Anything inferred rather than read directly is marked **INFERRED**. Anything that needs a live environment to confirm is marked **UNVERIFIED**.

---

## 1. Email infrastructure

### 1.1 Provider and pipeline

| Aspect | Fact | Evidence |
|---|---|---|
| Provider | **Resend**. The SDK is imported in exactly one file. | `lib/email/providers/resend.ts:4,23` |
| Chokepoint | Every sender calls `sendEmail(name, to, data)`, which renders the template, resolves the sender, selects a transport and sends. | `lib/email/send.ts:49-68` |
| Transport selection | `NODE_ENV==="test"` → capture. If `RESEND_API_KEY` is set → Resend. Otherwise → capture. | `lib/email/send.ts:33-39` |
| Capture transport | An unbounded in-memory array holds each full message, including bodies that contain raw tokens. The accessor functions (`capturedEmails`/`lastCapturedEmail`) have no non-test caller (grep). | `lib/email/providers/capture.ts:19-38` |
| Message shape | `{to, from, replyTo?, subject, text}`. **There is no `html` field.** | `lib/email/types.ts:24-35` |
| Resend call | Sends `from, to, subject, text, replyTo?`. It sets no `html`, no idempotency key, no tags and no headers. | `lib/email/providers/resend.ts:57-63` |
| Error contract | Non-throwing. It always returns `{status: sent|captured|skipped|error}`. | `lib/email/types.ts:47-55`; `resend.ts:47-75` |
| Template registry | 10 names: smoke, password-reset, email-verification, space-invite, security-alert, email-change, notification, beta-invite, beta-request, platform-alert. | `lib/email/types.ts:76-86`; `lib/email/templates/index.ts:28-39` |
| `smoke` template | Registered, but no production caller (grep for `"smoke"` finds no sender). | `lib/email/templates/smoke.ts:20-33` |

### 1.2 From and Reply-To configuration

- **Per-purpose From addresses are hard-coded** rather than set by env. `support@fourthmeridian.com` is used for smoke, reset, verification, space-invite, security-alert and platform-ops. `notifications@` is used for product-notification. `Fourth Meridian Beta <beta@…>` is used for beta-invite (`lib/email/senders.ts:32-52`).
- **`EMAIL_FROM_DEFAULT`** (env name) overrides the From for every purpose when it is set (`lib/email/send.ts:61`; `lib/env.ts:83,637`). Setting it collapses the beta@ and notifications@ identities.
- **Reply-To is never set.** No `SENDER_IDENTITIES` entry carries `replyTo` (`lib/email/senders.ts:32-52`). The plumbing exists (`send.ts:62`, `resend.ts:62`).
- Recipient env names: `SECURITY_ALERTS_EMAIL` defaults to `security@fourthmeridian.com` (`lib/env.ts:88,642`). `PLATFORM_ALERTS_EMAIL` has no default and is required in a production deployment (`lib/env.ts:100,337,645`). `BETA_REQUESTS_EMAIL` has no default, and the intake email is skipped when it is unset (`lib/env.ts:108,649`; `app/api/access-request/route.ts:149`).
- Link base: `NEXT_PUBLIC_APP_URL` defaults to `http://localhost:3000` (`lib/env.ts:608`) and is required in production (`lib/env.ts:318`). `RESEND_API_KEY` is also production-required (`lib/env.ts:319`).

### 1.3 Retry and idempotency

- **There are no retries anywhere.** Each send is a single attempt. `NotificationDelivery.attempts` is always 1 ("retries are OPS-4", `lib/notifications/create.ts:206-212,252`).
- **No provider idempotency key is used** (`resend.ts:57-63`). Idempotency exists only at the domain level, through conditional writes: approve (`approve/route.ts:73-91`), reset consumption (`reset-password/route.ts:61-74`) and invite redemption (`lib/registration-policy.ts:132-141`). Resend and direct-invite have no conditional write (§3.7).

### 1.4 Logging

- Senders log only the provider error string: `console.error("[…] … failed to send:", emailResult.error)`. Examples are `forgot-password/route.ts:82`, `approve/route.ts:100`, `resend/route.ts:69`, `invitations/route.ts:92`, `register/route.ts:372` and `spaces/[id]/invite/route.ts:172`. Purge redacts its error (`lib/account-deletion/purge.ts:527`).
- **No log line contains a token, a link or a recipient address.** A grep for `console.*(…inviteUrl|resetUrl|verifyUrl|confirmUrl|rawToken|.email…)` over `app/` and `lib/` found no hit beyond the `.error` lines above. **INFERRED:** a Resend validation error message could echo the recipient address into the log line (UNVERIFIED).
- Audit rows store `emailHash` (digest), never the address. Examples: `approve/route.ts:110`, `forgot-password/route.ts:89`, `access-request/route.ts:141`.
- **Two exceptions to "no PII in email bodies":**
  - The Security Ops email carries `Signal: ${anomaly.key}` (`lib/security/anomaly-alerts.ts:189`). The key is `identifier:<raw login identifier>` or `ip:<ip>` (`lib/security/anomalies.ts:105,145`).
  - The beta intake email carries the applicant's email and their free-text note (`lib/email/templates/beta-request.ts:32-37`).

### 1.5 Dev and Preview behaviour

- In dev with no key, emails are captured and never sent (`send.ts:37-38`). `forgot-password` additionally returns `resetUrl` in the response when `NODE_ENV!=="production"` and the status is not `sent` (`app/api/auth/forgot-password/route.ts:98-106`).
- **On Preview, real email goes out exactly when `RESEND_API_KEY` is present in that Vercel environment.** `send.ts` has no `VERCEL_ENV` awareness, no recipient allowlist and no sandbox redirect (`send.ts:33-39`). The boot check requires the key only when `VERCEL_ENV==="production"` (`lib/env.ts:306-320`).
- Whether Preview carries the key is **UNVERIFIED**. It is recorded as "Unknown / Owner check" in `docs/plans/PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md:747`, and remediation doc 16 recommends removing it from generic Preview (`docs/audits/pre-beta-2026-10/remediation/16-PREVIEW-REHEARSAL-AND-APPROVALS.md:153`).

### 1.6 Email-health monitoring

- `getEmailDeliveryHealth()` counts only `NotificationDelivery` rows where `channel="EMAIL"` (`lib/platform/email-health.ts:58-88`).
- All direct `sendEmail` legs bypass that ledger: password-reset, email-verification, email-change, space-invite, beta-invite, beta-request, security-alert and platform-alert. They are listed as declared coverage only, with the transport inferred from config (`lib/platform/email-health.ts:92-127`).
- No delivery, bounce or complaint webhook is ingested, so "sent" means accepted by the provider (`email-health.ts:26-34`).
- Beta invite outcomes are visible only through `metadata.emailStatus` on audit rows (`app/api/platform/growth-revenue/requests/route.ts:110-128`).

---

## 2. Inventory of email types

**Common to every row below:**
- All emails are **plain text only**. There is no HTML part, so a "plain-text alternative" is not applicable: the text is the only part (`types.ts:24-35`; `resend.ts:57-63`).
- **Branding** is limited to "Fourth Meridian" in the From display name and in the copy. There is no logo, no footer, no postal address and no legal or privacy links.
- Every link is built from `env.NEXT_PUBLIC_APP_URL`, never from the request Host. Examples: `lib/email/beta-invite-url.ts:14-25`, `reset-url.ts:8-27`.
- Every token is `crypto.randomBytes(32)` hex, stored as SHA-256 (`lib/password-reset-token.ts:20-24`).

| # | Email | Trigger (file:line) | Template | Recipient | Link → target | Token / TTL / single-use | Enumeration safety of trigger |
|---|---|---|---|---|---|---|---|
| 1 | **Beta approval invitation** | `POST …/requests/[id]/approve` `app/api/platform/growth-revenue/requests/[id]/approve/route.ts:98` | `templates/beta-invite.ts` | applicant | `/register?invite=<raw>` (`beta-invite-url.ts:22-25`) | hashed invite token; **14 d** (`approve/route.ts:37,68`); single-use on redeem (`registration-policy.ts:132-141`) | operator-only (GROWTH_REVENUE WRITE) |
| 1b | Beta invite **resend** | `…/requests/[id]/resend/route.ts:67` | same | applicant | same | rotates the token and resets to **14 d** (`resend/route.ts:32,55-64`) | operator-only |
| 1c | **Direct operator invite** | `POST …/growth-revenue/invitations` `invitations/route.ts:90` | same | any address | same | **default 7 d, operator 1–30 d** (`invitations/route.ts:33-34,48-50`) | operator-only; returns a 409 that reveals "already has an account" to the operator (`:53-56`) |
| 2 | Beta request intake (operator) | `POST /api/access-request` `app/api/access-request/route.ts:151` | `templates/beta-request.ts` | `BETA_REQUESTS_EMAIL` | `/dashboard/platform/GROWTH_REVENUE` (`:150`) | none | public route gives an identical 200 (`:161-165`). The email is sent **on every submission, including repeats** (no dedupe), rate-limited 5 per 15 min per IP (`:63`) |
| 3 | Space member invitation | `POST /api/spaces/[id]/invite` `app/api/spaces/[id]/invite/route.ts:165` | `templates/space-invite.ts` | existing user | `/dashboard/spaces` (`invite-url.ts:17-19`) | **no token**; acceptance is identity-gated in-app. `SpaceInvite.expiresAt` exists (`schema.prisma:657`) but is never written (only writer is the upsert at `invite/route.ts:129-152`) and never checked at accept (`invites/[inviteId]/route.ts:97`) | authenticated OWNER/ADMIN only. A 404 "No user found with that username" reveals username existence to members (`invite/route.ts:96-98`) |
| 3b | Space invite (notification copy) | EV-1 handler → `SPACE_INVITE_RECEIVED`, default channels IN_APP+EMAIL (`lib/notifications/registry.ts:304-308`; `lib/events/handlers/space-invite-notification.ts:52`) | `templates/notification.ts` | invitee | `/dashboard/spaces` | none | **INFERRED: invitee gets two emails per invite** (rows 3 and 3b) |
| — | Platform Spaces invitations / grants | `POST /api/admin/platform-grants` | — | — | — | — | **DOES NOT EXIST as an email.** That route contains no `sendEmail` or `createNotification` (grep) |
| 4 | Password reset | `POST /api/auth/forgot-password` `forgot-password/route.ts:80` | `templates/password-reset.ts` | account email | `/reset-password?token=` | `passwordResetToken` (`schema.prisma:362-363`); **1 h** (`:31`); single-use via conditional consume (`reset-password/route.ts:61-74`) | identical 200 for unknown accounts (`:55-62`). **INFERRED:** a timing difference exists, since a known account does a DB write and a provider call first |
| 4b | "Your password was reset" | `reset-password/route.ts:84` | security-alert | account | none | — | post-consumption |
| 5 | Email verification | register (uninvited only) `app/api/auth/register/route.ts:368-370`; resend `lib/email/verification.ts:75` | `templates/email-verification.ts` | new account | `/verify-email?token=` | `emailVerificationToken` (`schema.prisma:373-374`); **1 h** (`register:48`, `verification.ts:34`); **not cleared on use** by design (idempotent; `verify-email/route.ts:7-13,70-75`); rotated on resend | identifier resend always returns a generic 200 (`verify-email/resend/route.ts:41-56`); token resend is precise (`:59-71`) |
| 6 | Email change confirm (to the NEW address) + alert (to the OLD address) | `app/api/user/email/request/route.ts:107,113` | `email-change.ts` + security-alert | new + old | `/confirm-email-change?token=` | `emailChangeToken`; **1 h** (`:32`); not cleared on confirm (`confirm/route.ts:17`) | authenticated |
| 7 | **2FA reset (admin)** | `app/api/admin/security/users/[userId]/2fa-reset/route.ts:129` | security-alert | target user | none | — | SYSTEM_ADMIN + live TOTP |
| 8 | **Institution disconnected / reconnect** | Exists **only as the generic notification email** for `SYNC_FAILED` ("X needs attention … Reconnect"), default IN_APP+EMAIL, deduped suppress-while-open (`registry.ts:378-399`). Producer: `lib/plaid/sync-notifications.ts:85-110`. Call sites: `jobs/sync-banks.ts:333`, `lib/plaid/refresh.ts:807`, `lib/plaid/backgroundHistorySync.ts:657`, `app/api/plaid/refresh/route.ts:150`, `app/api/plaid/investments/enable/route.ts:153`, platform-ops resync/request-reauth (`…/request-reauth/route.ts:71`, `…/resync/route.ts:175`) | `notification.ts` | item owner | `/dashboard/connections` | none | n/a. **Gaps:** there is no dedicated template. Plaid **webhook** NEEDS_REAUTH/REVOKED transitions do not notify (`lib/plaid/webhook-receiver.ts:239-251`; no notify in `lib/plaid/webhook-health.ts`). Wallet sync failures do not notify. The user can switch the email off (FINANCIAL `locked:false`, `registry.ts:90-95`). The email is also skipped when IN_APP is off (`create.ts:323-326`) |
| 9 | Security anomaly (Security Ops inbox) | `lib/security/anomaly-alerts.ts:187` | security-alert | `SECURITY_ALERTS_EMAIL` | none | — | internal; contains the raw identifier/IP in the `Signal:` line (§1.4) |
| 9b | Security anomaly (account owner) | `anomaly-alerts.ts:197-207` | security-alert | resolved owner only | `/forgot-password` (no token) | — | sent only for a resolvable account (`:196`) |
| 10 | Account deletion scheduled / cancelled / completed | `app/api/user/delete/route.ts:116`; `lib/auth.ts:520`; `lib/account-deletion/purge.ts:519` | security-alert | account | none | grace **7 d** (`lib/account-deletion/preflight.ts:25`) | authenticated; purge sends after commit, exactly once (`purge.ts:515-517`) |
| 11 | Deactivated / reactivated / password changed / data exported | `app/api/user/deactivate/route.ts:92`; `lib/auth.ts:483`; `app/api/user/password/route.ts:87`; `app/api/user/export/route.ts:60` | security-alert | account | none | — | authenticated |
| 12 | Platform alerts | `lib/alerts/run.ts:170` (destination `env.PLATFORM_ALERTS_EMAIL`, `:165-167`) | `templates/platform-alert.ts` | operator inbox | none (copy says "Open Platform Operations → Alerts") | — | internal |
| — | Digest | `DIGEST_SENT` is EMAIL-only but `status:"VOCABULARY"` (`registry.ts:636-650`) | — | — | — | — | **NOT WIRED** (no producer) |
| — | Beta **denial** email | — | — | — | — | — | **DOES NOT EXIST**, deliberately (`deny/route.ts:4-7`) |
| — | Welcome / registration-complete email | — | — | — | — | — | **DOES NOT EXIST.** Invited signups get no email at all (`register/route.ts:365-368`) |

---

## 3. Beta invitation lifecycle, end to end

### 3.1 Flow

1. **Marketing site.** `site/app/request-access/page.tsx:15-29` has no form and no API. It hands off through `AppLink` to the app's `/request-access` (`site/lib/public-config.ts:141`), carrying utm/ref.
2. **App form.** `components/marketing/RequestAccessForm.tsx:88` posts `{email, note, captchaToken, source, consent}` to `/api/access-request`. The privacy notice version is `2026-10-22` (`components/marketing/access-request-consent.ts:12`).
3. **Intake.** In `app/api/access-request/route.ts`:
   - The IP rate limit is 5 per 15 min (`:63`).
   - `consent===true` is required (`:78-80`).
   - CAPTCHA is env-gated (`:86-89`).
   - The email is normalised to lowercase and trimmed (`:91`).
   - `createMany … skipDuplicates`, so one row per email; a repeat never resets status (`:112-115`).
   - One `BetaAccessRequestEvent` row is written per submission (`:127-129`).
   - A `BETA_ACCESS_REQUESTED` audit row records the hash, ip and UA (`:132-143`).
   - The operator email is sent (`:149-159`).
   - The response is identical every time (`:162-165`).
4. **Review.** `GET …/requests` returns up to 100 PENDING (oldest first) and 100 APPROVED (newest invited first), plus counts (`requests/route.ts:76-93`). Each row is enriched with submission counts and the first source (`:97-118`) and the last invite email status from audit (`:110-128`).
5. **Approve** (§3.6), which mints and emails the invite.
6. **Email** (§2 row 1).
7. **Redemption.** `/register?invite=` is read by `app/(auth)/register/page.tsx:36`. The page validates through `/api/registration-policy` (`:77`; rate-limited 30 per 5 min, `app/api/registration-policy/route.ts:29`) and locks the email field (`page.tsx:82-83`). `POST /api/auth/register` then runs in this order:
   - consent (`:78-83`);
   - mode (`:93-99`);
   - CAPTCHA (`:105-111`);
   - field validation;
   - **email/username uniqueness 409** (`:138-145`);
   - invite gate in `invite_only` only (`:153-180`);
   - user creation, pre-verified when invited (`:229-234`);
   - cohort (`:339-343`);
   - `redeemBetaInvite` plus a `BETA_ACCESS_REDEEMED` audit row, in the same `$transaction` (`:345-354`).
8. **Expiry.** This is a read-time predicate only. Nothing transitions the row. The widget derives `expired` (`requests/route.ts:148`), and the lifecycle counts treat `APPROVED ∧ inviteExpiresAt<now` as expired (`lib/platform/growth/growth.ts:183`). Retention deletes APPROVED-and-unredeemed rows 180 days after expiry (`jobs/data-retention.ts:72-77`).

### 3.2 Models and fields

- `enum BetaAccessRequestStatus { PENDING, APPROVED, DENIED, REDEEMED }` (`prisma/schema.prisma:3330-3335`).
- `model BetaAccessRequest` (`schema.prisma:3337-3354`) has these fields:
  - `email @unique` (`:3339`), `note` (`:3340`), `status` (`:3341`), `createdAt` (`:3342`);
  - `decidedAt` (`:3343`) and `decidedById` (soft ref, `:3344`);
  - `inviteTokenHash String? @unique` (`:3347`), `inviteExpiresAt` (`:3348`), `invitedAt` (last sent, `:3349`);
  - `redeemedAt` (`:3350`), `redeemedUserId` (soft ref, `:3351`);
  - `@@index([status, createdAt])` (`:3353`).
- `model BetaAccessRequestEvent { id, email, receivedAt, source Json? }` (`schema.prisma:4427-4435`).
- The column type is `TIMESTAMP(3)`, without time zone (`prisma/migrations/20260713180000_add_beta_access_request/migration.sql:22`).

### 3.3 Expiry: the "~7 days" claim is **wrong for the main path**

| Path | TTL | Where it is set |
|---|---|---|
| Approve (request queue) | **14 days** | `INVITE_TTL_MS = 14*24*60*60*1000` at `approve/route.ts:37`, applied at `:68,78` |
| Resend | **14 days**, always, even for a direct invite issued for 3 days | `resend/route.ts:32,61` |
| Direct invite | **7 days by default**, operator-chosen between 1 and 30 | `invitations/route.ts:33-34,48-50,65`; UI default `"7"` (`GrowthBetaRequestsWidget.tsx:196`) |
| Email copy | hard-coded **"14 days"** for all three paths | `lib/email/templates/beta-invite.ts:21-22,34-35` |
| Approve panel copy | "14-day expiry" | `GrowthBetaRequestsWidget.tsx:537` |

So "~7 days" is true only for the default of the direct-invite path. A direct invite issued for N≠14 days sends an email that says "expires in 14 days". Only the direct path records `expiresDays` in its audit (`invitations/route.ts:102`).

### 3.4 Server-side enforcement

`validateInvite` requires `inviteTokenHash = sha256(raw)`, `inviteExpiresAt > now` and `status = APPROVED` (`lib/registration-policy.ts:74-82`). The register route calls it (`register/route.ts:165-170`) and binds the email (`:173-178`).

The redemption write re-checks `status: APPROVED` but **not** expiry (`registration-policy.ts:133`). Expiry is therefore checked once, before the transaction. **INFERRED:** this leaves a sub-second window, which is negligible.

**Enforcement applies only in `invite_only` mode.** In `open` mode the token is ignored and the row stays APPROVED (`register/route.ts:154-155`).

### 3.5 Token generation, storage, comparison and single use

- Generation: `crypto.randomBytes(32).toString("hex")` (`approve/route.ts:66`; `resend/route.ts:55`; `invitations/route.ts:63`).
- Storage: SHA-256 hex, the hash only (`lib/password-reset-token.ts:20-24`). The raw token exists only in the URL (`approve/route.ts:14-17,94`).
- Comparison: an exact-match DB lookup on the hash, through `systemDb` (`registration-policy.ts:74-81`).
- **Single use:** `redeemBetaInvite` sets REDEEMED and nulls the hash, and throws `InviteNotConsumedError` unless `count===1`, which aborts the account creation (`registration-policy.ts:128-141`; `register/route.ts:389-395`).
- **At most one live token per email** is structural: one hash column on a row that is unique per email (`schema.prisma:3339,3347`). Duplicate active invitations for one address are impossible.
- The URL query token stays in browser history. The Referrer-Policy `strict-origin-when-cross-origin` keeps it out of cross-origin referrers (`next.config.ts:64`).

### 3.6 Approve idempotency, concurrency and audit

- Approve reads first: 404 if missing, 409 if REDEEMED, and an immediate `alreadyApproved` if APPROVED (`approve/route.ts:45-64`).
- The write is conditional: `updateMany where status IN (PENDING, DENIED)`, so only `count===1` mints and emails. The loser of a race gets `alreadyApproved` or a 409 (`:73-91`). **Double-click and concurrent approvals are safe.**
- A DENIED or revoked request **can be re-approved** (`:74`).
- **Approve does not check whether the email already has a User**, unlike the direct path (`invitations/route.ts:53-56`). An approved invite for an existing account cannot be redeemed (`register/route.ts:144`).
- Audit: `BETA_ACCESS_APPROVED` via `recordOperatorAction`, with `{betaRequestId, emailHash, emailStatus}`, written **after** the send and outside any transaction (`approve/route.ts:105-113`).
- The other audit actions are `BETA_ACCESS_REQUESTED/APPROVED/DENIED/REDEEMED`, `BETA_INVITATION_CREATED/RESENT/REVOKED` and `BETA_MODE_CHANGED` (`lib/audit-actions.ts:234-249`).

### 3.7 Resend, revoke, extend and reissue

- **Resend = reissue.** It requires APPROVED, then does an **unconditional** `update` that writes a new hash, `inviteExpiresAt=now+14d` and `invitedAt=now`. The old link dies. Audit is `BETA_INVITATION_RESENT` (`resend/route.ts:48-82`).
  - **INFERRED:** two concurrent resends send two emails, and only the last link works.
  - **INFERRED:** a resend racing a revoke writes a token onto a DENIED row. The row stays unredeemable, but an email with a dead link is sent.
- **Revoke** exists. It requires a structured reason, sets DENIED and nulls the token and expiry in one transaction with the audit row (`revoke/route.ts:35-84`).
- **Deny** also nulls any token (`deny/route.ts:44-53`). There is no email for either.
- **Extend without rotation: DOES NOT EXIST.** Changing the validity is possible only by re-issuing through resend (forced to 14 d) or through a direct invite to the same email (upsert, rotates the token).

### 3.8 Issuance paths: three, and duplicated

| # | Path | Mint and write | Notes |
|---|---|---|---|
| 1 | approve | `approve/route.ts:66-83` | conditional, 14 d |
| 2 | resend | `resend/route.ts:55-64` | unconditional, 14 d |
| 3 | direct invite | `invitations/route.ts:63-87` | **unconditional `upsert`**, 1–30 d. It silently turns PENDING, DENIED or revoked rows into APPROVED. **INFERRED TOCTOU:** the REDEEMED check (`:58-61`) is a read, and the upsert `update` has no status predicate, so a row redeemed in between could be set back to APPROVED with a fresh hash (the register 409 still blocks reuse) |

There is **no shared issuance function**. Each route repeats the token mint, hash, TTL constant, URL build, send and audit. **No seed or script issues invites.** The only other writer is the RLS test harness fixture (`scripts/lib/rls-harness.ts:357`). Readers are `lib/platform/growth/growth.ts:115-184`, `lib/platform/growth/acquisition.ts:45`, `lib/platform/customer/customer-detail.ts:94`, `jobs/data-retention.ts:72-77` and `lib/account-deletion/purge.ts:480-481`.

### 3.9 Time zone handling

- TTLs are epoch-millisecond arithmetic, which is UTC by construction (`approve/route.ts:67-68`). Values are stored in `TIMESTAMP(3)` without a zone. **INFERRED:** Prisma's UTC convention makes `gt: now` consistent.
- The invite email shows only a relative "14 days", with no absolute date (`beta-invite.ts:34-35`). The widget shows "in Nd" (`GrowthBetaRequestsWidget.tsx:58-66`).
- Security-alert bodies use `formatDateTime`. It formats in `timeZone:"UTC"` (`lib/format.ts:97-98`) but **prints no zone label** (`:109`), for example "Oct 31, 2026 at 3:04 PM". Callers: `reset-password/route.ts:86`, `2fa-reset/route.ts:131`, `user/delete/route.ts:120`, `lib/auth.ts:485,522`.

---

## 4. Growth UI today

- **Component:** `components/platform/widgets/GrowthBetaRequestsWidget.tsx` (668 lines). It handles the requests list, the invitations list, approve/deny, resend/revoke, direct invite, and the registration-mode and product-status toggles (`:1-24`).
  - It is registered at `components/platform/PlatformSpaceDashboard.tsx:194`, with section key `growth_beta_requests` (`lib/platform/policy.ts:187`; `lib/platform/workspaces.ts:354`).
  - It is hosted in the Growth default screen `components/platform/leads/GrowthLead.tsx:15` through `BETA_LIST_KEY` (`components/platform/leads/growth-model.ts:35`).
- **Actions:**
  - approve/deny `decide()` (`:199-201`);
  - resend (`:203-204`);
  - revoke with reason and confirm (`:206-209`);
  - direct invite with days input min 1, max 30 (`:193-197,342-370`);
  - approve button in the request RightPanel (`:515-553`).
- **Pagination:**
  - The server caps each list at `take: 100` (`requests/route.ts:80,86`).
  - The client shows `LIST_ROWS = 8` with "Show all N" (`:83,237,507-509`) and a truncation note when `counts > loaded` (`:232-236`).
  - Search and sort are client-side over the loaded rows only (`:224-231`).
  - There is no cursor and no server paging.
  - The invite-email status scan is capped at the newest 500 BETA audit rows (`requests/route.ts:110-115`). Older invitations show status `null`.
- **Permissions:**
  - List: `requirePlatformAccess("GROWTH_REVENUE","READ")` (`requests/route.ts:72`).
  - Every mutation (approve, deny, resend, revoke, direct invite, registration-mode) requires `requireFreshPlatformAccess("GROWTH_REVENUE","WRITE")`. Examples: `approve/route.ts:40`, `revoke/route.ts:30`, `invitations/route.ts:37`, `registration-mode/route.ts:40`.
  - **Not CONTROL.** The SYSTEM_ADMIN break-glass bypass applies (`lib/platform/authorize.ts:146`).
  - The UI hides controls unless `access.canWrite` (`:103`).
  - Levels are `READ | WRITE | CONTROL` (`schema.prisma:281-285`), and all are issuable (`lib/platform/policy.ts:306`).
- **Bulk selection: DOES NOT EXIST.** Selection state is a single `selectedRequestId` / `selectedInvitationId` (`:112-113`), and there is no checkbox or multi-select.

---

## 5. Settings mechanism

- **Storage:** `PlatformSetting { key @id, value String, updatedAt @updatedAt, updatedById? }`, a key/value store (`prisma/schema.prisma:3562-3567`).
- **Keys:** `PlatformSettingKey` (`lib/platform-settings.ts:38-117`); defaults in `DEFAULTS` (`:150-187`).
- **Descriptors:** `SETTING_DESCRIPTORS` is an exhaustive `Record<PlatformSettingKeyType, Descriptor>`, so a key without a descriptor fails to compile (`lib/platform-settings.ts:274-378`). The shape is in `lib/platform/settings/descriptor.core.ts:57-82`:
  - `valueType: boolean|integer|enum`, with `min`/`max` for integers (`:48,66-68`);
  - `writeSurfaces: ADMIN_SECURITY|GROWTH_REVENUE|PLATFORM_OPS` (`:38`);
  - `writeCapability: SYSTEM_ADMIN|WRITE|CONTROL` (`:46`);
  - `missingRow`, `resettable`, `constraint`.
- **Validated writes:**
  - `setSetting` validates before any DB call and stores the normalised value (`lib/platform-settings.ts:556-568`).
  - Conditional primitives `createSettingIfAbsent`, `updateSettingIfVersion` and `deleteSettingIfVersion` use `updatedAt` as the optimistic token (`:500-547`).
  - Reads fall back to `DEFAULTS` (`:414-417`).
- **Audit and gating:** these are the caller's job. Two templates exist:
  - (a) `registration-mode/route.ts:40-74` requires GROWTH_REVENUE WRITE (fresh), a structured reason, `setSetting`, and then `recordOperatorAction` with before/after. The setting write and the audit row are **not** in one transaction.
  - (b) `lib/platform/policies/mutate.ts:1-40` runs CONTROL with a closed key contract, conditional writes and the audit row in **one transaction**.
- Stale comment: `descriptor.core.ts:41-45` says CONTROL "is not yet issuable", but `policy.ts:306` makes all levels issuable.
- **Fit for `invitation_validity_days`: yes, without a migration.** It would be an `integer` key with `min:1`, `max:30`, `default:"14"` (or the owner's value), `missingRow:"FALLBACK_TO_DEFAULT"`, `writeSurfaces:["GROWTH_REVENUE"]`, `writeCapability:"WRITE"` or `"CONTROL"` (owner choice) and `resettable:true`. Adding it means:
  - adding the key and default;
  - adding a descriptor;
  - a write route following pattern (a), preferably with transactional conditional writes as in (b);
  - adding an AuditAction in `lib/audit-actions.ts` (plus reason-required registration in `lib/audit.ts`, **INFERRED** from mutate.ts:24-28).
  - No schema change, because `value` is a string row.

---

## 6. Branding assets available for email

| Asset | Size | Notes |
|---|---|---|
| `public/fm-mark-dark.png` / `public/fm-mark-light.png` | 1254×1254, ~1.4 MB / 1.7 MB | Used by `components/ui/AppLogo.tsx:63`. **Too heavy for email** |
| `public/logo-full.png` | 1997×787 | **Do not use.** It has "FinTracker" baked into the pixels (`AppLogo.tsx:27-29`) |
| `site/public/brand/fm-mark-dark-128.png` | 128×128, 18.8 KB | Used by `site/components/Wordmark.tsx:12` and the OG image (`site/app/opengraph-image.tsx:18`). **Best email candidate** |
| `public/icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png`; `site/app/icon.png` (192), `apple-icon.png` (180) | — | favicons |

- **Colours** (`app/globals.css`):
  - Atlas Ink neutrals `--ink-0 #FFFFFF` … `--ink-900 #0C111D`, `--ink-950 #060911` (`:14-26`);
  - Brass brand gold `--brass-400 #D4A938`, `--brass-500 #C9A227` (`:28-35`);
  - Meridian blue `--meridian-400 #5896FB`, `--meridian-500 #3B82F6`, `--meridian-600 #2563EB` (`:38-44`);
  - the site mirrors a subset (`site/app/globals.css:21-28`).
- **Fonts:** a system stack, `-apple-system, "SF Pro…", "Inter", system-ui` (`app/globals.css:110-111`). This is email-safe and needs no webfont.
- **Absolute URLs:**
  - Site origin: `PRODUCTION_SITE_ORIGIN = "https://fourthmeridian.com"` (`site/lib/public-config.ts:33`), so the logo would be `https://fourthmeridian.com/brand/fm-mark-dark-128.png` (**INFERRED** from the static `public/` mapping; liveness **UNVERIFIED**).
  - The app knows the site origin only through `NEXT_PUBLIC_SITE_URL`, which is nullable (`lib/marketing/public-site.ts:24,110`).
  - App assets resolve under `NEXT_PUBLIC_APP_URL`. The proxy gates only `/dashboard`, `/admin` and `/api` (`proxy.ts:32-36,167-169`), so `/fm-mark-dark.png` is **INFERRED** public.
  - A Preview email would need the Preview origin.

---

## 7. Legal pages

| Document | Site route (`site/`) | App route (`app/`) | Source |
|---|---|---|---|
| Privacy Policy | `/privacy`, `site/app/privacy/page.tsx:13` | `/privacy`, `app/(public)/privacy/page.tsx:14-22` | `site/content/legal/privacy.md` (66 lines) |
| Terms of Service | `/terms`, `site/app/terms/page.tsx:13` | `/terms`, `app/(public)/terms/page.tsx:14-22` | `site/content/legal/terms.md` (47 lines) |
| AI / data-use disclosure | `/legal/ai`, `site/app/legal/ai/page.tsx:13` | `/legal/ai`, `app/(public)/legal/ai/page.tsx:14-24` | `site/content/legal/legal-ai.md` (60 lines) |
| Security (bonus) | `/security`, `site/app/security/page.tsx` | `app/(public)/security` | — |

- The site copies are byte-identical to `content/marketing/*.md` (`site/lib/legal-content.ts:4-8`; `cmp` confirmed for privacy). All three show "updated: October 2026" (`site/content/copy.ts:154-165`).
- The app copies 308 to the site once `NEXT_PUBLIC_SITE_URL` is set (`lib/marketing/public-site.ts:14-22`).
- The privacy policy names "email-delivery … providers" generically, not Resend (`privacy.md:36`).
- Registration records `acceptedTermsAt`/`acceptedTermsVersion` (`register/route.ts:222-223`).
- **No GAP** among the three requested pages: all exist in code. Whether they are deployed live was **UNVERIFIED** here (no network).
- **GAP (email-side):** no email links to any legal page.

---

## 8. Risks and gaps (ranked)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| E-1 | P1 | **Expiry copy is wrong for direct invites.** The default is 7 d (1–30 d), but the email always says "14 days". | `invitations/route.ts:33,48-50` vs `beta-invite.ts:22` |
| E-2 | P1 | **Resend silently resets every invite to 14 d**, including direct invites. There is no extend-without-rotate operation. | `resend/route.ts:32,61` |
| E-3 | P1 | **Three duplicated issuance paths** with separate TTL constants and different concurrency guarantees (approve conditional; resend and direct unconditional). | §3.8 |
| E-4 | P1 | **Direct invite upsert has no status predicate.** It overwrites PENDING, DENIED or revoked rows without warning. **INFERRED:** it can flip a just-REDEEMED row back to APPROVED (TOCTOU). Concurrent direct invites or resends send two emails with only one valid link. | `invitations/route.ts:58-87`; `resend/route.ts:57-64` |
| E-5 | P1 | **Disconnection email gaps.** Plaid webhook NEEDS_REAUTH/REVOKED and wallet failures send nothing. The SYNC_FAILED email is generic, user-disableable, and suppressed when IN_APP is off. | `webhook-receiver.ts:239-251`; `create.ts:323-326`; `registry.ts:378-399` |
| E-6 | P2 | **Approve ignores existing accounts.** The invite is emailed but cannot be redeemed. | `approve/route.ts:45-48` vs `invitations/route.ts:53-56` |
| E-7 | P2 | **Approve in `open` mode** emails a token that registration ignores. The row stays APPROVED and later counts as "expired". | `register/route.ts:154-155`; `growth.ts:183` |
| E-8 | P2 | **Register enumerates accounts pre-invite.** "An account with that email already exists" is returned before the invite gate in `invite_only` (rate-limited 5/15 min, CAPTCHA only when configured). | `register/route.ts:56,138-145,153-180` |
| E-9 | P2 | **Preview may send real email.** There is no env guard or recipient allowlist, and `RESEND_API_KEY` presence on Preview is UNVERIFIED. | `send.ts:33-39`; `PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md:747` |
| E-10 | P2 | **No HTML, no branding, no footer or legal links**, and the notification emails have no settings link or unsubscribe. | `types.ts:24-35`; `notification.ts:41-44` |
| E-11 | P2 | **No retries, no provider idempotency key, no bounce or delivery ingestion.** Direct sends are not in the delivery ledger. | `resend.ts:57-63`; `email-health.ts:10-21,26-34` |
| E-12 | P2 | **Operator inbox flood and content injection.** The intake email is sent on every submission (no dedupe) and embeds the applicant's free-text note (up to 1000 chars). | `access-request/route.ts:59,149-159`; `beta-request.ts:32-37` |
| E-13 | P2 | **Security@ email carries the raw login identifier and IP.** | `anomaly-alerts.ts:189`; `anomalies.ts:105,145` |
| E-14 | P3 | **Timestamps have no zone label.** Security-alert times are UTC but unlabeled. | `lib/format.ts:97-109` |
| E-15 | P3 | **Space invites.** INFERRED double email (direct plus notification). `SpaceInvite.expiresAt` is never set or checked. | `invite/route.ts:165`; `registry.ts:304-308`; `invites/[inviteId]/route.ts:97` |
| E-16 | P3 | **Invite-email status is lost after 500 BETA audit rows**, and lists cap at 100 with no paging. | `requests/route.ts:80,86,113` |
| E-17 | P3 | **Audit is written after the send and outside any transaction** for approve, resend and direct invite (a failure leaves the email sent but unaudited). | `approve/route.ts:98-113` |
| E-18 | P3 | **`EMAIL_FROM_DEFAULT` overrides every identity.** No Reply-To is configured. | `send.ts:61`; `senders.ts:32-52` |
| E-19 | P3 | **Stale comments.** `/verify-email` and `/confirm-email-change` pages are said not to exist, but they do (`app/(auth)/verify-email`, `app/(auth)/confirm-email-change`). "CONTROL not issuable" is also out of date. | `verify-url.ts:11-13`; `email-change-url.ts:11-13`; `descriptor.core.ts:41-45` |

**Verified non-issues:**
- Tokens are hashed at rest (SHA-256).
- Raw tokens and links are not logged.
- Links come from a trusted env base, not the Host header.
- Invite expiry is enforced server-side.
- Single use is enforced, and a zero-count redemption aborts.
- Two active invites for one email are impossible.
- Approve is idempotent under double-click and concurrency.
- The public intake does not enumerate.
- Forgot-password returns an identical response body.

---

## 9. Proposed implementation plan (focused PRs, in order)

**Coordination key.** **[SHARED]** marks a file that also belongs to the Growth UI or the beta-request modules. Another session owns suspicious-request detection in Growth, and those files are its likely surface: `app/api/access-request/route.ts`, `app/api/platform/growth-revenue/requests/route.ts`, `GrowthBetaRequestsWidget.tsx`, `lib/platform/growth/acquisition*.ts`, `GrowthLead.tsx`, `growth-model.ts`, and the `BetaAccessRequest*` models. Agree on file ownership and merge order with that session before A–C start.

### (A) Shared email design system + beta approval email
- Add `html?: string` to `EmailMessage` and to the template render return type: `lib/email/types.ts`.
- Pass `html` through the chokepoint and adapter: `lib/email/send.ts`, `lib/email/providers/resend.ts`. Text remains mandatory as the multipart alternative.
- New `lib/email/layout/` (layout shell, tokens copied from `app/globals.css` ink/brass/meridian, HTML escaping, footer with Privacy, Terms, AI links and the support address).
- Logo: the 128 px mark. This needs an owner decision on the absolute-URL env: reuse `NEXT_PUBLIC_SITE_URL` or add an asset-base name.
- `lib/email/templates/beta-invite.ts` takes `expiresAt` and renders an absolute UTC date plus the relative wording. This fixes E-1.
- Callers pass `expiresAt`: `approve/route.ts` **[SHARED]**, `resend/route.ts` **[SHARED]**, `invitations/route.ts` **[SHARED]**. Only a one-line data change each.
- Tests: `lib/email/templates.test.ts`, `lib/email/send.test.ts`.

### (B) One issuance function + configurable validity (audited)
- New `lib/platform/growth/invite-issuance.ts` **[SHARED dir]**, `issueBetaInvite(client, {requestId|email, mode: approve|resend|direct, days?, actor})`:
  - status-predicated conditional writes for all three modes (fixes E-3 and E-4);
  - an existing-User check (E-6);
  - a warning or refusal when `registration_mode≠invite_only` (E-7);
  - mint, hash and expiry in one place;
  - audit in the same transaction, with `expiresDays` on every action (E-17).
- Rewire `approve/route.ts`, `resend/route.ts` and `invitations/route.ts` **[SHARED]** to call it.
- New setting `invitation_validity_days` (§5): `lib/platform-settings.ts` and a descriptor. Plus a write route, e.g. `app/api/platform/growth-revenue/invite-policy/route.ts` **[SHARED dir]**, following the `registration-mode` pattern but transactional.
- `lib/audit-actions.ts` gains a new action and `lib/audit.ts` gains reason-required registration (INFERRED).
- An optional "extend without rotating" mode (E-2).
- A widget field for the default days: `GrowthBetaRequestsWidget.tsx` **[SHARED]**.
- No migration.

### (C) Bulk approval
- New `app/api/platform/growth-revenue/requests/bulk-approve/route.ts` **[SHARED dir]**:
  - an id list with a cap of ≤100 to match the list cap;
  - loops `issueBetaInvite` per id, with a per-row result and a shared batch id in each audit row;
  - fresh GROWTH_REVENUE WRITE, or CONTROL (owner ruling).
- Multi-select, a "select all loaded", a confirm dialog and a results summary in `GrowthBetaRequestsWidget.tsx` **[SHARED]**.
- **Depends on B.** It must coordinate with suspicious-request detection, for example to exclude flagged rows from select-all.

### (D) Migrate the remaining templates
- Port to the layout: `password-reset.ts`, `email-verification.ts`, `email-change.ts`, `security-alert.ts`, `space-invite.ts`, `notification.ts` (add the settings link, E-10), `platform-alert.ts`, and `beta-request.ts` **[SHARED: beta-request module]**. Also neutralise or escape the applicant note (E-12).
- Add a "UTC" label to `formatDateTime` callers in emails, or an email-specific formatter (`lib/format.ts`, E-14). Check the other `formatDateTime` consumers first, because the function is app-wide.
- Optional: drop the duplicate Space-invite email by choosing one of `space-invite` or `SPACE_INVITE_RECEIVED` EMAIL (`lib/notifications/registry.ts`, E-15).
- Optional: redact the identifier/IP in `anomaly-alerts.ts:189` (E-13).

### (E) Safe preview route or script
- A render-only script, e.g. `scripts/email-preview.ts`. It writes `.html` and `.txt` for every template into the scratch area, using synthetic recipients (`@example.invalid`, RFC 2606) and a fixed non-hex marker token such as `PREVIEW-NONREDEEMABLE` that is never stored.
- It **never calls `sendEmail`**, imports only templates and layout, and makes no DB or network call.
- If a route is preferred, `app/api/dev/email-preview/route.ts` must refuse unless `NODE_ENV==="development"` and `VERCEL_ENV` is unset.
- Separately, and for an owner ruling: a Preview guard in `lib/email/send.ts` (allowlist or capture when `VERCEL_ENV==="preview"`, E-9).
- No [SHARED] files.

**Owner decisions needed before B and C:**
1. Default validity: the code says 14 d for approve and 7 d for direct. Which value?
2. Gate level for the validity setting and bulk approve: WRITE or CONTROL?
3. Should Preview send real email?
4. Logo hosting origin and env name.
