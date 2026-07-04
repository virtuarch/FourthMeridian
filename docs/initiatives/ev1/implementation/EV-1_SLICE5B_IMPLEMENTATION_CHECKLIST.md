# EV-1 — Slice 5B Implementation Checklist (Remaining Canonical Producers)

**Status:** Checklist only. No implementation. Awaiting approval.
**Source of truth:** `docs/initiatives/ev1/investigations/EV-1_SLICE5A_CANONICAL_ACTION_AUDIT.md`
**Completed:** Slices 0–4.
**Branch context:** `feature/v2.5-spaces-completion`

**Goal:** migrate the last two live, Timeline-visible legacy producers to canonical audit-only domain events, so **every** live producer emits a canonical action (the prerequisite for a later consumer-only Timeline cleanup).

**Targets:**
1. Members **PATCH** — `MEMBER_ROLE_CHANGE` → event `MemberRoleChanged` → `MEMBER_ROLE_CHANGED`.
2. Goals **POST** — `GOAL_CREATE` → event `GoalCreated` → `GOAL_CREATED`.

**Hard constraints:** no schema, no migration, no data migration, no Timeline/consumer cleanup, no new handlers, audit-only events, preserve route behavior and metadata byte-for-byte except the intended action canonicalization. Timeline renders identically because it already aliases both spellings. Stop after approval.

---

## 1. Producer verification (as-found)

### 1.1 Members PATCH — `app/api/spaces/[id]/members/[userId]/route.ts:73–92`
- Sequence: `db.spaceMember.update(...)` then a **standalone** `db.auditLog.create(...)`. **No `$transaction`. No snapshot side effect.**
- Current write: `action: "MEMBER_ROLE_CHANGE"` (literal), `metadata: { targetUserId, targetName, oldRole: targetMembership.role, newRole: role }`, `userId: user.id`, `spaceId`, `ipAddress: getClientIp(req)`.
- Fit: **NO-TX, audit-only** — identical shape to Slice 1/4 producers.
- Imports: the file **already imports** `emitDomainEvent` and `type DomainEvent` (added for the DELETE handler in Slice 3) → **no import change needed.**

### 1.2 Goals POST — `app/api/spaces/[id]/goals/route.ts:139–148`
- Sequence: `db.spaceGoal.create(...)` then a **standalone** `db.auditLog.create(...)`. **No `$transaction`. No snapshot side effect.**
- Current write: `action: "GOAL_CREATE"` (literal), `metadata: { goalId: goal.id, name: goal.name, goalType, targetAmount }`, `userId: user.id`, `spaceId`, `ipAddress: getClientIp(req)`.
- Fit: **NO-TX, audit-only.**
- Imports: does **not** import `emitDomainEvent` → **add it**. Does **not** import `AuditAction` (used a literal) → nothing to remove.

### 1.3 Constants — both already exist (no `audit-actions.ts` change)
`AuditAction.MEMBER_ROLE_CHANGED` (line 61) and `AuditAction.GOAL_CREATED` (line 36) are already defined. **`lib/audit-actions.ts` is not touched.**

### 1.4 Provisional payload vs. real metadata
| Event | Provisional type today | Real metadata | Action |
|---|---|---|---|
| `MemberRoleChanged` | `{ targetUserId: string; targetName: string; oldRole: string; newRole: string }` | `{ targetUserId, targetName, oldRole, newRole }` | **Matches** — no type change (only mark EXERCISED). `oldRole` is a `SpaceMemberRole` enum value, assignable to `string`. |
| `GoalCreated` | `{ goalId: string; name: string; goalType: string; targetAmount: number \| null }` | `{ goalId, name, goalType, targetAmount }` where `targetAmount` is typed `number \| undefined` (body: `targetAmount?: number`) and is **never null** in this write | **Correct the type** to `targetAmount?: number`. |

> Why the `GoalCreated` correction matters: the current audit passes the **raw** `targetAmount` (`number | undefined`), so when it is absent the JSON key is **omitted** (never stored as `null`). To preserve byte parity, the event must pass the same raw expression; the payload type must therefore be `targetAmount?: number` (optional, omit-when-undefined), not `number | null`. The provisional `number | null` was inaccurate.

---

## 2. Exact files

### Edited
- [ ] `lib/events/types.ts` — `GoalCreated` payload: `targetAmount: number | null` → `targetAmount?: number`; mark `GoalCreated` and `MemberRoleChanged` as EXERCISED (Slice 5B) in comments. `MemberRoleChanged` payload is unchanged.
- [ ] `lib/events/emit.ts` — add to `DOMAIN_EVENT_ACTION`: `MemberRoleChanged → AuditAction.MEMBER_ROLE_CHANGED`, `GoalCreated → AuditAction.GOAL_CREATED`. **No `HANDLERS` entries** (audit-only, no side effect).
- [ ] `app/api/spaces/[id]/members/[userId]/route.ts` — **PATCH handler only:** replace the standalone `db.auditLog.create({ action: "MEMBER_ROLE_CHANGE", … })` with `await emitDomainEvent({ type: "MemberRoleChanged", spaceId, actorUserId: user.id, ipAddress: getClientIp(req), payload: { targetUserId, targetName, oldRole: targetMembership.role, newRole: role } })`. No `tx`. No import change. DELETE handler untouched.
- [ ] `app/api/spaces/[id]/goals/route.ts` — **POST handler only:** add `import { emitDomainEvent } from "@/lib/events/emit";`; replace the standalone `db.auditLog.create({ action: "GOAL_CREATE", … })` with `await emitDomainEvent({ type: "GoalCreated", spaceId, actorUserId: user.id, ipAddress: getClientIp(req), payload: { goalId: goal.id, name: goal.name, goalType, targetAmount } })`. No `tx`.

**Explicitly NOT touched:** `prisma/schema.prisma`, `lib/audit-actions.ts`, `lib/events/handlers/snapshot.ts`, `lib/snapshots/regenerate.ts`, `app/api/spaces/[id]/activity/route.ts` (Timeline), any other producer, the members DELETE handler, and all goal update/archive/delete writes.

**Expected `git diff`:** `lib/events/types.ts`, `lib/events/emit.ts`, `app/api/spaces/[id]/members/[userId]/route.ts`, `app/api/spaces/[id]/goals/route.ts`.

---

## 3. Event mappings

| Producer | Event | Canonical action | Was (literal) | Payload (== today's metadata) |
|---|---|---|---|---|
| Members PATCH | `MemberRoleChanged` | `MEMBER_ROLE_CHANGED` | `MEMBER_ROLE_CHANGE` | `{ targetUserId, targetName, oldRole, newRole }` |
| Goals POST | `GoalCreated` | `GOAL_CREATED` | `GOAL_CREATE` | `{ goalId, name, goalType, targetAmount? }` |

Envelope (both): `spaceId` = route `spaceId`, `actorUserId` = `user.id`, `ipAddress` = `getClientIp(req)`, no `performedByAdminId`, no `occurredAt`. **No handler registered for either** → `dispatchDomainEvent` is a no-op for both (no-tx path calls it, does nothing).

---

## 4. Row-parity expectations

Intentional action canonicalization; everything else byte-identical.

- [ ] **Action:** `MEMBER_ROLE_CHANGE` → **`MEMBER_ROLE_CHANGED`**; `GOAL_CREATE` → **`GOAL_CREATED`**. Both safe — Timeline `ALLOWED_ACTIONS` + `normalizeLog` already alias both spellings ("Role changed" / "Goal created" render identically).
- [ ] **Metadata:** identical keys/values. `MemberRoleChanged` → `{ targetUserId, targetName, oldRole, newRole }`. `GoalCreated` → `{ goalId, name, goalType, targetAmount }` with `targetAmount` **omitted** when the request supplies none (same as today).
- [ ] `userId`, `spaceId` (legacy `workspaceId` column), `ipAddress`: unchanged.
- [ ] `performedByAdminId` = `null`, `userAgent` = `null`, `createdAt` = DB `now()`: unchanged.
- [ ] **Exactly one** `AuditLog` row per role change / goal creation (no handler persists anything).
- [ ] Audit remains **outside** any transaction (there is none) — no atomicity change.

---

## 5. Side-effect parity expectations

- [ ] **None to preserve** — neither producer has a snapshot or other side effect today, and no handler is registered for the new events. Behavior is identical: only the audit row's `action` string changes.

---

## 6. Validation plan

- [ ] `npx prisma generate` — no schema drift expected.
- [ ] **No** `npx prisma migrate dev`.
- [ ] `npx tsc --noEmit` — must pass; confirms the `GoalCreated` payload correction accepts the raw `targetAmount` (`number | undefined`) and that both emit calls type-check.
- [ ] `npm run lint` — 0 errors; confirm no unused imports (goals route gains `emitDomainEvent`; members route unchanged imports).
- [ ] **Row-parity diff:** capture `AuditLog` rows for (a) a role change and (b) a goal creation, before/after. Confirm only the `action` canonicalized; all other columns/metadata identical, including `targetAmount` omission when absent.
- [ ] **Timeline non-regression:** `GET /api/spaces/[id]/activity` renders "Role changed" and "Goal created" identically before/after (consumer aliases both spellings).
- [ ] **Manual smoke:** owner changes a member's role (expect one `MEMBER_ROLE_CHANGED` row); create a goal with and without `targetAmount` (expect one `GOAL_CREATED` row each; `targetAmount` present/absent in metadata matches input).
- [ ] **`git diff` shows only** the four files in §2.

---

## 7. Rollback strategy

- [ ] **Per-file revert.** Restore each handler's standalone `db.auditLog.create` (legacy literal action); remove the two `DOMAIN_EVENT_ACTION` entries; revert the `GoalCreated` payload type + EXERCISED comments; drop the goals route `emitDomainEvent` import.
- [ ] **Mixed-state safe.** Emitted rows are ordinary `AuditLog` rows; Timeline reads both spellings; a partial revert is valid. No data migration/backfill.
- [ ] **No irreversible steps.** No schema/table/data changes. `git revert` + redeploy fully restores prior behavior; `MEMBER_ROLE_CHANGED`/`GOAL_CREATED` rows written while live remain valid history under either code state.
- [ ] **No kill switch needed** — audit-only, handler-less; cannot affect request success or side effects.

---

## 8. Exit criteria

- [ ] Both producers emit canonical audit-only events via the no-tx path; standalone `auditLog.create` calls removed.
- [ ] No handlers registered for either event; no snapshot/side-effect change.
- [ ] Row parity (action canonicalized, all else identical incl. `targetAmount` omission) confirmed; Timeline unchanged.
- [ ] All validation green; `git diff` limited to §2 files.
- [ ] **All live Timeline-visible producers now emit canonical actions** — unblocking a future consumer-only cleanup.
- [ ] Deferrals hold: no Timeline dual-spelling cleanup, no `SpaceCreated`/`SpaceUpdated` seam routing, no goal update/archive/delete cleanup, no manual-asset codification, no `MemberInvited`/`MemberJoined` producers.

**Stop after approval of this checklist. No implementation until approved.**
