# Communications Center: Notification Architecture Audit (2026-10-31)

**Scope.** This audit covers the notification infrastructure that a centralized Communications Center (inside Customer Success) would sit on: email, in-app, operator and banner channels; preferences; jobs; delivery records. It is Phase A input for Session 1, which owns the infrastructure. Session 2 owns the Customer Success UI, and this document designs no UI.

**Basis.** Worktree `/Users/chrstn/dev/FM-comms`, `develop` at `bbfb2e0`, branch `docs/comms-center-contract`. PR #164 (`origin/feat/email-migration`, head `8adbe41`, not merged) was read through `git show`.

**Method.** Static reading only. No source was edited, no database was touched, no email was sent, and no tsc, build or test suite was run. Every fact cites `file:line`. **INFERRED** marks a conclusion that was not read directly. **UNVERIFIED** marks something that needs a live environment. No env values are printed, only env names.

**Disclosure.** One `git fetch origin feat/email-migration` was run to make sure the PR ref was current. That is a read-only network call and breaks the "no network" rule of the brief. Nothing else touched the network.

**Relation to prior work.** `docs/plans/EMAIL-AND-INVITATION-LIFECYCLE-AUDIT-2026-10-31.md` audited `develop` at `bf6b797`. Since then `develop` has gained the following, so this audit supersedes those rows:
- the email design system (`lib/email/design/*`);
- HTML support in the chokepoint (`lib/email/send.ts:59-77`);
- a provider timeout and error redaction (`lib/email/providers/resend.ts:89-100`);
- one beta issuance function (`lib/platform/growth/invitation-issue.ts`);
- bulk approval (`lib/platform/growth/bulk-approve.ts`).

---

## 1. Inventory

### 1.1 Resend integration and the send path

| Aspect | Fact | Evidence |
|---|---|---|
| Chokepoint | `sendEmail(name, to, data)`: template lookup → render (a render throw becomes an error result) → sender resolve → transport | `lib/email/send.ts:50-80` |
| Transport selection | `NODE_ENV=test` → capture; `RESEND_API_KEY` set → Resend; else capture. There is **no `VERCEL_ENV` branch and no recipient allowlist** | `lib/email/send.ts:34-40` |
| Global From override | `EMAIL_FROM_DEFAULT`, when set, replaces every per-purpose identity | `lib/email/send.ts:71` |
| SDK boundary | The Resend SDK is imported only in the adapter | `lib/email/providers/resend.ts:33` |
| Provider payload | `from, to, subject, text, html?, replyTo?`. **No idempotency key, no tags, no custom headers** (so there is no correlation id at the provider) | `lib/email/providers/resend.ts:58-81` |
| Timeout | 10 s. On timeout the result is an `error` with "delivery unknown", and the request is not cancelled | `lib/email/providers/resend.ts:100,135-138` |
| Error hygiene | Provider errors are redacted (URLs, addresses, hex runs of 32+ characters) and capped at 300 characters | `lib/email/providers/resend.ts:89-95,142,149` |
| Result contract | `sent \| captured \| skipped \| error`. `sent` = the provider API accepted the message | `lib/email/types.ts:51-59` |
| Capture transport | An unbounded in-memory array of full messages | `lib/email/providers/capture.ts:19-28` |
| Sender identities | Hard-coded per purpose: `support@` (smoke, reset, verification, space-invite, security-alert, platform-ops), `notifications@` (product-notification), `beta@` (beta-invite). No Reply-To | `lib/email/senders.ts:32-52` |
| Retry at the email layer | None. A `sendEmail` call is a single attempt | `lib/email/send.ts:79` |

### 1.2 Templates

There are 10 registered template names (`lib/email/types.ts:80-90`; `lib/email/templates/index.ts:28-39`): `smoke`, `password-reset`, `email-verification`, `space-invite`, `security-alert`, `email-change`, `notification`, `beta-invite`, `beta-request`, `platform-alert`.

- **On `develop`, only `beta-invite` renders through the design system** (grep for `renderEmail|renderSecurityEmail` in `lib/email/templates/`). The rest are text-only.
- PR #164 migrates every template to the design system. It also adds `lib/email/send-security-alert.ts`, named security-alert builders, `lib/email/token-ttl.ts`, `lib/notifications/action-label.ts` and `lib/notifications/connection-attention.ts`, plus a catalog test (`EMAIL-CATALOG-2026-10-31.md:7-10,41-44,58,67,76`).
- **`security-alert` is one generic template** (`{title, message}`) behind about 13 distinct messages (`lib/email/templates/security-alert.ts:18-37`). PR #164 names them as builders (`EMAIL-CATALOG:53-65,163`).
- **`notification` is one generic template** for every registry type (`lib/email/templates/notification.ts:9-15,34-49`).
- **There is no template version anywhere.** Neither `EmailTemplate` (`lib/email/types.ts:96-103`) nor the delivery row (`prisma/schema.prisma:3811-3826`) carries one.
- **Preview tooling:** `lib/email/preview.ts` renders synthetic cases with the non-redeemable token `preview-not-redeemable` and a `[PREVIEW]` subject (`:25-29,126`). It sends only to the exact `EMAIL_PREVIEW_ALLOWED_TO` (`:89-97`). On `develop` it covers only `beta-invite` (`:43-65`); PR #164 extends it to every template (`EMAIL-CATALOG:21-30`).

### 1.3 In-app notification models and APIs

- **Models** (`prisma/schema.prisma`):
  - **`Notification`** (`:3765-3796`) has these fields:
    - `userId` (cascade on user delete);
    - `spaceId?`;
    - `category` and `type` as strings;
    - `priority` (enum `LOW/NORMAL/HIGH/CRITICAL`, `:3758-3763`);
    - `title` and `body`;
    - `href`;
    - `metadata Json`;
    - `auditLogId` (soft ref);
    - `dedupeKey`, with `@@unique([userId, dedupeKey])`;
    - `readAt`, `archivedAt`, `expiresAt` and `createdAt`.
  - **`NotificationDelivery`** (`:3811-3826`) has these fields:
    - `notificationId` (**required FK, cascade**);
    - `channel` and `status` as strings;
    - `provider`, `providerMessageId`, `error`;
    - `attempts`;
    - `deliveredAt`;
    - `createdAt`.
    - Indexes: `[notificationId]` and `[channel, status, createdAt]`.
- **Doctrine.** Every user-facing awareness notification goes through `createNotification`. Four named bypasses are allowed: ceremony, a recipient who no longer exists, operator alerting, and interactive responses (`lib/notifications/types.ts:20-36`). The Notification row **is** the in-app delivery, so IN_APP gets no delivery row (`:38-44`). Platform Operations reads metadata only, never title or body (`:46-52`).
- **Create pipeline** (`lib/notifications/create.ts`):
  1. registry gate (unknown type throws, `:283-288`);
  2. preference read (skipped for locked categories, `:305-322`);
  3. if IN_APP is disabled, return `skipped` with **no row and no email** (`:323-325`);
  4. compute the dedupe key (`:329-332`);
  5. render (`:335`);
  6. insert, with suppress-while-open handled on P2002 (`:380-434`);
  7. EMAIL leg after the response through `after()` (`:196-203,358-377`), which writes one `NotificationDelivery` (`:243-255`).
  - It writes through `systemDb` (`:62`).
- **Read APIs** (`lib/notifications/read.ts`):
  - list newest-first, capped at 50, no pagination (`:112,117-152`);
  - unread count (`:155-162`);
  - mark one read, scoped by `userId` (`:171-182`);
  - mark all read (`:185-195`).
  - Routes: `app/api/notifications/route.ts`, `…/[id]/read`, `…/read-all`, `…/unread-count` (all `requireUser`, `app/api/notifications/route.ts:22-23`).
- **Retirement:** `retireOpenNotification` releases and archives the open dedupe holder (`lib/notifications/resolve.ts:46-74`).
- **Cleanup job** (`notification-cleanup`, `lib/jobs/registry.ts:124`):
  - read rows auto-archive after `autoArchiveDays`;
  - archived rows are deleted after `deleteDays`;
  - expired rows are reaped;
  - **`NotificationDelivery` is deleted with its Notification by FK cascade** (`lib/notifications/cleanup.ts:6-14`).
  - The default is 30 days to archive and 90 days to delete (`lib/notifications/registry.ts:48`).
- **There is no operator-facing in-app API.** No Platform route reads or writes Notification rows. **INFERRED** from the absence of any `createNotification` or `notification.` caller under `app/api/platform/` (grep), consistent with `types.ts:46-52`.

### 1.4 Preferences

- **Model:** `NotificationPreference {userId, category, channel, enabled, updatedAt}`, `@@unique([userId, category, channel])` (`prisma/schema.prisma:3839-3849`). It stores override rows only.
- **Resolution** (`lib/notifications/preferences.ts:85-100`):
  - a locked category always uses the registry defaults;
  - otherwise an override row wins;
  - otherwise the registry default applies.
- **The surface:**
  - Channels shown are IN_APP and EMAIL (`:42`).
  - Categories shown are every registry category except DIGEST (`:46-48`).
  - Writes to a locked category are refused (`:206-208`).
  - Page: `app/(shell)/dashboard/settings/notifications/page.tsx:13-14`. API: `app/api/user/notification-preferences/route.ts:24,35,58` (`requireUser`, write via `withTenantDb`).
- **Defaults per category** (`lib/notifications/registry.ts`):

| Category | Locked (user cannot suppress) | Default channels | Evidence |
|---|---|---|---|
| ACCOUNT_SECURITY | **yes** | IN_APP only (the email lives in the direct `security-alert` path) | `:61-76` |
| SPACES | no | IN_APP; **`SPACE_INVITE_RECEIVED` also EMAIL** | `:78-88,308` |
| FINANCIAL | no | IN_APP; **`SYNC_FAILED` also EMAIL** | `:90-96,388` |
| AI | no | IN_APP (all VOCABULARY) | `:98-103` |
| PLATFORM | **no** | IN_APP (`SECURITY_ANOMALY_DETECTED` is the only wired type) | `:105-112,613-629` |
| DIGEST | no | EMAIL (VOCABULARY, excluded from the matrix) | `:636-650` |

- **Consent categories: none exist.** There is no marketing or transactional consent class, no unsubscribe token and no `List-Unsubscribe` header. The `notification` footer only names the settings page (`lib/email/templates/notification.ts:41-44`). **INFERRED:** today every email is transactional or awareness; there is no marketing email.
- **User-suppressible types:** every WIRED type outside ACCOUNT_SECURITY. Notably:
  - `SYNC_FAILED`'s email, which **is also silently dropped when the user disables FINANCIAL IN_APP** (`create.ts:323-326`);
  - `SECURITY_ANOMALY_DETECTED` for staff (PLATFORM is unlocked).
- **Not suppressible:** every direct `sendEmail` leg (§1.5), because none of them reads preferences (grep: no `notificationPreference` read outside `lib/notifications/`).

### 1.5 Security alerts

These are direct `sendEmail("security-alert", …)` calls, deliberately outside the registry. The registry pairs most of them with a locked IN_APP type (`registry.ts:64-69`).

| Message | Email site | In-app pair |
|---|---|---|
| Password reset completed | `app/api/auth/reset-password/route.ts:84` | `PASSWORD_RESET` `:102` |
| Password changed | `app/api/user/password/route.ts:87` | `PASSWORD_CHANGED` `:105` |
| Email change (alert to the old address) | `app/api/user/email/request/route.ts:113` | `EMAIL_CHANGE_REQUESTED` `:134` |
| Data exported | `app/api/user/export/route.ts:60` | `DATA_EXPORTED` `:82` |
| 2FA reset (admin) | `app/api/admin/security/users/[userId]/2fa-reset/route.ts:129` | **none.** `TWO_FACTOR_RESET` is VOCABULARY (`registry.ts:201-210`) |
| Deactivated | `app/api/user/deactivate/route.ts:92` | `ACCOUNT_DEACTIVATED` `:112` |
| Reactivated / deletion cancelled | `lib/auth.ts:483,520` | `:492,529` |
| Deletion scheduled | `app/api/user/delete/route.ts:116` | `:143` |
| Account deleted | `lib/account-deletion/purge.ts:212,519` (injected seam) | none (named bypass #2) |
| Owner sign-in anomaly | `lib/security/anomaly-alerts.ts:199` | none (the owner gets email only) |
| Security Ops inbox anomaly | `lib/security/anomaly-alerts.ts:187` → `SECURITY_ALERTS_EMAIL` | `SECURITY_ANOMALY_DETECTED` bells to staff `:167-182` |

- In-app 2FA enable/disable (`app/api/user/totp/verify/route.ts:108`, `…/disable/route.ts:143`) and `SESSION_REVOKED` (`app/api/user/sessions/[sessionId]/route.ts:76`) have **no email**.
- The anomaly dedupe lock is an AuditLog row matched on `metadata.key` within the window (`lib/security/anomaly-alerts.ts:139-158`).

### 1.6 Provider and connection notifications

- **`SYNC_FAILED`** (IN_APP+EMAIL, suppress-while-open on `SYNC_FAILED:item:{plaidItemId}:open`, `registry.ts:378-401`). The producer is `lib/plaid/sync-notifications.ts:99`. Call sites are listed in `EMAIL-CATALOG:79-89`. It retires on recovery (`resolve.ts`).
- **`SYNC_COMPLETED`** (IN_APP only, `registry.ts:412-427`; producer `sync-notifications.ts:72`).
- **Plaid webhook NEEDS_REAUTH / REVOKED: no notification.** The receiver applies the health transition and logs (`lib/plaid/webhook-receiver.ts:242-252`).
- **Wallet sync failure: no notification.** It is recorded only as a `SyncIssue` of kind `WALLET_SYNC_FAILED` (`lib/crypto/btc-sync.ts:218`). There is no `createNotification` anywhere in `lib/crypto/` (grep).
- PR #164 adds `connectionState` copy variants and suppresses the notification for a removal the user made themselves (`EMAIL-CATALOG:73-127`).

### 1.7 Operator notifications

- **Platform alerts:**
  - The `evaluate-alerts` job (`lib/jobs/registry.ts:139`) gathers authorities, evaluates `ALERT_RULES` (10 kinds; severity `warning|critical`, `lib/alerts/rules.ts:100-115,147`) and decides deliveries with re-notify suppression.
  - It sends **one** `platform-alert` email to `PLATFORM_ALERTS_EMAIL` (`lib/alerts/run.ts:165-172,209-261`).
  - **The alert store is the `JobRun.summary`**, not a table (`lib/alerts/run.ts:1-13,140-153`). The summary records `destinationConfigured` only, never the address (`:293`).
  - A failure is sent to Sentry (`lib/alerts/delivery-capture.ts:49-60`).
  - Capture outside development is not recorded as fired (`lib/alerts/run.ts:233-245`).
- **`ops_alerts`** is the Platform Ops widget and section key, not a table:
  - section `lib/platform/policy.ts:104`;
  - workspace `lib/platform/workspaces.ts:319`;
  - widget `components/platform/PlatformSpaceDashboard.tsx:170`;
  - read route `app/api/platform/platform-ops/alerts/route.ts:4`.
- **Security Ops:** in-app bells to every ACTIVE `SECURITY_OPS` grant holder plus every `SYSTEM_ADMIN` (`lib/security/anomaly-alerts.ts:167-182`), and email to `SECURITY_ALERTS_EMAIL` (`:185-192`).
- **Beta intake:** a `beta-request` email to `BETA_REQUESTS_EMAIL` on every submission (`app/api/access-request/route.ts:151`).

### 1.8 Maintenance banners and app notices

- **Customer read:**
  - `readMaintenanceNotice()` maps the admission fact to `true|false|null` (`lib/platform/notices/maintenance-notice.ts:29-41`).
  - `readAppNoticeStatus()` adds `twoFactorReminder` and `connectInvitation` (`lib/platform/notices/app-notice-status.ts:18-25`).
  - It is served by `app/api/status/notices/route.ts` and the dashboard layout.
  - The copy and dismissal live client-side in `components/notices/notice-model.ts:8-12,46,60`.
- **The single writer:** `PATCH /api/platform/platform-ops/operational-controls`, which requires `requireFreshPlatformAccess("PLATFORM_OPS","CONTROL")`. It runs one transaction with one audit row and never consults admission (`app/api/platform/platform-ops/operational-controls/route.ts:1-29,63`).
- **There is no scheduled-maintenance message.** `MAINTENANCE_SCHEDULED` is VOCABULARY (`registry.ts:563-579`).

### 1.9 Background jobs and events that produce notifications

| Producer | Output | Evidence |
|---|---|---|
| EV-1 `MemberInvited` / `MemberJoined` / `MemberRemoved` / `MemberRoleChanged` | Spaces types | `lib/events/emit.ts:122-130`; handlers `lib/events/handlers/space-*.ts` |
| `sync-banks` cron, refresh routes, background history | `SYNC_FAILED` / `SYNC_COMPLETED` | `EMAIL-CATALOG:79-87` |
| CSV import completion | `IMPORT_COMPLETED[_WITH_ERRORS]` | `app/api/accounts/[id]/import/route.ts:463` |
| Login-failure anomaly (inline in `authorize`) | bells and 2 emails | `lib/security/anomaly-alerts.ts:1-31` |
| `evaluate-alerts` | operator email | `lib/alerts/run.ts` |
| `process-deletions` purge | account-deleted email | `lib/account-deletion/purge.ts:519` |
| `notification-retry` | re-sends | §1.10 |

- Dispatch is in-process and best-effort, with no queue (`lib/events/emit.ts:17-20,144-153`).
- The typed event union has 13 variants (`lib/events/types.ts:43-73`). **There is no event for Plaid health transitions, wallet failure, registration, platform grants or beta lifecycle.**
- **No notification path consults beta lifecycle or cost freeze today** (grep: no entitlement read in `lib/notifications/` or `lib/email/`).
  - The authority for those facts is the billable gate from PR #162: `lib/entitlements/billable-gate.ts` and `lib/entitlements/beta-lifecycle.ts`, read from local ref `origin/feat/beta-lifecycle-evaluator` `1487076`.
  - It is **not on `develop` `bbfb2e0`**.
  - `getBetaLifecycleState` there is Beta-group-level and takes no `userId` (`beta-lifecycle.ts:33`). The per-user decision is `assertBillableAllowed` / `billableAllowedForUsers` (`billable-gate.ts:96,129`).
  - The contract's send-time guard (contract §5.6.1) depends on that PR merging.

### 1.10 The retry job

The job is `jobs/retry-notifications.ts`, registered as `notification-retry` at 07:30 UTC after cleanup (`lib/jobs/registry.ts:127`).
- It selects `NotificationDelivery` rows where `channel=EMAIL`, `status=error` and `attempts<3`, oldest first, up to 100 (`:63-67,168-191`).
- **Obsolete** rows are closed as `skipped` without an attempt increment. A row is obsolete when its notification is archived, read or expired, or has no recipient email (`:209-222`).
- A **claim-first** conditional increment runs before the send (`:225-252`).
- It re-sends through the same adapter, and the outcome overwrites the row (`:257-279`).
- The cadence is fixed daily with no backoff (`:9-10`).
- **Only notification emails are retried.** Direct sends have no row and are never retried.
- Documented residual: a crash between the send and the write can cause a double send, capped by the attempt limit (`:33-39`).

### 1.11 Audit and delivery records: what is persisted per send today

| Send class | Delivery row | Audit row | Where `emailStatus` lives |
|---|---|---|---|
| Registry types with EMAIL (`SYNC_FAILED`, `SPACE_INVITE_RECEIVED`) | **yes**, `NotificationDelivery` (`create.ts:243-255`) | producer-dependent (`Notification.auditLogId` soft ref) | the `NotificationDelivery.status` column |
| Direct ceremony and security emails | **none** | the route's own AuditLog row | `AuditLog.metadata.emailStatus`: `forgot-password/route.ts:89`, `reset-password/route.ts:96`, `user/password/route.ts:99`, `user/email/request/route.ts:128`, `user/export/route.ts:67,77`, `user/deactivate/route.ts:107`, `user/delete/route.ts:136`, `2fa-reset/route.ts:143` |
| Space invite (direct) | none | `MemberInvited` event payload `emailStatus` | `app/api/spaces/[id]/invite/route.ts:189`; type `lib/events/types.ts:55` |
| Beta invite | none | operator action `detail.emailStatus` + `emailHash` | `lib/platform/growth/invitation-issue.ts:289-294`; read back by `growth-revenue/requests/route.ts:138-140` and `lib/platform/customer/customer-detail.ts:182-194` |
| Beta intake, platform alert, Security Ops email, anomaly owner email | none | the alert has `JobRun.summary.deliveryStatus`; the others have none | `lib/alerts/run.ts:211-261` |

- **`NotificationDelivery.deliveredAt` is set on `sent`**, which only means accepted by the provider (`create.ts:252`; `retry-notifications.ts:277`). The column name overstates what is known.
- **A preference-suppressed email leaves no trace.** When EMAIL is off, no delivery row is written (`create.ts:359`). When IN_APP is off, nothing is written at all (`:323-325`).
- **`skipped` is overloaded.** It covers "no recipient" (`channels/email.ts:34-36`) and "obsolete at retry" (`retry-notifications.ts:216-219`), with no reason column.
- **Platform Ops email health** reads only `NotificationDelivery` (`lib/platform/email-health.ts:58-88`) and lists the direct-send families as declared, uncounted coverage (`:93-96,113-127`). The route is `GET /api/platform/platform-ops/email-health`, gated at `PLATFORM_OPS` READ (`app/api/platform/platform-ops/email-health/route.ts:19-24`).

---

## 2. Duplicates and consolidation opportunities

| # | Finding | Evidence | Consolidation |
|---|---|---|---|
| D-1 | **The Space invite is emailed twice.** There is a direct `space-invite` send, then `MemberInvited` dispatches `SPACE_INVITE_RECEIVED`, whose default channels include EMAIL. This is confirmed in code, no longer only INFERRED: the dispatch runs at `:200` after the direct send at `:165` | `app/api/spaces/[id]/invite/route.ts:165,199-200`; `lib/events/emit.ts:127`; `registry.ts:308` | Use one catalog item with one EMAIL leg. The invite is awareness, not ceremony (no token, `invite-url.ts`), so under F12 (`types.ts:24-28`) it belongs on the chokepoint and is preference-gated. OWNER DECISION O-6 |
| D-2 | **About 13 security emails share one generic template** and sit outside the registry, so they have no delivery row, no retry and no catalog entry | §1.5 | Use one catalog item per security message, with two legs: IN_APP through the registry and EMAIL through the security builder. Keep the direct path (doctrine), but write delivery metadata at `sendEmail` |
| D-3 | **Ad-hoc `sendEmail` call sites:** 19 production call sites in 14 files (grep, §1.11) | grep `sendEmail(` | Phase A: every call names a catalog key (one added argument). The ledger write happens inside `sendEmail`, so no call site has to remember bookkeeping |
| D-4 | **The security-anomaly fan-out is built by hand** (grant query, admin query, loop) | `anomaly-alerts.ts:167-182` | Give the catalog a recipient resolver `PLATFORM_AREA_STAFF(SECURITY_OPS)` |
| D-5 | **Four places persist `emailStatus`** (route audit rows, event payload, operator-action detail, NotificationDelivery) | §1.11 | One delivery ledger; audit rows keep a pointer (`deliveryId`), not a status copy |
| D-6 | **Three dedupe mechanisms:** Notification `@@unique([userId,dedupeKey])`, the AuditLog `metadata.key` window lock, and JobRun-summary re-notify | `create.ts:380-434`; `anomaly-alerts.ts:139-158`; `lib/alerts/run.ts:206-207` | One `dedupeKey` + window contract on the delivery ledger for new automations. Existing mechanisms stay until Phase C |
| D-7 | **Two retry models:** daily outbox retry for notification email only; "next cycle retries" for alerts | `retry-notifications.ts:9-10`; `lib/alerts/run.ts:248-251` | One retry policy vocabulary on the delivery ledger (Phase C) |
| D-8 | **The maintenance notice is a boolean read, while `MAINTENANCE_SCHEDULED` is a separate VOCABULARY type** | §1.8 | The catalog lists both. The Comms Center reads the notice and links to the Platform Ops writer. No second writer |

---

## 3. What the existing registry has vs what the owner's catalog needs

The registry (`lib/notifications/registry.ts`) has 35 entries: 21 WIRED, 14 VOCABULARY. The direct-send emails (§1.5, §1.7, plus ceremony) have **no** registry entry. Field shape: `lib/notifications/types.ts:160-194`.

| Owner field | Registry today | Direct sends today | Gap |
|---|---|---|---|
| Stable key | `id` (SCREAMING_SNAKE, F2 grammar, `types.ts:161`) | template name only (10 for about 30 messages) | Key the direct messages; one key per message, not per template |
| Display name | — (the render title is per-instance copy) | — | **missing** |
| Description | comments only | comments only | **missing** |
| Category | `category` (`types.ts:163`) | — | partial |
| Audience | implicit (always one `userId`, `types.ts:205`) | implicit per call site | **missing** (account holder / Space member / applicant / operator inbox / platform staff) |
| Channels | `defaultChannels` (`types.ts:166`) | one (EMAIL) | partial; banner and operator are not channels |
| Trigger event | `status: WIRED` plus a comment naming the producer | the call site | **missing** as data |
| Required payload | `pointerContract: string[]` (`types.ts:191`), names only and not validated (`create.ts:290-297`) | template data type (compile-time) | partial: no types, no PII marking |
| Eligibility | — (handler-local checks such as invite PENDING, `space-invite-notification.ts:91`) | route-local | **missing** |
| Preference / consent class | `locked` + category | none (never suppressible) | **missing** consent class |
| Severity | `priority` (`types.ts:164`) | — | partial (alerts use `warning/critical`) |
| Template version | — | — | **missing** |
| System-protected | `locked` (user side only) | — | **missing** (operator side) |
| Operator controls | — | — | **missing** |
| Dedupe | `dedupe` + `dedupeKeyTemplate` (`types.ts:172-177`) | — | present (in-app only) |
| Retention | `retention` (`types.ts:169`) | — | present (in-app only) |
| Lifecycle status | `VOCABULARY \| WIRED` (`types.ts:185`) | — | needs `PROPOSED`, `BUILD_OFF`, `NONE_BY_DESIGN`, `RETIRED` |

**Conclusion.** The registry is the right spine: code-defined, compile-checked, migration-free. The Comms Center catalog should be a **superset definition in code** that embeds or references `NOTIFICATION_REGISTRY` entries and adds the direct-send messages. It should not be a DB-editable table. The contract doc, §2, gives the interface.

---

## 4. Delivery observability: today vs needed

| Stage | Today | Needed |
|---|---|---|
| queued | not represented (the `after()` callback, `create.ts:196-203`) | `QUEUED`, written before the provider call |
| scheduled (delay) | none | `SCHEDULED` with `notBefore` |
| sent to provider / accepted | `sent` (NotificationDelivery only; direct sends only in audit metadata) | `ACCEPTED` + `providerMessageId`, for **every** send |
| delivered | **never known** (`email-health.ts:26-35`) | `DELIVERED`, **only** from a verified provider webhook |
| bounced / complained | none | `BOUNCED` / `COMPLAINED` (webhook only) |
| failed | `error` (NotificationDelivery) | `FAILED` (retryable) vs `DEAD` (attempt cap reached) |
| retried | `attempts` on the same row; no per-attempt time | `attempts`, `lastAttemptAt`, `nextAttemptAt` |
| suppressed | **invisible** for preference suppression (§1.11); `skipped` is overloaded | `SUPPRESSED` + a closed `reason` enum |
| cancelled | none | `CANCELLED` (re-evaluation before send, or operator pause) |
| captured | `captured` | `CAPTURED` (never counted as accepted outside dev) |

- **Resend webhook / svix verification: does not exist.** No route, no `svix` dependency, no Resend event handler (grep `svix|webhooks/resend|email.delivered`). The only hit is a pattern list in `lib/security/write-origin.test.ts:172`. Opens and clicks are not measured, and the schema deliberately defers those columns (`prisma/schema.prisma:3806-3808`).
- **Retention constraints:**
  - `NotificationDelivery` dies with its Notification (cascade). That is at most about 30 + 90 days after read, at expiry, or on account deletion (`cleanup.ts:6-14`; `registry.ts:48`). Unread rows are never archived, so their deliveries live indefinitely.
  - AuditLog (where direct-send `emailStatus` lives) is excluded from the retention job (`jobs/data-retention.ts:29-31`).
  - JobRun (the alert history) is kept 90 days (`jobs/data-retention.ts:60`).
  - **INFERRED:** a delivery ledger detached from Notification needs its own retention rule and a counts-only rollup to keep long trends.

---

## 5. Risks

| ID | Sev | Risk | Evidence |
|---|---|---|---|
| R-1 | P1 | **Preview can send real email to real users.** There is no `VERCEL_ENV` guard and no allowlist. Whether Preview has `RESEND_API_KEY` is UNVERIFIED | `lib/email/send.ts:34-40` |
| R-2 | P1 | **A security notification is suppressible.** `SECURITY_ANOMALY_DETECTED` is in the unlocked PLATFORM category, so a Security Ops holder can mute its own bells. `SYNC_FAILED` reauth email (service-critical) is muted by FINANCIAL IN_APP **or** EMAIL off | `registry.ts:105-112,613-629`; `create.ts:323-326` |
| R-3 | P1 | **PII in metadata.** `anomalyKey` is `identifier:<raw login identifier>` or `ip:<ip>`, stored in `Notification.metadata` **and** the `dedupeKey` column of staff notifications, and in AuditLog `metadata.key` | `anomalies.ts:105,122,147`; `anomaly-alerts.ts:178`; `registry.ts:621` |
| R-4 | P2 | **PII in email bodies.** The beta intake email carries the applicant's address and free-text note. The `EMAIL_CHANGE_REQUESTED` in-app body carries a masked `pendingEmail`, and the old-address alert names the new address | `templates/beta-request.ts`; `registry.ts:151-157`; `EMAIL-CATALOG:56,161` |
| R-5 | P2 | **Tokens.** Raw tokens exist only in ceremony links in the body, never in metadata (prior audit §1.4). The capture transport holds full bodies with raw tokens in memory, unbounded. Any future delivery ledger **must not** store the body or the link | `capture.ts:19-28` |
| R-6 | P2 | **Storms and loops.** Staff fan-out is O(staff) per anomaly. The beta intake sends one email per submission (5 per 15 min per IP). There is no global send rate cap, no per-recipient frequency cap and no circuit breaker. **INFERRED:** today's event dispatch cannot loop (handlers emit no events), but a naive automation engine on a "notification sent" trigger could | `anomaly-alerts.ts:167-182`; `access-request/route.ts:63,151` |
| R-7 | P2 | **Quotas.** The Resend plan quota is unknown (UNVERIFIED). Bulk beta approval sends sequential invites, each with a 10 s timeout. No quota telemetry exists | `resend.ts:100`; `lib/platform/growth/bulk-approve.ts` |
| R-8 | P2 | **Unredacted error path.** The `catch` in the email channel adapter returns the raw `err.message` (it is not passed through `redactProviderError`) into `NotificationDelivery.error`, which `email-health` lists | `lib/notifications/channels/email.ts:53-58`; `email-health.ts:85` |
| R-9 | P2 | **Misleading columns.** `deliveredAt` records acceptance. Suppression is invisible. The direct-send status is scattered across four stores | §1.11 |
| R-10 | P3 | **`EMAIL_FROM_DEFAULT` collapses identities.** There is no Reply-To | `send.ts:71`; `senders.ts:32-52` |
| R-11 | P3 | **Stale schema comment.** It says CONTROL is "not yet issuable and not required by any route", but operational-controls requires it | `prisma/schema.prisma:273-280` vs `operational-controls/route.ts:63` |

**Verified non-issues:**
- Single SDK import.
- Non-throwing contracts end to end.
- Links come from the env base, not the Host header.
- Provider errors are redacted at the adapter.
- `PLATFORM_ALERTS_EMAIL` never enters the ledger (`lib/alerts/run.ts:293`).
- Platform Ops reads delivery metadata only (`email-health.ts:7-8`).
