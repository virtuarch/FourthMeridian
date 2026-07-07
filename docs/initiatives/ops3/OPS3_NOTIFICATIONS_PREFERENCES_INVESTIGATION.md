# OPS-3 — Notifications & Preferences · Investigation

**Date:** 2026-07-07 · investigated against the working tree (post `77e5f27`, OPS-2 complete; UX-1 Settings decomposition mid-flight — `settings/account` and `settings/preferences` pages, `lib/settings/loaders.ts`, and `components/settings/` already exist)
**Status:** Investigation only. No implementation, no code, no schema changes, no migrations, no STATUS update.
**Scope:** the complete Notifications & Preferences architecture — notification model, producers, delivery channels, preferences, Notification Center, Ambient Intelligence compatibility, event architecture, Settings integration, background jobs, OPS-5 observability.

---

## 0. Prior art in the tree (what this design must not reinvent)

Every major seam OPS-3 needs already has an in-repo precedent. The design below is assembled from them rather than invented.

| Seam | Where it exists | What OPS-3 borrows |
|---|---|---|
| **Chokepoint + provider contract** | `lib/email/send.ts` (OPS-1): one entry point, `EmailProvider` contract, SDK imported in exactly one file, non-throwing `EmailResult { status: sent\|captured\|skipped\|error, provider, id?, error? }` | The identical shape for notification delivery: one `createNotification()` entry point, per-channel adapters behind a contract, non-throwing results |
| **Typed event seam** | `lib/events/` (EV-1): `DomainEvent` union → `emitDomainEvent` (persist to `AuditLog`, tx-aware) + `dispatchDomainEvent` (best-effort handler registry, each handler try/caught, never fails the request) | The attach point for event-derived notifications: a notification handler registered per event type |
| **Facts store** | `AuditLog` (append-only, `action` string + `metadata Json`, `SetNull` on user/space delete, never cascade-deleted) | The "what happened" record. Notifications point at it; they never duplicate it |
| **Allowlist-derived user surface** | `lib/security-history.ts` (OPS-2 S1): pure config map filtering the user's own `AuditLog` rows to a safe, labeled subset | The pattern for category/policy config: a pure, unit-testable map in `lib/notifications/`, no DB enum |
| **Timestamps as state** | `User.deactivatedAt`, `deletionRequestedAt/ScheduledAt`, `SpaceInvite.seenAt`, `RecoveryCode.usedAt` | Notification lifecycle as nullable timestamps (`readAt`, `archivedAt`, `expiresAt`), not a status enum |
| **Sender identity already reserved** | `lib/email/senders.ts`: `"product-notification" → Fourth Meridian <notifications@fourthmeridian.com>` — declared in OPS-1 S0, **zero callers today** | The From identity for notification emails. It was declared for exactly this initiative |
| **Cron architecture** | `vercel.json` (3 crons: sync-banks 06:00, fetch-fx-rates 06:30, process-deletions 07:00 UTC) + `CRON_SECRET` Bearer-guarded `/api/jobs/*` routes, `maxDuration = 60`. `jobs/scheduler.ts` is explicitly dead ("Do NOT invent another scheduler" — process-deletions route) | Any OPS-3 job is a Vercel-cron `/api/jobs/*` route, same auth, same headroom |
| **Post-response background work** | D2.x Slice 2: background history via `after()` | Fan-out (email render/send, preference resolution) can run post-response without a queue |
| **Prior schema sketch** | `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` §J: one polymorphic `Notification` table, `NotificationPreference (userId, type, channel, enabled)`, and the rule that a security notification carries an `auditLogId` pointer rather than duplicating `AuditLog` | Adopted and extended below. §J's warning — don't conflate "bell-icon record" with "email send log" — becomes the `Notification` / `NotificationDelivery` split |
| **Proto-notification already shipped** | `SpaceInvite.seenAt` + the invite email (OPS-1 S3); `User.lastBriefViewedAt` + `VisitState` (`lib/brief-types.ts`) + Since-Last-Visit modal | Evidence the product already wants notification semantics; the invite is the natural first producer |
| **Settings home** | UX-1 Phase 2 (`docs/investigations/UX1_PHASE2_SETTINGS_ARCHITECTURE_REFINEMENT.md`): directory index; `/dashboard/settings/notifications` is **created only when OPS-3 begins** — one directory line, no placeholder today | OPS-3 ships the route, its first preference, and the directory entry in the same slice |

One naming note: the UX-1 docs and OPS-2 investigation confirm the roadmap chain OPS-1 → OPS-2 → **OPS-3 Notifications & Preferences** → OPS-4 Background Jobs & Scheduling → OPS-5 Platform Operations. Several hard problems below (retries, per-timezone scheduling, queues) are deliberately fenced to OPS-4 — the same fence OPS-2 S7 used ("Background worker (BullMQ/queue): Reject… explicitly an OPS-4 concern").

---

## 1. Notification model

### 1.1 First-class object, two tables

A notification is **"does this user need a ping, and did we reach them"** — two different lifecycles, so two tables:

- **`Notification`** — the per-recipient, in-app record. Owns read/archive state. This row *is* the in-app delivery.
- **`NotificationDelivery`** — one row per *external* channel attempt (email now; push/SMS/webhook later). Owns provider outcome, retries, opens/clicks. This is the OPS-5 observability surface (§10) and mirrors `EmailResult` exactly.

No delivery row is written for the in-app channel — the `Notification` row's own timestamps carry that state. This keeps the common case (bell-only notification) one insert.

### 1.2 Proposed minimum schema (proposal only — nothing lands in this investigation)

```prisma
enum NotificationPriority {
  LOW        // digest-foldable, no badge urgency
  NORMAL     // default
  HIGH       // sync failed, goal risk
  CRITICAL   // security, account lifecycle — cannot be muted
}

model Notification {
  id         String                @id @default(cuid())
  userId     String                // recipient — always a single user
  user       User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  spaceId    String?               // optional Space context
  space      Space?                @relation(fields: [spaceId], references: [id], onDelete: SetNull)

  category   String                // NotificationCategory constant (lib/notifications/categories.ts)
  type       String                // fine-grained key, e.g. "PASSWORD_CHANGED" — same vocabulary as AuditLog.action where one exists
  priority   NotificationPriority  @default(NORMAL)

  title      String
  body       String?               @db.Text
  href       String?               // in-app destination, e.g. "/dashboard/settings/security"
  metadata   Json?                 // type-specific pointers: { inviteId, plaidItemId, adviceId, batchId, ... }
  auditLogId String?               // soft ref to the AuditLog fact (soft, like User.preferredSpaceId — AuditLog is append-only forensics; no FK coupling)

  readAt     DateTime?             // null = unread
  archivedAt DateTime?             // null = live in the feed
  expiresAt  DateTime?             // null = never expires; past = hidden from all queries
  createdAt  DateTime              @default(now())

  deliveries NotificationDelivery[]

  @@index([userId, archivedAt, createdAt])  // feed + history
  @@index([userId, readAt])                 // unread badge count
  @@index([category, createdAt])            // OPS-5 / ops queries
}

model NotificationDelivery {
  id                String       @id @default(cuid())
  notificationId    String
  notification      Notification @relation(fields: [notificationId], references: [id], onDelete: Cascade)
  channel           String       // "EMAIL" now; "PUSH" | "SMS" | "WEBHOOK" later — string, not enum, so channels add without migration
  status            String       // "sent" | "captured" | "skipped" | "error" — mirrors EmailResult verbatim
  provider          String?      // "resend" | "capture" — from EmailResult.provider
  providerMessageId String?      // EmailResult.id
  error             String?      // EmailResult.error
  attempts          Int          @default(1)
  deliveredAt       DateTime?    // set when status = "sent"
  openedAt          DateTime?    // reserved — populated by provider webhooks later (Resend supports open/click events); no consumer in OPS-3
  clickedAt         DateTime?    // reserved — same
  createdAt         DateTime     @default(now())

  @@index([notificationId])
  @@index([channel, status, createdAt])     // OPS-5: failure-rate queries
}
```

Design decisions and their grounding:

- **`userId` cascades; `auditLogId` is a soft ref.** Notifications are the user's inbox — they die with the account (unlike `AuditLog`, which is `SetNull`-anonymized platform forensics). This split is exactly why the notification must *point at* the audit row rather than be one: different retention, different PII posture (DATABASE_ARCHITECTURE_REVIEW §J made the same call). Soft ref (no FK) follows the `User.preferredSpaceId` precedent and keeps `AuditLog` free of inbound FK coupling.
- **Lifecycle = nullable timestamps, not a status enum.** `readAt` / `archivedAt` / `expiresAt` compose (an archived notification keeps its read state; an expired one keeps both) and match the repo's uniform idiom (`deactivatedAt`, `seenAt`, `usedAt`, `resolvedAt`). A status enum would force lossy transitions.
- **`category` and `type` are strings validated by a pure config module**, not DB enums — the `AuditLog.action` / `lib/audit-actions.ts` pattern. Adding a producer must never require a migration.
- **"Dismissed" is not a column.** In v1, dismissing from the bell = archiving (`archivedAt`). A distinct dismissed state (hidden from feed but not archived) has no behavioral difference worth a column yet; adding `dismissedAt` later is additive. Recorded as an open decision (§12) so the UI slice makes it consciously.
- **No `updatedAt`** — every mutation is a timestamp set; the row is otherwise immutable.

### 1.3 Status lifecycle

```
created ──► unread (readAt = null)
              │  user opens panel item / clicks through
              ▼
            read (readAt set)
              │  user archives · or auto-archive after N days read (cleanup job, §9)
              ▼
            archived (archivedAt set)          ──► deleted by cleanup job after retention (e.g. 90 days archived)
expiresAt passes at ANY stage ──► expired: excluded from every user-facing query (WHERE expiresAt IS NULL OR expiresAt > now()); rows reaped by cleanup job
```

Priority does not gate lifecycle; it gates **defaults** (badge emphasis, whether email is on by default, whether the category is mutable — §4).

---

## 2. Notification producers — complete inventory

Legend: **substrate** = the code/model that already establishes the fact; **wave** = producer migration wave (§11). Default channels shown as in-app / email (push does not exist in OPS-3).

### 2.1 Account & security — `category: ACCOUNT_SECURITY` · CRITICAL · mandatory (not mutable)

Every one of these already writes an `AuditLog` row, and most already send a `security-alert` email inline. OPS-3 adds the in-app record **alongside** the existing email calls — it does not rewrite them (§7, §11).

| Type | Substrate (evidence) | Email today? |
|---|---|---|
| `PASSWORD_CHANGED` | `app/api/user/password/route.ts` | ✅ security-alert |
| `PASSWORD_RESET` (completed) | `app/api/auth/reset-password/route.ts` | ✅ security-alert |
| `EMAIL_CHANGE_REQUESTED` | `app/api/user/email/request/route.ts` (alert to old address) | ✅ security-alert + confirm link |
| `EMAIL_CHANGE_COMPLETED` | OPS-2 S3b confirm consumer | (sessions revoked) |
| `EMAIL_VERIFIED` | `AuditAction.EMAIL_VERIFIED` | — |
| `TWO_FACTOR_ENABLED / DISABLED / RESET` | `AuditAction.TWO_FACTOR_*` | — |
| `RECOVERY_CODE_USED / CODES_REGENERATED` | `AuditAction.RECOVERY_*` | — |
| `SESSION_REVOKED` | `AuditAction.SESSION_REVOKED` | — |
| `ACCOUNT_DEACTIVATED` | `app/api/user/deactivate/route.ts` | ✅ security-alert |
| `ACCOUNT_REACTIVATED` | `lib/auth.ts` reactivation leg | ✅ security-alert |
| `ACCOUNT_DELETION_REQUESTED` | `app/api/user/delete/route.ts` | ✅ security-alert |
| `ACCOUNT_DELETION_CANCELLED` | `lib/auth.ts` cancel-deletion leg | ✅ security-alert |
| `DATA_EXPORTED` | `app/api/user/export/route.ts` | ✅ security-alert |

(`ACCOUNT_DELETED` / purge sends a final email but can create no in-app notification — the user row is gone. Email-only by nature.)

### 2.2 Spaces — `category: SPACES` · NORMAL · mutable

| Type | Substrate | Notes |
|---|---|---|
| `SPACE_INVITE_RECEIVED` | `SpaceInvite` row + `MemberInvited` domain event + invite email (`app/api/spaces/[id]/invite/route.ts`) | **The natural first producer** — `SpaceInvite.seenAt` shows the product already wanted this ping; §J called it the trigger for building notifications at all. Metadata: `{ inviteId }`; expire with `SpaceInvite.expiresAt` |
| `SPACE_INVITE_ACCEPTED` | `MemberJoined` event (EXERCISED) | To the inviter |
| `MEMBER_REMOVED` | `MemberRemoved` event (EXERCISED) | To the removed user |
| `MEMBER_ROLE_CHANGED` | `MemberRoleChanged` event (EXERCISED) | To the target user |
| `OWNERSHIP_TRANSFERRED` | **Does not exist yet** — OPS-2 S7 explicitly deferred the ownership-transfer flow | Inventory entry only; producer ships with that feature, not OPS-3 |

### 2.3 Financial — `category: FINANCIAL` · HIGH (failures) / LOW (completions) · mutable

| Type | Substrate | Default |
|---|---|---|
| `SYNC_FAILED` | `PlaidItemStatus` error states; `SyncIssue` table (D2.x M1); `jobs/sync-banks.ts` | in-app ✅ email ✅ (actionable: reconnect) |
| `SYNC_COMPLETED` | `ConnectionSynced` event (EXERCISED, Slice 4) | **off by default** — fires daily per item; noise. The `/dashboard/connections` hub already surfaces this state |
| `DUPLICATE_DETECTED` | `DuplicateAccountCandidate` `PENDING` rows | in-app ✅ (links to review) |
| `IMPORT_COMPLETED` | `ImportBatch.status` → `COMPLETED` / `COMPLETED_WITH_ERRORS` | in-app ✅; `_WITH_ERRORS` at HIGH |

### 2.4 AI — `category: AI` · NORMAL/LOW · mutable — **producers are v2.6b, rails are OPS-3**

Per STATUS.md, Daily Brief *generation* and richer AI analysis are explicitly deferred to v2.6b (Ambient Intelligence). OPS-3 builds the delivery layer they will use (§6); it ships **no AI producer**.

| Type | Future substrate |
|---|---|
| `DAILY_BRIEF_READY` | brief pipeline (today: on-demand `app/api/brief` + `lastBriefViewedAt`; `jobs/run-ai-advice.ts` is an empty stub) |
| `OPPORTUNITY_FOUND` | `AiAdvice` (`riskLevel`, `actionReady`) — metadata `{ adviceId }`, content stays in `AiAdvice` |
| `UNUSUAL_SPENDING` | future anomaly detection over `Transaction` (FlowType corpus is certified — DESYNC) |
| `GOAL_RISK` | `SpaceGoal` / `GoalCheckIn` |
| `DEBT_ALERT` | `DebtProfile`, `lib/debt.ts` |

### 2.5 Platform — `category: PLATFORM` · NORMAL · mutable — admin-authored

| Type | Substrate |
|---|---|
| `MAINTENANCE` | none today (`PlatformSetting` is a key-value store, not an announcement system). Admin-authored broadcast; `expiresAt` set to the maintenance end |
| `NEW_FEATURE` | none — admin-authored |
| `POLICY_UPDATE` | none — admin-authored |

Broadcast fan-out (one row per user at send time vs. a broadcast table joined per user) is an open decision (§12); at beta scale, simple fan-out wins.

---

## 3. Delivery architecture

Mirror OPS-1's seam exactly — one chokepoint, adapters behind a contract, SDKs never imported outside their adapter:

```
lib/notifications/
  types.ts        pure types: NotificationInput, ChannelResult, ChannelAdapter contract   (≈ lib/email/types.ts)
  categories.ts   category + type constants, labels, priority & default-channel policy    (≈ lib/audit-actions.ts + lib/security-history.ts)
  notify.ts       THE chokepoint: createNotification(input)                               (≈ lib/email/send.ts)
  channels/
    in-app.ts     writes the Notification row (the only mandatory "channel")
    email.ts      delegates to lib/email/send.ts — sendEmail("notification", …); writes a NotificationDelivery row from the EmailResult
```

`createNotification()` pipeline: validate type against the registry → resolve recipient preferences (§4) → insert `Notification` (in-app, unless the category's policy routes it elsewhere only) → for each enabled external channel, deliver and record a `NotificationDelivery`. **Non-throwing end to end** — returns a result object; a notification failure must never fail the originating request (the `EmailResult` / dispatch-handler contract). External-channel work may run post-response via `after()` (D2.x precedent).

Channel separation:

- **in-app** — the `Notification` insert itself. Always available.
- **email** — *reuses* the OPS-1 chokepoint; one new `"notification"` template (title/body/href → subject/text) with `sender: "product-notification"` — the identity reserved unused in `lib/email/senders.ts` since OPS-1 S0. Security-alert emails keep their existing template and support@ identity. **No second email path is built.**
- **push / SMS / webhook** — declared as channel string values in the vocabulary and preference matrix only. **No adapter files, no stub code** — an unimplemented channel simply has no adapter registered, and the policy map marks it unavailable. (This is the no-placeholder way to reserve them: the seam is the `ChannelAdapter` contract, not dead files.)

---

## 4. Preference architecture

**Per category × per channel — both.** Per-type preferences (40+ rows of toggles) are unmanageable; per-channel-only can't express "brief in-app but not email" — which is exactly the ticket's own example. The category × channel matrix is also §J's sketch, upgraded from `type` to `category`.

```prisma
model NotificationPreference {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  category  String   // NotificationCategory constant
  channel   String   // "IN_APP" | "EMAIL" (| "PUSH" later)
  enabled   Boolean
  updatedAt DateTime @updatedAt

  @@unique([userId, category, channel])
}
```

**Default-by-absence:** a row exists only when the user overrides the default. Defaults live in the pure policy map in `lib/notifications/categories.ts` — per category: default-enabled channels, priority, and a `locked` flag. Resolution: `locked` → forced on; row present → row wins; else → policy default. Benefits: no per-user seeding migration, new categories get sane defaults for every existing user instantly, and the policy is unit-testable config (the `security-history.ts` pattern).

**Mandatory categories:** `ACCOUNT_SECURITY` is `locked` — the security-alert emails OPS-2 ships are not opt-out, and the in-app mirror shouldn't be either. UI renders these checked-and-disabled with a "security notifications can't be turned off" note.

**Digest / quiet hours / timezone** (see §8 for placement):

- `User.timezone String?` — the one new User column this initiative should add (in the preferences slice). Nothing in the tree stores a timezone today, and digests, quiet hours, *and* the existing Daily Brief greeting logic all eventually need it. General preference → lives on Preferences, not Notifications.
- Digest prefs (`digestFrequency: none | daily | weekly`) — deferred to the digest slice (S6); a column or a preference row decided then. No digest exists to configure before the job exists.
- **Quiet hours — recommend deferring past OPS-3 v1.** Honest reason: quiet hours require *delayed delivery* (hold the email, send at 08:00), and there is no queue and no scheduler-with-state — that is OPS-4 by the project's own fence. Faking it by dropping (not delaying) violates user expectation. Ship the timezone foundation now; ship quiet hours when OPS-4 gives them a mechanism.

---

## 5. Notification Center UX & lifecycle

**Recommendation: bell in the shell chrome** (`components/ui/DashboardChrome.tsx` / `Sidebar.tsx` / `BottomNav.tsx` are the existing surfaces; exact placement is the UI slice's call) → **panel** (unread + recent, mark-read, archive, mark-all-read) → **full history page** at `/dashboard/notifications` (paginated, filter by category, archived visible).

Aging — recommended lifecycle:

- **Notifications don't silently disappear; they age out via archive.** Feed shows non-archived, non-expired. Read items auto-archive after **30 days**; archived items are deleted after **90 days** (cleanup job, §9). Numbers are policy-map constants, tunable without migration.
- **Expiration is for content with a shelf life** (`MAINTENANCE`, invites mirroring `SpaceInvite.expiresAt`). Expired = hidden everywhere immediately, reaped later.
- **Unread badge** = count of unread, unexpired, non-archived — served by the `[userId, readAt]` index.
- Read semantics: opening the panel does **not** mark all read; clicking an item (or explicit mark-read / mark-all-read) does. Per-item state is what makes CRITICAL items un-missable.
- No real-time push in v1: badge fetch piggybacks on navigation/polling. WebSockets/SSE are out of scope (nothing in the tree does server push; Vercel serverless makes it non-trivial) — recorded as future work, likely alongside push (OPS-4+).

Security History does not change — it remains the audit-derived forensic surface on Security; the bell is ephemeral awareness. Same fact, two purposes, connected by `auditLogId`.

---

## 6. Ambient Intelligence compatibility

The rule that makes OPS-3 future-proof is the same one OPS-1 established for email: **one chokepoint, no bypass.** Codify: *an AI agent may only reach a user through `createNotification()`* — never a direct email call, never a bespoke table.

What v2.6b then gets for free, with zero notification-layer redesign:

- **Recommendations / opportunities** — `category: AI`, `type: OPPORTUNITY_FOUND`, `metadata: { adviceId }` pointing at `AiAdvice` (which already carries `riskLevel` / `actionReady`). Content lives in `AiAdvice`; the notification is the ping — the exact `auditLogId` discipline applied to AI.
- **Daily Brief digest** — `DAILY_BRIEF_READY` at LOW priority, foldable into the digest email (§9). `lastBriefViewedAt` already gives read-tracking a precedent.
- **Anomalies / goal risk / debt alerts** — HIGH priority types under `AI`, riding preference enforcement, quiet-hour semantics (when they exist), and OPS-5 observability with no new machinery.
- **Attribution** — `metadata.agentId` (the `AiAgent` model is one-per-Space already); an explicit `agentId` column is an additive later migration if querying by agent becomes real.
- **User control from day one** — the AI category row in the preference matrix means users can mute AI pings the day the first agent ships, not after a redesign.

The AI category is defined in the vocabulary in OPS-3 but has **zero producers** until v2.6b — a declared constant is vocabulary, not a placeholder implementation.

---

## 7. Event architecture — how notifications get created

Four options were on the table; the tree itself argues the answer:

| Option | Verdict |
|---|---|
| Derived from audit events (scan/poll `AuditLog`) | **Reject.** No queue or poller exists; `AuditLog.metadata` shapes predate any notification contract; `SetNull` anonymization breaks recipient resolution; polling adds latency and a new moving part. |
| Derived from platform facts (scan `SyncIssue`, `DuplicateAccountCandidate`…) | **Reject as the general mechanism.** Same polling problem. (Fact tables remain the *substrate* the in-request producer reads, and dedupe anchors.) |
| Generated independently (each route hand-rolls inserts) | **Reject.** That's the pre-OPS-1 email world the chokepoint pattern exists to prevent. |
| **Generated at the moment of the fact, through the chokepoint — attached to the EV-1 seam where it exists, called directly where it doesn't** | **Recommend.** |

Concretely:

1. **Producer already emits a typed `DomainEvent`** (invites, membership, sync — §2 marks them EXERCISED): register a notification handler in the EV-1 `HANDLERS` registry. Dispatch is already best-effort, post-commit-safe, and isolated — a notification failure can never fail the request. This is precisely what the seam was built for; the snapshot handler proves the pattern.
2. **Producer not yet on EV-1** (all OPS-2 account/security routes write `AuditLog` + `sendEmail` inline): call `createNotification()` inline next to the existing calls — the exact idiom those routes already use for email. Migrating them onto EV-1 is EV-1's own producer-migration track, not an OPS-3 prerequisite; the chokepoint call site moves with them when they migrate.
3. **Scheduled/derived producers** (digests, future AI) call the chokepoint from their jobs.

One seam detail for the implementation plan: `emitDomainEvent` doesn't currently return the created `AuditLog` row id, so an EV-1-attached handler can't populate `auditLogId` without a small additive change (return the id, or thread it through dispatch). Inline call sites can capture it directly. Either resolution is minor; flagged so it's decided consciously, not discovered mid-slice.

---

## 8. Settings integration (UX-1)

UX-1 Phase 2 already decided the seam, and OPS-3 should follow it exactly: **notifications get their own Settings page**; the directory gains one line. Phase 2 §5 explicitly reversed the placeholder route — `/dashboard/settings/notifications` is created *by* OPS-3, route + first preference in the same slice, per-page loader in `lib/settings/loaders.ts` (`getNotificationPreferences()`), matching the established per-page-loader architecture.

What belongs where:

| Surface | Contents |
|---|---|
| **Settings → Notifications** (new, OPS-3) | The category × channel preference matrix (checked-disabled for locked `ACCOUNT_SECURITY`) · digest preferences (when S6 lands) · quiet hours (when OPS-4 enables them) · default-channel behavior notes |
| **Settings → Preferences** (exists) | Stays "user preference *values*" per UX-1 Phase 2 §4: reporting currency, Default Space — plus **timezone** when OPS-3 adds `User.timezone`. Timezone is a general preference consumed by notifications, digests, and Brief greetings; it is not notification-specific, so it does not live on the Notifications page |
| **Settings → Security** | Unchanged. Security History stays here; the mandatory-alert note on the Notifications page can link to it |
| **Directory index** | Gains the `Notifications — What we tell you about, and where.` line — the "one-line insertion" Phase 2 designed for |

No UX-1 redesign: no changes to Account, Security, Data & Privacy, the directory pattern, or the loader architecture.

---

## 9. Background processing

Constraints from the tree: Vercel cron is the **only** scheduler (`jobs/scheduler.ts` is explicitly dead); 3 crons exist today at daily cadence; job routes are `CRON_SECRET`-guarded with `maxDuration = 60`.

| Job | Verdict | Shape |
|---|---|---|
| **Cleanup** (auto-archive read >30d, delete archived >90d, reap expired) | **Ship in OPS-3.** The only job the core system *requires* | `/api/jobs/notifications-cleanup`, daily (e.g. 07:30 UTC, after the existing chain). Bounded deletes, same idiom as `process-deletions` |
| **Daily digest** (fold LOW/unread into one email) | **Ship as the last OPS-3 slice (S6)** | `/api/jobs/send-digests`, daily fixed UTC. Honest limitation: per-user *local-morning* delivery needs hourly cron granularity — plan-dependent; v1 sends at a fixed UTC time, per-timezone delivery moves to OPS-4. Weekly digest = same job, frequency preference |
| **Reminder delivery** | **Not OPS-3.** No reminder feature exists to deliver; arrives with v2.6b producers via the same digest/cron rails | — |
| **Retry failed notifications** | **Not OPS-3 — OPS-4 by the project's own fence** (OPS-2 S7 rejected queues; D2.x deferred retry hardening to v2.5). Email is best-effort non-throwing today; failures are *recorded* (`NotificationDelivery.status = "error"`, `attempts`) so OPS-4 retries and OPS-5 dashboards need data, not redesign | — |

Cron-budget note: this adds up to 2 crons (cleanup, digests) to the existing 3. Vercel plan limits on cron count/granularity must be verified before the slice plan is finalized (the OPS-2 investigation ran the same check for `process-deletions`) — open decision §12; fallback is folding cleanup into an existing daily job's window.

---

## 10. Platform Operations (OPS-5) compatibility

OPS-5 should be a *reader*, not a schema driver. Metadata that must exist from day one — and where it lives:

| OPS-5 question | Where it already is in this design |
|---|---|
| delivery time | `NotificationDelivery.deliveredAt` / `createdAt` |
| retry count | `NotificationDelivery.attempts` (recorded now, consumed by OPS-4 retries) |
| provider | `NotificationDelivery.provider` + `providerMessageId` (straight from `EmailResult`) |
| failure reason | `NotificationDelivery.status = "error"` + `error` |
| opened / clicked | `NotificationDelivery.openedAt` / `clickedAt` — columns reserved; populated later by a Resend-webhook consumer (Resend emits open/click events). In-app equivalents: `Notification.readAt`, and click-through is measurable via `href` navigation later |
| dismissed | `Notification.archivedAt` (+ `dismissedAt` if that state is later split out) |
| volume / category mix / noise | `@@index([category, createdAt])` and `@@index([channel, status, createdAt])` make these plain aggregate queries |

Deliberately **not** built now: rollup/metrics tables, admin dashboards, alerting — that is OPS-5 itself (and the "Platform Facts → Platform Rollups" runway in STATUS.md). The invariant OPS-3 must honor is only: **never deliver through any path that skips `NotificationDelivery` bookkeeping**, so OPS-5 inherits complete data.

---

## 11. Implementation slices, migration strategy, order

Sliced like OPS-1/OPS-2: additive, behavior-neutral until wired, one migration, producers in waves.

| Slice | Contents | Migration? |
|---|---|---|
| **S0 — Vocabulary & policy** | `lib/notifications/types.ts` + `categories.ts`: category/type constants, priority, default-channel + `locked` policy map, unit tests. Pure config, zero runtime callers (the OPS-1 S0 playbook) | none |
| **S1 — Schema + chokepoint + first producer** | `Notification`, `NotificationDelivery`, `NotificationPreference` tables; `createNotification()` with the in-app channel; wire **one** producer end-to-end: `SPACE_INVITE_RECEIVED` (EV-1 handler on `MemberInvited`) | **the** OPS-3 migration (one, additive) |
| **S2 — Notification Center** | Bell + badge + panel in shell chrome; `/dashboard/notifications` history; APIs: list / unread-count / mark-read / mark-all / archive | none |
| **S3 — Preferences** | `/dashboard/settings/notifications` page + loader + directory line (the UX-1 handshake); preference resolution enforced in the chokepoint; `User.timezone` on the Preferences page | small additive (`User.timezone`) if not folded into S1 |
| **S4 — Email channel** | `"notification"` email template (`product-notification` sender); email adapter writing `NotificationDelivery`; per-category email prefs live | none |
| **S5 — Producer waves** | Wave 1 account/security (inline, alongside existing security-alert emails — **existing OPS-1/OPS-2 email flows untouched**); Wave 2 spaces (EV-1 handlers); Wave 3 financial (`SYNC_FAILED`, `DUPLICATE_DETECTED`, `IMPORT_COMPLETED`; `SYNC_COMPLETED` default-off) | none |
| **S6 — Jobs** | `notifications-cleanup` cron + `send-digests` cron + digest preference | none (vercel.json + routes) |
| **Deferred beyond OPS-3** | Push/SMS/webhook adapters · retries (OPS-4) · quiet hours (OPS-4) · per-timezone digest delivery (OPS-4) · real-time badge push · AI producers (v2.6b) · Resend open/click webhook consumer · platform-broadcast admin UI (with OPS-5's admin surface) | — |

**Migration strategy:** purely additive — three new tables + one nullable `User` column; no backfill (default-by-absence preferences need none; history starts at launch — notifications are forward-looking, unlike audit); no existing table altered; no data moved; every slice independently shippable and inert until the next wires it (the OPS-1 "zero production callers" discipline). Rollback of any slice is a no-op for existing behavior.

**Recommended order:** S0 → S1 → S2 → S3 → S4 → S5 → S6. Rationale: schema before UI (S1/S2), UI before preferences so the surface exists to configure (S2/S3), preferences before the second channel so email launches respectful of them (S3/S4), producers only when the full in-app + email + prefs path is proven on the invite producer (S5), jobs last since nothing needs cleaning until volume exists (S6). Coordination with UX-1: only S3 touches Settings; everything through S2 is independent of UX-1's remaining slices (Security/Data/cutover), so OPS-3 S0–S2 can proceed while UX-1 finishes.

---

## 12. Risks

- **Noise is the product risk, not the technical one.** A chatty bell trains users to ignore it — which poisons Ambient Intelligence's channel before it exists. Mitigations: `SYNC_COMPLETED` off by default; LOW priority digest-folded; per-category mute from day one; producer waves add categories deliberately.
- **Dual surfaces for security events.** Security History (audit-derived) and the bell (notification) both show `PASSWORD_CHANGED`. Intended — but copy must come from one place (labels in the S0 policy module) or the surfaces drift.
- **Dual write without a transaction.** Route writes `AuditLog` (in tx) and notification (best-effort, possibly post-commit) — a crash can yield a fact with no ping. Acceptable: notifications are best-effort awareness by contract (same risk OPS-1 accepted for email); never the inverse (notification without fact), since the fact is written first.
- **Fan-out cost of platform broadcasts.** One row per user is fine at beta scale but is a write-amplification cliff later. Contained: broadcast is one producer behind the chokepoint; swapping its storage later doesn't touch the rest.
- **Cron budget / granularity on the current Vercel plan** (§9). Verify before S6; fallback is job-folding.
- **In-request latency.** Preference resolution + inserts + email render on hot paths (login legs in `lib/auth.ts`). Mitigate with `after()` for external channels and a single-query preference read; the in-app insert is one indexed write.
- **`User` model bloat.** Only `timezone` is added; digest/quiet-hours settings go to preference rows, not columns.
- **EV-1 coverage gap.** Most account/security producers aren't on the event seam, so S5 Wave 1 is inline calls — more call sites to migrate when EV-1 producer migration reaches them. Accepted: it mirrors exactly how email landed, and both migrate together later.

## 13. Open decisions

1. **Dismissed vs archived** — ship v1 with archive-only (recommended), or add `dismissedAt` in the S1 migration for feed-hide-without-archive?
2. **`auditLogId` plumbing** — extend `emitDomainEvent` to return the created row id, or leave EV-1-derived notifications without the pointer until needed?
3. **Broadcast storage** — per-user fan-out rows (recommended at current scale) vs. a broadcast table + per-user read state?
4. **Vercel cron budget** — confirm plan limits for 2 additional daily crons; decide standalone vs. folded cleanup.
5. **Digest timing v1** — fixed UTC hour (recommended) vs. blocking on per-timezone delivery.
6. **Retention numbers** — 30-day auto-archive / 90-day delete are proposals; confirm against the product's data-retention posture (Data & Privacy page copy).
7. **Badge freshness** — poll interval / fetch-on-navigation for v1; when (if ever) real-time push is worth its infrastructure.
8. **`SYNC_COMPLETED` existence** — default-off preference (recommended) vs. not creating rows at all and letting `/dashboard/connections` remain the sole surface.

---

*Investigation only — stop here. No implementation begun.*
