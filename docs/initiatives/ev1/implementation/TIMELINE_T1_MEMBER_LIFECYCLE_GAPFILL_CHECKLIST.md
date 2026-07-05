# Timeline Foundation — T-1: Member Lifecycle Producer Gap-Fill Checklist

**Status:** Checklist only. No implementation. Awaiting approval.
**Source of truth:** `docs/initiatives/ev1/investigations/EV-1_CLOSURE_AUDIT_AND_NEXT_STEP.md`
**Predecessors:** EV-1 Slices 0–5B complete.
**Branch context:** `feature/v2.5-spaces-completion`

**Goal:** emit `MemberInvited` and `MemberJoined` through the domain-event seam so the activity Timeline finally shows invitations and joins — rows the consumer was **built to render** but no producer has ever fed.

> **⚠ This is NOT a parity migration.** Prior EV-1 slices preserved behavior byte-for-byte. T-1 **intentionally creates new, user-visible Timeline rows** and net-new `AuditLog` rows. See §7 (product delta) — this must be approved as a deliberate product change.

**Hard constraints:** no schema, no migration, no Timeline **consumer** cleanup, no dual-spelling cleanup, no `GoalCheckedIn`, no other producer migrations. Preserve existing invite behavior, responses, auth, and transaction boundaries. Stop after approval.

---

## 1. Producer analysis

### 1.1 Invite creation → `MemberInvited` — `app/api/spaces/[id]/invite/route.ts`
- `POST /api/spaces/[id]/invite` (plain `export async function POST`, not `withApiHandler`). Invites **by username**; ADMIN+ only.
- Writes a single `db.spaceInvite.upsert(...)` — **no `$transaction`**, **no audit today**.
- Available fields at the write: `spaceId`; inviter `user.id`; invitee `targetUser.{id, name, username}` (selected); `role` (default `"MEMBER"`); `invite.id`.
- `req: NextRequest` is in scope (so `getClientIp(req)` is available if we want `ipAddress`). `getClientIp` is **not** currently imported.

### 1.2 Invite accept → `MemberJoined` — `app/api/spaces/[id]/invites/[inviteId]/route.ts`
- `PATCH …/invites/[inviteId]` (plain `export async function PATCH`). Only the invited user; body `{ action: "accept" | "decline" }`.
- **Accept path** runs `db.$transaction([ spaceMember.upsert(→ACTIVE), spaceInvite.update(→ACCEPTED) ])` — **array-form transaction**, **no audit today**.
- **Decline path** updates the invite only — **no `MemberJoined`** should be emitted here.
- Available fields at accept: `spaceId`; joining `user.id` (from `requireUser`); `invite.role`; `inviteId`; `invite.invitedById`.
- `req: NextRequest` in scope; `getClientIp` not imported.

### 1.3 Transaction boundaries
- `MemberInvited`: no transaction → **no-tx emit** after the upsert.
- `MemberJoined`: array-form `$transaction([...])`. Per the member-DELETE precedent, **do not convert** the array form. Emit **post-commit** (no-tx) after the transaction resolves. Since these events have **no handler**, there is no post-commit side effect to order — persistence-after-commit is sufficient and preserves atomicity of member+invite.

### 1.4 AuditAction constants
- `AuditAction.MEMBER_INVITED` **exists** (line 59).
- `AuditAction.MEMBER_JOINED` **does NOT exist** → **add one line** `MEMBER_JOINED: "MEMBER_JOINED"` (mirrors the `SPACE_LEAVE` addition in Slice 3). This is the only `audit-actions.ts` change and is required.

### 1.5 In-tx vs post-commit (decision)
Both emit **post-commit / no-tx, audit-only, no handler**. No in-tx persist is needed: neither event has a side effect, and neither has an existing audit row whose atomicity must be preserved. This keeps both diffs minimal and leaves the array-form transaction untouched.

### 1.6 Duplicate-event risk
- `MemberInvited`: the route returns **409** if a `PENDING` invite already exists, so no duplicate while pending. Re-invite is only possible after DECLINED/rescinded → a genuinely new invitation → a new event (correct, not a duplicate).
- `MemberJoined`: the route returns **409** if the invite is not `PENDING`, so accept fires at most once per invite. Re-join after LEAVE/REMOVE (via a fresh invite) is a legitimate new join.
- `invited` and `joined` are **distinct** events for one member flow (both wanted); they do not double-count each other.

---

## 2. Consumer readiness (already built — DO NOT modify)

`app/api/spaces/[id]/activity/route.ts` already renders both, and must stay untouched:

- `MEMBER_INVITED` → reads `meta.invitedEmail` (fallback `"Someone"`) + `meta.role`; `actorName` from the row's `userId` join. Subtitle: `"{invitedEmail} was invited as {role}"`, icon `UserPlus`.
- `MEMBER_JOINED` → reads **no metadata**; uses `actorName` from the row's `userId` join. Subtitle: `"{actor} joined the space"`, icon `UserCheck`.

**Implication for actor fields:**
- `MemberInvited.actorUserId` = **inviter** (`user.id`) → renders the inviter as the actor; the invitee goes in `invitedEmail` (see §3 decision).
- `MemberJoined.actorUserId` = **joining user** (`user.id`) → the consumer derives "{name} joined" from that user relation. Payload is not read by the consumer.

---

## 3. Decision point — the `MemberInvited` display field

The consumer reads `meta.invitedEmail`, but invites are **username-based** (the route selects `name`/`username`, not email). To render a meaningful row **without touching the consumer**, the producer must write an `invitedEmail` key. Options:

- **(Recommended) Option A — put a safe display handle in `invitedEmail`.** Populate `invitedEmail` with `targetUser.name ?? "@" + targetUser.username` (a "safe field" per the activity route's own security note, which forwards *names/roles*, not raw emails). Renders `"Bob was invited as MEMBER"`. No extra DB select (name already fetched), no email exposure, no consumer change. **Debt:** the key is misnamed (holds a display name, not an email) — flag for a future consumer-side rename slice.
- **Option B — real email.** Add `email: true` to the invitee select and pass the actual email. Accurate to the key name, but exposes the invitee's email to all space members, contradicting the "safe fields (names, roles)" posture.
- **Option C — honest keys only.** Payload `{ invitedUserId, invitedUsername, role }`; consumer shows the generic `"Someone was invited as MEMBER"` until a future consumer-improvement slice. Cleanest metadata, weakest rendering.

**This checklist assumes Option A.** Confirm or switch before implementation.

---

## 4. Exact event payloads (finalize provisional types)

```
MemberInvited: {
  invitedUserId: string;   // targetUser.id  (honest audit field; not read by consumer)
  role: string;            // invite role (default "MEMBER")  → meta.role
  invitedEmail: string;    // Option A: targetUser.name ?? "@"+username  → meta.invitedEmail
}
MemberJoined: {
  userId: string;          // joining user id (== envelope actorUserId; kept for completeness)
  role: string;            // invite.role  (not read today; useful future metadata)
}
```

Envelopes:
- `MemberInvited`: `spaceId`, `actorUserId = inviter user.id`, `ipAddress = getClientIp(req)` (recommended for parity with other space audits), no `performedByAdminId`/`occurredAt`.
- `MemberJoined`: `spaceId`, `actorUserId = joining user.id`, `ipAddress = getClientIp(req)`, no `performedByAdminId`/`occurredAt`.

Both map audit-only, **no handler** registered → `dispatchDomainEvent` is a no-op.

---

## 5. Exact files

### Edited
- [ ] `lib/audit-actions.ts` — add `MEMBER_JOINED: "MEMBER_JOINED"` in the Members group. (`MEMBER_INVITED` already exists.)
- [ ] `lib/events/types.ts` — finalize `MemberInvited` payload to `{ invitedUserId, role, invitedEmail }` (per §3 Option A); add `role` to `MemberJoined` payload → `{ userId, role }`; mark both EXERCISED (T-1).
- [ ] `lib/events/emit.ts` — add to `DOMAIN_EVENT_ACTION`: `MemberInvited → AuditAction.MEMBER_INVITED`, `MemberJoined → AuditAction.MEMBER_JOINED`. **No `HANDLERS` entries.**
- [ ] `app/api/spaces/[id]/invite/route.ts` — after the `spaceInvite.upsert`, emit `MemberInvited` (no-tx); add imports `emitDomainEvent` and `getClientIp`. Preserve all guards/responses.
- [ ] `app/api/spaces/[id]/invites/[inviteId]/route.ts` — in the **accept** branch only, after the `$transaction([...])` resolves, emit `MemberJoined` (no-tx); add imports `emitDomainEvent` and `getClientIp`. **Do not** emit on decline. Do not convert the array-form transaction. Preserve responses.

**Explicitly NOT touched:** `prisma/schema.prisma`, `app/api/spaces/[id]/activity/route.ts` (consumer), `lib/events/handlers/*`, `lib/snapshots/*`, the invite DELETE (cancel) handler, decline path, and every other producer.

**Expected `git diff`:** the five files above.

---

## 6. Implementation plan (order)

1. [ ] `lib/audit-actions.ts`: add `MEMBER_JOINED`.
2. [ ] `lib/events/types.ts`: finalize payloads + EXERCISED marks.
3. [ ] `lib/events/emit.ts`: map both events (no handlers).
4. [ ] `invite/route.ts`: emit `MemberInvited` post-upsert.
5. [ ] `invites/[inviteId]/route.ts`: emit `MemberJoined` post-transaction, accept-only.
6. [ ] Validate (§8); confirm `git diff` limited to the five files.

---

## 7. Product delta (call out explicitly)

- **New Timeline rows will appear.** Every future invite shows **"Member invited"**; every future accept shows **"Member joined"** in the space activity feed. These were dormant handlers with no producer; T-1 turns them on. This is the intended value of the slice — but it is a **visible behavior change**, not a parity migration.
- **Net-new `AuditLog` rows.** `MEMBER_INVITED` / `MEMBER_JOINED` rows are now written on invite/accept (audit volume rises modestly).
- **Historical invites/joins remain invisible** — only actions taken after deploy produce rows (no backfill; no data migration).
- **`invitedEmail` key holds a display name** under Option A (documented debt).

---

## 8. Validation plan

- [ ] `npx prisma generate` — no schema drift.
- [ ] **No** `npx prisma migrate dev`.
- [ ] `npx tsc --noEmit` — union enforces both payloads; `DOMAIN_EVENT_ACTION` resolves `MEMBER_INVITED`/`MEMBER_JOINED`.
- [ ] `npm run lint` — 0 errors; confirm new imports (`emitDomainEvent`, `getClientIp`) are used and nothing is left unused.
- [ ] **Invite create:** POST invite → exactly one `MEMBER_INVITED` row (`userId` = inviter, `meta = { invitedUserId, role, invitedEmail=<name/@handle> }`); activity feed shows "Member invited — {name} was invited as {role}".
- [ ] **Invite accept:** PATCH accept → exactly one `MEMBER_JOINED` row (`userId` = joiner); feed shows "Member joined — {joiner} joined the space".
- [ ] **Decline:** PATCH decline → **no** `MEMBER_JOINED` row; invite → DECLINED as before.
- [ ] **Guards intact:** re-invite while PENDING → 409, no extra row; accept of non-PENDING → 409, no extra row.
- [ ] **Transaction preserved:** accept still commits member(ACTIVE)+invite(ACCEPTED) atomically; the `MEMBER_JOINED` row is written only after commit (roll back the tx in a test → no member, no join row).
- [ ] **Timeline consumer untouched:** `git diff` shows no change to `activity/route.ts`.
- [ ] **`git diff` shows only** the five files in §5.

---

## 9. Rollback plan

- [ ] **Per-file revert.** Remove both emit blocks (+ imports); remove the two `DOMAIN_EVENT_ACTION` entries; revert `types.ts` payloads; remove the `MEMBER_JOINED` constant. Invite create/accept return to writing no audit.
- [ ] **Harmless orphans.** Any `MEMBER_INVITED`/`MEMBER_JOINED` rows written while live are ordinary audit rows; after revert, the Timeline simply has no producer for them again (they render from history if the consumer aliases remain, which is fine). No data migration/backfill either way.
- [ ] **No irreversible steps.** No schema/table/data changes. `git revert` + redeploy fully restores prior behavior.
- [ ] **No kill switch needed** — audit-only, handler-less; cannot affect invite success, responses, or the accept transaction.

---

## 10. Exit criteria

- [ ] Invite create emits `MemberInvited`; invite accept emits `MemberJoined` (accept-only, post-commit); both audit-only, no handler.
- [ ] `MEMBER_JOINED` constant added; both events mapped; payloads finalized (§3 decision recorded).
- [ ] New rows render correctly in the activity feed; decline emits nothing; guards and the accept transaction intact.
- [ ] Product delta accepted; all validation green; `git diff` limited to §5 files.
- [ ] Deferrals hold: no consumer cleanup, no dual-spelling cleanup, no `GoalCheckedIn` (future Slice T-2), no other producer migrations.

**Stop after approval of this checklist — including the §3 display-field decision. No implementation until approved.**
