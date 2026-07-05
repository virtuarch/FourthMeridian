# Timeline Foundation — T-2: Goal Check-In Producer + Consumer Checklist

**Status:** Checklist only. No implementation. Awaiting approval.
**Source of truth:** `docs/initiatives/ev1/investigations/EV-1_CLOSURE_AUDIT_AND_NEXT_STEP.md`, `TIMELINE_T1_MEMBER_LIFECYCLE_GAPFILL_CHECKLIST.md`
**Predecessors:** EV-1 Slices 0–5B, Timeline T-1 complete.
**Branch context:** `feature/v2.5-spaces-completion`

**Goal:** emit `GoalCheckedIn` through the seam **and** teach the activity Timeline to render it, so habit check-ins finally appear in the space feed.

> **⚠ Not a parity migration.** Like T-1, this **intentionally creates new, user-visible Timeline rows** and net-new `AuditLog` rows. **Unlike** T-1, the consumer has **no** handler for this event yet — so this slice makes a **minimal additive consumer change** (one `ALLOWED_ACTIONS` entry + one `normalizeLog` case). That is Timeline *foundation*, not a redesign and not dual-spelling cleanup.

**Hard constraints:** no schema, no migration, no Timeline **redesign**, no dual-spelling cleanup, no other producer migrations. Preserve check-in behavior/response and its transaction. Keep the slice small. Stop after approval.

---

## 1. Current check-in route analysis

`app/api/spaces/[id]/goals/[goalId]/check-in/route.ts` (`POST`, `withApiHandler`):

- **Guarding:** `requireSpaceAction(spaceId, "goal:checkIn")` (any ACTIVE member). HABIT goals only (non-HABIT → 400). Missing goal / wrong space → 404.
- **Auth user is currently discarded:** `const [, err] = await requireSpaceAction(...)` — the auth result's first element is dropped. To set `actorUserId`, capture it (`const [auth, err] = …` → `auth.user.id`). Small, behavior-neutral change.
- **Data available at the write:** `spaceId`, `goalId`, `goal.name`, `note` (`string | null`), `now` (checkedAt), `newStreak` (the updated `currentStreak`), `newLongest` (`longestStreak`), `goal.habitFrequency`.
- **Transaction boundaries:** `db.$transaction([ goalCheckIn.create, spaceGoal.update ])` — **array-form transaction** (check-in row + streak counters commit together).
- **Current response:** `{ checkIn, goal: updatedGoal }`, `201`. Must be preserved.
- **Current audit/event behavior:** **none.** No `auditLog.create`, no `emitDomainEvent`. This is the gap.

---

## 2. Gap confirmation (evidence)

| Question | Finding |
|---|---|
| 2. `GoalCheckedIn` in `DomainEvent` types? | **Yes, PROVISIONAL** — `{ goalId, goalName }` (`lib/events/types.ts:62`). |
| 3. `AuditAction.GOAL_CHECKED_IN` exists? | **No.** Goals group has `GOAL_CREATED/UPDATED/ARCHIVED/TRASHED/RESTORED`, no check-in. **Must add one line.** |
| 4. Activity route recognizes it? | **No.** `GOAL_CHECKED_IN` is absent from `ALLOWED_ACTIONS` and `normalizeLog`. **Consumer change required (in scope).** |

---

## 3. Payload shape

Rule 6: include check-in value/status if available; streak/progress **only if already available and safe**. Available and safe: `goalId`, `goalName` (goal.name), `streak` (newStreak — a plain integer). **Exclude `note`** — it is user free-text on a personal habit; surfacing it in the space activity feed is a broader exposure than the goal detail view and adds no structural value. `longestStreak`/`habitFrequency` are omitted (not needed to render a meaningful row).

**Finalize the provisional type:**
```
GoalCheckedIn: { goalId: string; goalName: string; streak: number }
```
Envelope: `spaceId`, `actorUserId = auth.user.id` (the checker), `ipAddress = getClientIp(req)` (for parity with other space audits; `req` in scope), no `performedByAdminId`/`occurredAt`. Audit-only, **no handler** → `dispatchDomainEvent` is a no-op.

> Note: `getClientIp` is not currently imported in the check-in route → add the import.

---

## 4. Required consumer changes (activity route — minimal, additive)

`app/api/spaces/[id]/activity/route.ts`:

- [ ] **`ALLOWED_ACTIONS`:** add `"GOAL_CHECKED_IN"` (Goals section). No dual spelling — this is a brand-new action with a single canonical string.
- [ ] **`normalizeLog` case `"GOAL_CHECKED_IN"`:**
  - `title`: `"Goal check-in"`
  - `subtitle`: `streak > 1 ? \`${goalName} — ${streak}-day streak\` : \`Checked in on ${goalName}\`` (reads `meta.goalName`, `meta.streak`)
  - `tone`: `"positive"`
  - `icon`: `"Flame"` (Lucide; distinct from goal-completion's `CheckCircle2` — connotes streak). Falls back to `"Activity"` if the widget can't map it.
  - `actorName`: from the row's `userId` join (the checker), consistent with other cases.
- [ ] Update the route's header doc comment ("Supported event types") to list `GOAL_CHECKED_IN` — documentation only.

This is the only consumer touch. **Do not** alter existing cases, aliases, filters, or the noise list (no dual-spelling cleanup, no redesign).

---

## 5. Emit placement — post-commit

Follow the member-DELETE / invite-accept precedent: the array-form `$transaction([...])` is **preserved and not converted**; emit **after** it resolves (no-tx, audit-only, no handler). No side effect needs post-commit ordering — persistence-after-commit is correct and keeps the check-in + streak update atomic.

---

## 6. Duplicate-event risk

- The route **records every check-in**, including "too soon" ones (it still creates a `GoalCheckIn` row; it just doesn't increment the streak — see the `diffMs < minGap` branch). There is **no 409 guard** for rapid re-check-ins.
- Therefore exactly **one `GoalCheckedIn` per successful POST**, matching the existing one-`GoalCheckIn`-row-per-POST behavior. The slice introduces **no new** duplicate risk; back-to-back check-ins with the same `streak` value are possible today and would render as-is (acceptable, faithful to the data).

---

## 7. Exact files

### Edited
- [ ] `lib/audit-actions.ts` — add `GOAL_CHECKED_IN: "GOAL_CHECKED_IN"` in the Goals group.
- [ ] `lib/events/types.ts` — finalize `GoalCheckedIn` payload to `{ goalId, goalName, streak }`; mark EXERCISED (T-2).
- [ ] `lib/events/emit.ts` — add `GoalCheckedIn → AuditAction.GOAL_CHECKED_IN` to `DOMAIN_EVENT_ACTION`. **No `HANDLERS` entry.**
- [ ] `app/api/spaces/[id]/goals/[goalId]/check-in/route.ts` — capture the auth user (`const [auth, err] = …`); add `getClientIp` + `emitDomainEvent` imports; after the `$transaction([...])`, emit `GoalCheckedIn` (no-tx) with `payload: { goalId, goalName: goal.name, streak: newStreak }`. Preserve guards, response, and the transaction.
- [ ] `app/api/spaces/[id]/activity/route.ts` — add the `ALLOWED_ACTIONS` entry + `normalizeLog` case (§4).

**Explicitly NOT touched:** `prisma/schema.prisma`, `lib/events/handlers/*`, `lib/snapshots/*`, other goal routes (create/update/delete), the goal-completion path, any other producer, and every existing `normalizeLog` case / alias.

**Expected `git diff`:** the five files above.

---

## 8. Product delta (call out explicitly)

- **New Timeline rows appear.** Every future HABIT check-in shows **"Goal check-in — {goal} — {n}-day streak"** in the space activity feed. This is the intended value; it is a **visible behavior change**, not parity.
- **Net-new `AuditLog` rows** (`GOAL_CHECKED_IN`); audit volume rises with check-in frequency (habits can be daily → higher volume than invite/join events). Acceptable, but note it.
- **No backfill** — only check-ins after deploy produce rows.
- **Consumer extended** (one new recognized action). Additive; no existing rendering changes.

---

## 9. Validation plan

- [ ] `npx prisma generate` — no schema drift.
- [ ] **No** `npx prisma migrate dev`.
- [ ] `npx tsc --noEmit` — union enforces the finalized payload; `DOMAIN_EVENT_ACTION` resolves `GOAL_CHECKED_IN`; the captured `auth` typechecks.
- [ ] `npm run lint` — 0 errors; confirm new imports used, no now-unused bindings.
- [ ] **Check-in:** POST a HABIT check-in → exactly one `GOAL_CHECKED_IN` row (`userId` = checker; `meta = { goalId, goalName, streak }`); activity feed shows "Goal check-in — {goal} — {n}-day streak".
- [ ] **Non-HABIT / not-found:** POST to a non-HABIT goal → **400**, no row; missing goal → **404**, no row (unchanged).
- [ ] **Response unchanged:** body remains `{ checkIn, goal }`, `201`.
- [ ] **Transaction preserved:** check-in row + streak counters still commit together; the `GOAL_CHECKED_IN` row is written only after commit (roll back the tx in a test → no check-in row and no audit row).
- [ ] **Consumer non-regression:** all existing activity rows render exactly as before; only the new case is added. `git diff` on `activity/route.ts` shows only the additive entry + case (+ doc comment).
- [ ] **`git diff` shows only** the five files in §7.

---

## 10. Rollback plan

- [ ] **Per-file revert.** Remove the emit block + auth-capture + imports from the check-in route; remove the `ALLOWED_ACTIONS` entry + `normalizeLog` case (+ doc comment) from the activity route; remove the `DOMAIN_EVENT_ACTION` entry; revert the `GoalCheckedIn` payload; remove the `GOAL_CHECKED_IN` constant.
- [ ] **Harmless orphans.** Any `GOAL_CHECKED_IN` rows written while live are ordinary audit rows; after revert the consumer no longer lists the action, so they simply stop rendering. No data migration/backfill.
- [ ] **No irreversible steps.** No schema/table/data changes. `git revert` + redeploy fully restores prior behavior.
- [ ] **No kill switch needed** — audit-only, handler-less; cannot affect check-in success, response, or the transaction.

---

## 11. Exit criteria

- [ ] Check-in emits `GoalCheckedIn` post-commit (audit-only, no handler); transaction and response preserved; auth user captured.
- [ ] `GOAL_CHECKED_IN` constant added; event mapped; payload finalized to `{ goalId, goalName, streak }` (note excluded).
- [ ] Activity route recognizes and renders the new event (one `ALLOWED_ACTIONS` entry + one `normalizeLog` case); all existing cases unchanged.
- [ ] Product delta accepted; all validation green; `git diff` limited to §7 files.
- [ ] Deferrals hold: no dual-spelling cleanup, no Timeline redesign, no other producer migrations, no schema.

**Stop after approval of this checklist. No implementation until approved.**
