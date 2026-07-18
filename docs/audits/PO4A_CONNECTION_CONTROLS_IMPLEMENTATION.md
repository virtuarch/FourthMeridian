# PO-4A — Platform Operations Connection Controls (Implementation Record)

**Status:** IMPLEMENTED — the first true operator *action* layer on customer infrastructure. HQ can now diagnose and repair a single connection.
**Date:** 2026-07-19 · branch `feature/v2.5-spaces-completion`
**Verification:** tsc clean · eslint clean (changed files) · 289/290 unit (the 1 failure is a concurrent `MarketingNav` change, not this slice) · browser-verified the full loop end-to-end.
**Reference:** `docs/audits/PO4_PLATFORM_OPERATIONS_CONTROL_INVESTIGATION.md`.

---

## 1. What existed vs what was wired

**Existed (reused, no new infrastructure):** the per-item sync body (`withPlaidItemSyncLock(id, () => syncTransactionsForItem(id))` — the exact call `jobs/sync-banks.ts` makes per item); the manual cooldown (`checkManualRefreshCooldown`/`markManualRefreshed`); the health chokepoint (`setPlaidItemHealth`) + owner reconnect flow (`ReconnectAccountButton` on `NEEDS_REAUTH`) + notification (`notifyItemSyncFailed`); the non-PII connection-health read-model (`ConnectionHealthRow{ id, label(institution), status, healthState, lastSyncedAt, since }`, where `id` for a PLAID row IS the `PlaidItem.id`); the AuditLog + operator-action feed.

**Wired (the missing control plane):**
- `OpsConnectionHealthWidget` — the unhealthy list became **row → RightPanel** of operational FACTS (institution / provider / status / health state / last sync / error code / broken since — never balances/transactions/holdings), with two WRITE actions in the footer (Plaid connections only).
- `POST /api/platform/platform-ops/connections/[id]/resync` — reruns the existing per-item sync under the existing lock + cooldown; audits `CONNECTION_RESYNC_TRIGGERED { connectionId, provider, institution, outcome }`.
- `POST /api/platform/platform-ops/connections/[id]/request-reauth` — marks `NEEDS_REAUTH` via `setPlaidItemHealth` (lights the existing owner reconnect prompt) + pings the owner; audits `CONNECTION_REAUTH_REQUESTED`. **Never** `itemRemove`.

**Deferred (PO-4B, per the investigation):** authorization age, `reauth_after_days`, `REAUTH_DUE`, proactive emails.

---

## 2. Security & safety

Both mutations follow the PO-1/PO-3 contract: `requireFreshPlatformAccess("PLATFORM_OPS","WRITE")` → ConfirmDialog → mutation (reusing existing safe bodies) → `AuditLog(performedByAdminId)` → Security Ops operator feed. READ operator → 403 by construction; SYSTEM_ADMIN break-glass unchanged.

- **No second engine** — resync calls the imported `syncTransactionsForItem` under `withPlaidItemSyncLock`; it defines no sync loop of its own. Cooldown + in-flight lock preserved (an in-flight sync is coalesced → 409; a recent sync → 429).
- **Never auto-revoke** — reauth only flips status to `NEEDS_REAUTH`; neither route calls `itemRemove`/deletes the item. `item_id`/cursor continuity preserved.
- **No customer financial data** — routes select only `{id, status, institutionName, lastManualRefreshAt}` and return only outcome + row-touch counts. Audit metadata is operational only (provider/institution/connectionId/outcome). The connection-health read-model carries no userId/email/balances.
- **Action gating** — actions are Plaid-only; Resync is disabled for `NEEDS_REAUTH`/`REVOKED` (a dead credential can't sync → steer to reauth); Request reauth is disabled for `REVOKED` (customer must re-add).
- **Audit subject** — connection actions set no `userId` (there is no user subject); the target is the connection, surfaced as the institution in the operator feed ("janesmith → PO4A Test Bank").

Locked by `lib/platform/connection-ops-guards.test.ts` (source-scan): WRITE gate + audit + performedByAdminId per route; resync reuses lock + body + cooldown and defines no loop; neither route calls `itemRemove`; no transaction/balance/holding queries or fields; both actions in the operator feed.

---

## 3. Browser verification (as a granted operator, on an isolated seeded test connection)

- **Inspection** — Connection Health row → RightPanel shows facts only; note explains the actions.
- **Resync** — ConfirmDialog → attempted → failed safely on a bogus token → honest inline "Resync failed" (list preserved) → audited `CONNECTION_RESYNC_TRIGGERED{outcome:"failed"}` with `performedByAdminId`.
- **Request reauthorization** — ConfirmDialog ("does NOT remove the connection or any data") → item flipped to `NEEDS_REAUTH` (still exists), moved to top worst-first, owner notification fired → audited `CONNECTION_REAUTH_REQUESTED`.
- **Gating** — on the now-`NEEDS_REAUTH` item, Resync is disabled, Request reauth enabled.
- **Security Operations feed** — both actions appear, humanized + attributed: "Resynced a connection · janesmith", "Requested reauthorization · janesmith → PO4A Test Bank".
- DB confirmed both audit rows carry `performedByAdminId` + operational-only metadata; item state `NEEDS_REAUTH` (never removed). Test scaffolding (seeded connection, grants) reverted.

---

## 4. Files

New: the two route files · `lib/platform/connection-ops-guards.test.ts` · this doc · `PO4_..._INVESTIGATION.md`.
Changed: `lib/audit-actions.ts` (+2 actions, +feed) · `components/platform/widgets/OpsConnectionHealthWidget.tsx` (row→RightPanel+actions) · `components/platform/widgets/SecOperatorActionsWidget.tsx` (humanize) · `app/api/platform/security-ops/operator-actions/route.ts` (institution as target label).
