# OPS-2 S7 — Account Deletion: Investigation & Design

**Status:** INVESTIGATION — awaiting approval before implementation
**Slice:** OPS-2 S7 (Delete Account). Final OPS-2 slice.
**Builds on:** S1 (Security Center), S2/S2b (password hardening + session revocation), S3 (change email), S4 (deactivation/reactivation), S5 (deletion inventory — the ratified contract), S6 (personal data export).
**Frozen inputs:** `OPS2_S5_DELETION_INVENTORY.md` (cascade map + preflight contract, RATIFIED), `OPS2_ACCOUNT_LIFECYCLE_INVESTIGATION.md` §4 / §4.6.
**Scope guardrails honored:** investigation only, no code, no schema change, no migration, no implementation. Reuse existing primitives; propose no new systems unless necessary.

The thesis: S1–S6 already built every primitive S7 needs. S7 is an **orchestration slice** — a state machine, an ordered purge that composes existing helpers, one cron route modeled on `sync-banks`, and three audit actions. The only genuinely new code is the pipeline sequencing and its preflight gate. Two nullable timestamp columns are the entire schema cost.

---

## 1. Files inspected

**Deletion / destructive precedents**
- `app/api/spaces/[id]/permanent/route.ts` — the ONLY `db.space.delete()` in the codebase. The canonical "audit-before-delete, then one cascading delete" pattern S7 copies.
- `jobs/purge-trash.ts` — existing scheduled, idempotent, cutoff-based purge (7-day retention on trashed goals). The purge-cadence precedent.
- `lib/plaid/disconnect.ts` — `disconnectPlaidItemIfOrphaned(plaidItemDbId)`: `itemRemove` at Plaid (best-effort, try/caught) then mark `PlaidItem.status = REVOKED`.
- `lib/providers/catalog.ts` (+ `lib/providers/plaid` adapter) — the provider-agnostic seam; today only PLAID is live, MANUAL/WALLET have nothing to revoke upstream.
- `lib/accounts/space-account-link.ts` — SAL write/revoke helpers (`dualWriteSpaceAccountLink`, `resolvePersonalSpaceId`, `resolveAccountCreatorUserId`).

**Auth / lifecycle to reuse**
- `lib/session.ts` — `requireFreshUser()` (live revocation check).
- `lib/sessions.ts` — `revokeAllUserSessions(userId)` (returns count) and `revokeOtherUserSessions`.
- `app/api/user/deactivate/route.ts` — the sensitive-action template (fresh user → password re-auth → mutate → revoke sessions → security-alert → audit).
- `lib/auth.ts` §"Reactivation (OPS-2 S4)" — the `reactivate` credential leg (full auth incl. TOTP, then clear `deactivatedAt`, audit, email). Cancellation mirrors it exactly.
- `app/api/auth/pre-login/route.ts` — the post-password `reason: "deactivated"` branch; S7 adds a sibling `reason: "pending_deletion"`.
- `jobs/sync-banks.ts` — bank sync already filters `user: { deactivatedAt: null }`, so a pending-deletion user (which sets `deactivatedAt`) is auto-skipped by sync.

**Scheduler / cron**
- `vercel.json` — 2 crons live: `/api/jobs/sync-banks` (`0 6 * * *`), `/api/jobs/fetch-fx-rates` (`30 6 * * *`), region `sin1`.
- `app/api/jobs/sync-banks/route.ts` — the cron auth pattern: `Authorization: Bearer ${CRON_SECRET}`, `maxDuration = 60`, `withApiHandler`.
- `jobs/scheduler.ts` — `startScheduler()` (setInterval-based) is **never invoked** (no `instrumentation.ts`); it does not run on Vercel serverless. `purgeTrash` is registered there and is therefore effectively **dead in production**. S7 must NOT depend on it.

**Reuse infra (from S1/S2/S6)**
- `lib/email/send.ts` `sendEmail("security-alert", …)` (template takes `{ title, message }`).
- `lib/audit-actions.ts` `AuditAction` catalog; `lib/security-history.ts` allowlist.
- `lib/rate-limit.ts` `limitByUser`.
- `lib/plaid/encryption.ts` `decryptWithPurpose` (Plaid token for `itemRemove`).

---

## 2. Deletion state machine

Reuses `deactivatedAt` as the lockout mechanism; `deletionScheduledAt` is the distinguishing timer. "Pending deletion" IS "deactivated + a scheduled purge time."

```
                 ┌─────────────────────────────────────────────┐
                 │                   ACTIVE                     │
                 │  deactivatedAt=null  deletionScheduledAt=null│
                 └───────────────┬─────────────────────────────┘
                                 │  POST /api/user/delete
                                 │  (fresh user + password re-auth + PREFLIGHT passes)
                                 │  → set deletionRequestedAt, deletionScheduledAt=now+GRACE,
                                 │    deactivatedAt=now; revokeAllUserSessions();
                                 │    email(requested); audit ACCOUNT_DELETION_REQUESTED
                                 ▼
                 ┌─────────────────────────────────────────────┐
                 │             PENDING DELETION                 │
                 │  deactivatedAt=set  deletionScheduledAt=set  │
                 │  login gated to the cancel leg only;         │
                 │  bank-sync skips (deactivatedAt filter)      │
                 └──────┬───────────────────────────────┬──────┘
      cancel: login `cancelDeletion` leg               │  cron: deletionScheduledAt <= now
      (full auth incl. TOTP)                           │  AND user row still exists
      → clear deletionRequestedAt,                     ▼
        deletionScheduledAt, deactivatedAt   ┌───────────────────────┐
      → email(cancelled)                     │        PURGING        │
      → audit ACCOUNT_DELETION_CANCELLED     │ (ordered pipeline §3) │
                 │                           └───────────┬───────────┘
                 ▼                                       │ pipeline completes
        back to ACTIVE                                   ▼
                                             ┌───────────────────────┐
                                             │        DELETED        │
                                             │ User row gone; audit  │
                                             │ ACCOUNT_DELETED       │
                                             │ survives anonymized   │
                                             └───────────────────────┘
```

**Every transition**

| From | Trigger | Guard | Effect |
|---|---|---|---|
| ACTIVE → PENDING | `POST /api/user/delete` | fresh user + correct password + preflight (§3.0) passes; not SYSTEM_ADMIN; not already pending | set 3 timestamps, revoke all sessions, email, audit REQUESTED |
| PENDING → ACTIVE | login `cancelDeletion` leg | full auth (password + TOTP/recovery) succeeds | clear 3 timestamps, email, audit CANCELLED |
| PENDING → PURGING | cron `process-deletions` | `deletionScheduledAt <= now` AND row exists AND still pending (re-checked in tx) | run §3 pipeline |
| PURGING → PENDING (retry) | pipeline error mid-run | any step throws | leave timestamps; next daily cron resumes (all steps idempotent) |
| PURGING → DELETED | pipeline success | — | `User` row deleted; `ACCOUNT_DELETED` audit survives via SetNull |
| ACTIVE → (blocked) | `POST /api/user/delete` | sole ACTIVE OWNER of a SHARED Space with other members (§3.0a) | **409**, no state change, resolution instructions |

Notes: password reset stays available to a pending account (reset ≠ cancel). SYSTEM_ADMIN cannot self-delete (mirrors S4's self-deactivate block; the `DISABLE_SYSTEM_ADMIN` kill switch is the admin path).

---

## 3. Purge order (validated against S5)

### 3.0 Preflight (read-only gate) — runs at REQUEST time and is re-asserted at PURGE time

Per S5 §4. Blocks the request if unsafe; discloses side-effects before confirm.

- **a. Sole-OWNER block** — SHARED Spaces where the user is the only ACTIVE OWNER and ≥1 other ACTIVE member exists → **hard block** (409) with resolution instructions (transfer ownership when that flow exists, or delete the Space via trash→permanent). A SHARED Space where the user is the sole member is treated as personal property and pipeline-deleted.
- **b. Shared-visibility disclosure** — USER-owned `FinancialAccount`s SAL-linked into others' Spaces will be REVOKED; disclose counts before confirm.
- **c. Canonical-connection note** — SPACE-owned accounts where the user holds the `isCanonical` connection will re-elect or go stale; informational.
- **d/e. State checks** — not SYSTEM_ADMIN; not already pending.

### 3.1 Purge pipeline (per user, at scheduled time)

External side-effects run OUTSIDE any DB transaction (KD-4 rule); the destructive DB steps run INSIDE one `db.$transaction` so a mid-purge failure leaves nothing half-deleted (resume next run).

| # | Step | S5 basis | Reuses |
|---|---|---|---|
| 0 | **Re-validate**: row exists, `deletionScheduledAt <= now`, still pending (read inside tx). Abort cleanly if cancelled/raced. | §4e | — |
| 1 | **Revoke all sessions** (idempotent re-assert; already revoked at request). | §4.6 | `revokeAllUserSessions` |
| 2 | **Provider revocation** (OUTSIDE tx, best-effort): for every ACTIVE `PlaidItem`, `itemRemove` at Plaid then mark `REVOKED`; MANUAL/WALLET `Connection`s have nothing upstream. Failures logged + audited, **never block**. | §4d | `disconnectPlaidItemIfOrphaned` pattern / `lib/plaid/disconnect.ts` |
| 3 | **Revoke SALs** the user added in surviving Spaces → `status=REVOKED`, `revokedByUserId=self` (soft; the S5 FK flip nulls `addedByUserId` harmlessly on the later user delete). | §4a, §6 | SAL revoke helpers |
| 4 | **Canonical re-election**: for SPACE-owned accounts where the user's `AccountConnection` is `isCanonical`, re-elect another live connection or mark the account `syncStatus` stale; soft-delete the user's connection. Account survives. | §4c | AccountConnection soft-delete pattern |
| 5 | **Delete USER-owned FinancialAccounts** (`ownerUserId=self`) explicitly — cascades their transactions, holdings, `AccountConnection`, `DebtProfile`, `ProviderAccountIdentity`, `SpaceAccountLink`, `GoalContribution`, `ImportBatch`. **Required** because `FinancialAccount.ownerUserId` is SetNull, not Cascade — deleting the user alone would orphan these as ghost rows (S5 §4b). | §4b, §6 | `db.financialAccount.delete` cascade |
| 6 | **Delete PERSONAL Space** via `db.space.delete()` → existing cascade removes SpaceMember, SpaceInvite, AiAgent, AiAdvice, legacy Account, SpaceGoal (+contributions/check-ins), SpaceDashboardSection, SpaceSnapshot, ImportMappingProfile. | §4.2, §6 | `spaces/[id]/permanent` cascade |
| 7 | **Write `ACCOUNT_DELETED` audit** (userId still set; metadata: masked email hash + purge counts). Written BEFORE the user delete so SetNull preserves it anonymized. | §4.5, §5 | `permanent` route's audit-first trick |
| 8 | **`db.user.delete()`** → cascades UserSession, RecoveryCode, CreditScore, PlaidItem, Connection, SpaceMember (accepted, §3.1), SpaceInvite; SetNull nulls AuditLog.userId, surviving SpaceGoal.createdBy, SpaceAccountLink.addedByUser/revokedBy. | §1, §6 | schema cascades (S5-corrected) |

**Validation against S5:** every row of the S5 §1 cascade table and §4 preflight is covered — SpaceMember cascade accepted (§3.1); AuditLog retained-and-anonymized (§5); PlaidItem/Connection revoked-then-cascade (§4d); SALs soft-revoked (§4a); surviving shared goals kept with null creator (§6); USER-owned accounts resolved explicitly (§4b, the one step easy to miss because `ownerUserId` SetNull ≠ personal-space cascade). Purge order equals S5's stated order with steps 4–5 made explicit.

---

## 4. Required schema (absolute minimum — DO NOT implement)

Two nullable columns on `User`, additive, no backfill, metadata-only migration:

- `deletionRequestedAt DateTime?` — when the user requested deletion (audit/UX).
- `deletionScheduledAt DateTime?` — when the purge is due (`= requestedAt + GRACE`). This single field is the cron's selection key and the pending-vs-deactivated discriminator.

**No new lockout column** — `deactivatedAt` (S4) is reused as the login/sync gate. **No cancel-token columns** — cancellation is login-based (§8), so no hashed-token trio is needed. **No new tables.** (An optional index on `deletionScheduledAt` could speed the cron scan, but at beta volume a full scan of the tiny pending set is fine — defer.)

---

## 5. Required routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/user/delete` | `requireFreshUser()` + current-password re-auth + `limitByUser` | Run preflight (§3.0); on pass set timestamps + `deactivatedAt`, `revokeAllUserSessions`, email(requested), audit REQUESTED. Returns preflight disclosure (§3.0b/c) on the confirm step. |
| `GET /api/jobs/process-deletions` | `Bearer ${CRON_SECRET}`, `maxDuration = 60` | Vercel Cron entrypoint. Selects users with `deletionScheduledAt <= now`, runs §3 pipeline per user. Modeled 1:1 on `sync-banks/route.ts`. Added to `vercel.json`. |

**Cancellation needs no new endpoint** — it rides the NextAuth `authorize()` `cancelDeletion` credential leg (§8), exactly as S4's reactivation rides the `reactivate` leg. (Sessions are revoked at request time, so an authenticated cancel route would be unreachable anyway.) `pre-login/route.ts` gets one added branch, not a new route.

---

## 6. Required emails (all reuse the existing `security-alert` template)

1. **Deletion requested / scheduled** — "Your account is scheduled for deletion on {date}. Sign in before then to cancel. If this wasn't you, sign in and cancel now."
2. **Deletion cancelled** — "Your scheduled account deletion was cancelled; your account is active again."
3. **Deletion completed** — "Your Fourth Meridian account and data have been deleted." Sent at pipeline start (step ~1) while the email is still readable, since the `User` row is gone by step 8.

No new template, sender, or transport — `sendEmail("security-alert", email, { title, message })` covers all three. All non-throwing (delivery failure never blocks the state change).

---

## 7. Required audit actions (add to `lib/audit-actions.ts`)

- `ACCOUNT_DELETION_REQUESTED`
- `ACCOUNT_DELETION_CANCELLED`
- `ACCOUNT_DELETED`

REQUESTED and CANCELLED are user-security-relevant → add to the `SECURITY_HISTORY_ACTIONS` allowlist + labels (they surface in the Security Center while the account still exists, and update the pinned `security-history.test.ts` count, exactly as S6 did for `DATA_EXPORTED`). `ACCOUNT_DELETED` is written with `userId` set, then survives with `userId` null after the cascade — it is platform forensics, not user-facing, so it goes in the catalog but not the user allowlist.

---

## 8. Cancellation flow

Mirror S4 reactivation precisely (`lib/auth.ts` §"Reactivation").

1. User visits `/login` during the window → `pre-login` returns `{ ok:false, reason:"pending_deletion", totpRequired }` (new branch beside the `"deactivated"` one).
2. Login page shows "Your account is scheduled for deletion on {date}. Cancel and sign in?" → submits credentials with `cancelDeletion:"true"` (+ TOTP/recovery where enabled).
3. `authorize()` gate: if `deletionScheduledAt` set and NOT `cancelDeletion` → block login (audit `LOGIN_FAILED` reason `pending_deletion`), same shape as the deactivation gate.
4. After **full** auth succeeds and `cancelDeletion` is set → in one `db.$transaction`: clear `deletionRequestedAt`, `deletionScheduledAt`, `deactivatedAt`; audit `ACCOUNT_DELETION_CANCELLED`; then (non-throwing) email(cancelled). A normal session is created.
5. **Cancel-vs-purge race:** cancellation clears `deletionScheduledAt`; the cron re-reads the flag INSIDE its transaction (step 3.0) and skips if cleared. Because grace is measured in days and the cron runs daily, the window where both could fire is negligible, and the transactional flag re-check closes it deterministically. Cancellation is allowed right up until the purge transaction commits.

Email-link cancellation without login (S5 §4.6's "cancel link") is **deferred** — it would require a hashed single-use token column pair. Login-to-cancel needs zero new schema and covers the safety case (the attacker-deletes-then-user-recovers scenario is satisfied by the multi-day window + alert email + credential-gated cancel). Revisit in OPS-3 if support data shows users need link-cancel.

---

## 9. Scheduler — recommendation: **Vercel Cron** (new route, no new system)

| Option | Verdict |
|---|---|
| **Vercel Cron** (`/api/jobs/process-deletions`, daily, `CRON_SECRET`, `maxDuration 60`) | **RECOMMEND.** Identical to the two live crons; authed; serverless; zero new infra. The purge job function (`jobs/process-deletions.ts`) is also directly callable from a script/admin for testing. |
| `jobs/scheduler.ts` `startScheduler()` | **Reject.** Never invoked, setInterval-based, does not run on Vercel serverless. Wiring it up is a larger, out-of-scope change; `purgeTrash` proves it's dead. |
| Manual trigger only | **Reject** as the mechanism (a time-based purge must automate), but keep the job function manually invocable for ops/verification. |
| Background worker (BullMQ/queue) | **Reject.** New system, new dependency, unjustified at beta scale. Explicitly an OPS-4 concern if volume ever demands it. |

**The one infra caveat — cron slot budget.** Vercel Hobby limits cron count (the two existing slots may be the ceiling). Options if a 3rd dedicated slot isn't available: (a) run `process-deletions` on a **weekly** schedule (grace is in days, exact hour is irrelevant); (b) append `processDeletions()` to the tail of the existing daily `sync-banks` cron (couples concerns but uses no new slot); (c) upgrade plan. **Recommend a dedicated daily route; fall back to appending to `sync-banks` if the slot is unavailable.** This is the single deployment decision to confirm (open decision D3).

Idempotency + resumability (like `purge-trash`): the cron reselects any still-existing user past their scheduled time each run, so a failed/partial purge simply retries on the next tick.

---

## 10. Validation plan

1. **Zero-residue proof** (the headline test): a scripted sweep for a deleted `userId` across every table — must find nothing except anonymized `AuditLog` rows (`userId=null`). Mirrors `lib/deletion-safety.test.ts`'s schema-scan discipline; can be a `scripts/verify-deletion.ts` harness run against a seeded user.
2. **Ghost-account guard:** after purge, assert no `FinancialAccount` with the deleted user's former `ownerUserId` survives (validates step 5), and that **shared** Space-owned accounts the user merely connected DO survive with a re-elected/stale canonical connection (validates step 4).
3. **Surviving-Space integrity:** a SHARED Space the user co-owned/participated in still exists with its other members, its goals survive with `createdBy=null`, and the user's SALs are `REVOKED` (validates steps 3, 6-exclusion, S5 §6).
4. **Sole-OWNER block:** preflight returns 409 for a sole-OWNER-with-other-members Space; no state change.
5. **Provider revocation:** Plaid sandbox proof that `itemRemove` fires before the row is gone; a simulated `itemRemove` failure must NOT block the purge (best-effort assertion) and must log/audit.
6. **Cancellation + race:** cancel via the login leg clears all three timestamps and audits CANCELLED; a cancel committed before the cron's tx re-check causes the cron to skip (transactional-flag test).
7. **Freed-email re-registration:** the deleted user's email re-registers cleanly (unique constraint freed).
8. **Audit survival:** `ACCOUNT_DELETED` row exists post-delete with `userId=null` and the masked-hash + counts metadata intact.
9. **Envelope reuse:** request route enforces fresh-user + password + rate limit; emails fire non-throwing (mirror the deactivate route tests).

Where possible these are pure/harness tests in the repo's standalone-`tsx` style; the DB-touching ones (1, 5, 7) are `scripts/*` harnesses run against a seeded/sandbox DB, matching the existing `scripts/test-*.ts` convention (not part of `npm test`).

---

## 11. Implementation order & slice breakdown

Recommended split (each independently shippable, additive-first, audited/rate-limited from birth):

- **S7a — Foundations (schema + audit + gates).** The 2 `User` columns (migration); 3 audit actions + allowlist/labels + test count; `pre-login` `pending_deletion` branch; `authorize()` `cancelDeletion` gate+leg (mirrors S4). No purge yet. Small, low-risk, unblocks everything.
- **S7b — Request + cancel routes.** `POST /api/user/delete` (fresh user + password + preflight + set timestamps + revoke sessions + email + audit); the preflight module (`lib/account-deletion/preflight.ts`); wire the cancel leg end-to-end; security-page "Delete account" + confirm UI that offers **"Export first"** (links S6's `POST /api/user/export`). Pending-deletion is fully live and reversible, but nothing purges yet — safe to ship.
- **S7c — Purge pipeline + cron.** `lib/account-deletion/pipeline.ts` (§3 steps, transaction + external-effect discipline); `jobs/process-deletions.ts`; `GET /api/jobs/process-deletions` (+ `vercel.json`); `ACCOUNT_DELETED` audit; the `scripts/verify-deletion.ts` zero-residue harness. The only slice that destroys data — ships last, behind the verification harness.

(If preferred as one slice, S7a+S7b can merge; keep S7c separate so the destructive path lands with its proof.)

**Complexity estimate:** **Moderate.** S7a/S7b are low (they re-skin S4 deactivation + S6 export affordances). S7c is the real work — the ordered pipeline and its resume/idempotency semantics — but it composes existing helpers rather than inventing mechanisms. No new libraries, one new dependency-free cron route, ~2 lib modules + 2 routes + 1 job + 1 harness. Schema is 2 nullable columns.

**Biggest risks**
1. **Provider revocation is best-effort but has real cost** — a failed `itemRemove` before the PlaidItem cascades means an item stays authorized (and potentially billing) at the institution with its token destroyed. Mitigation: retry within the run, log + audit failures for manual/OPS-4 sweep; never block the user's deletion. This is the highest-consequence residual.
2. **Step 5 (USER-owned account deletion) is easy to omit** — `ownerUserId` SetNull ≠ personal-space cascade; missing it silently orphans balances. The zero-residue + ghost-account tests exist specifically to catch this.
3. **Cron slot budget** (§9 D3) — a deployment decision, not code risk, but must be settled before S7c ships.
4. **Cancel/purge race** — closed by the transactional flag re-check, but must be implemented exactly (read the flag inside the purge tx, not before).

**Defer to OPS-3 / OPS-4**
- Email-link cancellation (token columns) — OPS-3 if needed.
- Ownership-transfer flow (the clean resolution for the sole-OWNER block) — currently the user must delete the Space via trash→permanent; a real transfer flow is OPS-3.
- Async/queued purge, provider-revocation retry queue, and any batch-scale hardening — OPS-4 (explicitly out of scope while a daily cron over a tiny pending set suffices).
- Admin-initiated deletion / GDPR operator tooling — not in OPS-2; would reuse the same pipeline behind an admin gate later.

---

## 12. Open decisions

- **D1 — Grace period: 7 vs 30 days.** Recommend **7** (S5/lifecycle recommendation: any multi-day window + alert satisfies the takeover-then-delete threat; shorter honors intent faster). 30 is a retention posture, not a safety one.
- **D2 — Password re-auth on the request route.** Recommend **yes** (deletion is more destructive than S6 export; matches S4 deactivate). `requireFreshUser()` alone is the fallback.
- **D3 — Cron slot** (§9): dedicated daily route (recommended) vs appended to `sync-banks` vs weekly.
- **D4 — Email-link cancel:** defer (recommended) vs include the token trio now.

---

**Stopping here for approval.** No code, schema, or migration changes were made. On approval, the smallest path is S7a→S7b→S7c as above, reusing `requireFreshUser`, `revokeAllUserSessions`, the `security-alert` email, the S4 reactivation leg, `disconnectPlaidItemIfOrphaned`, the `spaces/[id]/permanent` delete pattern, the `sync-banks` cron shape, and the S5 deletion inventory verbatim.
