# OPS-3 — Notifications & Preferences · Implementation Plan (FROZEN)

**Date:** 2026-07-07 · **Status:** DESIGN FROZEN — planning document only; no implementation begun.
**Supersedes/consolidates:** `OPS3_NOTIFICATIONS_PREFERENCES_INVESTIGATION.md` (baseline) · `OPS3_ARCHITECTURE_REVIEW.md` (second pass) · `OPS3_SOURCEEVENTID_OWNERSHIP_REVIEW.md` (ownership ruling). Where those documents disagree, **this plan is the ruling of record.**
**House rules honored:** one migration per schema-owning slice · additive-only · behavior-neutral until wired · no placeholders (columns require writers; constraints reserved at birth) · STATUS.md updated only by implementation PRs, never by this document.

---

## 1. Frozen design decisions

| # | Decision | Source |
|---|---|---|
| F1 | **Single notification registry** — `lib/notifications/registry.ts`, one typed `const` entry per notification type (widget-registry contract: adding a type = one entry, no switch edits). Entry carries: id, category, priority, default channels, `locked`, per-type retention, `digestable`, dedupe strategy + key template, icon key, title/body render refs, **metadata pointer contract** | Review §3, ruling 3 |
| F2 | Registry ids follow the **PO1 P0 grammar** (`DOMAIN_OBJECT_EVENT`, past-tense SCREAMING_SNAKE) and **cite** canonical/audit ids rather than coining synonyms; legacy grammar mapped, never renamed | Review §3; Rev B R.2 |
| F3 | **`dedupeKey` ships in S1 with `@@unique([userId, dedupeKey])`** — constraint reserved at birth (retrofit onto a populated table = expensive backfill). v1 implements the `suppress` strategy only; `none`/`refresh` are registry vocabulary | Review §4, ruling 4 |
| F4 | **No `sourceEventId`** — no substrate, no writer, no owner; instance lineage belongs to whichever initiative builds an instance store | Ownership ruling §6 |
| F5 | **`auditLogId` (soft ref)** links notifications to audited facts — `AuditLog` is the platform's only event-instance store | Baseline §1.2; ownership ruling |
| F6 | **Metadata pointer contracts per type** — each registry entry documents its `metadata Json` shape (e.g. `SYNC_FAILED → { plaidItemId }`, `OPPORTUNITY_FOUND → { adviceId }`); future stores' ids (job-run ids, PO instance ids) ride in as JSON keys with zero migration; column promotion only when an indexed query exists | Ownership ruling §3-D |
| F7 | **No new cron slots unless the PF1 dispatcher exists.** Cleanup folds into an existing daily cron's window (the bounded best-effort `process-deletions` idiom); digests wait for the dispatcher | Review §7.1, ruling 5 |
| F8 | Three-table model: `Notification` / `NotificationDelivery` / `NotificationPreference`; `AuditLog` untouched; in-app channel = the `Notification` row itself (asymmetry documented in module header) | Baseline §1; review §2 |
| F9 | Lifecycle = nullable timestamps (`readAt`, `archivedAt`, `expiresAt`); **no `dismissedAt`** — dismiss is a UI alias for archive (decision closed) | Baseline §1.3; review §7.1 |
| F10 | **No `openedAt`/`clickedAt` in S1** — deferred to the Resend-webhook consumer (columns are cheap later; principle: reserve constraints, defer columns) | Review ruling 6 |
| F11 | Preferences: category × channel, default-by-absence, `locked` for `ACCOUNT_SECURITY`; quiet hours deferred to OPS-4 (delay-not-drop needs a mechanism); `User.timezone` is the one new User column | Baseline §4 |
| F12 | **Chokepoint invariant:** every subsystem, including AI, reaches users only via `createNotification()`. Named bypasses (exhaustive): ceremony emails (suppression would break a user-initiated flow), post-purge email (no user row), operator alerting (PO track, tenant-blind), interactive request/response surfaces. Grep-enforced: `db.notification.create` appears only in `lib/notifications/` | Review §5 |
| F13 | **The digest is itself a notification** (own registry entry) delivered through the chokepoint; folded items record `metadata.digestedIn`; `digestable` declared per type at S0 | Review §7.2, ruling 9 |
| F14 | **Trust boundary:** notifications are Product Operations (tenant-scoped). OPS-5/Platform Operations reads delivery **metadata only** — never `title`/`body`. Stated in schema comments | Review §1.2, ruling 7 |
| F15 | Email channel delegates to the OPS-1 `sendEmail()` chokepoint; one `"notification"` template; `product-notification` sender identity (reserved since OPS-1 S0). Existing security-alert/ceremony emails untouched. Push/SMS/webhook are vocabulary only — no adapter files | Baseline §3 |
| F16 | Retries are OPS-4; `NotificationDelivery` error rows + `attempts` are the outbox-shaped substrate. Rollups/dashboards are POR1/OPS-5; OPS-3 ships raws only | Baseline §9–10; review §6 |

## 2. Proposed schema (frozen shape — lands in S1; reproduced here as the single reference)

```prisma
enum NotificationPriority { LOW NORMAL HIGH CRITICAL }

model Notification {
  id         String                @id @default(cuid())
  userId     String                // recipient; Cascade — the user's inbox dies with the account
  user       User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  spaceId    String?
  space      Space?                @relation(fields: [spaceId], references: [id], onDelete: SetNull)

  category   String                // registry-validated (F1); string, never a DB enum
  type       String                // registry id, PO1 P0 grammar (F2)
  priority   NotificationPriority  @default(NORMAL)

  title      String
  body       String?               @db.Text
  href       String?
  metadata   Json?                 // shape per registry pointer contract (F6)
  auditLogId String?               // soft ref (F5) — no FK; AuditLog is append-only forensics
  dedupeKey  String?               // condition identity, template per registry entry (F3)

  readAt     DateTime?
  archivedAt DateTime?
  expiresAt  DateTime?
  createdAt  DateTime              @default(now())

  deliveries NotificationDelivery[]

  // OPS-5 reads aggregates over these; never title/body (F14).
  @@unique([userId, dedupeKey])              // NULLs distinct — keyless rows unconstrained
  @@index([userId, archivedAt, createdAt])   // feed + history
  @@index([userId, readAt])                  // unread badge
  @@index([category, createdAt])             // ops aggregates
}

model NotificationDelivery {
  id                String       @id @default(cuid())
  notificationId    String
  notification      Notification @relation(fields: [notificationId], references: [id], onDelete: Cascade)
  channel           String       // "EMAIL" now; others are vocabulary (F15)
  status            String       // "sent" | "captured" | "skipped" | "error" — EmailResult verbatim
  provider          String?
  providerMessageId String?
  error             String?
  attempts          Int          @default(1)
  deliveredAt       DateTime?
  createdAt         DateTime     @default(now())
  // openedAt / clickedAt arrive with the Resend-webhook consumer (F10).

  @@index([notificationId])
  @@index([channel, status, createdAt])
}

model NotificationPreference {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  category  String
  channel   String
  enabled   Boolean
  updatedAt DateTime @updatedAt

  @@unique([userId, category, channel])      // rows are overrides only (default-by-absence)
}

// + User.timezone String?   (S3; consumed by digests and future Brief/quiet-hours work)
```

Lifecycle: unread → read → archived (auto-archive/delete per **per-type registry retention**, defaults 30/90 days); `expiresAt` hides at any stage. Dedupe `suppress`: insert is a no-op while an un-archived row with the same key exists; keys carry a `:open`-style suffix retired when the condition resolves, so a new outage notifies again.

---

## 3. Slice breakdown

### S0 — Registry & doctrine *(pure config; zero runtime callers; no migration)*

- `lib/notifications/types.ts` — `ChannelAdapter` contract, `NotificationInput`, result types (the `lib/email/types.ts` shape).
- `lib/notifications/registry.ts` — the F1 registry, typed `const … satisfies`, `NotificationTypeId = keyof typeof REGISTRY`. Seed entries for every §2-inventory type in the baseline (entries for unshipped producers are *vocabulary*, exercised only when their wave lands — the EV-1 PROVISIONAL/EXERCISED idiom, marked as such).
- Module-header doctrine: chokepoint invariant + the four named bypasses + ceremony/awareness test (F12) · in-app delivery asymmetry (F8) · metadata-only OPS-5 boundary (F14) · note for PO1 P1 that `createNotification()` is a telemetry-chokepoint candidate.
- Unit tests: registry shape exhaustiveness; grammar lint (ids match `DOMAIN_OBJECT_EVENT` pattern); locked categories have email enabled; every entry declares a pointer contract (may be `{}`).
- **Gate:** type-checks; tests green; zero runtime diff (nothing executes).
- **Dependency note:** if PO1 P0 has landed, reconcile ids into its registry; if not, follow its published grammar and reconcile when it lands (Rev B R.2 permits this explicitly).

### S1 — Schema + chokepoint + first producer *(THE OPS-3 migration — one, additive)*

- Migration: the §2 tables, exactly. Nothing else. `AuditLog` untouched.
- `lib/notifications/notify.ts` — `createNotification()`: validate type against registry (unknown → throw at producer, the `emitDomainEvent` idiom) → resolve preferences (F11; policy defaults, `locked` forced) → dedupe check (F3, `suppress` only) → insert `Notification` → external channels post-response via `after()` (none enabled until S4). Non-throwing to callers end to end.
- `lib/notifications/channels/in-app.ts` — the insert path.
- First producer: `SPACE_INVITE_RECEIVED` via an EV-1 handler on `MemberInvited` (registered in `lib/events/emit.ts` `HANDLERS`). `metadata: { inviteId }`; `expiresAt` mirrors `SpaceInvite.expiresAt`. Resolve open decision D1 (§5) at slice entry: capture `auditLogId` by having `emitDomainEvent` return the created row id (small additive change) or ship the handler without the pointer.
- **Gate:** migration applies + rolls back clean · unit tests: dedupe suppress/reopen semantics, locked-preference forcing, unknown-type throw · inviting a user in dev produces exactly one Notification row with correct pointer contract · grep-proof: `db.notification.create` only under `lib/notifications/` · zero behavior change anywhere else.

### S2 — Notification Center *(no migration)*

- Bell + unread badge in shell chrome (`DashboardChrome`/`Sidebar`/`BottomNav` — placement decided in-slice); panel: unread + recent, mark-read, mark-all-read, archive (dismiss == archive, F9); full history at `/dashboard/notifications` (paginated, category filter, archived visible).
- APIs: list / unread-count / mark-read / mark-all / archive. All queries exclude expired rows. Badge = fetch-on-navigation/poll; no server push (decision closed — F-series review §7.3).
- **Gate:** invite flow lights the bell end-to-end · badge count matches query · expired/archived rows never render · `tsc`/build clean · mobile (BottomNav) and desktop verified.

### S3 — Preferences *(migration: `User.timezone String?` only — or folded into S1 at implementation's discretion; either way additive)*

- `/dashboard/settings/notifications` page + `getNotificationPreferences()` loader in `lib/settings/loaders.ts` + one directory-index line (the UX-1 Phase 2 handshake — no other Settings changes).
- Category × channel matrix rendered **from the registry** (locked rows checked-disabled with a note linking to Security History); writes upsert override rows only.
- Timezone field lands on the existing **Preferences** page (it is a general preference, not notification-specific).
- Chokepoint enforces preferences from this slice (before S3, only always-on defaults exist — behavior identical).
- **Gate:** toggling a category/channel provably suppresses/enables creation/delivery in dev · locked rows cannot be disabled via UI *or* API · directory shows the new entry · UX-1 pages otherwise untouched (diff-proof).

### S4 — Email channel *(no migration)*

- `"notification"` template in `lib/email/templates/` (title/body/href → subject/text; sender `product-notification`) + `lib/notifications/channels/email.ts` delegating to `sendEmail()` and writing one `NotificationDelivery` row per attempt from the `EmailResult`, verbatim.
- Runs post-response via `after()`. Existing security-alert/ceremony email calls are **not** rerouted (F12/F15).
- **Gate:** capture transport records the rendered email in test/dev · `NotificationDelivery` row matches `EmailResult` field-for-field including `error` on forced failure · email disabled by preference produces a Notification with **no** delivery row · template unit tests (OPS-1 pattern).

### S5 — Producer waves *(no migration; each wave independently shippable)*

- **Wave 1 — Account & security** (`ACCOUNT_SECURITY`, CRITICAL, locked): inline `createNotification()` beside the existing audit + security-alert email calls in the OPS-2 routes (`password`, `reset-password`, `email/request`, `deactivate`, `delete`, `export`, `lib/auth.ts` legs). Existing emails untouched; `auditLogId` captured inline.
- **Wave 2 — Spaces**: EV-1 handlers for `MemberJoined` (→ inviter), `MemberRemoved` (→ removed user), `MemberRoleChanged` (→ target). `OWNERSHIP_TRANSFERRED` remains inventory-only (its feature doesn't exist).
- **Wave 3 — Financial**: `SYNC_FAILED` (dedupe `suppress`, key `SYNC_FAILED:item:<id>:open`, resolved on successful sync) · `DUPLICATE_DETECTED` (per-run granularity — one notification per sync run's findings, count in metadata, **not** per candidate row; the collapse rule from review §7.2) · `IMPORT_COMPLETED` / `_WITH_ERRORS` (HIGH). `SYNC_COMPLETED`: **not created** — resolve open decision D2 at wave entry (recommendation: don't create rows; `/dashboard/connections` already surfaces it).
- **Gate per wave:** each producer proven in dev end-to-end (bell + email per prefs) · Wave-3 noise check: a broken item across 3 consecutive daily syncs yields exactly **one** live notification · no wave touches another wave's files.

### S6 — Scheduled work *(no migration; **no new cron slots unless the PF1 dispatcher exists** — F7)*

- **Cleanup** (auto-archive read > per-type `autoArchiveDays`; delete archived > per-type `deleteDays`; reap expired): implemented as a bounded, best-effort library function. Mounting: **(a)** PF1 dispatcher exists → register as a dispatcher job; **(b)** otherwise → invoke at the tail of an existing daily cron's handler within its `maxDuration` budget (the `process-deletions` idiom). No new `vercel.json` entry in case (b).
- **Digests**: **blocked on the dispatcher.** When available: daily job assembling unread `digestable` LOW-priority items per opted-in user into one email — *as a notification* (F13: own registry entry, delivery rows like any other, folded items get `metadata.digestedIn`). v1 sends at a fixed UTC hour; per-timezone delivery is OPS-4. Digest frequency preference ships with this slice, not before.
- **Gate:** cleanup provably prunes per-type retention in dev without touching live rows · (if digests ship) digest email observable via its own `NotificationDelivery` rows · `vercel.json` diff is empty in case (b).

### Explicitly deferred beyond OPS-3 (unchanged)

Push/SMS/webhook adapters · retries (OPS-4; substrate already recorded) · quiet hours + per-timezone digests (OPS-4) · real-time badge push · AI producers (v2.6b — vocabulary ships in S0, exercised then) · Resend open/click webhook consumer (brings `openedAt`/`clickedAt` columns with it) · platform-broadcast admin UI (with OPS-5's admin surface) · rollups/dashboards (POR1/OPS-5).

---

## 4. Order, parallelism, migration strategy

**Order: S0 → S1 → S2 → S3 → S4 → S5 → S6.** Rationale unchanged from the baseline: schema before UI; UI before preferences (a surface must exist to configure); preferences before the second channel (email launches respectful of them); producers only after the full path is proven on the invite; scheduled work last (nothing to clean before volume exists).

**UX-1 coordination:** S0–S2 are file-disjoint from UX-1's remaining slices (Security page, Data & Privacy, directory cutover) and may proceed in parallel; **S3 requires UX-1's directory index to exist** (it adds the Notifications line). Only S3 touches Settings files.

**Runway coordination:** S0 follows the PO1 P0 grammar whether or not P0 has landed (F2). S6's digest leg is the only slice with a hard external dependency (PF1 dispatcher) — everything else in OPS-3 completes without it.

**Migration strategy:** one additive migration (S1: three new tables) + one trivial additive column (S3: `User.timezone`, foldable into S1). No backfills (default-by-absence preferences; notification history starts at launch). No existing table altered. Every slice inert until the next wires it; rollback of any slice is a no-op for existing behavior.

## 5. Open decisions carried into implementation (all others closed)

- **D1 (S1 entry):** `emitDomainEvent` returns the created `AuditLog` id (small additive change) vs. EV-1-derived notifications shipping without `auditLogId`. Recommendation: return the id.
- **D2 (S5 Wave-3 entry):** `SYNC_COMPLETED` — create no rows (recommended) vs. default-off preference rows.
- **D3 (S6 entry):** verify the actual Vercel plan cron budget (the tree carries 3 crons against a PlatOps note implying a ceiling of 2); this decides nothing architectural — F7 holds either way — but informs whether case (a) or (b) applies.
- **Closed by ruling, do not reopen:** `sourceEventId` (deferred to its future owner) · `dismissedAt` (dismiss = archive) · `openedAt`/`clickedAt` (with the webhook consumer) · quiet hours (OPS-4) · real-time push (deferred) · retention numbers (per-type registry values, defaults 30/90, tunable without migration).

## 6. Exit criteria (initiative-level)

1. A Space invite, a password change, and a sync failure each produce a correct, deduplicated, preference-respecting notification observable at the bell and (where enabled) by email — with `NotificationDelivery` rows matching `EmailResult` outcomes.
2. Adding a hypothetical new notification type requires touching **exactly one file** (the registry) plus its producer call site.
3. `grep` proofs hold: notification writes single-sited; Resend SDK still single-sited; no new `vercel.json` entries without a dispatcher.
4. OPS-5 can already answer "delivery failure rate by provider, last 7 days" as a plain query over delivery metadata — without reading any `title`/`body`.
5. STATUS.md updated by the closing implementation PR (not by this document) with the OPS-3 ledger row and this plan as evidence.

---

*Planning document only — design frozen; implementation not begun.*
