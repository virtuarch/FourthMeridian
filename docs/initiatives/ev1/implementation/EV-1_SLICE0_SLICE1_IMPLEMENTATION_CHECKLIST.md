# EV-1 — Slice 0 + Slice 1 Implementation Checklist

**Status:** Checklist only. No implementation. Awaiting approval.
**Source of truth:** `docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md`
**Branch context:** `feature/v2.5-spaces-completion`

**Scope (this checklist only):**
- **Slice 0** — `DomainEvent` typed union only. Pure types, zero runtime.
- **Slice 1** — `emitDomainEvent` helper that persists `AuditLog` rows **only** (empty handler registry), plus migration of **one** low-risk producer site for a row-parity proof.

**Hard constraints (enforced throughout):**
- No schema changes. No migration.
- No event bus. No queue. No async.
- No snapshot handler (Slice 2).
- No timeline / consumer cleanup (Slice 5).
- Preserve behavior exactly.
- Stop after this checklist is approved — do not code yet.

---

## 0. First-producer verification (requested)

**Question:** Is `SpaceUpdated` still the safest first producer?
**Answer: No. Recommend `SpaceRestored` instead.**

`SpaceUpdated` — `PATCH /api/spaces/[id]/route.ts:110` — was the investigation's tentative pick, but on inspection it is **overloaded and not parity-clean**:

- One `auditLog.create` conditionally emits **three** actions: `SPACE_UPDATE`, `SPACE_ARCHIVED`, or `SPACE_UNARCHIVED` (via `archivedAt !== undefined ? … : …`). Migrating "SpaceUpdated" would force handling three events in the first slice.
- `metadata: { name, isPublic, category }` writes the **raw `category` request input**, which is `undefined` on any non-category edit. `undefined` is dropped during JSON serialization, so the persisted key set varies by request — a parity trap for a first proof.

**Recommended first site: `SpaceRestored` — `POST /api/spaces/[id]/restore/route.ts:47`.** It is the cleanest producer in the codebase:

| Property | `SpaceRestored` (recommended) | `SpaceUpdated` (rejected) |
|---|---|---|
| Actions per call site | **1**, unconditional | 3, conditional |
| Action already canonical? | **Yes** — `AuditAction.SPACE_RESTORED` (no drift literal) | `SPACE_UPDATE` is canonical but siblings aren't clean |
| Transaction | **None** — sequential `update` then `create` | None |
| Downstream side effects | **None** — header: "pure `deletedAt -> null` flip, nothing more" | None |
| Metadata | **`{ name: space.name }`** — always defined, no conditional | `category` may be `undefined` (dropped key) |
| Blast radius | Restore-from-trash, rare, OWNER-only | Every space edit, high traffic |
| Parity type | **Exact byte-for-byte** (canonicalization is a no-op) | Requires 3-way reasoning |

Because `SPACE_RESTORED` is *already* the canonical constant, the migrated row must be **byte-for-byte identical** to today's — the strongest possible parity proof, since any diff at all signals a regression rather than an intended canonicalization.

**Runner-up:** `SpaceTrashed` — `DELETE /api/spaces/[id]/route.ts:156` — also single-action (`AuditAction.SPACE_TRASHED`), no transaction, and side-effect-free per the same file header. Use it as the fallback if `restore` is unavailable for any reason.

---

## 1. Exact files

### Slice 0 (new, types only)
- [ ] `lib/events/types.ts` — `DomainEventEnvelope`, the `DomainEvent` discriminated union, and the `DOMAIN_EVENT_ACTION` map. **No runtime logic. No imports beyond `@/lib/audit-actions` types and Prisma types.**

### Slice 1 (new + one edit)
- [ ] `lib/events/emit.ts` — `emitDomainEvent()` helper. Persistence only; **empty handler registry** (a declared but empty dispatch step, wired in Slice 2).
- [ ] `app/api/spaces/[id]/restore/route.ts` — **edit**: replace the single inline `db.auditLog.create({ … })` block with one `emitDomainEvent({ type: "SpaceRestored", … })` call. No other line in the file changes.

**Files explicitly NOT touched in Slices 0–1:** `prisma/schema.prisma`, `lib/audit-actions.ts`, `lib/timeline-*.ts`, `app/api/spaces/[id]/activity/route.ts`, `lib/snapshots/*`, any other producer route.

---

## 2. Event types (Slice 0)

Slice 0 declares the shared envelope and the **full Tier-1 + Tier-2 union** from the investigation (§3). Types are free at runtime; declaring the whole vocabulary in one reviewable diff locks canonical naming. **Only the `SpaceRestored` variant is exercised in Slice 1**; payloads for not-yet-migrated variants are pinned to their real call sites when each is migrated in later slices, and are marked provisional here.

### 2.1 Shared envelope
```
interface DomainEventEnvelope {
  spaceId?: string | null;          // → AuditLog.spaceId  (mapped to legacy column "workspaceId")
  actorUserId?: string | null;      // → AuditLog.userId
  ipAddress?: string | null;        // → AuditLog.ipAddress
  performedByAdminId?: string | null; // → AuditLog.performedByAdminId
  occurredAt?: Date;                // → AuditLog.createdAt (omit to accept DB default now())
}
```

### 2.2 Discriminated union (keyed on `type`)
```
type DomainEvent =
  // ── Space lifecycle ──────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "SpaceRestored";  payload: { name: string } })        // EXERCISED in Slice 1
  | (DomainEventEnvelope & { type: "SpaceCreated";   payload: { name: string; isPublic: boolean; category: string } })      // provisional
  | (DomainEventEnvelope & { type: "SpaceUpdated";   payload: { name: string; isPublic: boolean; category?: string } })     // provisional
  // ── Members ──────────────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "MemberInvited";      payload: { invitedEmail: string; role: string } })                 // provisional
  | (DomainEventEnvelope & { type: "MemberJoined";       payload: { userId: string } })                                     // provisional
  | (DomainEventEnvelope & { type: "MemberRemoved";      payload: { targetUserId: string; targetName: string; newStatus: string } }) // provisional
  | (DomainEventEnvelope & { type: "MemberRoleChanged";  payload: { targetUserId: string; targetName: string; oldRole: string; newRole: string } }) // provisional
  // ── Account sharing ──────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "AccountShared";        payload: { financialAccountId: string; accountName: string; visibilityLevel: string } }) // provisional
  | (DomainEventEnvelope & { type: "AccountShareRevoked";  payload: { financialAccountId: string; accountName: string | null } })                   // provisional
  // ── Goals ────────────────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "GoalCreated";    payload: { goalId: string; name: string; goalType: string; targetAmount: number | null } })    // provisional
  | (DomainEventEnvelope & { type: "GoalCheckedIn";  payload: { goalId: string; goalName: string } })                       // provisional
  // ── Sync / snapshots ─────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "ConnectionSynced";   payload: { provider: string; connectionId: string; updatedAccountIds: string[] } })        // provisional
  | (DomainEventEnvelope & { type: "SnapshotGenerated";  payload: { date: string; netWorth: number } });                    // provisional
```

### 2.3 `type` → `AuditAction` binding (compile-time)
```
const DOMAIN_EVENT_ACTION: Record<DomainEvent["type"], AuditActionType> = {
  SpaceRestored:       AuditAction.SPACE_RESTORED,   // ONLY entry needed for Slice 1
  SpaceCreated:        AuditAction.SPACE_CREATE,
  SpaceUpdated:        AuditAction.SPACE_UPDATE,
  MemberInvited:       AuditAction.MEMBER_INVITED,
  MemberJoined:        AuditAction.MEMBER_JOINED,       // NOTE: constant does not exist yet — add in the slice that emits it, NOT now
  MemberRemoved:       AuditAction.MEMBER_REMOVED,
  MemberRoleChanged:   AuditAction.MEMBER_ROLE_CHANGED,
  AccountShared:       AuditAction.ACCOUNT_SHARED,
  AccountShareRevoked: AuditAction.ACCOUNT_REVOKED,
  GoalCreated:         AuditAction.GOAL_CREATED,
  GoalCheckedIn:       AuditAction.GOAL_CHECKED_IN,     // NOTE: constant does not exist yet — add in the slice that emits it, NOT now
  ConnectionSynced:    AuditAction.PLAID_REFRESH,       // (revisit provider-neutral naming when migrated)
  SnapshotGenerated:   AuditAction.SNAPSHOT_GENERATED,  // NOTE: constant does not exist yet — add in the slice that emits it, NOT now
};
```

- [ ] **Slice-0 discipline:** the map above references three constants that don't exist yet (`MEMBER_JOINED`, `GOAL_CHECKED_IN`, `SNAPSHOT_GENERATED`). Since Slice 0 must **not** edit `lib/audit-actions.ts`, either (a) declare the map with only the constants that already exist and mark the three future keys with a `// added in Slice N` TODO, or (b) keep the map minimal to the migrated event. **Recommended: option (b)** — declare `DOMAIN_EVENT_ACTION` with the `SpaceRestored` entry now and extend it per slice. This keeps Slice 0 free of any `audit-actions.ts` dependency on not-yet-defined constants. The union in §2.2 may still declare all variants (types only), but the action map grows with real migrations.

---

## 3. Emit signature (Slice 1)

```
async function emitDomainEvent(
  event: DomainEvent,
  ctx?: { tx?: Prisma.TransactionClient },
): Promise<void>
```

- [ ] `event` is the fully-typed discriminated union — the compiler guarantees a valid `type` + matching `payload`.
- [ ] `ctx.tx` optional. When present, persistence uses the caller's transaction client (`ctx.tx.auditLog.create`) so a producer can emit inside its existing `$transaction` and keep KD-4 atomicity. When absent (the `restore` case), persistence uses the module `db` client. **The `restore` migration passes no `tx`** — it has no transaction today, and we preserve that.
- [ ] Return type `Promise<void>` — emit is fire-and-persist; it returns nothing, mirroring the current inline `await db.auditLog.create(...)`.
- [ ] Handler dispatch step exists in the code path but iterates an **empty registry** in Slice 1 (documented as "handlers wired in Slice 2"). No handler runs, so behavior cannot change.

---

## 4. AuditLog mapping (exact)

`emitDomainEvent` maps the envelope + payload to the existing `AuditLog` columns. **No schema change** — this is a mapping over current columns.

| `AuditLog` column | Source in `emitDomainEvent` | Notes |
|---|---|---|
| `action` | `DOMAIN_EVENT_ACTION[event.type]` | For `SpaceRestored` → `AuditAction.SPACE_RESTORED` (identical to today's literal) |
| `metadata` | `event.payload` (as `Prisma.InputJsonValue`) | For `SpaceRestored` → `{ name }` (identical shape/keys to today) |
| `userId` | `event.actorUserId ?? null` | maps from envelope |
| `spaceId` | `event.spaceId ?? null` | persisted to legacy `workspaceId` column via existing `@map` — unchanged |
| `ipAddress` | `event.ipAddress ?? null` | `restore` passes `getClientIp(req)` — identical to today |
| `performedByAdminId` | `event.performedByAdminId ?? null` | `restore` passes none → `null` (today's row also omits it → `null`) |
| `userAgent` | not set | `restore` does not set it today → stays default `null` |
| `createdAt` | `event.occurredAt` if provided, else DB default `now()` | `restore` passes none → DB default, identical to today |

### 4.1 The `restore` call, before → after
**Before** (`app/api/spaces/[id]/restore/route.ts:47`):
```
await db.auditLog.create({
  data: {
    userId:    user.id,
    spaceId:   id,
    action:    AuditAction.SPACE_RESTORED,
    metadata:  { name: space.name },
    ipAddress: getClientIp(req),
  },
});
```
**After:**
```
await emitDomainEvent({
  type:        "SpaceRestored",
  spaceId:     id,
  actorUserId: user.id,
  ipAddress:   getClientIp(req),
  payload:     { name: space.name },
});
```
- [ ] No other line in `restore/route.ts` changes. The `db.space.update` above it is untouched.

---

## 5. Row-parity expectations

The migrated `SpaceRestored` row must be **byte-for-byte identical** to the pre-migration row (the action was already canonical, so canonicalization is a no-op):

- [ ] `action` === `"SPACE_RESTORED"` (unchanged).
- [ ] `metadata` === `{ "name": <space name> }` — same single key, same value, no added/dropped keys.
- [ ] `userId` === restoring user's id (unchanged).
- [ ] `spaceId` (column `workspaceId`) === space id (unchanged).
- [ ] `ipAddress` === `getClientIp(req)` result (unchanged).
- [ ] `performedByAdminId` === `null`, `userAgent` === `null`, `createdAt` === DB `now()` (all unchanged).
- [ ] **Timeline non-regression:** `SPACE_RESTORED` is already in `activity/route.ts` `ALLOWED_ACTIONS` and its `normalizeLog` case reads `meta.name` — the migrated row renders identically ("Goal restored"… no: "Space restored" via `GOAL_RESTORED`? — confirm: `SPACE_RESTORED` currently has **no** dedicated timeline case, so it is filtered out today and must remain filtered out after. Parity = still not shown.) Verify the rendered timeline is unchanged either way.
- [ ] **Method:** capture the `AuditLog` row from a restore action on `main`/pre-change, then from the migrated build, and diff all columns. Expect zero differences.

> Parity note: because `restore` writes no `tx` and no handler runs, the emit path is a strict 1:1 replacement of one `auditLog.create`. There is no behavioral surface other than the row itself.

---

## 6. Validation (run after each slice)

- [ ] `npx prisma generate` — confirms no schema drift (none expected).
- [ ] **No** `npx prisma migrate dev` — EV-1 Slices 0–1 introduce no migration. If one appears needed, stop: scope has been exceeded.
- [ ] `npx tsc --noEmit` — primary safety net; the discriminated union must compile and the `restore` call must type-check against the `SpaceRestored` variant.
- [ ] `npm run lint`.
- [ ] **Row-parity diff** (§5) on the `restore` endpoint — zero column differences.
- [ ] **Timeline non-regression** — `GET /api/spaces/[id]/activity` output identical before/after for a space that was restored.
- [ ] **Manual smoke:** trash a non-personal space, restore it as OWNER, confirm 200 + `deletedAt` cleared + exactly one `AuditLog` row written.
- [ ] Confirm Slice 0 alone (types only) has **zero** runtime footprint: `git diff` shows only `lib/events/types.ts` added and no import of it from runtime code until Slice 1.

---

## 7. Rollback

- [ ] **Slice 0:** delete `lib/events/types.ts`. Nothing imports it yet; no other effect. No DB impact.
- [ ] **Slice 1:** revert `app/api/spaces/[id]/restore/route.ts` to the inline `db.auditLog.create` block (§4.1 "before"), and delete `lib/events/emit.ts`. Because the emit wrote the **same** `AuditLog` row, historical data is unaffected and no cleanup/backfill is required.
- [ ] **Mixed-state safety:** if only Slice 0 is merged (types, no callers), the system is unchanged at runtime — Slice 1 can be deferred or reverted independently.
- [ ] **No irreversible steps:** no table created/altered/dropped, no legacy table removed, no data rewritten. A `git revert` + redeploy fully restores prior behavior.
- [ ] **No kill switch needed** at this slice — with an empty handler registry there is no dispatch to disable; persistence parity means there is nothing unsafe to gate.

---

## 8. Exit criteria

- [ ] `lib/events/types.ts` compiles; union + `SpaceRestored` variant reviewed.
- [ ] `lib/events/emit.ts` persists rows only; empty handler registry documented.
- [ ] `restore/route.ts` emits `SpaceRestored`; byte-for-byte row parity confirmed.
- [ ] All validation checks green.
- [ ] Slices 2–5 remain unstarted and unblocked.

**Stop after approval of this checklist. No implementation until Slice 0 + Slice 1 are approved.**
