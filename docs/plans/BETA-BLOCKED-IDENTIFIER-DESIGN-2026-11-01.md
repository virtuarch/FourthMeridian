# Beta blocked identifiers and abuse evidence: design (2026-11-01)

**Owner ruling (2026-11-01, P2-1 of the #204 review).** The retention of rejected beta requests must not quietly undo a suspected-abuse decision. The owner chose a **hashed blocked-identifier mechanism**, not keeping rejected rows longer. Requirements:
1. A keyed hash (HMAC), with the signing key **outside the database**.
2. A documented retention period and expiry.
3. Manual review, correction and removal, all audited.
4. A legitimate applicant is never permanently blocked solely because of an unreviewed automated classification. **Only an operator-confirmed SUSPICIOUS verdict on a DENIED request blocks.**
5. The **earliest** verified suspicious application is preserved separately as historical evidence, with controlled access and an explicit retention deadline.
6. Normal rejected requests still expire at 180 days.
7. Tests cover deletion, reapplication, alias handling, authorization and races.

Context: PR #204 (the suspected-abuse lock) refuses issuance while the DENIED request row exists. Retention deletes DENIED rows after 180 days (`jobs/data-retention.ts`), and the verdicts cascade with them. Without this design, the lock would lapse silently.

---

## 1. Identifier and key

- **Identifier.** A **conservative** canonical mailbox, `blocklistMailbox(email)`. It is deliberately stricter than the risk heuristic's `canonicalEmailKey`, which strips `+tag` on every domain: a block must never catch a different real person.
  - Lowercased and trimmed everywhere.
  - **gmail.com and googlemail.com:** dots removed, `+tag` removed, domain folded to gmail.com.
  - **Providers documented to deliver `+tag` subaddresses to the same mailbox:** `+tag` removed, dots kept. These are outlook.com, hotmail.com, live.com, msn.com, icloud.com, me.com, mac.com, fastmail.com, proton.me, protonmail.com and pm.me.
  - **Every other domain:** exact, apart from case. Dots and `+` are significant there.

  So `j.o.e+x@googlemail.com` and `joe@gmail.com` are one identifier. `j.doe@example.com` vs `jdoe@example.com`, and `a+b@example.com` vs `a@example.com`, are **different** identifiers.
- **Hash.** `HMAC-SHA256(key_v, canonical)`, stored as hex with its key version `v`.
- **Key.** Dedicated, versioned environment secrets, following the established `BETA_INTAKE_HASH_KEY_*` house pattern:
  - `BETA_BLOCKLIST_HMAC_KEY_VERSION` selects the version, default `v1`;
  - `BETA_BLOCKLIST_HMAC_KEY_<V>` holds the secret, at least 32 characters.

  The key never falls back to another secret, and it is never stored in the database.
- **Rotation.**
  - Writes use the current version.
  - Lookups compute the HMAC for **every configured version** and match `(hmac, version)` pairs, so blocks written under v1 still match after the switch to v2, as long as `_V1` stays set.
  - Retiring a version means waiting for its blocks to expire, or removing them.
- **Missing or invalid key.**
  - **Production** (`VERCEL_ENV === "production"`):
    - issuance (approve, bulk, direct) refuses with **409 `BLOCKLIST_UNAVAILABLE`**, failing closed;
    - creating a block also fails, which rolls back the deny or verdict transaction it belongs to;
    - the public intake still stores the request. It is only a waitlist row, and issuance remains closed, so nothing slips through. The intake logs once.
  - **Outside Production:** blocklist checks are skipped with one warning per process, so development and Preview keep working. The env report flags it.

## 2. Data model (one additive migration, `20261101120000_beta_blocked_identifiers`)

`BetaBlockedIdentifier`
| column | notes |
|---|---|
| `id` | cuid |
| `identifierHmac` | hex HMAC of the canonical mailbox, never the address |
| `keyVersion` | `v1`, `v2`, … |
| `status` | enum `ACTIVE` \| `REMOVED` |
| `sourceRequestId` | soft reference to the BetaAccessRequest that caused it (no FK, so it survives that row's 180-day deletion) |
| `reasonCode` | operator reason code of the confirming action |
| `createdById` | operator id |
| `createdAt`, `expiresAt` | `expiresAt = createdAt + BLOCKLIST_RETENTION_DAYS` |
| `removedAt`, `removedById`, `removalReasonCode`, `removalNote` | set on removal |

- A partial unique index allows at most one ACTIVE row per (`identifierHmac`, `keyVersion`) (`WHERE status = 'ACTIVE'`).
- Indexes on `(status, expiresAt)` and on `sourceRequestId`.

`BetaAbuseEvidence`
| column | notes |
|---|---|
| `id` | cuid |
| `sourceRequestId` | soft reference, **unique** |
| `sealedPayload` | `sealWithPurpose(JSON, BETA_ABUSE_EVIDENCE)`: the request's email, note, createdAt, status, its verdict history (status, reason code, time), and its risk signals (codes and evidence counts). Authenticated encryption under a new `EncryptionPurpose` subkey of `ENCRYPTION_KEY`, which lives outside the database |
| `capturedAt`, `capturedById`, `reasonCode`, `note` | the operator's capture |
| `retainUntil` | **required** and explicit; at most `capturedAt + 3 years` |

Grants and RLS follow the `BetaAccessRequestReview` migration:
- RLS is enabled;
- `fm_system` has SELECT, INSERT, UPDATE and DELETE (DELETE for retention only);
- `fm_backup` has SELECT;
- `fm_app` and `fm_auth` have nothing.

**This is the first migration of B9.** It must be applied before the B9 code. The code also reads the table defensively: if the table is missing in Production, issuance fails closed with BLOCKLIST_UNAVAILABLE.

## 3. When a block is created (operator-confirmed only)

A block is created, in the **same transaction** and under the request row lock (`SELECT … FOR UPDATE` on `BetaAccessRequest`, as in #204), whenever a request **becomes** DENIED with a latest verdict of SUSPICIOUS:
- **Deny** (`/requests/[id]/deny`): reworked into one transaction (row lock, status update, block upsert when the latest verdict is SUSPICIOUS, then audit). Today the update and the audit are separate statements.
- **Risk review** (`/requests/[id]/risk-review`, POST `SUSPICIOUS`) on a DENIED request: the existing transaction already takes the row lock, and the block upsert is added to it.

Rules:
- **Upsert.** If an ACTIVE block already exists for this identifier and version, extend nothing and create nothing. The existing block stands, and the audit says `alreadyBlocked`.
- **Audit.** `BETA_IDENTIFIER_BLOCKED` with `{ blockId, keyVersion, expiresAt, sourceRequestId }`. Never the address, never the full HMAC; an 8-hex prefix at most.
- **Not a block:** an automated risk level (high, review, insufficient), a PENDING+SUSPICIOUS request, or a plain DENIED. This satisfies requirement 4.

## 4. Clearing, correction and removal (audited)

- **Deliberate clear through the verdict.** A newer `LEGITIMATE` or `UNREVIEWED` verdict on the source request does two things in the risk-review transaction:
  - it clears the #204 lock;
  - it marks the request's ACTIVE block REMOVED, with removal reason equal to the verdict's reason code, and audits `BETA_IDENTIFIER_UNBLOCKED`.
- **Removal or correction when the source request is gone.** After 180 days the request no longer exists.
  - `GET /api/platform/growth-revenue/blocked-identifiers` (GROWTH_REVENUE READ) lists:
    - `id`, a `hmacPrefix` (8 hex characters), `keyVersion`, `status`;
    - `createdAt`, `expiresAt`, `reasonCode`;
    - `sourceRequestId`, plus whether that request still exists;
    - removal fields.

    It never shows the address, which the server does not have.
  - `POST …/blocked-identifiers/[id]/remove` requires **fresh GROWTH_REVENUE CONTROL** and a reason. It writes REMOVED and audits `BETA_IDENTIFIER_UNBLOCKED`.
  - `POST …/blocked-identifiers/[id]/expiry` (correction) requires fresh CONTROL and a reason. It sets a new `expiresAt` between now + 1 day and `createdAt + BLOCKLIST_MAX_DAYS`, and audits `BETA_IDENTIFIER_BLOCK_CORRECTED` with before and after values.
  - A **lookup by address** (`POST …/blocked-identifiers/lookup { email }`, fresh CONTROL, audited) answers "blocked or not, and which block id". An operator can check a specific person's appeal without the server ever storing the address. The address is used only to compute the HMAC; it is neither logged nor audited (the audit stores its email hash, as elsewhere).

## 5. Enforcement

- **Issuance** (`loadInviteRowFacts` gains `blocked: boolean`; `planApprove` and `planDirect` refuse **409 `IDENTIFIER_BLOCKED`**):
  - single approve, bulk (eligibility and execute) and direct invite, with the lookup on the canonical mailbox of the row's email or of the direct address;
  - it is re-checked inside the approve or create transaction, after the row lock (approve) or before the insert (create);
  - precedence: `SUSPECTED_ABUSE`, then `IDENTIFIER_BLOCKED`, then other refusals.
- **Intake (re-application).** A blocked canonical mailbox is **silently dropped** with the same 200, with no row, no event, no email and no per-submission audit. Hourly, one counts-only `BETA_INTAKE_BLOCKED_DROPPED { hourWindow, count }` is written, the same oracle-free pattern as the #160 per-address drop.
- **Registration.** No change. It requires an APPROVED invitation, and issuance is closed.

## 6. Retention

- **Blocks:** `BLOCKLIST_RETENTION_DAYS = 730` (2 years) from creation; `BLOCKLIST_MAX_DAYS = 1095` (3 years) is the ceiling for corrections. `jobs/data-retention.ts` gains two rules:
  - delete blocks whose `expiresAt` has passed;
  - delete REMOVED blocks 90 days after `removedAt`, so the audit trail still references a recent removal.

  **Owner: please confirm the 2-year default.**
- **Evidence:** delete when `retainUntil` has passed. There is no automatic extension; extending is a new capture decision.
- **Rejected requests:** unchanged at 180 days. The block outlives them by design.
- **Account deletion and purge:** blocks and evidence are not tied to a user, so they are untouched (there is no `userId`). `BetaAccessRequest` deletion by email stays as it is.

## 7. Evidence capture (the earliest verified suspicious application)

- **Capture.** `POST /api/platform/growth-revenue/requests/[id]/preserve-evidence` requires a **SYSTEM_ADMIN, fresh** session.
  - Body: `{ reason, retainUntil, note? }`.
  - The request must be DENIED with a latest verdict of SUSPICIOUS, and there may be one evidence row per request.
  - It seals the payload and audits `BETA_ABUSE_EVIDENCE_PRESERVED { evidenceId, sourceRequestId, retainUntil }`.
  - The operator picks the request: the owner named the earliest, `hzupno`.
- **Access.**
  - `GET /api/platform/security-ops/abuse-evidence` (SYSTEM_ADMIN, fresh) lists metadata only.
  - `GET …/abuse-evidence/[id]` (SYSTEM_ADMIN, fresh, and **every read audited** as `BETA_ABUSE_EVIDENCE_ACCESSED`) returns the opened payload.
  - There is no edit route. Deletion happens only through retention, or through an explicit `DELETE` (SYSTEM_ADMIN, fresh, reason, audited) before the deadline.

## 8. Races

- **Deny vs verdict.** Both take the request row lock, so whichever commits second sees the other, and the block is created exactly once (by upsert, under the partial unique index).
- **Approve vs block.** Approve locks the same row and re-checks both the lock and the block inside its transaction (#204 pattern).
- **Two direct invites** for the same blocked address: each reads the block inside its transaction, and both refuse.
- **Retention vs clear.** Removing a block that retention already deleted returns 404. Neither can resurrect the other.

## 9. Tests (required)

- **Deletion.** After the request purge (simulated by deleting the row and its verdicts), the block persists. Re-applying the same address, or an alias (dots, `+tag`, googlemail), is silently dropped. A direct invite gets 409 IDENTIFIER_BLOCKED.
- **Reapplication** in every alias form. A different mailbox (not an alias) is not blocked.
- **Operator-confirmed only.** A high automated risk with no verdict creates no block. PENDING+SUSPICIOUS creates no block. Plain DENIED creates no block. DENIED+SUSPICIOUS creates exactly one, whether deny comes first or the verdict comes first.
- **Clear.** A newer LEGITIMATE or UNREVIEWED verdict removes the block. The manual remove and correction routes are audited, need a reason, and enforce the bounds.
- **Authorization.** READ can list but not remove. WRITE cannot remove or correct (CONTROL is required). Non-SYSTEM_ADMIN users cannot capture or read evidence. Every evidence read is audited.
- **Keys.**
  - Missing key in Production: issuance refuses BLOCKLIST_UNAVAILABLE, and a deny that would create a block rolls back.
  - Missing key outside Production: checks are skipped with a warning.
  - Rotation: a v1 block still matches with VERSION=v2 while `_V1` is set.
  - A key shorter than 32 characters is rejected.
- **Retention:** expired blocks, REMOVED blocks after 90 days and evidence past `retainUntil` are deleted. ACTIVE blocks that haven't expired and evidence still within `retainUntil` are kept.
- **Races:** deny and verdict concurrently, approve against a block created mid-plan, and two direct invites.
- **Privacy pins:** no address or full HMAC appears in any audit row or log line. The evidence payload exists only in sealed form.

## 10. Owner and release items

- **Owner decisions:**
  - confirm the 2-year block retention and the 3-year ceilings for blocks and evidence;
  - confirm that CONTROL (not WRITE) is required to remove or correct a block.
- **Release (B9):**
  - apply migration `20261101120000_beta_blocked_identifiers` first;
  - set `BETA_BLOCKLIST_HMAC_KEY_V1` (32+ random characters) in Production and Preview before the B9 code, or Production issuance refuses (fail closed);
  - after B9, capture the `hzupno` evidence through the preserve-evidence route.
- **Catch-up for decisions made before B9.** The 13-request cluster is rejected on B4/5 code, before this ships, so those denials create no blocks.
  - B9 therefore adds `POST …/blocked-identifiers/backfill`: fresh CONTROL, a reason, and a dry run by default.
  - It scans requests that are DENIED with a latest SUSPICIOUS verdict and have no ACTIVE block, then upserts their blocks, each under its row lock.
  - It audits one `BETA_IDENTIFIER_BLOCKED` per block plus one batch row with counts.
  - It is idempotent. Run it once right after B9, within 180 days of the denials: until then the #204 lock still protects those rows.
