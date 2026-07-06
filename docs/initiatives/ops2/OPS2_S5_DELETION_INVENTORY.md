# OPS-2 S5 — Deletion Inventory & Safety Decision Record

**Status:** RATIFIED (2026-07-06)
**Slice:** OPS-2 S5 — Cascade corrections + deletion inventory
**Companion:** `OPS2_ACCOUNT_LIFECYCLE_INVESTIGATION.md` §4 (source audit), verified line-by-line against the schema as of this slice.
**Tripwire:** `lib/deletion-safety.test.ts` (schema-scan; runs in `npm test`).

This document is the contract the S7 delete-account pipeline builds against.
It ratifies, per table, what happens when a `User` row is deleted, which
cascades were corrected in this slice, and which preflight checks S7 MUST run
before any purge. Nothing here implements deletion — S5 is schema safety and
decision-making only.

---

## 1. Cascade inventory (per User relation, ratified)

| Relation | onDelete | Verdict |
|---|---|---|
| `UserSession`, `RecoveryCode`, `CreditScore` | Cascade | **Keep** — strictly personal rows. |
| `SpaceInvite.invitedBy` / `.invitedUser` | Cascade | **Keep** — invites are ephemeral. |
| `AuditLog.userId` | SetNull | **Keep** — retain & anonymize (see §5). |
| `PlaidItem` | Cascade | **Keep**, but the S7 pipeline MUST revoke at Plaid (`itemRemove`) **before** the row delete — cascade alone destroys tokens while the item stays authorized (and billing) at the institution. |
| `Connection` | Cascade | **Keep**, same obligation for future providers; WALLET/MANUAL have nothing to revoke upstream. |
| `SpaceMember.user` | Cascade | **Keep — ACCEPTED (decision §3.1)**. Contradicts the soft-membership doctrine, but preserving anonymized member rows would need a third flip + fake-user pattern. AuditLog carries the history. S7 compensates with the sole-OWNER preflight block (§4a). |
| `SpaceMember.revokedBy` | SetNull | **Keep.** |
| `FinancialAccount.ownerUser` / `.createdByUser` | SetNull | **Keep** — survivable, but the S7 pipeline resolves USER-owned accounts explicitly (PERSONAL-Space cascade or SAL revocation) so no ownerless "ghost" rows remain (§4b). |
| `Account.owner` (legacy) | SetNull | **Keep** — model is retiring. |
| `AccountConnection.connectedByUser` | Cascade | **Keep**, but S7 MUST re-elect a canonical connection for jointly connected accounts first (§4c) — otherwise a shared account silently loses its authoritative balance source. |
| `SpaceAccountLink.addedByUser` | ~~Cascade~~ → **SetNull (FLIPPED, this slice)** | SAL doctrine is revoke-don't-delete (`status: REVOKED`). The old cascade hard-deleted links — including HOME — orphaning accounts other members rely on. S7 revokes via status; the FK then nulls harmlessly. |
| `SpaceAccountLink.revokedBy` | SetNull | **Keep.** |
| `SpaceGoal.createdBy` | ~~Cascade~~ → **SetNull (FLIPPED, this slice)** | Goals in SHARED Spaces are the Space's data; the old cascade destroyed other members' goals + contributions + check-ins. Goals now survive with `createdBy` null. |
| `ImportBatch.createdByUser`, `ImportMappingProfile.createdByUser`, `DuplicateAccountCandidate.resolvedBy` | SetNull | **Keep.** |
| `User.preferredSpaceId`, `UserSession.revokedById`, `AuditLog.performedByAdminId` | no FK (soft refs) | **Keep** — naturally safe. |

## 2. The two corrections made in this slice

Migration `20260706170000_ops2_s5_cascade_corrections`:

1. `SpaceGoal.createdByUserId` — `String` → `String?`, FK `ON DELETE CASCADE` → `ON DELETE SET NULL`.
2. `SpaceAccountLink.addedByUserId` — `String` → `String?`, FK `ON DELETE CASCADE` → `ON DELETE SET NULL`.

Metadata-only in Postgres (`DROP NOT NULL` + constraint swap; no row rewrite,
no backfill). Behavior-neutral for live code: both columns are always written
at creation and no code path deletes users today. Null-tolerance sweep landed
with this slice: `ShareRow` / `AccountLinkRow` / `SpaceAccountLinkWriteFields`
widened to `string | null`; the share-revoke self-check
(`link.addedByUserId !== userId`) is null-safe by construction — a nulled
adder simply requires OWNER/ADMIN to revoke. These are the only intentional
one-way flips in OPS-2; they are safe under old code, which never relied on
those cascades intentionally.

## 3. Ratified decisions

1. **SpaceMember cascade: ACCEPTED.** Membership rows in surviving Spaces die
   with the user; AuditLog (anonymized) is the historical record. No third
   flip, no anonymized-member pattern. Frozen for S7.
2. **Soft vs hard map (§6) is frozen** as the S7 treatment table.
3. **AuditLog posture:** retain-and-anonymize, never cascade (tripwired).
   Privacy policy must state this.
4. **No new audit actions in S5.** `ACCOUNT_DELETION_REQUESTED / CANCELLED /
   DELETED` belong to S7.

## 4. S7 preflight contract (read-only gate, run before any purge)

The delete-account pipeline MUST evaluate, per user:

a. **Sole-OWNER block:** SHARED Spaces where the user is the only ACTIVE
   OWNER and ≥1 other ACTIVE member exists → **hard block** with resolution
   instructions (transfer ownership when that flow exists, or delete the
   Space via the normal trash → permanent path). Mirrors the existing
   "cannot remove the OWNER — transfer first" rule. A SHARED Space where the
   user is the sole member is pipeline-deleted like personal property.
b. **Shared-visibility disclosure:** USER-owned `FinancialAccount`s
   SAL-linked into others' Spaces → will be revoked (status REVOKED,
   `revokedByUserId` = self); disclose to the user before confirm.
c. **Canonical re-election:** SPACE-owned accounts where the user holds the
   `isCanonical` `AccountConnection` → re-elect another live connection if
   one exists, else mark the account's `syncStatus` stale. The account
   survives; only the user's connection dies.
d. **Provider revocation queue:** all ACTIVE `PlaidItem`s / `Connection`s →
   revoke at provider (`lib/plaid/disconnect.ts` pattern — at deletion every
   item is orphaned by definition) **before** the user-row delete. Best-effort,
   logged and audited, never blocks the purge.
e. **State check:** account not already pending deletion.

Purge order: revoke SALs → resolve canonical connections → provider
revocation → delete PERSONAL Space (existing Space cascade) → write
`ACCOUNT_DELETED` audit row (masked email hash + purge counts; survives
anonymized) → `db.user.delete()`.

## 5. Audit / retention posture

Append-only; `AuditLog.userId` / `.spaceId` are SetNull so a user's deletion
never erases the security history of Spaces others still occupy. No TTL or
purge job exists or is planned in OPS-2.

## 6. Soft vs hard delete map (frozen for S7)

| Data | Treatment |
|---|---|
| User row + PII (email, names, encrypted DOB, passwordHash, totpSecret), sessions, recovery codes, credit scores | **Hard** |
| PlaidItems / Connections | Revoke at provider, then hard (cascade) |
| PERSONAL Space + everything cascading from it (incl. USER-owned FinancialAccounts, transactions, holdings, imports) | **Hard** |
| SpaceMember rows in surviving Spaces | Cascade accepted (decision §3.1) — AuditLog carries history |
| SALs the user added in surviving Spaces | **Soft** — REVOKED via status before delete; FK then nulls |
| Goals the user created in surviving Spaces | **Survive** with `createdBy` null (this slice's flip) |
| AuditLog | **Retain**, anonymized |

## 7. Out of scope for S5 (deferred)

S6: personal-data export (must land before S7 so "export first" is a real
offer). S7: `deletionRequestedAt`/`deletionScheduledAt` columns, request/cancel
routes (pending window reuses the S4 deactivation gate), Vercel-cron purge
(scheduler remains un-invoked; check cron slot budget), the pipeline itself,
zero-residue sweep script, `ACCOUNT_DELETION_*` audit actions, security-alert
emails, 7-vs-30-day grace decision.
