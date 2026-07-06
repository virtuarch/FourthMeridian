# OPS-2 S7b — Account Deletion Request + Cancel UI: Investigation

**Status:** INVESTIGATION — awaiting approval before implementation
**Slice:** OPS-2 S7b (reversible pending-deletion request + cancel surfaces). Follows S7a (foundations), precedes S7c (purge pipeline).
**Depends on (all shipped):** S7a (`deletionRequestedAt`/`deletionScheduledAt` columns, `pending_deletion` pre-login branch, `cancelDeletion` authorize leg), S6 (`POST /api/user/export`), S4 (deactivate route + card + reactivation login UI — the exact templates).
**Frozen contract:** `OPS2_S7_ACCOUNT_DELETION_INVESTIGATION.md` §2 (state machine), §3.0 (preflight), §5 (routes), §6 (emails), §7 (audit).

**Thesis.** S7b introduces **no new mechanism** — it wires the S7a backend gate to two user surfaces by cloning S4. The request route is `deactivate` + timestamps + preflight; the Settings card is `DeactivateAccountCard` reskinned; the login cancel affordance is the `reactivate` offer reskinned. Nothing is destroyed — the account is fully recoverable for the entire grace window. Purge, cron, and provider revocation are explicitly S7c.

---

## 1. Files inspected

**Templates to clone (S4/S6)**
- `app/api/user/deactivate/route.ts` — the sensitive-action route template (fresh user → password re-auth → rate limit → mutate → revoke sessions → security-alert → audit → SYSTEM_ADMIN block → already-in-state short-circuit).
- `components/security/DeactivateAccountCard.tsx` — the reveal→password-confirm→POST→`signOut()` card pattern.
- `components/dashboard/SettingsClient.tsx` (lines 591–602) — the "Deactivate Account" `DataCard` the new card sits beside. **Already WIP-dirty in the working tree** — S7b edits must be strictly additive and attributable.
- `app/(auth)/login/page.tsx` (`reactivateOffer`/`reactivateMode`, `handleReactivate`, `completeSignIn`, lines 46–266) — the "This account is deactivated → Reactivate and sign in" affordance the cancel offer mirrors. **Also WIP-dirty.**
- `app/api/user/export/route.ts` (S6) — the export-first target; **has no UI yet**, so S7b is its first surfacing.

**S7a primitives (consume, do not modify)**
- `lib/auth.ts` — `cancelDeletion` credential + pending gate + cancellation leg (clears all three timestamps, audits `ACCOUNT_DELETION_CANCELLED`, emails).
- `app/api/auth/pre-login/route.ts` — returns `{ ok:false, reason:"pending_deletion", totpRequired }`.
- `lib/audit-actions.ts` — `ACCOUNT_DELETION_REQUESTED` (already in catalog + allowlist).

**Preflight precedent**
- `app/api/spaces/[id]/members/[userId]/route.ts` — the "Cannot remove the Space owner — transfer ownership first" OWNER guard; the sole-OWNER block is the same idea applied across all the user's SHARED Spaces.

**Reuse infra**
- `lib/session.ts` `requireFreshUser`; `lib/sessions.ts` `revokeAllUserSessions`; `lib/rate-limit.ts` `limitByUser`; `lib/email/send.ts` `sendEmail("security-alert")`; `lib/format.ts` `formatDateTime`.

---

## 2. Proposed minimal diff

**New (4 files)**
1. `app/api/user/delete/route.ts` — `POST`. Clone of `deactivate/route.ts` with: preflight (§3) instead of nothing; on pass, set `deletionRequestedAt=now`, `deletionScheduledAt=now+GRACE`, `deactivatedAt=now` (reuse S7a lockout) in one update; `revokeAllUserSessions`; `sendEmail("security-alert", …)` (requested); audit `ACCOUNT_DELETION_REQUESTED`. Returns **409** with structured `{ error, blockingSpaces }` when the sole-OWNER block fires; **200** on success (client then `signOut()`). Idempotent: if already pending, return success without re-stamping (mirrors deactivate's `already-deactivated` short-circuit).
2. `lib/account-deletion/preflight.ts` — a small server helper: `deletionPreflight(userId) → { blocked, blockingSpaces, disclosures }`. Pure DB reads over `SpaceMember`/`Space`; no new visibility logic. Also exports `GRACE_DAYS`. (Split out rather than inlined because S7c re-asserts the same gate — one source of truth.)
3. `components/security/DeleteAccountCard.tsx` — clone of `DeactivateAccountCard`: reveal → static consequence copy + **"Download my data first"** button (POSTs `/api/user/export`, streams the ZIP) → password confirm → `POST /api/user/delete` → on 200 `signOut({callbackUrl:"/login"})`; on 409 render the blocking-Spaces message with resolution instructions.
4. `lib/account-deletion/preflight.test.ts` — pure test of the sole-OWNER predicate (see §6).

**Edited (2 files, both already WIP-dirty — additive only)**
5. `components/dashboard/SettingsClient.tsx` — one new "Delete Account" `DataCard` rendering `DeleteAccountCard`, directly below the Deactivate card (danger-zone grouping).
6. `app/(auth)/login/page.tsx` — a `pendingDeletionOffer`/`cancelDeletionMode` pair mirroring `reactivateOffer`/`reactivateMode`: handle `reason:"pending_deletion"`, render "This account is scheduled for deletion — Cancel deletion and sign in", thread `cancelDeletion:"true"` through the existing `completeSignIn` (exactly as `reactivate:"true"` is threaded).

No other files. No schema, no migration, no `vercel.json`, no `lib/plaid`, no `jobs`, no purge.

---

## 3. Preflight design

Runs server-side inside `POST /api/user/delete` at request time (S7c re-asserts at purge time). Two parts:

**a. Sole-OWNER block (hard, the only blocking check).** For each Space where the user is an ACTIVE `OWNER` and `type != PERSONAL` and `deletedAt = null`: count OTHER ACTIVE OWNERs and OTHER ACTIVE members. **Block** the Space when `otherActiveOwners === 0 && otherActiveMembers > 0`. If any Space blocks, the route returns 409 with the blocking Space names and instructions: "Transfer ownership (or delete the Space via trash → permanent) before deleting your account." Mirrors the established member-removal OWNER residual. A SHARED Space where the user is the sole member does **not** block (it's materially personal property; S7c pipeline-deletes it).

This is membership/role counting over `SpaceMember` — the same shape the members route already uses — **not** a new permission system.

**b. Disclosures (informational, non-blocking).** Optional counts surfaced so the confirm copy is honest: number of SHARED Spaces the user will leave, and whether USER-owned accounts are shared into others' Spaces (they'll be revoked at purge). Minimal S7b can ship with **static** consequence copy and skip live disclosure counts (the sole-OWNER block is the only thing that must be computed). Recommendation: compute the block; keep disclosures as static copy in the card (open decision D2).

**PERSONAL Space** is never a blocker — it's the user's private container, deleted with them in S7c.

---

## 4. UI design

**Settings → Security (danger zone).** A new "Delete Account" `DataCard` under "Deactivate Account", red-accented, copy: *"Permanently delete your account and all your data. You'll have {GRACE_DAYS} days to cancel by signing back in; after that it can't be undone."*

**`DeleteAccountCard` (reveal flow, clones DeactivateAccountCard):**
1. Collapsed: "Delete account" button (negative accent).
2. Revealed: consequence panel ("signed out everywhere; reversible for {GRACE_DAYS} days by signing in and choosing Cancel; after the window your data is permanently removed") + a secondary **"Download my data first"** button (S6 export) + password field + "Delete my account" confirm + Cancel.
3. On submit → `POST /api/user/delete`. **409** → render blocking-Spaces list + instructions (no state change). **200** → `signOut({callbackUrl:"/login"})`.

**Export-first affordance.** The "Download my data first" button `fetch`es `POST /api/user/export`, turns the response into a Blob, and triggers a download (the export route already enforces its own fresh-user + rate limit + audit, so no new backend). This is S6's first UI surfacing and stays scoped inside the delete flow.

**Login page (cancel).** When `pre-login` returns `reason:"pending_deletion"`, show a panel mirroring the deactivated one: *"This account is scheduled for deletion. Cancel deletion and sign in?"* → button sets `cancelDeletionMode` and calls `completeSignIn({ …, cancelDeletion:true })`, routing through the TOTP screen when `totpRequired`. The S7a `authorize()` leg does the clearing/audit/email; the page only offers the button. Generic message (no scheduled date) keeps `pre-login` unchanged from S7a (open decision D3).

---

## 5. Security considerations

- **Re-auth:** `requireFreshUser()` (live revocation check) **and** current-password confirm — deletion is at least as sensitive as deactivate, and the S7 investigation D2 recommended password re-auth. (Open decision D4, recommend keep.)
- **Rate limit:** `limitByUser(user.id, "account-delete", { limit: 5, windowSec: 900 })`, matching the deactivate route.
- **SYSTEM_ADMIN self-delete blocked** (mirror deactivate; the kill switch is the admin path).
- **Immediate lockout:** setting `deactivatedAt` + revoking all sessions locks the account the moment the request returns; recovery is only via the credential-gated `cancelDeletion` login leg (full auth incl. TOTP). This is the account-takeover-then-delete mitigation.
- **Nothing is destroyed in S7b.** No row is deleted; the account is 100% recoverable for the whole window. Purge/hard-delete is S7c only.
- **Idempotency & races:** already-pending → success no-op; the cancel/purge race is S7c's concern (transactional flag re-check), not reachable in S7b.
- **Audit:** `ACCOUNT_DELETION_REQUESTED` with metadata `{ deletionScheduledAt, graceDays }`; surfaces in the user's own Security History (S7a allowlist).
- **Export-first** reuses S6's already-hardened endpoint — no new data-egress surface.
- **Non-enumeration:** authenticated route, N/A; the login cancel offer preserves S7a's post-password reveal discipline.

---

## 6. Validation plan

- `npx tsc --noEmit`, `npm run lint`, `npm test` green.
- **Pure preflight test** (`lib/account-deletion/preflight.ts` factored so the predicate takes membership rows): sole OWNER + other members → **blocked**; sole OWNER + no other members → **not blocked**; a co-OWNER exists → **not blocked**; PERSONAL Space → **ignored**. No DB.
- **Route behaviour** (harness/manual against a seeded DB): 409 shape on block; 200 sets the three timestamps + revokes sessions + writes the audit row + (non-throwing) emails; already-pending → no-op success; SYSTEM_ADMIN → 403.
- **Round-trip e2e (manual):** request → signed out everywhere → login surfaces `pending_deletion` → "Cancel deletion and sign in" (S7a leg) clears all three timestamps + audits `ACCOUNT_DELETION_CANCELLED` + emails → account active, **zero data lost**.
- **Export-first:** the button downloads a valid S6 ZIP.
- **Grep proofs:** no purge pipeline, no cron/`app/api/jobs` deletion route, no `jobs/*` deletion job, no `vercel.json` diff, no `lib/plaid`/`lib/providers` edits, no `db.user.delete`/`db.*.deleteMany` anywhere in the S7b diff.

---

## 7. Open decisions

- **D1 — Grace period: 7 vs 30 days.** Recommend **7** (S7 investigation default). Drives `GRACE_DAYS` copy + `deletionScheduledAt` math.
- **D2 — Preflight delivery.** Recommend **POST-only**: preflight runs inside the request route, returns 409 with blocking Spaces; disclosures are static card copy. Alternative: a read-only `GET /api/user/delete/preflight` to show live disclosures before the password step (better UX, +1 endpoint, slightly beyond "smallest").
- **D3 — Pending-deletion login message.** Recommend **generic** ("scheduled for deletion") so `pre-login` stays as S7a shipped. Alternative: return `deletionScheduledAt` from `pre-login` to show the exact date (tiny change, reveals the date post-password only).
- **D4 — Password re-auth on the request.** Recommend **yes** (matches deactivate + S7 D2). `requireFreshUser()` alone is the fallback.
- **D5 — Export-first placement.** Recommend **inside `DeleteAccountCard`** (in-scope). A standalone "Download my data" Settings card is a broader S6-surfacing better done separately.

---

**Stopping here for approval.** No code, schema, migration, `vercel.json`, provider, cron, or purge changes were made. On approval, the minimal path is: `lib/account-deletion/preflight.ts` (+ test) → `app/api/user/delete/route.ts` (clone deactivate) → `DeleteAccountCard.tsx` (clone DeactivateAccountCard) → additive edits to `SettingsClient.tsx` and `login/page.tsx` (clone the reactivate affordance). Reuses `requireFreshUser`, `revokeAllUserSessions`, `limitByUser`, `security-alert`, the S6 export endpoint, the S7a `cancelDeletion` leg, and the S4 card/login templates verbatim.
