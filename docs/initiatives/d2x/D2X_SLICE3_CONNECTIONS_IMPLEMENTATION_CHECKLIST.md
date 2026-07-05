# D2.x — Slice 3: Connections Experience — Implementation Checklist

**Status:** Checklist only. No implementation until approved.
**Source:** `D2X_SLICE3_CONNECTIONS_EXPERIENCE_INVESTIGATION.md` (approved direction).
**Decision:** First increment of the permanent `/dashboard/connections` page, backed by a provider-agnostic read-only `/api/sync/status` endpoint. Plaid Link success routes here. `/dashboard/accounts` untouched.

---

## 1. Exact files

| # | File | Action | Notes |
|---|------|--------|-------|
| 1 | `lib/sync/status.ts` | **New** | Provider-agnostic types + pure derivation (no I/O). |
| 2 | `app/api/sync/status/route.ts` | **New** | `GET`, `requireUser`, reads `PlaidItem` safe fields. |
| 3 | `app/(shell)/dashboard/connections/page.tsx` | **New** | Server page — connection list + discovered accounts + connect action. |
| 4 | `components/connections/ConnectionsList.tsx` | **New** | `"use client"` — polls `/api/sync/status`, renders cards, drives state. |
| 5 | `components/connections/ConnectionCard.tsx` | **New** | Presentational — `importing` checklist vs `ready` summary. (May be a sub-component of #4; keep one file if simpler.) |
| 6 | `context/PlaidContext.tsx` | **Edit (small)** | `onSuccess` routes to `/dashboard/connections`. |
| 7 | `components/ui/Sidebar.tsx` | **Edit (optional, minimal)** | Add a "Connections" nav entry so the hub is reachable. Omit if it risks scope. |

**Explicitly NOT touched:** `prisma/schema.prisma`, any migration, `/dashboard/accounts/page.tsx`, `app/api/brief/route.ts`, `lib/data/accounts.ts` (`getAccounts` used as-is), `lib/plaid/syncTransactions.ts`, `lib/plaid/refresh.ts`, `lib/plaid/backgroundHistorySync.ts`, `jobs/*`, `vercel.json`.

---

## 2. Data shape

### 2.1 `lib/sync/status.ts` (pure, unit-testable)

```ts
export type SyncConnectionState = "importing" | "ready" | "needs_reauth" | "error";

export interface SyncConnection {
  id:           string;                 // PlaidItem.id (opaque connection id)
  provider:     "PLAID";                // future: "WALLET" | "CSV" | "COINBASE" | ...
  institution:  string;                 // PlaidItem.institutionName
  state:        SyncConnectionState;
  lastSyncedAt: string | null;          // ISO; null until first full sync completes
  errorCode:    string | null;          // only meaningful for needs_reauth/error
}

export interface SyncStatus {
  building:     boolean;                // true iff any connection.state === "importing"
  connections:  SyncConnection[];
}

// Minimal item shape this helper needs — selected from PlaidItem.
export interface PlaidItemStateInput {
  id:            string;
  institutionName: string;
  status:        "ACTIVE" | "NEEDS_REAUTH" | "ERROR" | "REVOKED";
  cursor:        string | null;
  lastSyncedAt:  Date | null;
  errorCode:     string | null;
}

export function deriveConnectionState(item: PlaidItemStateInput): SyncConnectionState | null;
// REVOKED → null (caller filters out). NEEDS_REAUTH → "needs_reauth".
// ERROR → "error". ACTIVE & cursor === null → "importing".
// ACTIVE & cursor !== null → "ready".

export function buildSyncStatus(items: PlaidItemStateInput[]): SyncStatus;
// Maps each item → SyncConnection (dropping nulls), computes building.
// NOTE: cursor is consumed here for derivation and MUST NOT appear on SyncConnection.
```

**Invariant to enforce in code + test:** `cursor` is read only inside the helper; it is never a field on `SyncConnection` and never leaves the server.

### 2.2 Response body (`GET /api/sync/status`)

```json
{
  "building": true,
  "connections": [
    { "id": "clx…", "provider": "PLAID", "institution": "Chase",
      "state": "importing", "lastSyncedAt": null, "errorCode": null },
    { "id": "cly…", "provider": "PLAID", "institution": "Fidelity",
      "state": "ready", "lastSyncedAt": "2026-07-04T12:00:00.000Z", "errorCode": null }
  ]
}
```

---

## 3. Route design — `GET /api/sync/status`

- Path: `app/api/sync/status/route.ts` (provider-agnostic; not under `/api/plaid`).
- Auth: `const [user, err] = await requireUser(); if (err) return err;`
- Query (safe fields only — no `encryptedToken`, and `cursor` selected for derivation but never returned):
  ```ts
  const items = await db.plaidItem.findMany({
    where:  { userId: user.id, status: { not: PlaidItemStatus.REVOKED } },
    select: { id: true, institutionName: true, status: true,
              cursor: true, lastSyncedAt: true, errorCode: true },
  });
  ```
- Map through `buildSyncStatus(items)` and `return NextResponse.json(status)`.
- No caching header needed; it's per-user dynamic. Optional `export const dynamic = "force-dynamic"` to be explicit.
- No `POST` in this slice (no triggers). No cross-user data (filtered by `user.id`).

---

## 4. Page layout — `/dashboard/connections`

Server component (`app/(shell)/dashboard/connections/page.tsx`), match existing shell page conventions (`preferredRegion = "sin1"`, `runtime = "nodejs"` as in the accounts page).

Server-side data prep (first paint, no client round-trip needed):
- Resolve `userId` via `getSpaceContext()` (same pattern as other routes) or `requireUser()`.
- `PlaidItem` rows for the user (same select as §3) → initial connections via `buildSyncStatus` (SSR seed so the page is correct before the first poll).
- Discovered accounts via existing `getAccounts()`; group by `account.institution` (and correlate to a connection by institution name / `plaidItemId` where available) for the per-connection account list.

Layout (top → bottom):
1. **Header:** "Connections" title + **"Connect another institution"** action → reuse `ConnectAccountButton` (existing; opens Plaid Link via `PlaidContext`).
2. **`<ConnectionsList>`** (client) seeded with the SSR connections + grouped accounts. For each connection, a `ConnectionCard`:
   - **`importing` state** — the first-run checklist:
     - ✓ Institution connected
     - "Building your financial profile…"
     - ✓ Accounts discovered (from grouped accounts count)
     - ✓ Balances imported (guaranteed by fast path once page loads)
     - … Transaction history *(spinner while importing)*
     - … Timeline / Daily Brief / AI — **forward-looking "ready next" markers**, visually distinct from ✓ rows; gated on `building` (must NOT render as complete). Copy e.g. "Ready once history finishes importing."
     - Discovered accounts listed beneath.
   - **`ready` state** — settled summary: institution, account count/list, `lastSyncedAt`, and (if `needs_reauth`) the existing `ReconnectAccountButton`; if `error`, a quiet error line.
3. **Empty state** (no connections): a connect prompt (reuse `ConnectAccountButton`, `variant="card"`).
4. Once `building` is false and at least one connection is `ready`, show a **"Go to Dashboard"** link (user-driven; not a forced redirect).

Honesty guard: only the four observable rows may show ✓; Timeline/Brief/AI are "next" markers only.

---

## 5. Client polling behavior (`ConnectionsList`)

- `"use client"`. Seed state from SSR props (connections + grouped accounts) so first render is correct with zero flced.
- On mount: if seeded `building` is true, start polling; else no polling.
- `fetch('/api/sync/status')` every **4s** while `building === true`.
- In-flight guard: skip a tick if the previous request hasn't resolved.
- **Stop conditions:** `building === false`; **or** a safety cap of ~45 polls (~3 min) → stop and switch importing cards' copy to "Still importing — this can take a few minutes and will finish on its own."
- **Cleanup:** single `interval` ref; `clearInterval` on unmount and on stop.
- **Tab visibility:** pause polling while `document.hidden`; resume + immediate fetch on `visibilitychange` to visible.
- **On transition `building: true → false`:** call `router.refresh()` once so the server page repulls now-complete data (accounts/lastSynced), then render `ready` cards.
- Merge rule: update card `state`/`lastSyncedAt` from each poll; keep the SSR-grouped accounts (accounts don't change mid-poll in this slice).

---

## 6. Routing behavior after Plaid success (`PlaidContext.onSuccess`)

- Current: on success `onDoneRef.current?.(); router.refresh();`
- Change: after a successful exchange, **navigate to the Connections hub** as the single destination for all Plaid connects:
  ```ts
  onDoneRef.current?.();
  router.push('/dashboard/connections');
  ```
  - Preserve the `onDone` callback invocation (callers may still close a modal, etc.).
  - Replace the bare `router.refresh()` — the push to Connections (a fresh server render) supersedes it. If a caller relies on staying in place, `onDone` still runs first.
  - No behavioral change to `onExit`/error paths, `historyPending`, or the exchange request itself.
- First-vs-subsequent connect: **same destination**; the page differentiates by rendering the new institution as an `importing` card. No branching in `PlaidContext`.

---

## 7. Optional nav entry (`Sidebar.tsx`)

- Add a single "Connections" link → `/dashboard/connections`, styled like existing entries (active-state via `pathname.startsWith`). Keep it to one additive row. **Skip entirely if it can't be done cleanly in a couple of lines** — the routing change (§6) already gets users onto the page post-connect; nav polish can be its own tiny follow-up.

---

## 8. Validation plan

- `npx prisma generate` — no schema delta (sandbox may 403 on engine fetch; environment-only, not a signal).
- `npx tsc --noEmit` — 0 errors.
- `npm run lint` — no new errors in scoped files.
- **Unit** (`lib/sync/status.ts`): `deriveConnectionState` returns the correct value for all five `status × cursor` combinations; `buildSyncStatus` sets `building` correctly and **omits `cursor`** from every `SyncConnection` (assert the field is absent).
- **Endpoint check:** authenticated `GET /api/sync/status` returns `{ building, connections[] }`; response JSON contains no `cursor` key.
- **Dev sandbox Link run:**
  - First connect → lands on `/dashboard/connections`; new institution card shows the `importing` checklist; discovered accounts listed; balances present.
  - After background/cron sync completes → poll returns `building:false`; `router.refresh()` fires once; card settles to `ready` with `lastSyncedAt`; **no manual Refresh** used.
  - Second connect → returns to Connections; new card `importing` alongside existing `ready` cards.
  - `/dashboard/accounts` still renders unchanged.
  - Tab-hidden pause: polling stops when tab hidden, resumes on focus.
- `git diff` limited to the scoped files (§1).

## 9. Rollback plan

- Additive: new endpoint, helper, page, and components — revert the commit to remove them; nothing else imports them.
- The only behavioral edit is `PlaidContext.onSuccess` (one line push vs refresh) and the optional nav row — reverting restores the prior `router.refresh()` flow exactly.
- No schema/migration, so no data rollback. `/dashboard/accounts` and the Slice 1–2 sync engine are untouched, so rollback carries no sync/data risk. First-run history still completes via background + cron regardless.

---

**Stop — await approval before writing code.**
