# OPS-2 — Account Lifecycle & Identity Management · Investigation & Architecture Proposal

**Status:** PLANNED — investigation complete, zero implementation
**Date:** 2026-07-06 · investigated against the working tree (post-MC1/TI-1, `ef6227e` era; OPS-1 S0–S2c landed, S2d resend routes present in tree)
**Track:** `OPS-2` per the revised OPS roadmap (OPS-1 Operational Communications → OPS-2 Account Lifecycle & Identity → OPS-3 Notifications & Preferences → OPS-4 Background Jobs & Scheduling → OPS-5 Platform Operations)
**Relationship to prior planning:** the original `OPS1_OPERATIONAL_FLOOR_PLAN.md` Slices 7 (export) and 8 (deletion) are absorbed and superseded by this initiative. STATUS.md §3/§4 should record that re-allocation at implementation start.

**This document contains no code changes and no migrations. All schema and code described here is FUTURE work.**

---

## 1. Files inspected

- `prisma/schema.prisma` (all 1,648 lines — every User relation and `onDelete` directive)
- `lib/auth.ts`, `lib/session.ts`, `lib/session-cache.ts`, `proxy.ts` (NextAuth v4 config, JWT strategy, revocation cache, route guarding)
- `lib/audit-actions.ts`, AuditLog model
- `lib/email/` — `index.ts`, `senders.ts`, `verification.ts`, templates, providers (OPS-1 seam)
- `app/api/auth/` — `[...nextauth]`, `register`, `forgot-password`, `reset-password`, `pre-login`, `verify-email`, `verify-email/resend`
- `app/api/user/` — `password`, `profile`, `sessions`, `sessions/[sessionId]`, `totp/*`
- `app/api/spaces/[id]/route.ts`, `.../permanent/route.ts`, `.../members/[userId]/route.ts`; `lib/spaces/policy.ts`
- `lib/plaid/disconnect.ts` (Plaid `itemRemove` obligation), `lib/account-privacy.ts` (visibility redaction)
- `app/(shell)/dashboard/settings/page.tsx`, `components/dashboard/SettingsClient.tsx`, `TotpSection`
- `app/admin/security/page.tsx`, `app/api/admin/security/*`, `app/api/admin/users/route.ts`
- `app/api/ai/chat/route.ts` (AI persistence check), AiAgent/AiAdvice models
- `STATUS.md`, `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md`, `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md`

---

## 2. Current state

| Subsystem | State | Evidence |
|---|---|---|
| Identity | `User.email` (unique) is the login identifier; optional unique `username`. bcrypt cost 12. TOTP + recovery codes shipped. `emailVerifiedAt` + hashed verification token live (S2b–S2d); **nothing gates on verification yet** | `lib/auth.ts`; User model |
| Sessions | JWT strategy (30d) carrying an opaque `sessionToken` UUID; one `UserSession` row per login (ip, UA, `lastActiveAt`, `revokedAt`, `revokedById`). Every `getServerSession` checks revocation against the DB, cached 30s per token per instance (`lib/session-cache.ts`). `requireFreshUser()` bypasses the cache for sensitive actions | `lib/auth.ts` session callback; `lib/session.ts` |
| Session APIs | Already exist: `GET /api/user/sessions` (list + `isCurrent` + parsed UA), `DELETE /api/user/sessions` (**revoke all except current — "sign out everywhere" exists at API level**), `DELETE /api/user/sessions/[sessionId]` (single revoke, `confirmSelf` guard). Admin twin under `/api/admin/security/users/[userId]/sessions` | route files |
| Sessions UI | **Users have none.** The only `SessionsList` renderer lives inside `app/admin/security/page.tsx` (admin surface). `SettingsClient` = profile + password form + `TotpSection` only | grep `/api/user/sessions` across components |
| Change password | `PATCH /api/user/password`: current-password check, fresh-session check, audited. Does **not** revoke other sessions; sends **no** notification email. Failure audit uses free-string `"PASSWORD_CHANGE_FAILED"` not in the `AuditAction` catalog | route file |
| Change email | **No route.** Email rendered read-only in settings | `app/api/user/`; SettingsClient |
| Delete account | **No endpoint.** `db.user.delete()` would be unsafe (see §4) | `app/api/user/` |
| Export | **None.** `exceljs`/`papaparse` serve import only | repo grep |
| Deactivate / reactivate | Nothing. No status/`deactivatedAt` on User | User model |
| Trusted devices | Nothing. No device identity beyond raw UA/IP strings on UserSession | schema |
| Security history | `AuditLog` is append-only with `SetNull` on user/space delete and a rich action catalog; **admin-only** filter UI exists. No user-facing view | AuditLog; `app/admin/audit` |
| Email seam | OPS-1 chokepoint live. `senders.ts` already declares an (unused) `security-alert` purpose; templates: password-reset, email-verification, smoke. Capture transport for dev/CI | `lib/email/*` |
| Space ownership | Role-based via `SpaceMember` (OWNER). `lib/spaces/policy.ts`: `space:delete`/`deletePermanent` = OWNER + sharedOnly; PERSONAL Spaces cannot be archived/trashed/deleted. **No ownership-transfer flow** ("transfer ownership is a separate flow" — members route; OWNER promotion explicitly rejected by PATCH) | policy.ts; members route |
| Space permanent delete | Only `db.space.delete()` call site; requires trashed-first; **blocked if the Space owns FinancialAccounts** (anti-ghost-account guard — precedent OPS-2 must mirror for user deletion) | `app/api/spaces/[id]/permanent/route.ts` |
| Plaid | `PlaidItem` is a User credential (Cascade). `lib/plaid/disconnect.ts` = the `itemRemove` + REVOKED pattern; a DB cascade alone would delete tokens **without revoking at Plaid** | disconnect.ts |
| AI | AiAgent/AiAdvice are Space-scoped (cascade with Space). Chat route persists **no** conversation rows — only audit events (`AI_CONTEXT_ASSEMBLED`, validation flags). "AI history" for a user = anonymous-izable audit rows only | schema; chat route |
| Invites | `SpaceInvite` requires an existing `invitedUserId`; Cascade on user delete both directions | schema |

---

## 3. Capability analysis

Legend: **CB** current behavior · **MI** missing infrastructure · **SI** schema impact · **Sec** security · **UX** · **Aud** audit · **Em** email · **Dep** dependencies · **Rev** reversible?

### 3.1 Change email
- **CB:** none.
- **MI:** request endpoint, verify-new-address consumer, notify-old-address email, settings UI.
- **SI:** `User.pendingEmail`, `User.pendingEmailToken` (hashed, `@unique`), `User.pendingEmailExpiry` — additive, nullable. Mirrors the S2b token trio exactly.
- **Sec:** this is the #1 account-takeover vector. Require `requireFreshUser()` + current password (+ TOTP code if enrolled); check new-email uniqueness at request **and** at consume (race); token TTL 1h (house pattern); rate-limit both endpoints from birth; old address gets a security-alert with the change details (and optionally a revert link — open decision §13.4).
- **UX:** two-phase — email stays unchanged until the new address is verified; settings shows "pending verification → x@y" with cancel/resend. `emailVerifiedAt` refreshes on switch.
- **Aud:** `EMAIL_CHANGE_REQUESTED`, `EMAIL_CHANGED` (metadata: old/new masked).
- **Em:** verify link → new address (`email-verification` purpose); notification → old address (`security-alert`).
- **Dep:** OPS-1 seam (done). None else.
- **Rev:** yes within the revert window if adopted; otherwise reversible by performing the change again.

### 3.2 Verify new email
Not a separate capability — it is the consume leg of 3.1 and reuses the S2c consumer shape (POST-only, hashed lookup, idempotent-safe, rate-limited). Distinct token column from `emailVerificationToken` so an in-flight signup verification and an email change can't collide.

### 3.3 Change password
- **CB:** exists and is sound (fresh session + current password + audit).
- **MI:** (a) revoke all **other** sessions on success (the DELETE-all-except-current logic already written in `/api/user/sessions` — extract to a `lib/` helper, call from both); (b) security-alert email on change **and** on reset-completed; (c) promote `PASSWORD_CHANGE_FAILED` into the `AuditAction` catalog.
- **SI:** none. **Sec:** closes the hijacked-session persistence hole. **Rev:** n/a (user can change again).

### 3.4 Delete account — see §4 (special investigation).

### 3.5 Export personal data — see §5.

### 3.6 Deactivate account
- **CB:** none.
- **MI:** `POST /api/user/deactivate` (fresh auth + password), login-time gate, reactivation leg.
- **SI:** `User.deactivatedAt DateTime?` — additive.
- **Sec:** revoke all sessions on deactivation (`clearAllSessions()` + `updateMany revokedAt`). Deactivated ≠ deleted: data intact, memberships stay ACTIVE, no cascade.
- **UX:** login with valid credentials against a deactivated account → "your account is deactivated — reactivate?" one-click restore (clears `deactivatedAt`). Shared-Space members see the member normally (or a subtle "inactive" badge — cosmetic, later).
- **Aud:** `ACCOUNT_DEACTIVATED`, `ACCOUNT_REACTIVATED`. **Em:** confirmation to user (security-alert).
- **Dep:** decision whether the daily bank-sync cron skips PlaidItems of deactivated users (recommended: yes — filter in the sync job; keeps Plaid billing honest). **Rev:** fully — that is its purpose, and it is the cheap alternative the delete flow should offer ("deactivate instead?").

### 3.7 Reactivate account
The inverse leg of 3.6; also the cancel leg of pending deletion (§4.6). No extra schema.

### 3.8 Sign out everywhere
- **CB:** API complete (`DELETE /api/user/sessions`, fresh-auth, audited, cache-cleared).
- **MI:** user-facing button on the new Security page; optional security-alert email.
- **SI:** none. **Rev:** no (sessions are re-creatable by logging in — harmless).
- **Known limit to document, not fix:** `session-cache.ts` is per-instance in-memory; on multi-instance Vercel another instance may serve a revoked session for ≤30s. Acceptable, but must be stated in the security page copy/docs.

### 3.9 Active sessions
- **CB:** API complete; renderer exists but is trapped inside the admin page.
- **MI:** extract `SessionsList` into a shared component; new `/dashboard/settings/security` page (or Security tab) rendering it for the user; per-row revoke wired to the existing `[sessionId]` DELETE.
- **SI:** none.

### 3.10 Trusted devices
- **CB:** nothing — no device identity at all; UserSession stores raw UA/IP per login row, so the same laptop appears as N sessions.
- **MI/SI:** a long-lived httpOnly `fm_device` cookie (random id, hashed at rest) set at login; additive `TrustedDevice` model: `id, userId, deviceIdHash @unique, label?, uaSnapshot, firstSeenAt, lastSeenAt, trustedAt?, revokedAt?`; additive `UserSession.deviceId?` linking sessions to devices.
- **Phasing:** ship **device identity + "new device" security-alert email** first (this is the OPS-1 S3 stretch goal, landed properly). Actual *trust semantics* (skip step-up on trusted devices) has no consumer until step-up auth exists — defer the semantics, keep the model.
- **Sec:** device cookie is identification, never authentication — it must grant nothing. **Aud:** `NEW_DEVICE_SEEN`, `DEVICE_REVOKED`. **Rev:** yes (revoke).

### 3.11 Security history
- **CB:** all events already captured in AuditLog; admin-only viewer.
- **MI:** `GET /api/user/security-history` — the user's own rows filtered by an explicit **allowlist** of actions (LOGIN, LOGIN_FAILED, LOGOUT, PASSWORD_*, TWO_FACTOR_*, RECOVERY_*, SESSION_*, EMAIL_*, ACCOUNT_*, DEVICE_*, DATA_EXPORTED) — allowlist, not "all rows," so Space/import/AI operational noise and admin-context metadata never leak; paginated; renders on the Security page.
- **SI:** none (indexes `[userId, createdAt]` + `[action, createdAt]` already exist).

---

## 4. Special investigation — Delete Account

### 4.1 Why `db.user.delete()` is unsafe today (cascade audit)

Walking every User relation's current `onDelete`:

| Relation | Current | Consequence on raw delete | Verdict |
|---|---|---|---|
| `UserSession`, `RecoveryCode`, `CreditScore` | Cascade | fine — strictly personal | keep |
| `AuditLog.userId` | SetNull | correct — retain & anonymize | keep |
| `PlaidItem` | Cascade | **tokens destroyed without `itemRemove`** — items stay authorized at the institution and keep billing | pipeline must revoke first (`lib/plaid/disconnect.ts` pattern), then let cascade run |
| `Connection` | Cascade | same class of issue for future providers | same |
| `SpaceMember` | Cascade | **contradicts the "rows are never deleted" soft-membership doctrine**; erases membership history from shared Spaces; a SHARED Space whose OWNER is deleted becomes administratively orphaned (no OWNER row — nobody can invite/delete/manage) | block deletion while sole OWNER of a SHARED Space with other ACTIVE members (§4.3) |
| `SpaceInvite` (both) | Cascade | acceptable — invites are ephemeral | keep |
| `FinancialAccount.ownerUser` / `createdByUser` | SetNull | ownerless "ghost" accounts still holding balances/transactions — exactly what the Space permanent-delete guard exists to prevent | pipeline resolves accounts explicitly (§4.4) |
| `AccountConnection.connectedByUser` | Cascade | connection rows vanish; if the deleted user's connection was `isCanonical`, a **shared/joint account loses its authoritative balance source** with no re-election | pipeline soft-deletes + re-elects or removes account first |
| `SpaceAccountLink.addedByUser` | **Cascade** | **worst finding:** SAL rows are hard-deleted — including HOME links — orphaning accounts other members rely on, and contradicting SAL's own revoke-don't-delete doctrine (`status: REVOKED` exists precisely for this) | flip to nullable + SetNull (§9) and revoke via status in the pipeline |
| `SpaceGoal.createdBy` | **Cascade** | goals the user created **in SHARED Spaces** are hard-deleted with all contributions/check-ins — destroys other members' data | flip to nullable + SetNull (§9) |
| `ImportBatch` / `ImportMappingProfile` / `DuplicateAccountCandidate.resolvedBy` | SetNull | fine | keep |
| `SpaceMember.revokedBy` / `SpaceAccountLink.revokedBy` | SetNull | fine | keep |

**Conclusion:** deletion must be an orchestrated application-level pipeline in a defined order, and two `onDelete` directives should be corrected regardless (defense in depth).

### 4.2 What happens if the user owns Spaces?
- **PERSONAL Space:** it is the user's private container — hard-delete it with the user (the existing Space cascade handles members/goals/sections/snapshots/AiAgent/AiAdvice). The API-layer "PERSONAL cannot be deleted" rule is a *user-initiated-route* rule; the deletion pipeline is the one legitimate caller and deletes it after account resolution.
- **SHARED Space, user is sole OWNER, other ACTIVE members exist:** **block deletion** until resolved. Resolution paths: transfer ownership (flow does not exist — see §13.3) or the OWNER deletes the Space through the normal trash → permanent path (their prerogative; existing guards apply). Blocking mirrors the established `member:remove` OWNER residual.
- **SHARED Space, user is sole member:** treat like personal property — require the user to delete it first, or pipeline-delete it (recommend: pipeline-delete, it is materially theirs).
- **User is non-OWNER member:** normal member-leave semantics — status → LEFT, their contributed SALs → REVOKED (the existing member-removal machinery, which also fires the EV-1 snapshot handler).

### 4.3 Other members / shared financial data
- Accounts the user owns (`ownerType=USER`) that are SHARED into others' Spaces: revoke the SAL (status REVOKED, `revokedByUserId` = self) — counterparties lose visibility, which is correct; snapshot regeneration rides the existing revocation events.
- Accounts owned by a **Space** (`ownerType=SPACE`) that the user merely connected: the account is Space property and **survives**. The user's AccountConnection is soft-deleted; if it was canonical, re-elect another live connection or mark the account `syncStatus` stale. The Plaid item behind it is revoked only if orphaned (existing `disconnectPlaidItemIfOrphaned` logic).
- Joint accounts where a second user has their own AccountConnection: account survives; canonical re-election as above.

### 4.4 AI history
No user-owned AI data exists: AiAgent/AiAdvice belong to Spaces and no chat transcripts are persisted. The user's PERSONAL-Space advice dies with that Space's cascade; SHARED-Space advice belongs to the Space and survives. AI-related audit rows anonymize like all others. Disclose the OpenAI processing posture on the legal page (OPS-1 obligation), not here.

### 4.5 Audit logs
Retain and anonymize (`SetNull` — already correct). A user's deletion must not delete the security history of Spaces other users still occupy. The deletion pipeline writes its own `ACCOUNT_DELETED` row *before* the final delete (metadata: masked email hash, counts of purged rows), which then survives with `userId` null — the same trick `SPACE_PERMANENT_DELETE` already uses. Privacy policy must state the retain-and-anonymize posture.

### 4.6 Hard vs soft delete, timing, cancellation

| Data | Treatment |
|---|---|
| User row + PII (email, names, DOB, passwordHash, totpSecret), sessions, recovery codes, credit scores | **Hard** |
| PlaidItems / Connections | Revoke at provider, then hard |
| PERSONAL Space + everything in it (incl. USER-owned FinancialAccounts, transactions, holdings, imports) | **Hard** |
| SpaceMember rows in surviving Spaces | **Soft** — status LEFT + anonymize is impossible once the User row is gone (FK). Decision §13.6: either flip `SpaceMember.userId` handling to preserve anonymized rows, or accept membership-row loss and rely on AuditLog for history. Recommendation: accept cascade (AuditLog carries history), keep it simple |
| SALs / goals the user created in surviving Spaces | **Soft** — SAL → REVOKED; goals survive with `createdBy` null (post-§9 flip) |
| AuditLog | Retain, anonymized |

**Timing — recommend delayed deletion:** request → `deletionRequestedAt` + `deletionScheduledAt` (now + grace period) → all sessions revoked → confirmation email with cancel link → purge at the scheduled time. Grace period: OPS-1 plan recommended 7 days; the OPS-2 charter suggests 30. Recommendation: **7 days** — the protection argument (account-takeover-then-delete) is satisfied by any multi-day window plus the email alert, and shorter honors the user's intent faster; 30 days is a retention posture, not a safety one. Open decision §13.1.

**Cancellation:** logging in during the window (credentials still valid) surfaces "scheduled for deletion — cancel?"; the email cancel link (hashed single-use token, house pattern) does the same without login. Either path clears the two timestamps and audits `ACCOUNT_DELETION_CANCELLED`.

**During the window:** account behaves as deactivated (§3.6) — login allowed only to the cancel/reactivate surface. This is why Deactivate ships before Delete: pending-deletion *is* deactivation plus a timer.

**Purge execution:** the scheduler (D5) is still un-invoked — the purge must be a Vercel cron route (check the Hobby-plan cron slot budget — the OPS-1 plan notes 2 slots already used) or an inline check. **The purge may not depend on `startScheduler()`.**

**Verification:** post-deletion zero-residue proof — scripted sweep for the userId across all tables, allowing only anonymized audit rows; Plaid sandbox proof of `itemRemove`; the freed email must re-register cleanly.

---

## 5. Export personal data

- **What belongs to the user:** profile (decrypted DOB — it is their own), security history (their audit allowlist rows), sessions metadata, PERSONAL-Space data in full (accounts, transactions, holdings, snapshots, goals, import batches), their USER-owned accounts wherever linked, credit scores. Shared-Space data **only through the same visibility predicates as every read surface** (`lib/account-privacy.ts` / KD-19 posture) — a BALANCE_ONLY counterparty's transactions must not appear. Export must not become a visibility bypass; this is the slice's core correctness risk.
- **Excluded, documented:** Plaid tokens, TOTP secret, password hash, recovery-code hashes, other users' data, raw audit rows beyond their own.
- **Formats:** one zip: `data.json` (canonical machine-readable bundle, versioned envelope) + CSVs for the tabular sets (transactions, accounts, holdings, snapshots) — CSVs reuse import-pipeline column conventions so a transactions export round-trips through the CSV importer (built-in self-consistency test). FX-converted totals labeled as estimates per MC1 doctrine.
- **Security:** `requireFreshUser()`, rate-limited (e.g. 3/day), `DATA_EXPORTED` audit row, security-alert email ("your data was exported from IP x"). Synchronous generation is fine at beta scale (5k-row-cap precedent); async job explicitly deferred to OPS-4.
- **Schema impact:** none.
- **Dep:** none beyond the email seam. Ships before Delete (the delete confirmation page offers "export first").

---

## 6. Sessions & devices (summary of §3.8–3.10)

Session management is the most-finished capability: model, revocation, cache discipline, and all three APIs exist; the entire gap is user-facing UI plus the shared-component extraction. Device trust is greenfield; ship identity + new-device alert only, defer trust semantics.

**Passkey compatibility (future):** the real prerequisite is NextAuth v4 → Auth.js v5 + WebAuthn, out of OPS-2 scope. OPS-2 must simply not paint into a corner, and doesn't: the opaque `sessionToken` → UserSession row pattern is auth-mechanism-agnostic (a future passkey login creates a UserSession identically); `TrustedDevice` gives authenticators a natural anchor (`deviceId`); nothing proposed here reaches into JWT internals. No pre-work needed beyond keeping these seams.

---

## 7. Proposed initiative breakdown

Doctrine unchanged: additive-first, one chokepoint per capability, every new endpoint rate-limited and audited from birth, each slice independently shippable.

| Slice | Name | Contents | Schema |
|---|---|---|---|
| **S0** | Allocation + audit-action catalog | STATUS ledger row; supersede OPS-1 Slices 7–8; add all new `AuditAction` constants + `PASSWORD_CHANGE_FAILED` promotion; `.env.example` pass if any new flags | none |
| **S1** | Security page foundation | `/dashboard/settings/security`: extract shared `SessionsList`, wire existing session APIs (list, per-row revoke, sign-out-everywhere), add `GET /api/user/security-history` (allowlist) + history panel | none |
| **S2** | Password-change hardening | Revoke-other-sessions helper (extracted, reused); security-alert email on change + reset-complete | none |
| **S3** | Change email | Two-phase pending-email flow (§3.1/3.2) | `pendingEmail*` trio |
| **S4** | Deactivate / reactivate | §3.6–3.7 incl. login gate + sync-skip filter | `deactivatedAt` |
| **S5** | Cascade corrections + deletion inventory | Flip `SpaceGoal.createdBy` and `SpaceAccountLink.addedByUser` to nullable + SetNull (behavior-neutral for live code); commit the per-table deletion-inventory decision record (this §4 table, ratified) | 2 onDelete flips |
| **S6** | Export | §5 | none |
| **S7** | Delete account | Request/cancel/purge pipeline (§4), Vercel-cron purge, zero-residue proof | `deletionRequestedAt`, `deletionScheduledAt` |
| **S8** *(optional / OPS-3 border)* | Device identity | `fm_device` cookie, `TrustedDevice` model, `UserSession.deviceId`, new-device security-alert | TrustedDevice + 1 column |

## 8. Recommended implementation order

S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → (S8).

Rationale: S1–S2 are pure wins on existing infrastructure (no migrations) and give every later slice its UI home and its notification habit. S3 is the highest-value identity feature and independent. S4 before S7 because pending-deletion reuses the deactivation gate. S5 must land before S7 (delete rides corrected cascades) but is safe any time. S6 before S7 so "export first" is a true offer on the delete screen. S8 floats — it is the seam into OPS-3 notifications.

## 9. Schema changes (all additive except the two flips)

```
User:          pendingEmail String?, pendingEmailToken String? @unique, pendingEmailExpiry DateTime?
               deactivatedAt DateTime?
               deletionRequestedAt DateTime?, deletionScheduledAt DateTime?
SpaceGoal:     createdByUserId String  → String?; onDelete Cascade → SetNull
SpaceAccountLink: addedByUserId String → String?; onDelete Cascade → SetNull
TrustedDevice (S8): id, userId (Cascade), deviceIdHash @unique, label?, uaSnapshot,
               firstSeenAt, lastSeenAt, trustedAt?, revokedAt?
UserSession (S8): deviceId String?
```

Deliberately **not** a `DeletionRequest` table: two timestamps + audit rows carry the whole state machine; a table adds nothing until multi-request history matters.

## 10. Security risks

1. **Email change = takeover vector.** Mitigations in §3.1 (fresh auth + password + TOTP, dual-address notification, TTL, rate limits, uniqueness re-check at consume).
2. **Delete/export = takeover-destruction/exfiltration vectors.** Fresh auth + grace window + email alerts + rate limits.
3. **Revocation cache staleness** (≤30s, per-instance). Documented limit; sensitive routes already bypass. Do not widen the TTL.
4. **Purge job runs with no user in the loop** — it must be idempotent, re-check `deletionScheduledAt <= now` and cancellation state atomically, and never partially delete (transaction per user, external Plaid revocation before the transaction with retry-safe ordering).
5. **Export visibility bypass** — reuse the exact read-surface predicates; never re-implement redaction.
6. **Plaid-side residue** — cascade without `itemRemove` leaves live institution grants; the pipeline order is a hard requirement, and failure to revoke must block the purge (retry) rather than skip.
7. **Admin parity** — every new user action should surface on the SYSTEM_ADMIN panel via the same core functions (build once, expose twice), all `performedByAdminId`-stamped.

## 11. Migration strategy

All migrations are additive nullable columns except S5's two flips, which require `DROP NOT NULL` + FK action change — metadata-only in Postgres, no row rewrite, no backfill (existing rows keep their real user ids). One migration per slice, applied via `DIRECT_URL` per the schema header convention. No data migration anywhere in OPS-2. Rollback story per slice: columns are unread by prior code (additive doctrine), so every slice is revertible by deploy rollback alone; S5's flips are the only one-way door and are safe under old code (old code never relied on the cascades intentionally).

## 12. Testing strategy

- Token flows (email change, deletion cancel) mirror the existing reset/verify test suites (hash-at-rest, TTL, single-use/rotation, non-revealing responses).
- Session tests: password change revokes other sessions; sign-out-everywhere leaves current alive; revoked session rejected after cache TTL.
- **Two-user privacy harness extended twice:** export (BALANCE_ONLY counterparty's transactions absent from the artifact; no encrypted secret in any export byte — grep the artifact) and deletion (counterparty's Space intact, SALs REVOKED not deleted, goals survive with null creator).
- **Zero-residue sweep script** for deletion (allowing only anonymized audit rows) — committed and run in CI where the Postgres service container exists, or as a documented manual gate until then.
- Plaid sandbox: item provably removed; deleted email re-registers cleanly.
- House standard per slice: `tsc --noEmit`, `lint`, `npm test` green.

## 13. Open decisions (resolve at slice entry)

1. **Grace period:** 7 vs 30 days (rec: 7 — §4.6). Also: does the confirmation email's cancel link require login? (rec: no — token suffices, matches reset pattern.)
2. **Pending-deletion login semantics:** cancel-only surface vs read-only access (rec: cancel-only — simplest gate, reuses deactivation).
3. **Space ownership transfer:** in-scope for OPS-2 (small: OWNER-only PATCH extension + audit + consent?) vs block-only deletion with "transfer or delete the Space" messaging (rec: block-only now; transfer is its own small follow-on — it has non-trivial consent questions).
4. **Email-change revert link** in the old-address notification (rec: yes, 72h — it is the standard takeover recovery affordance; requires storing the prior address alongside the change audit row or a revert token).
5. **Deactivation sync behavior:** pause PlaidItem syncs for deactivated users (rec: yes).
6. **SpaceMember rows on delete:** accept cascade (rec) vs preserve anonymized membership rows (requires nullable userId — heavier).
7. **Purge execution slot:** Vercel cron budget check vs inline login-time/lazy check (cron is cleaner; verify plan limits first — OPS-4 will eventually own this).
8. **S8 now or in OPS-3:** device identity naturally feeds the notifications initiative; keep it at the boundary.

---

*Investigation stops here per the charter: no code, no migrations, no repository behavior changed. This file is the only artifact.*
