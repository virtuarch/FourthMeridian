> **POINT-IN-TIME RECORD — immutable.** Architecture baseline as of 2026-06-22. Schema line references and some model claims (e.g. Holding FKs) predate D11. For current state see `STATUS.md` at the repository root.

# Phase 2 Architecture Freeze — Spaces, Connections & Marketplace Foundation

**Status: FROZEN — pending product/eng approval. Documentation only. No schema, migration, API, or application code was modified to produce this document.**

## 0. Document control

| | |
|---|---|
| Branch | `feature/phase-2-architecture` (off `fourth-meridian`) |
| Baseline tag | `v2.3.0` — Workspace → Space rename, merged into `fourth-meridian` |
| Primary source | `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` (759 lines, all 8 sections + 3 addenda read in full) |
| Reconciled against | `prisma/schema.prisma` (1053 lines, read in full — every model/enum listed in §2 below), plus `lib/plaid/encryption.ts`, `lib/audit-actions.ts`, `lib/account-privacy.ts`, `lib/accounts/reconcile.ts`, `lib/space.ts`, `lib/space-presets.ts`, `jobs/scheduler.ts`, `jobs/sync-banks.ts`, `app/api/plaid/exchange-token/route.ts`, `app/api/auth/forgot-password/route.ts`, `app/api/auth/reset-password/route.ts` |
| Out of scope this pass | Any change to `prisma/schema.prisma`, migrations, API routes, or UI. This document is the only deliverable. |

This document supersedes nothing in `DATABASE_ARCHITECTURE_REVIEW.md` — it adopts that document's conclusions, then reconciles each one against what is actually running in the codebase today. Where the two disagree, that disagreement is called out explicitly (§18) rather than silently resolved in either direction.

---

## 1. Purpose & method

Phase 1 renamed `Workspace` → `Space` end-to-end with zero schema drift (`@@map`/`@map`, one real enum-value rename). Phase 2 is the architecture for everything Spaces becomes next: multi-provider financial connections, account publication, an AI context boundary, and a Marketplace. Before any of that is built, this document fixes:

1. What already exists and is staying exactly as it is.
2. What already exists and will be retired later, but not now.
3. What is new and proposed — schema sketches to review, not to merge.
4. What is explicitly out of scope for Phase 2.
5. The rules (ownership, lifecycle, encryption, AI access) that every future table — including ones nobody has thought of yet — must obey.

Method: every claim below was checked against the live file, not assumed from the review doc. Line numbers are cited so any claim here can be re-verified in under a minute.

---

## 2. Current confirmed foundation

The platform today is **25 Prisma models** (verified via `^model ` grep against `prisma/schema.prisma`), all already renamed Workspace→Space at the Prisma-Client layer per Phase 1. Confirmed canonical foundation, in the user's own words from the governing instruction, plus exact line references:

| Model | Lines | Confirmed role |
|---|---|---|
| `Space` | 297–340 | The container. `@@map("Workspace")` — physical table name unchanged. `type` (PERSONAL/SHARED), `category` (`SpaceCategory`, 15 values incl. legacy `GOAL`), `isPublic`, archive/trash lifecycle. |
| `SpaceMember` | 351–371 | Join table, `role` (OWNER/ADMIN/MEMBER/VIEWER), `status` (ACTIVE/REMOVED/LEFT) — rows never hard-deleted. |
| `SpaceInvite` | 379–397 | Grant-only invite, no request-access path. |
| `SpaceGoal` | 709–755 | Four goal types (FINANCIAL/HABIT/SPENDING_LIMIT/DEBT_REDUCTION) in one model via nullable type-specific field groups. |
| `SpaceDashboardSection` | 808–826 | Per-Space widget layout, generated from category preset at creation (`lib/space-presets.ts`), then user-editable. |
| `SpaceSnapshot` | 900–927 | Daily pre-aggregated net-worth rollup. Stores only derived numbers, never raw rows — the load-bearing precedent for §9.3's `PublishedAccountView`. |
| `AiAgent` | 405–417 | One per Space (`spaceId @unique`), created automatically on Space creation. Currently just identity + `lastActiveAt`; no scope field (see §9.5). |
| `AiAdvice` | 935–950 | Space-scoped advice record. **Confirmed unimplemented write path** — see §18.3. |
| `AuditLog` | 976–992 | Append-only, `userId`/`spaceId` both `onDelete: SetNull` so the log survives account/Space deletion. `performedByAdminId` already exists for admin-on-behalf-of actions. |
| `FinancialAccount` | 504–571 | Canonical "one row per real-world account" model. `ownerType`/`ownerUserId`/`ownerSpaceId` already implement most of the identity-decoupling goal in §2.A of the review doc. |
| `WorkspaceAccountShare` | 650–671 | **Protected legacy table — deliberately excluded from Phase 1 naming and from any Phase 2 schema change.** See §17. |

Also confirmed current and in active use, not called out by name in the governing instruction but load-bearing for everything below: `User` (232–285), `AccountConnection` (610–633), `DebtProfile` (582–598), `Holding` (833–852), `Transaction` (867–892), `GoalCheckIn` (762–771), `GoalContribution` (779–792), `CreditScore` (958–968), `RecoveryCode` (1002–1013), `UserSession` (1024–1038), `PlatformSetting` (1047–1052).

Two models exist in the schema today that occupy a special, unsettled status — `Account` (legacy) and `DuplicateAccountCandidate`. They are covered in §8 and §18, not listed as plain "current foundation," because their actual behavior diverges from how the schema and review doc describe them.

---

## 3. Canonical entity model — tables to keep

These 22 models are structurally final for Phase 2. No renames, no new columns required to ship the items in §9, no retirement plan. (Total: 25 current models − 3 in §8's retire-later list.)

**Identity** — `User`, `UserSession`, `RecoveryCode`, `AuditLog`, `PlatformSetting`

**Spaces** — `Space`, `SpaceMember`, `SpaceInvite`, `SpaceDashboardSection`

**Financial** — `FinancialAccount`, `AccountConnection`, `DebtProfile`, `Holding`, `Transaction`, `SpaceGoal`, `GoalCheckIn`, `GoalContribution`, `CreditScore`, `SpaceSnapshot`, `DuplicateAccountCandidate`*

**Platform / AI** — `AiAgent`, `AiAdvice`

\* `DuplicateAccountCandidate` is listed here because neither the user's governing instruction nor the review doc places it on a retire/replace list — by elimination it stays. See §18.1 for why "keep" should not be read as "no action needed": it is currently dead code, and that needs a decision, just not a schema change.

New work in §9 attaches to this set (e.g. `SpaceAccountLink` sits alongside `WorkspaceAccountShare`, `Connection` sits alongside `PlaidItem`) rather than modifying it.

---

## 4. Ownership model

Confirmed mechanism (`FinancialAccount`, 504–571; `AccountOwnerType` enum, 169–172):

- `ownerType: USER | SPACE` — exactly one of `ownerUserId` / `ownerSpaceId` is populated, the other null.
- `USER`-owned accounts are visible only to that user until explicitly shared via `WorkspaceAccountShare`.
- `SPACE`-owned accounts (e.g. a joint or business account) belong to the Space directly — every member sees it per their role's read permission, no separate share row needed.
- `AccountOwnerType.SPACE` is a real `ALTER TYPE ... RENAME VALUE` migration from the Phase 1 rename (renamed from `WORKSPACE`) — metadata-only in Postgres, already applied, not part of Phase 2.

Space-level access is resolved exclusively through `lib/space.ts`'s `resolveSpaceContext()` (167–246): membership lookup → personal-Space fallback → any-active-membership fallback, with an explicit, code-commented guarantee that **`SYSTEM_ADMIN` gets no bypass** — an admin with no Space memberships throws, the same as any other user. Roles derive fixed permissions (`canInvite`/`canManage`/`canWrite`/`canRead`/`isOwner`) via `derivePermissions()` (59–67); there is no per-resource ACL layer beneath role.

**Gap confirmed (matches review doc §2.A):** when `ownerType = SPACE`, there is no required human-accountable `createdByUserId` independent of the visibility owner. Carried into §19 as an open decision, not resolved here — it's an additive, low-risk column whenever it's prioritized.

**Confirmed unresolved (matches review doc §2.G):** no role check gates Space *creation* by category, and no `isInternal` flag or internal-ops `SpaceCategory` value exists. Any authenticated user can create a Space of any category today. Not a Phase 2 blocker — internal-ops Spaces are deferred (§10) — but noted because it means the ownership model has no separate tier for platform-operated Spaces yet.

---

## 5. Provider / connection / account lifecycle — current state

This is the pipeline that §9.1's new tables extend, not replace. Confirmed shape, end to end:

1. **Credential.** `PlaidItem` (426–445) holds one encrypted OAuth token per institution, owned by `User`. `AccountConnection` (610–633) is the existing generalization point: it links a `FinancialAccount` to its origin (Plaid item today; `walletAddress`/manual implicitly via null `plaidItemDbId`), carries `isCanonical` (authoritative balance source) and `syncStatus`, and already supports **multiple connections to one `FinancialAccount`** (e.g. two spouses both holding Plaid access to the same joint account) — this is more capable than the review doc's framing suggests; it is not a thin join table.
2. **Import.** `app/api/plaid/exchange-token/route.ts` (380 lines, read in full): on every Link flow, Plaid-reported accounts are turned directly into `FinancialAccount` + `AccountConnection` + `WorkspaceAccountShare` rows in the same request. **Confirmed: there is no staging step.** A newly discovered account is imported immediately; nothing resembles review doc §2.B's proposed `DiscoveredAccount` "awaiting decision" state today.
3. **Dedup at the credential layer.** The route's institution-level duplicate check only logs — it does not merge or reuse an existing `PlaidItem` row. Confirmed: relinking a bank from scratch can create a second `PlaidItem`.
4. **Dedup at the account layer — more mature than assumed.** `lib/accounts/reconcile.ts` (313 lines, read in full) is a real, already-shipped automatic reconciliation engine, not a "cleans up after the fact" patch:
   - Exact-match dedup via `plaidAccountId` (globally `@unique`).
   - **Fingerprint fallback** (`resolveAccountByFingerprint`) for the documented real-world case where Plaid reissues a new `account_id` for the same account on reconnect: matches on institution(Id) + mask + type + name fields, case-insensitive, tolerates *multiple* stale matches, picks one canonical row (most transaction history, oldest on ties), and folds every other match into it via `mergeArchivedDuplicateIntoCanonical` — which re-points transactions, goal contributions, the debt profile, and **every `WorkspaceAccountShare`** (so a relinked account never disappears from a Space it was shared into).
   - **Never hard-deletes.** Losing rows stay archived (`deletedAt` set), never restored as a second visible row.
   - **Never writes to `DuplicateAccountCandidate`.** See §18.1 — this is the single largest divergence found between the review doc and live code.
5. **Legacy track.** `Account` (454–492) + `Holding` (833–852) are still the only path for investment positions: `Holding.accountId` is a required FK to `Account`, with **no `financialAccountId` field on `Holding` at all** — confirmed by full-model read, not inferred from a TODO comment. `Transaction` already supports both (`accountId` optional, `financialAccountId` optional, exactly one set per row — 867–892), but `Holding` does not.

This pipeline is the baseline §9.1 (`Connection`, four detail tables, `DiscoveredAccount`) and §13 (Provider Adapter Layer) extend. None of it changes in this document.

---

## 6. Publication & sharing model — current state

Two distinct trust boundaries exist conceptually; only one has a built mechanism today.

**Private sharing (built).** `WorkspaceAccountShare` (650–671) is one row per `(workspaceId, financialAccountId)` pair, with `visibilityLevel` (`PRIVATE`/`BALANCE_ONLY`/`SUMMARY_ONLY`/`SHARED`(legacy)/`FULL`) and `status` (`ACTIVE`/`REVOKED`). The redact-at-read-time pattern is fully implemented in `lib/account-privacy.ts` (306 lines, read in full):
- `genericAccountName()` derives a non-identifying label from type + debt subtype (e.g. "Jane's Credit Card").
- `sanitizeForBalanceOnly()` strips every identifying field (real name, institution, rates, Plaid metadata) for a single account.
- `normalizeSharedAccounts()` aggregates multiple `BALANCE_ONLY` accounts from the same owner/type/currency into one summed row, so the UI never reveals account *count* either — not just hides identity.

Nothing is ever persisted in redacted form; redaction happens entirely in the read path. This is the exact precedent §9.3 cites for `PublishedAccountView` — the new work is applying the same already-proven pattern to a public/anonymous trust boundary instead of a private/Space one, with a richer permission knob set (per-field toggles, not just a visibility tier).

**Public/anonymous publication (not built).** No `PublishedAccountView`, no public Space page, no anonymous read path exists yet. This is net-new (§9.3).

---

## 7. Encryption & hashing boundaries

Confirmed via full read of `lib/plaid/encryption.ts` (59 lines) and the relevant `User`/`PlaidItem`/`RecoveryCode` fields:

| Field | Mechanism | Confirmed |
|---|---|---|
| `PlaidItem.encryptedToken` | AES-256-GCM, format `iv:authTag:ciphertext` | Yes |
| `User.totpSecret` | AES-256-GCM, same function/key | Yes |
| `User.dateOfBirthEncrypted` | AES-256-GCM, same function/key | Yes |
| `User.passwordHash` | bcrypt, cost 12 | Yes |
| `RecoveryCode.codeHash` | bcrypt, cost 10 | Yes (schema comment, 1006) |
| `User.passwordResetToken` | **Plaintext** — `String? @unique`, no hash annotation anywhere in the schema or in `forgot-password`/`reset-password` routes | Confirmed gap, matches review doc exactly |
| `UserSession.sessionToken` | Plaintext opaque lookup key (not a derived secret) | Confirmed, acceptable as designed |
| `Transaction`/`FinancialAccount` numeric/date fields | Plaintext, relies on infrastructure-level (disk) encryption | Confirmed; `SpaceSnapshot`'s and `Transaction`'s indexed range queries (`[financialAccountId, date]`, 887–891) depend on this staying plaintext |

**Real, currently-live risk, not hypothetical:** all three AES-256-GCM fields (`PlaidItem.encryptedToken`, `User.totpSecret`, `User.dateOfBirthEncrypted`) share **one root `ENCRYPTION_KEY`**, with no per-purpose key derivation. Rotating that key for any one purpose today silently invalidates all three. This document does not propose a fix — only confirms the boundary so any future encryption work (e.g. a `Connection.credential` field) inherits an accurate understanding of where the blast radius currently sits, rather than assuming per-field isolation that doesn't exist.

**Tiering rule adopted from the review doc, carried forward as binding for all new tables:** reversible app-level encryption is for true secrets only (provider tokens, TOTP seed, password reset token once fixed, DOB). Everything else — amounts, dates, categories, balances — stays plaintext at the application layer and relies on infrastructure-level encryption, specifically *so that* indexing and SQL aggregation keep working. No new table in §9 may encrypt a field that needs to be summed, sorted, or range-filtered.

---

## 8. Tables to retire later (not immediate deletions)

| Model | Current role | Retirement path | Rule |
|---|---|---|---|
| `Account` | Legacy pre-`FinancialAccount` model. Still the *only* FK target for `Holding` (confirmed no `financialAccountId` field exists on `Holding`). | Superseded once `Holding` is migrated to FK `FinancialAccount` and historical `Account` rows are backfilled into `FinancialAccount`/`AccountConnection`. | Do not drop. Do not add new features to it. This migration is a prerequisite the review doc places **first** in its sequencing (§4) — before `Connection` work — because the new provider layer should not be built on top of two live legacy tracks at once. |
| `PlaidItem` | One encrypted token per institution, owned by `User`. | Superseded by `Connection` + `AggregatorConnectionDetail` (§9.1) once a dual-write/cutover migration is run. | Do not drop. `PlaidItem.accounts` (legacy `Account[]`) and `PlaidItem.connections` (`AccountConnection[]`) both stay wired exactly as-is until the cutover branch (§16, `feature/schema-modernization` or a dedicated follow-on) actually executes it. |
| `WorkspaceAccountShare` | Visibility join table, `(workspaceId, financialAccountId)`. | Superseded by `SpaceAccountLink` (§9.3) — a single polymorphic link with a `kind` (`HOME`/`SHARED`) replacing both this table and `FinancialAccount.ownerSpaceId`/`ownerUserId`. | **Do not rename.** Model name, field names (`workspaceId`, `workspace`, the `workspaceShares`/`accountShares`/`addedShares`/`revokedShares` relation names, `db.workspaceAccountShare`) all stay exactly as they are through Phase 2. Migrate only during the dedicated `feature/space-account-link-migration` branch (§16), and only as an additive new table with a staged cutover — never an in-place rename of this one. |

None of these three are touched, renamed, or dropped by this document or by any Phase 2 branch other than the explicitly-scoped migration branches in §16.

---

## 9. New tables proposed (prepare, do not implement)

Every schema sketch below is a **design reference for review, not a migration to merge.** None of it should be applied to `prisma/schema.prisma` until its own dedicated branch (§16) is explicitly approved.

### 9.1 Provider / Connection layer

Generalizes `PlaidItem` + `AccountConnection` to support more than one aggregator/exchange/brokerage/import shape, and adds the staging step (`DiscoveredAccount`) that doesn't exist today (§5, point 2).

```prisma
model Connection {
  id                    String   @id @default(cuid())
  userId                String
  provider              ConnectionProvider   // PLAID | MX | FINICITY | COINBASE | WALLET | CSV | MANUAL
  providerInstitutionId String?              // stable per institution+user
  credential            String?              // AES-256-GCM encrypted; null for CSV/manual/wallet
  status                ConnectionStatus
  lastSyncedAt          DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@unique([userId, provider, providerInstitutionId])
}

// One detail table per connection *shape*, not one nullable-everything table —
// Coinbase, a future brokerage, and CSV import carry genuinely different metadata.
model AggregatorConnectionDetail { connectionId String @unique; cursor String?; institutionName String? }
model ExchangeConnectionDetail   { connectionId String @unique; apiKeyLabel String?; lastTradeSyncAt DateTime? }
model BrokerageConnectionDetail { connectionId String @unique; custodian String?; isMargin Boolean @default(false) }
model ImportConnectionDetail    { connectionId String @unique; originalFilename String?; columnMapping Json? }

model DiscoveredAccount {
  id                 String   @id @default(cuid())
  connectionId       String
  providerAccountId  String
  name               String?
  mask               String?
  type               AccountType?
  snapshotBalance    Float?
  discoveredAt       DateTime @default(now())
  status             DiscoveredAccountStatus  // PENDING | IMPORTED | DISMISSED
}
```

Binding constraints carried into every future PR that touches this layer:

- `Connection` stays generic forever — provider-specific fields go in a detail table, never as new nullable columns on `Connection` itself.
- The real dedup fix (`@@unique([userId, provider, providerInstitutionId])`) only works if Plaid Link is invoked in **Update Mode** when a `Connection` already exists for that institution, instead of always starting a fresh Link flow. That is a behavior change in `exchange-token/route.ts`, not a side effect of adding the table — call it out as a named dependency in whatever branch implements this.
- Sequence after `SpaceAccountLink` (§9.3) — staging needs to know which Space a newly imported account defaults into, which depends on the consolidated ownership/sharing model existing first.

### 9.2 ProviderCatalog

See full field spec in §14. One line here: this is the user-facing **institution** picker ("Chase", "Coinbase", "CSV Import") that resolves to a `providerType`, which resolves to one of §9.1's four adapters. It sits in front of the Connection layer, not inside it.

### 9.3 SpaceAccountLink & PublishedAccountView

```prisma
model SpaceAccountLink {
  id                 String              @id @default(cuid())
  spaceId            String
  financialAccountId String
  kind               SpaceAccountLinkKind   // HOME | SHARED — exactly one HOME per account
  visibilityLevel    VisibilityLevel
  status             ShareStatus
  addedByUserId      String
  revokedAt          DateTime?
  revokedByUserId    String?

  @@unique([spaceId, financialAccountId])
}

model PublishedAccountView {
  id                      String   @id @default(cuid())
  financialAccountId      String
  spaceId                 String   // the public Space this is published into
  createdByUserId         String
  showBalance             Boolean  @default(true)
  showTransactions        Boolean  @default(false)
  hideMerchantNames        Boolean  @default(true)
  hideCategories           Boolean  @default(false)
  hidePendingTransactions  Boolean  @default(true)
  roundValues              Boolean  @default(false)
  delayHours               Int?     // query filter, not a batch job — see note below
  summaryOnly              Boolean  @default(false)
  status                   PublishedViewStatus   // ACTIVE | REVOKED
  revokedAt                DateTime?
  revokedByUserId          String?
}
```

Notes carried forward unchanged from the review doc, because they're implementation guardrails, not optional commentary:

- `SpaceAccountLink` **consolidates**, it does not add a third system. It replaces both `WorkspaceAccountShare` and `FinancialAccount.ownerSpaceId`/`ownerUserId` — the review doc is explicit that adding a fourth way to answer "which Space can see this account" alongside the two that already exist would be fragmentation, not progress. `FinancialAccount.ownerSpaceId`/`ownerUserId` retire in favor of "the `HOME` row" once this lands.
- `PublishedAccountView` has **no snapshot/cache table** behind it — computed at request time from live data, same pattern as `normalizeSharedAccounts()` today. `delayHours` is a query filter (`transaction.date <= now() - delayHours`), never a job that copies "ready" rows somewhere else.
- If public Space pages are ever CDN-cached or statically rendered, instant revocation needs either no caching of those responses or an active cache-purge wired into the revoke action — an infrastructure decision to make explicitly when that feature is built, not something to assume away.
- `VisibilityLevel` (private, trusted-Space sharing) and `PublishedAccountView` (public, open-internet) must stay conceptually and operationally distinct — different default-deny posture, and `PublishedAccountView` reuses `AuditLog`/`lib/audit-actions.ts` for its audit trail rather than inventing a parallel log.
- Depends on §9.3's own `SpaceAccountLink` and a public/Creator Space concept existing first — sequenced accordingly in §16.

### 9.4 Marketplace foundation

Four tables, matching the review doc's "build the v1 four, defer the other two" scope:

```prisma
model CreatorProfile { userId String @unique; bio String?; socialLinks Json?; creatorVerifiedAt DateTime? }
model Framework       { id String @id; creatorProfileId String; name String; description String?; status FrameworkStatus }
model FrameworkInstall { id String @id; frameworkId String; installedByUserId String; installedAt DateTime @default(now()) }
model Follow          { id String @id; followerUserId String; followingCreatorId String?; followingSpaceId String? }
model SpaceTemplate {
  id                       String   @id @default(cuid())
  frameworkId              String
  name                     String
  description              String?
  category                 SpaceCategory
  templateJson             Json?
  defaultPerspectiveConfig Json?
  defaultWidgetConfig      Json?
  defaultGoalConfig        Json?
  defaultAiPromptConfig    Json?
  version                  Int      @default(1)
  createdByUserId          String
  visibility               TemplateVisibility   // PUBLIC | PRIVATE | UNLISTED
}
```

`SpaceTemplate` is the answer to "what does installing a `Framework` actually do" — it's the concrete, installable scaffold (default dashboards, starter widgets, starter goals, AI prompt presets) that a `Framework`'s marketing/methodology unpacks into. `FrameworkInstall` records *that* an install happened; `SpaceTemplate` is *what* got installed. `category` deliberately reuses the existing `SpaceCategory` enum rather than inventing a parallel template-category type — it should grow in the same place the real Space categories grow, including the user's eventual Estate/Tax templates.

Explicitly out of scope here, same reasoning as §10: no `SpaceRating` (nothing to aggregate against without install volume) and no `CreatorPayout` (no billing integration exists to attach it to).

### 9.5 AI / security support

- **`AiAgent.agentScope`** — proposed additive, nullable field (JSON or a small enum set) declaring what data categories and/or which linked accounts a given agent instance is allowed to read. This is declarative metadata, not enforcement — see §12 for why enforcement lives entirely in the Context Builder, not in this field. Treat this as defense-in-depth documentation that's queryable, not a second access-control system.
- **AI Context Builder contract** — see §12 in full.
- **`AuditLog` entries for AI context assembly** — every context build writes a row (existing `AuditLog` model, no schema change needed): `action` from a new `AuditAction` constant (none exists yet — confirmed via full read of `lib/audit-actions.ts`, 148 lines; the current 9 groups are Auth, Password, 2FA, Recovery Codes, Sessions, Goals, Spaces, Members, Accounts, with no AI group), `metadata` carrying account/Space **IDs and scope**, never raw financial values.

---

## 10. Explicitly deferred

Per the governing instruction, verbatim scope, not built and not designed further in this document:

- `CreatorPayout` — no billing/payments integration exists to attach a payout ledger to.
- Billing/subscription tables — no product requirement yet.
- Messaging tables (`Conversation`, `ConversationParticipant`, `Message`, `MessageAttachment`) — no concrete feature driving them.
- Support ticket tables — none exist; `AuditLog` and a future support-tool integration are believed sufficient if and when this is needed.
- A full notification system (`Notification`, `NotificationPreference`) — deferred **unless a concrete feature requires it.** Flag for reconsideration: §9.1's `DiscoveredAccount` import flow and Space invites are both natural first consumers of a real-time notification primitive, so if either ships before a notification system exists, that dependency should be resurfaced rather than worked around with an ad hoc mechanism.

**Additional items the review doc scopes but that the governing instruction's "new tables proposed" list (§9) does not name**, carried here as deferred-by-omission rather than silently added to §9 — flagged again in §19 for an explicit yes/no:

- `MerchantSpendingSummary` (review doc §6.1) — account-level only, never Space-level, if/when built.
- `SpaceCollection` / `SpaceCollectionItem` — personal folder grouping of Spaces; no nesting of Spaces themselves (review doc §2.I is explicit that recursive permission resolution is a complexity/security trap to avoid).
- Internal-ops Platform tables (`PlatformDataSource`, `PlatformMetricDefinition`, `PlatformMetricSnapshot`) and the internal-ops `isInternal`/`SpaceCategory` gating from review doc §2.G — no billing/Stripe integration exists yet to make this urgent, and it has its own prerequisite (`jobs/scheduler.ts` actually being invoked — see §18.2) that's unrelated to Spaces work.

---

## 11. Lifecycle rules by category

Adopting the review doc's lifecycle classification (§7.1), restated as binding rules rather than tags, because every future table needs to be assignable to one of these without a new category being invented per-table:

| Category | Rule | Examples (current) | Examples (proposed) |
|---|---|---|---|
| **Canonical** | The single source of truth for a fact. Never derived, never redacted-on-write. Soft-delete (`deletedAt`) preferred over hard-delete; cascade-only for child rows. | `FinancialAccount`, `Transaction`, `Holding`, `SpaceGoal` | `Connection`, `DiscoveredAccount` |
| **Published** | A permission-gated *projection* of canonical data, computed at read time, never persisted in redacted form. | (the `BALANCE_ONLY` path in `lib/account-privacy.ts`) | `PublishedAccountView` |
| **Derived** | Pre-aggregated for performance, regenerable from canonical data, safe to recompute/discard. | `SpaceSnapshot` | `MerchantSpendingSummary` (if built) |
| **Event / Audit** | Append-only, time-boxed or permanent retention, `SetNull` rather than cascade on parent delete so history survives. | `AuditLog` | AI context-assembly entries (§9.5) reuse this category — no new table |

Two allow-list tags from the review doc are adopted as hard rules, not guidelines:

- **AI-accessible is an allow-list, not a default.** A table with no explicit AI-accessible designation is the common case and must never reach the Context Builder. `Connection.credential`, `PlaidItem.encryptedToken`, `AuditLog`, and the raw (non-redacted) form of any published view must never be read by the Context Builder, regardless of future refactors.
- **Publicly-exposable is an allow-list, not a default.** A table has no public exposure unless it explicitly says so (today: nothing does, by design — `PublishedAccountView` is the first and only intended public surface).

---

## 12. AI access boundaries — AI Context Builder contract

**Confirmed starting point: there is nothing to retrofit.** `lib/ai-advice.ts` and `jobs/run-ai-advice.ts` do not exist as files at all — not even as stubs. `lib/data/advice.ts` exists only as a read path for displaying already-seeded `AiAdvice` rows; it generates nothing. This means the "AI never queries the database directly" rule can be **built in structurally from day one**, not retrofitted onto running code — the review doc calls this "nearly free to guarantee right now," and that's still true.

Binding contract for whenever `AiAdvice` generation is actually built:

1. **AI never queries the database directly.** A single module — proposed `lib/ai/context-builder.ts` — is the *only* code in the repository allowed to both decrypt Tier-1 sensitive fields (§7) and call an LLM client. Every other file receives only its already-assembled, already-permission-filtered output.
2. **Scope of what the AI may read**, per the governing instruction: only accounts the requesting user owns directly, or accounts actively linked into the Space the request is scoped to (via `WorkspaceAccountShare` today, `SpaceAccountLink` post-§9.3). No cross-Space, no cross-user leakage, no "admin convenience" bypass — consistent with `lib/space.ts`'s existing no-bypass guarantee for `SYSTEM_ADMIN`.
3. **Provider secrets are never exposed to the context**, full stop. `Connection.credential` / `PlaidItem.encryptedToken` are categorically excluded, not filtered case-by-case.
4. **Every context build writes an `AuditLog` row** with the requesting user, the Space, and the account **IDs and scope** included — never raw financial values. (§9.5 above.)
5. **Enforcement mechanism, not just convention:** recommend a lint rule blocking any file other than `lib/ai/context-builder.ts` from importing both `lib/plaid/encryption` and an LLM SDK in the same module. This is a Phase 2/3 implementation detail to adopt when that module is actually written — noted here so it isn't lost between this freeze and that implementation.
6. **Tier separation governs the mechanism, not just the secrecy.** Per §7's tiering: Tier-1 data (true secrets) goes through "permission check → authorized decrypt → context builder." Tier-2 data (amounts, balances, categories — plaintext by design) goes through "permission check → already-scoped SQL query → context builder." Both pipelines guarantee the same end state — AI never free-queries the DB — without paying an encryption-breaks-indexing cost on data that doesn't need it.

---

## 13. Provider Adapter Layer contract

Every provider integration — present (Plaid) or future (MX, Finicity, Coinbase, a brokerage, CSV import) — implements one shared interface so sync jobs, the reconciliation engine (§5, point 4), and the UI only ever touch a canonical DTO, never a provider-specific shape:

```ts
interface ProviderAdapter {
  discoverAccounts(connection: Connection): Promise<DiscoveredAccountDTO[]>;
  syncActivity(connection: Connection): Promise<SyncResultDTO>;
  normalizeProviderData(raw: unknown): NormalizedAccountDTO;
}
```

Binding rules:

- `Connection` (§9.1) stays generic **forever**. Provider-specific metadata lives in one of the four shape-specific detail tables (`AggregatorConnectionDetail`, `ExchangeConnectionDetail`, `BrokerageConnectionDetail`, `ImportConnectionDetail`) — never as a new nullable column on `Connection` itself, and never as a catch-all JSON blob on `Connection` either (the review doc rejects that as the same anti-pattern one level up).
- **Canonical tables must never gain provider-specific columns.** `FinancialAccount`, `Transaction`, `Holding` describe the financial fact, not how it arrived. If a new provider needs a field none of the four detail tables cover, the fix is a fifth detail-table shape (or a new column on the relevant existing detail table) — never a new column on a canonical table.
- One row per `(user, provider, institution)` on `Connection` (the real fix for today's reconnect-duplication gap, §5 point 3) — contingent on Plaid Link actually being invoked in Update Mode when applicable, which is an `exchange-token/route.ts` behavior change to track as a dependency of this work, not a free side effect of the schema.

---

## 14. ProviderCatalog field specification

Reconciling two near-identical but not-identical field lists — the governing instruction's and the review doc's (§8.1) — into one spec, with the small differences called out rather than silently merged:

| Field | Source | Purpose |
|---|---|---|
| `id` | both | Primary key |
| `slug` | both | Stable routing identifier (`chase`, `coinbase`, `csv-import`) |
| `displayName` | both | User-facing institution name |
| `institutionType` | both | Bank, brokerage, exchange, credit union, etc. |
| `providerType` | both | Which of §13's four adapter shapes services this institution |
| `providerInstitutionId` | both | The aggregator's internal id for this institution (e.g. Plaid's `ins_3`) |
| `logoUrl` | both | Institution logo for the Add Account UI |
| `supportsTransactions` / `supportsInvestments` / `supportsLiabilities` | both | Capability flags |
| `supportsOAuth` / `supportsRefresh` | both | Capability flags |
| `supportsHoldings` *or* `supportsCrypto` | **differs** — governing instruction says `Holdings`, review doc says `Crypto` | Open question (§19): these likely need to be two separate flags, not one renamed field — a brokerage can support holdings without crypto and vice versa. |
| `isEnabled` *(review doc: `enabled`)` | both, naming differs | Kill switch — pull an institution from the picker without deleting history |
| `isFeatured` | governing instruction only | Not in review doc — open question (§19) on whether this is in scope for the v1 catalog or a later merchandising layer |
| `knownIssues` *(review doc: `knownIssue`, singular)* | both, pluralization differs | Free-text note(s) shown before a user attempts a flaky institution |
| `successRate` | both | Rolling connection-success metric |
| `lastHealthCheck` *(review doc: `reliabilityStatus` as a separate enum field)* | **differs** — governing instruction wants a timestamp, review doc wants a derived status enum | Open question (§19): likely both are needed — `lastHealthCheck` (when it was last checked) feeding a derived `reliabilityStatus` (what the badge shows), rather than either alone. |

Binding regardless of which exact field set is finalized:

- **Platform-owned, not tenant-owned.** `ProviderCatalog` lives in the Platform domain, the same bucket as `PlatformSetting` — no customer Space creates, edits, or has a management UI for it.
- **Mutations require internal admin permissions.** Catalog edits (adding an institution, flipping `enabled`/`isEnabled` off, updating health/known-issue fields) happen through internal Fourth Meridian operations tooling, gated the same way `PlatformSetting` already is — not through any normal Space-creation or account-linking flow.
- Sits in front of the §13 adapter layer, not inside it: a user's institution choice resolves to `providerType`, which resolves to one adapter, which writes one `Connection` row plus its shape-specific detail table.

---

## 15. Migration strategy & backward compatibility

General rules binding across all six follow-on branches in §16, synthesized from the review doc's repeated "incremental cutover, not big-bang rename" guidance plus the Phase 1 zero-DDL precedent:

1. **Additive before subtractive, always.** Every new table in §9 is introduced alongside its predecessor, dual-written for at least one release, with reads cut over only after the dual-write period proves out — the same shape as Phase 1's `@@map` approach achieved zero-DDL, applied here to genuine new tables instead of renames.
2. **No big-bang schema rename for any model.** The review doc is explicit that further schema-level renames beyond the completed Phase 1 `Workspace` → `Space` pass are not recommended — `PlaidItem` → `Connection`, `WorkspaceAccountShare` → `SpaceAccountLink`, and `Account` → `FinancialAccount` all land as **new models with staged cutovers**, never as in-place renames.
3. **Legacy tables are retired by data migration + call-site migration, then a final drop** — in that order, across separate, reviewable PRs, not one PR. §8's three retire-later tables each get their own cutover plan when their dedicated branch is approved; none of that work is scoped into this document.
4. **Backward compatibility for existing rows is non-negotiable during any cutover.** Every existing `FinancialAccount`, `WorkspaceAccountShare`, `PlaidItem`, and `Account`/`Holding` row must resolve correctly through both the old and new code path for the duration of a dual-write window. This mirrors the existing `VisibilityLevel.SHARED` enum value, which the schema already keeps specifically "for backward compat with Account model" (139–145) — i.e., the codebase already has a working precedent for carrying a deprecated value forward rather than breaking old rows, and that precedent should be reused rather than re-invented.
5. **No migration in §9 ships without its own impact map**, the same artifact Phase 1 produced before any rename — confirmed schema diff, confirmed call-site list, confirmed rollback plan — reviewed independently of this freeze document.

---

## 16. Migration sequencing — six branches

Each branch below is scoped to be independently reviewable, ships only what its name says, and depends only on branches listed before it:

1. **`feature/schema-modernization`** — close out `Account` → `FinancialAccount` (migrate `Holding`'s FK, the one piece of legacy-track debt every later branch would otherwise inherit), hash `passwordResetToken`, add `createdByUserId` to `FinancialAccount`. Lowest risk, highest leverage — review doc's own sequencing puts equivalent work first for the same reason.
2. **`feature/provider-catalog`** — `ProviderCatalog` only (§9.2, §14). No dependency on the Connection layer landing first; this can ship and be populated independently.
3. **`feature/provider-adapter-layer`** — `Connection`, the four shape-specific detail tables, `DiscoveredAccount`, the `ProviderAdapter` interface (§9.1, §13), and the `exchange-token` Update-Mode behavior change it depends on. Dual-write alongside `PlaidItem`/`AccountConnection`; do not cut reads over or drop `PlaidItem` in this branch.
4. **`feature/space-account-link-migration`** — `SpaceAccountLink` (§9.3), backfilling `HOME` rows from `FinancialAccount.ownerSpaceId`/`ownerUserId` and `SHARED` rows from `WorkspaceAccountShare`. Dual-write; do not drop `WorkspaceAccountShare` or the legacy owner columns in this branch.
5. **`feature/published-account-view`** — `PublishedAccountView` (§9.3). Depends on branch 4 (needs a settled Space/account link model) and on a public/Creator Space concept existing in product terms, not just schema terms.
6. **`feature/ai-context-builder`** — `lib/ai/context-builder.ts`, the lint rule, the `AiAgent.agentScope` field, the new `AuditAction` entries (§9.5, §12). No schema dependency on branches 2–5; can run in parallel with them since `AiAdvice`'s write path doesn't exist yet to conflict with.

Marketplace tables (§9.4) are intentionally not assigned their own branch number here — per the review doc, they're additive and low-risk whenever the product feature is actually being built, and should get a dedicated branch named at that time rather than reserved now.

---

## 17. What stays unchanged

Stated once, plainly, so it can't be missed in the detail above:

- **`WorkspaceAccountShare`** — model name, field names (`workspaceId`, `workspace`), relation names (`workspaceShares`, `accountShares`, `addedShares`, `revokedShares`), and the `db.workspaceAccountShare` Prisma Client accessor. Not touched by Phase 1, not touched by anything in §9–§16 except the additive, dual-write `SpaceAccountLink` introduction in its own dedicated branch.
- **`PlaidItem`** — kept exactly as-is, including its `accounts`/`connections` relations, until `feature/provider-adapter-layer`'s dual-write proves out and a separate cutover decision is made to migrate call sites and drop it.
- **`Account` (legacy)** and **`Holding`'s FK to it** — kept exactly as-is until `feature/schema-modernization` migrates `Holding` to `FinancialAccount` and the historical backfill is validated.
- **`AccountOwnerType.SPACE`** — the Phase 1 enum-value rename is final; no further change proposed.
- **All encryption mechanisms in §7** — no proposal in this document changes how `PlaidItem.encryptedToken`, `User.totpSecret`, or `User.dateOfBirthEncrypted` are encrypted, or fixes the shared-key blast radius. That's flagged as a known risk, not as in-scope work.
- **`jobs/scheduler.ts`'s current behavior** — not modified by this document. See §18.2 for what's actually wired up today.

---

## 18. Reconciliation notes — where live code diverges from the review doc

The review doc is accurate on the large majority of its claims — confirmed line-by-line against the schema and the relevant `lib/`/`app/` files. The following divergences are real and material enough to flag explicitly, because Phase 2 implementation work should be scoped against what the code actually does, not against what either document assumed it does.

### 18.1 `DuplicateAccountCandidate` is dead code, not a working safety net

The review doc describes this model twice as currently functioning: §1's Current State Matrix calls it "Output of the fingerprint-reconciliation engine... flagging likely-duplicate accounts... Keep as-is — working, evidence-backed safety net," and §7.5's revised Appendix C tags it `current` / "Dedupe detection across reconnections." The schema's own model comment (673–680) goes further, claiming it's "Created by the sync job when heuristics detect possible duplicates."

**None of this is true of the running code.** A full-repo search confirms zero application code references `DuplicateAccountCandidate` — no API route creates one, no job creates one, no UI surface reads or resolves one. The actual duplicate-handling mechanism, `lib/accounts/reconcile.ts` (§5, point 4), does the opposite of what the schema comment and `DuplicateStatus` enum describe: the enum's own comment says duplicates are "NEVER auto-merged — user must confirm" (155–159), but `reconcile.ts`'s `resolveAccountByFingerprint` + `mergeArchivedDuplicateIntoCanonical` **auto-merge silently**, with no review step and no user confirmation, every time a fingerprint match is found.

This is not a minor staleness issue — it's two different, mutually exclusive duplicate-handling designs, one described in the schema/docs and a different one actually running. §3 keeps the table (by elimination, since no governing instruction lists it for retirement), but this needs an explicit decision, not silence: wire `DuplicateAccountCandidate` up to do something real, repurpose it as a *log* of what the automatic merge already did (audit trail rather than review queue), or formally mark it deprecated. Carried into §19.

### 18.2 The job scheduler has two layers of gap, not one

The review doc correctly notes `jobs/scheduler.ts` "is never actually invoked from any entrypoint today." Confirmed — there is no `instrumentation.ts` or any other call site for `startScheduler()`. But the gap is deeper than that single fact suggests: even if it were invoked, `startScheduler()` only wires up **2 of the 4** jobs its own comments describe. `purgeTrash` and `syncBanks` are real, scheduled, working jobs. `take-snapshot` and `run-ai-advice` are listed in scheduler comments as if they exist, but neither `lib/ai-advice.ts` nor `jobs/run-ai-advice.ts` exists at all (§12) — and there is similarly no dedicated `jobs/take-snapshot.ts`; snapshot regeneration happens inline elsewhere (`lib/snapshots/regenerate.ts`, called from the exchange-token route post-import), not as a scheduled job. Anything in Phase 2 that assumes "the scheduler just needs to be turned on" should instead account for: turn it on, *and* finish writing two of its four documented jobs.

### 18.3 `AiAdvice` generation is more absent than "unimplemented stub" implies

The review doc calls the write path "fully unimplemented" and cites `lib/ai-advice.ts`, `jobs/run-ai-advice.ts` as the (unimplemented) files. Confirmed more precisely: **neither file exists at all**, not even as an empty stub or interface definition. `lib/data/advice.ts` is the only related file, and it's read-only — it displays whatever `AiAdvice` rows already exist (from seed data), generating nothing. This doesn't change any conclusion in §12, but it means "build the Context Builder structurally from day one" is even more literally true than the review doc's phrasing suggests — there is no existing call site anywhere to retrofit, audit, or migrate away from.

### 18.4 The fingerprint reconciliation engine is more capable than "cleans up after the fact"

The review doc's §2.B framing — duplicate `PlaidItem` rows happen, and "the account-level fingerprint reconciliation... cleans up the resulting duplicate `FinancialAccount` rows after the fact" — is directionally correct but undersells what's actually built. `resolveAccountByFingerprint` doesn't just clean up two rows; it resolves an arbitrary number of stale matches (every past relink can leave one behind) down to one canonical row in a single pass, migrates `WorkspaceAccountShare` rows to point at the winner (so a relinked account never silently vanishes from a Space it was shared into), and explicitly handles the case where more than one match is simultaneously active. This is relevant to §9.1's sequencing: the new `Connection`/`DiscoveredAccount` layer should be designed to *preserve* this engine's behavior, not assume a simpler one needs to be built from scratch alongside it.

### 18.5 `AccountConnection` already partially generalizes what §9.1 proposes

The review doc's §2.B treats `PlaidItem` → `Connection` as the generalization step, with `AccountConnection` mentioned mostly in passing ("generalize alongside `PlaidItem`"). Worth stating more directly for implementation planning: `AccountConnection` (610–633) already does real generalization work today — it's the layer that supports multiple connections to one `FinancialAccount`, carries the `isCanonical` authoritative-source flag, and tracks `syncStatus` per connection independent of the credential layer. §9.1's `Connection` model generalizes the *credential* (one row per institution login, replacing `PlaidItem`), while `AccountConnection` already generalizes the *link* between a credential and an account. These are complementary, not duplicative — but the eventual migration should be explicit that `AccountConnection` is being extended to point at `Connection` instead of `PlaidItem`, not replaced by it.

---

## 19. Open design decisions requiring approval

Nothing below is decided by this document. Each needs a product/eng call before its corresponding branch in §16 starts.

1. **`DuplicateAccountCandidate`** (§18.1) — wire it up for real (as a true review queue, contradicting the current silent-auto-merge behavior), repurpose it as a post-hoc audit log of automatic merges, or formally deprecate and eventually drop it. The current state — schema and docs describing one behavior, code doing another — should not persist into Phase 2 unaddressed.
2. **`ProviderCatalog` field set** (§14) — reconcile `supportsHoldings` vs. `supportsCrypto` (likely both, as separate flags), `isFeatured` (in v1 catalog scope or deferred), and `lastHealthCheck` timestamp vs. `reliabilityStatus` enum (likely both — one feeds the other).
3. **`FinancialAccount`/`Connection.createdByUserId`** (§4) — confirm priority/timing for adding a required, non-deletable accountable party for `SPACE`-owned accounts, independent of the visibility-owner fields.
4. **Internal-ops Spaces** (§4, §10) — whether an `isInternal` flag or a dedicated `SpaceCategory` value (and the `SYSTEM_ADMIN`-gated creation check that doesn't exist today) is needed before, or only alongside, the first internal-ops feature that actually requires it.
5. **Status of review-doc-only proposals not named in the governing instruction's §9 list** (§10) — `MerchantSpendingSummary`, `SpaceCollection`/`SpaceCollectionItem`, and the Platform-Ops metrics tables (`PlatformDataSource`, `PlatformMetricDefinition`, `PlatformMetricSnapshot`): confirm these stay deferred indefinitely, or should be added to a future phase's explicit scope.
6. **`Connection.credential` nullability** (review doc §5) — uniform encrypted-blob shape for every provider (possibly empty for CSV/manual/wallet) vs. genuinely nullable. Affects how generic `Connection` can stay.
7. **Shared `ENCRYPTION_KEY` blast radius** (§7) — not a Phase 2 blocker, but should be scheduled (per-purpose key derivation via HKDF, or at minimum accurate documentation of the current shared blast radius) before any key rotation is ever performed in production, and before a fourth secret (`Connection.credential`) is added to the same shared-key pool.
8. **`jobs/scheduler.ts` invocation + the missing `take-snapshot`/`run-ai-advice` jobs** (§18.2) — confirm whether wiring up the scheduler entrypoint is a Phase 2 prerequisite (it blocks §12's eventual `AiAdvice` generation work and §10's deferred internal-ops metrics) or tracked as separate, unscoped infrastructure work.
9. **Marketplace branch timing** (§16) — confirmed deferred-but-not-cancelled; needs its own branch name and sequencing slot assigned only once a concrete Marketplace feature is being built, not on this timeline.

---

## 20. Sign-off & next steps

This document makes no code changes. Per the governing instruction, work pauses here for review.

Recommended next step once reviewed: approve or amend the six-branch sequencing in §16, resolve the nine open decisions in §19 (or explicitly defer each one with a stated reason), and only then open `feature/schema-modernization` — the lowest-risk, highest-leverage branch, and the one every other branch in §16 implicitly depends on not having open legacy-track debt underneath it.
