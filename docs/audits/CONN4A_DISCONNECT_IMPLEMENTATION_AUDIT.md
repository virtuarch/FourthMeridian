# CONN-4A — Connection Disconnect Lifecycle: Implementation Audit

**Status:** INVESTIGATION → IMPLEMENTATION. Model A (Disconnect) ONLY. **No hard deletion, no purge, no shared-space amendment, no snapshot regeneration beyond today's row, no PO-4B.** Builds on `docs/audits/CONN4_CONNECTION_REMOVAL_DOCTRINE_AUDIT.md`.
**Date:** 2026-07-19.

---

## 1. Current state (verified)

- **Removal is account-level today.** `DELETE /api/accounts/[id]` is the only removal path; the Connections surface has **no** connection-level control.
- **It is already pure Model A**, in this exact order:
  1. Auth: caller must hold an ACTIVE `SpaceAccountLink` they added (`addedByUserId`) → else 403.
  2. `$transaction`: soft-delete `FinancialAccount` (`deletedAt`), soft-delete `AccountConnection`s, capture ACTIVE SAL spaceIds, revoke those SALs (`status=REVOKED, revokedAt, revokedByUserId`).
  3. `regenerateSpaceSnapshot(spaceId)` per affected space (**today's row only** — best-effort).
  4. `disconnectPlaidItemIfOrphaned(plaidItemDbId)` per item (orphan-gated `itemRemove` + `PlaidItem→REVOKED`).
  5. `ACCOUNT_REMOVE` audit.
- **`disconnectPlaidItemIfOrphaned`** (`lib/plaid/disconnect.ts`) — no-op unless the item has zero live `AccountConnection`s, then best-effort `itemRemove` + `REVOKED`. Deletes nothing.
- **Restore** (`POST /api/accounts/[id]/restore`) reverses the soft-delete; reconnect (`exchange-token`) revives the same rows via identity/fingerprint (no duplicate).

## 2. Reused primitives (no second engine)

The account-DELETE mechanics (steps 2–4 above) are **extracted** into ONE reusable primitive, `disconnectAccounts(financialAccountIds, actorUserId)` (`lib/accounts/disconnect.ts`):
- Queries the accounts' live Plaid item ids (before soft-delete).
- `$transaction`: soft-delete accounts + connections, revoke ACTIVE SALs, capture affected spaces.
- Regenerates today's snapshot per affected space (best-effort).
- `disconnectPlaidItemIfOrphaned` per item.
- Returns `{ disconnectedAccountIds, affectedSpaceIds, plaidItemDbIds }`.

**Both callers delegate to it** — the existing `DELETE /api/accounts/[id]` (refactored, behavior-preserving) and the new connection route. This satisfies "do not create a second disconnect engine": the logic lives in exactly one place. `disconnectAccounts` performs NO authorization — each caller authorizes (account route via ACTIVE SAL; connection route via connection ownership).

## 3. New surface — connection-level disconnect

`POST /api/connections/[id]/disconnect` (`id` = `SyncConnection.id` — `PlaidItem.id` for Plaid, `Connection.id` for wallet):
- `requireUser`; **ownership gate**: resolve the connection's OWNED, live financial accounts via `AccountConnection` joined to `plaidItem.userId` / `connection.userId` = caller. Zero owned accounts → 404 (not found / already disconnected).
- `disconnectAccounts(faIds, user.id)` — disconnects all of the connection's accounts together.
- `CONNECTION_DISCONNECTED` audit (new action; metadata `{ institution, provider, accountCount }`, `ipAddress`) — reuses the existing `AuditLog` + `recordAuditEvent` pattern, no parallel audit system.
- Returns `{ ok, disconnectedAccounts }`.

## 4. Lifecycle states (unchanged truth, honest surface)

| State | Meaning | Signal |
|---|---|---|
| Connected | syncing, history live | `PlaidItem.status=ACTIVE`, live `AccountConnection`s |
| Disconnected | sync stopped, history preserved | accounts `deletedAt` set, SALs REVOKED, `PlaidItem→REVOKED` when orphaned |
| Reconnected | resumed | relink revives the same rows (identity/fingerprint) — no duplicate |

The disconnected connection simply **stops appearing** on the Connections surface (its accounts are soft-deleted, so `loadConnectionsSpaceData` no longer lists them) — matching the honest "we stopped syncing; history remains" story. History stays queryable in the workspaces exactly as the account-level archive already behaves.

## 5. Shared-Space behavior (documented; no destructive mutation)

Disconnecting revokes **all** ACTIVE SALs for the connection's accounts across **every** space (via `disconnectAccounts`). So a Family Space that had visibility **loses it immediately** (revoke-don't-delete — the substrate survives, re-sharing/reconnect can reactivate). Their **today** snapshot excludes the accounts; their **historical** snapshots retain the contribution (per doctrine — historical correction is explicitly deferred; **not** attempted here). No shared data is deleted or destructively mutated. This matches the ratified revoke-don't-delete doctrine.

## 6. Historical honesty (binding copy constraint)

The disconnect copy must NOT claim data is "gone". Approved wording:
> **Disconnect Chase?** Fourth Meridian will stop receiving updates from Chase. Your existing financial history will remain available. You can reconnect anytime.

No "your data is deleted" language anywhere — historical snapshots still contain prior values (correction deferred).

## 7. Security considerations

- **Ownership**, not just space-membership: the connection route gates on `PlaidItem.userId` / `Connection.userId` = caller, so only the connection's owner can disconnect it (a shared-space member who merely has visibility cannot).
- **Reversible + non-destructive**: soft-delete + revoke only; `itemRemove` is the sole external effect (best-effort, orphan-gated) and only revokes provider access — never deletes FM data.
- **Audited**: `CONNECTION_DISCONNECTED` with actor + institution + provider + timestamp.
- **No new authority**: reuses `disconnectAccounts` → the same soft-delete/revoke/itemRemove primitives the account path already used.

## 8. UX

Connection card gains a **⋯ menu** (`ConnectionMenu`): "Refresh connection" (Plaid → `POST /api/plaid/refresh {plaidItemId}`, reused), "Restore financial intelligence" (→ `POST /api/connections/build-intelligence {connectionIds:[id]}`, reused CONN-2B), "Disconnect <institution>" (→ ConfirmDialog with the §6 copy → the new route → `router.refresh()`). No "Delete permanently".

## 9. Explicitly deferred (NOT in this slice)

Hard deletion / purge UI / GDPR changes / shared-space historical amendment / snapshot regeneration after removal (beyond today's row) / PO-4B. Per doctrine + mission.

## 10. Verification plan

tsc + eslint; source-scan test (connection disconnect reuses `disconnectAccounts`, never hard-deletes, is owner-gated + audited); browser-verify the ⋯ menu + Disconnect confirm modal render with the honest copy. The actual disconnect is **not executed against seed data** (it soft-deletes seed accounts and reconnect needs a live Plaid relink) — the behavior is covered by the behavior-preserving extraction (the account path already exercised it) + the reversible restore path.
