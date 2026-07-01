# QA Pass #2 — Production Readiness Report

Inspection date: 2026-06-13  
Scope: Full server-side and client-side code review across auth, workspace lifecycle, goal system, account sharing, dashboard, navigation, API error handling, data consistency, and security.

---

## CRITICAL

### C1 — `GET /api/workspaces/[id]/accounts` ignores `visibilityLevel`

**File:** `app/api/workspaces/[id]/accounts/route.ts`

**Reproduction:**
1. User A shares an account into a workspace with `visibilityLevel = BALANCE_ONLY`.
2. User B (any role: ADMIN, MEMBER, VIEWER) calls `GET /api/workspaces/{id}/accounts`.
3. Response contains `institution`, `creditLimit`, `interestRate`, `minimumPayment` — the full record — regardless of the BALANCE_ONLY setting.

**Root cause:** The query destructures only `{ financialAccount: a }` from each `WorkspaceAccountShare` row, discarding `visibilityLevel` entirely. The field is never read. All accounts are returned with a full field spread (`...a`).

```ts
// current — visibilityLevel is fetched but thrown away:
shares.map(({ financialAccount: a }) => ({
  ...a,
  lastUpdated: a.lastUpdated.toISOString(),
}))
```

**Recommended fix:** Include `visibilityLevel` in the destructure and conditionally strip sensitive fields for BALANCE_ONLY shares.

```ts
shares.map(({ financialAccount: a, visibilityLevel }) => {
  const base = {
    id:          a.id,
    name:        a.name,
    type:        a.type,
    balance:     a.balance,
    currency:    a.currency,
    lastUpdated: a.lastUpdated.toISOString(),
  };
  if (visibilityLevel === "BALANCE_ONLY") return base;
  return {
    ...base,
    institution:    a.institution,
    creditLimit:    a.creditLimit,
    debtSubtype:    a.debtSubtype,
    interestRate:   a.interestRate,
    minimumPayment: a.minimumPayment,
  };
})
```

Also add `visibilityLevel: true` to the `WorkspaceAccountShare` select at the top of the query (it's currently omitted from the include).

---

## HIGH

### H1 — Removed members cannot be re-invited (permanent 409)

**File:** `app/api/workspaces/[id]/invite/route.ts`, lines 49–53

**Reproduction:**
1. Invite User B to workspace. B accepts and becomes a MEMBER.
2. Remove B from the workspace. A `WorkspaceMember` row with `status = REMOVED` now exists.
3. Try to re-invite B. The invite endpoint calls `findUnique` on `WorkspaceMember` with no status filter. The stale REMOVED row is found. The check `if (existing)` returns 409 "User is already a member" — even though they were removed.

**Root cause:** The member-existence guard does not filter by `status: ACTIVE`.

```ts
// current — returns any row regardless of status:
const existing = await db.workspaceMember.findUnique({
  where: { workspaceId_userId: { workspaceId, userId: targetUser.id } },
});
if (existing) {
  return NextResponse.json({ error: "User is already a member" }, { status: 409 });
}
```

**Recommended fix:**

```ts
const existing = await db.workspaceMember.findUnique({
  where: { workspaceId_userId: { workspaceId, userId: targetUser.id } },
});
if (existing?.status === WorkspaceMemberStatus.ACTIVE) {
  return NextResponse.json({ error: "User is already a member" }, { status: 409 });
}
```

---

### H2 — REMOVED OWNER/ADMIN can still send workspace invites

**File:** `app/api/workspaces/[id]/invite/route.ts`, lines 20–24

**Reproduction:**
1. User A is an ADMIN of a workspace.
2. A is removed from the workspace (status → REMOVED, but role field stays ADMIN on the stale row).
3. A calls `POST /api/workspaces/{id}/invite`. The caller membership check passes because it finds the stale row with `role = ADMIN` and no status filter.

**Root cause:** Same pattern as H1, but on the *caller* side.

```ts
// current:
const callerMembership = await db.workspaceMember.findUnique({
  where: { workspaceId_userId: { workspaceId, userId: user.id } },
});
if (!callerMembership || !["OWNER", "ADMIN"].includes(callerMembership.role)) { ... }
// ↑ never checks callerMembership.status
```

**Recommended fix:** Add a status check.

```ts
if (
  !callerMembership ||
  callerMembership.status !== WorkspaceMemberStatus.ACTIVE ||
  !["OWNER", "ADMIN"].includes(callerMembership.role)
) {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
```

Same pattern likely needs to be audited in any other route that does a manual caller membership check instead of going through `requireWorkspaceRole` (which should enforce ACTIVE status — verify it does).

---

## MEDIUM

### M1 — `DELETE /api/workspaces/[id]` allows a LEFT owner to delete

**File:** `app/api/workspaces/[id]/route.ts`, lines 96–99

**Reproduction:**
1. User A creates a workspace (role = OWNER).
2. A leaves the workspace (status → LEFT, role stays OWNER on the row).
3. A calls `DELETE /api/workspaces/{id}`. The check `membership?.role !== "OWNER"` passes because the stale row still has `role = OWNER`. The workspace is deleted.

**Root cause:** Caller membership status is not validated.

```ts
// current:
const membership = await db.workspaceMember.findUnique({ ... });
if (membership?.role !== "OWNER") { ... }  // status never checked
```

**Recommended fix:**

```ts
if (!membership || membership.status !== WorkspaceMemberStatus.ACTIVE || membership.role !== "OWNER") {
  return NextResponse.json({ error: "Only the owner can delete this workspace" }, { status: 403 });
}
```

---

### M2 — `GET /api/users/search` excludes REMOVED/LEFT users from invite search

**File:** `app/api/users/search/route.ts`, lines 27–31

**Reproduction:**
1. Remove User B from a workspace.
2. Open the invite flow and search for B by username.
3. B does not appear in results because their stale `WorkspaceMember` row (status = REMOVED) causes their `userId` to be added to `excludeIds`.

**Root cause:** `findMany` on `WorkspaceMember` has no status filter — all rows for the workspace are used to build the exclusion list, including REMOVED and LEFT rows.

```ts
// current:
const members = await db.workspaceMember.findMany({
  where: { workspaceId },       // no status filter
  select: { userId: true },
});
excludeIds.push(...members.map((m) => m.userId));
```

**Recommended fix:**

```ts
const members = await db.workspaceMember.findMany({
  where: { workspaceId, status: WorkspaceMemberStatus.ACTIVE },
  select: { userId: true },
});
```

> Note: M2 compounds H1 — even if the search returned removed users, the invite POST would still reject them with 409. Both fixes are required for re-inviting to actually work end-to-end.

---

## LOW

### L1 — "Refresh Data" button is a dead UI element

**File:** `app/dashboard/layout.tsx`, lines ~23 and ~34

**Reproduction:** Click either the mobile "Refresh" button or the desktop "Refresh Data" button. Nothing happens.

**Root cause:** Both `<button>` elements have no `onClick` handler. The component is a Server Component (layout), but the buttons are rendered as plain HTML with no interactivity wired up.

**Recommended fix:** Convert the relevant section to a Client Component and add an `onClick` that calls `router.refresh()`:

```tsx
"use client";
import { useRouter } from "next/navigation";

// ...
const router = useRouter();
// ...
<button onClick={() => router.refresh()}>Refresh Data</button>
```

---

### L2 — No rate limiting on sensitive auth endpoints

**Files:**
- `app/api/auth/pre-login/route.ts` (has TODO comment)
- `app/api/user/totp/setup/route.ts` (has TODO comment)
- `app/api/user/totp/verify/route.ts` (has TODO comment)
- `app/api/user/totp/disable/route.ts` (has TODO comment)

**Reproduction:** Send unlimited requests to any of these endpoints with no throttling.

**Root cause:** Rate limiting is acknowledged as missing (TODO comments present) but not yet implemented. Pre-login in particular accepts a username/password check on every request with no lockout.

**Recommended fix:** Add rate limiting middleware (e.g., `upstash/ratelimit`, or a simple in-memory token bucket behind a Redis adapter) on these four endpoints before production. The TODO comments already identify the need.

---

## Notable non-issues (verified clean)

- **Auth — registration:** User + personal workspace + member row created atomically in a `$transaction`. DOB AES-256-GCM encrypted at rest. bcrypt cost 12.
- **Auth — token reset:** Single-use reset token; cleared on use. Plaintext token storage noted (not hashed before insert) — low practical risk at current scale but worth upgrading to a hashed token before launch.
- **Auth — session revocation:** Per-request DB check in the NextAuth `session` callback. TOTP enforcement via `PlatformSetting`. Both work correctly.
- **Auth — two-step login:** Dummy hash prevents user enumeration on the pre-login endpoint. Timing is safe.
- **Workspace GET:** `isPublic` check prevents non-members from discovering private workspaces. Correct.
- **Goal system:** Enum guard added server-side (from Bug Fix Pass 1). `archivedAt`/`deletedAt` two-phase soft-delete is correct. Check-in streak deduplication with `minGap` is correct.
- **Invite accept:** `upsert` re-join fix (from Bug Fix Pass 1) handles the stale REMOVED row case on accept. Correct.
- **Workspace delete — PERSONAL guard:** Present and working (`type === "PERSONAL"` check before any auth check).
- **Admin routes:** `requireSystemAdmin` applied. Correct.
- **`requireWorkspaceRole`:** Enforces ACTIVE status via `lib/session.ts`. Routes that use it (goals, sections, accounts/share) are correctly protected. The gap is routes that do *manual* `findUnique` on `WorkspaceMember` instead of going through `requireWorkspaceRole` (H1, H2, M1 above).

---

## Summary

| ID | Severity | File | Issue |
|----|----------|------|-------|
| C1 | Critical | `workspaces/[id]/accounts/route.ts` | `visibilityLevel` ignored — all fields exposed to all members |
| H1 | High     | `workspaces/[id]/invite/route.ts`   | REMOVED target → permanent 409, can never re-invite |
| H2 | High     | `workspaces/[id]/invite/route.ts`   | REMOVED caller → can still send invites |
| M1 | Medium   | `workspaces/[id]/route.ts`          | LEFT owner can delete workspace |
| M2 | Medium   | `users/search/route.ts`             | REMOVED users excluded from search, making re-invite impossible via UI |
| L1 | Low      | `dashboard/layout.tsx`              | Refresh buttons have no onClick — dead UI |
| L2 | Low      | auth endpoints (4 files)            | No rate limiting (TODOs present, not implemented) |

The root pattern behind C1, H1, H2, M1, and M2 is the same: **manual `WorkspaceMember` lookups without a `status: ACTIVE` filter.** Routes that go through `requireWorkspaceRole` are protected; the ones that roll their own `findUnique` are not. A focused audit of every route that does a raw `findUnique` on `WorkspaceMember` would close all five issues systematically.
