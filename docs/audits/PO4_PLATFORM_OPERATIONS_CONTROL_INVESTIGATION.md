# PO-4 — Platform Operations Control Plane · Investigation & Design

**Status:** INVESTIGATION + DESIGN. No code in this deliverable.
**Date:** 2026-07-19 · branch `feature/v2.5-spaces-completion`
**Scope:** the operator control of *data operations* deferred throughout PO-3 as "separate PO slices" — per-connection resync / job retry / provider refresh (Track B3), and the **Provider Authorization Lifecycle** (Track N1). This is the Platform Operations analogue of what PO-3B/3C did for beta: turn a read surface into safe operator actions.
**Predecessors:** PO-3 operating-model audit (Tracks B3/N1), PO-3B/3C (the WRITE+confirm+audit contract in practice), PO-1 (security foundation).
**Method:** read-only audit of `lib/platform/operations/*`, `lib/connections/*`, `lib/plaid/*`, `jobs/sync-banks.ts`, the provider/connection-health read-models, and the manual-operations surface.

---

## 0. Thesis

Platform Operations can already *observe* the fleet (job/provider/connection/freshness health, all shipping) and can already run **fleet-level** jobs on the PO-1 contract (run-now / dry-run over fetch-fx / prices / crypto / sync-banks, WRITE-gated + audited). The gap is **granularity and lifecycle**: an operator cannot act on *one* failing connection, and there is no notion of a connection's *authorization age*. PO-4 closes both — reusing the per-item sync body and the reactive-reauth flow that already exist — under the same `requireFreshPlatformAccess(PLATFORM_OPS, WRITE)` + confirmation + audit + Security-feed contract PO-3B/3C proved.

**The one hard constraint (from the PO-3 provider investigation, reaffirmed): prompt-to-reauth, never auto-revoke.** `plaidClient.itemRemove` is irreversible — it destroys `item_id` + cursor continuity. Nothing in PO-4 may wire revocation to age or staleness.

---

## 1. Current state (what exists)

| Capability | State | Evidence |
|---|---|---|
| Fleet manual operations (run-now/dry-run) | **E** — WRITE-gated + audited, one execution path (`runJob(trigger:"manual")`) | `lib/platform/operations/registry.ts` + `execute.ts`; targets: fetch-fx-rates, fetch-security-prices, sync-crypto, **sync-banks (whole fleet)** |
| Per-item Plaid sync body | **E** — exists, isolated, locked | `jobs/sync-banks.ts`: `withPlaidItemSyncLock(item.id, () => syncTransactionsForItem(item.id))` |
| Per-connection handle (non-PII) | **E** — already surfaced | `ConnectionHealthRow { id, label(institution), healthState, lastSyncedAt }` (`lib/connections/health.ts`) — a stable id + institution name, no userId/email |
| Reactive reauth (credential dead) | **E** — owner-driven, self-healing | `ITEM_LOGIN_REQUIRED → NEEDS_REAUTH` (`setPlaidItemHealth`) → `ReconnectAccountButton` → Plaid Link update mode → `exchangeToken` self-heal |
| Health status flip chokepoint | **E** — single writer + audit transition | `lib/connections/health-transitions.ts` `setPlaidItemHealth` (writes columns + `PLAID_ITEM_STATUS_CHANGED`) |
| Provider / connection health read-models | **E** | `lib/platform/provider-health.ts`, `lib/connections/health.ts` |
| Guarded revoke (orphan-only) | **E** — never age/staleness-driven | `lib/plaid/disconnect.ts` `disconnectPlaidItemIfOrphaned` (only on account-deletion orphaning) |

**What does NOT exist:** an operator route to act on ONE connection; an operator "force-reauth" action; any `authorizedAt` / reauth-after-N-days / age-based `REAUTH_DUE` concept; a proactive (pre-breakage) reauth prompt.

---

## 2. Gap classification

Legend: **E** exists · **P** partial (body/handle exist, no operator route) · **N** new architecture.

| Mission capability | Cls | Note |
|---|---|---|
| **Per-connection resync** (retry one connection) | **P** | body (`withPlaidItemSyncLock` per-item) + handle (`ConnectionHealthRow.id`) exist; **no operator route** — today it's owner-scoped (`/api/plaid/refresh`, `account.ownerUserId === user.id`) or whole-fleet (`sync-banks`) |
| **Per-job retry** | **E (mostly)** | `run-now` already retries idempotent jobs (re-running `sync-banks` retries failed items); the `retry` kind is `reserved` for a genuinely different body (resume-from-checkpoint) → **N** only for that future case |
| **Provider/FX/price refresh** | **E** | `run-now` over fetch-fx-rates / fetch-security-prices / sync-crypto |
| **Operator force-reauth** (prompt the user) | **P** | `setPlaidItemHealth(NEEDS_REAUTH)` exists; no operator route to trigger it → surfaces the existing owner reconnect prompt |
| **Connection authorization age** | **N** | no `authorizedAt`; `PlaidItem.createdAt` is not reset on update-mode relink, so it's the wrong proxy |
| **Reauth-after-N-days policy** | **N** | no policy setting; only sync-staleness windows (48h) exist, which measure recency ≠ authorization age |
| **Proactive (age-based) reauth prompt** | **N** | today the prompt fires only AFTER Plaid rejects the credential |

---

## 3. Design — PO-4A: per-connection operator actions (Track B3)

**Surface a connection handle for targeting** (already non-PII): the ops connection view lists `ConnectionHealthRow`s (institution + healthState + lastSyncedAt), each opening a RightPanel — the proven row→panel idiom. The RightPanel footer gains WRITE actions:

- **Resync now** — `POST /api/platform/platform-ops/connections/[id]/resync` (`requireFreshPlatformAccess(PLATFORM_OPS,"WRITE")` + confirm). Resolves the id → PlaidItem/Connection, runs the **existing per-item body under `withPlaidItemSyncLock`** (skipped-locked if already in flight — no race), audits `CONNECTION_RESYNC_TRIGGERED { connectionId, provider, outcome }`. This is the "targeted per-connection resync" the PO-3 audit called the top operational value. Either a dedicated route (above) or a parameterized `OperationCommand` (`retry:sync-banks` accepting `connectionId`, promoting the reserved `retry` kind) — both reuse the one body; the route is simpler and keeps the operations registry fleet-only.
- **Request reauthorization** — `POST …/connections/[id]/request-reauth` → `setPlaidItemHealth(NEEDS_REAUTH)`, which lights the **existing** owner-facing `ReconnectAccountButton` + notification. Audits `CONNECTION_REAUTH_REQUESTED`. **Never** calls `itemRemove`.

**Per-job actions** stay fleet-level (run-now already retries); no per-item job action needed. `refresh`/`retry` reserved kinds remain reserved unless a resume-from-checkpoint body appears.

**Cooldown honesty:** the per-item body already respects `MANUAL_REFRESH_COOLDOWN` (60 min) via its own path; the operator resync should surface (not bypass) a recent-sync note, and the lock makes a double-fire harmless.

---

## 4. Design — PO-4B: provider authorization lifecycle (Track N1)

The safe, prompt-not-revoke design from the PO-3 audit:

1. **`authorizedAt` / `lastReauthorizedAt`** — new `PlaidItem` (+ `Connection`) columns, written by `exchangeToken.ts` on **both** initial create and successful update-mode relink (the missing authoritative "authorization age" source; `createdAt` is wrong because relink doesn't touch it).
2. **`reauth_after_days`** — a `PlatformSetting` (default e.g. 90; `0`/null disables), mirroring the `refreshCooldown` "configurable later" seam.
3. **`REAUTH_DUE`** derived state — extend `deriveConnectionHealthState` with an **age-based** state from `lastReauthorizedAt ?? authorizedAt + reauth_after_days`, kept **orthogonal to sync-`STALE`** (age ≠ recency). Surfaced in provider/connection health as "authorized 45d ago · reauth due in 45d".
4. **Proactive prompt** — when `REAUTH_DUE` approaches, fire the existing owner reconnect prompt (in-app + email via the dispatcher) *before* Plaid rejects the credential.

**Never** auto-revoke on age/staleness. An operator "force-reauth" sets `NEEDS_REAUTH` (prompting the user); it does not remove the item.

---

## 5. Security contract (unchanged — PO-1 / PO-3B)

Every PO-4 mutation: `requireFreshPlatformAccess("PLATFORM_OPS","WRITE")` → confirmation (ConfirmDialog) → mutation (reusing the existing locked body / status chokepoint) → `AuditLog(performedByAdminId)` → Security Ops operator feed. New audit actions (added to `OPERATOR_ACTION_FEED_ACTIONS` + humanized): `CONNECTION_RESYNC_TRIGGERED`, `CONNECTION_REAUTH_REQUESTED`, and (PO-4B) `PROVIDER_REAUTH_POLICY_CHANGED`. READ operators → 403; SYSTEM_ADMIN break-glass unchanged.

**Boundary:** the operator connection view exposes only operational metadata (connection id, institution, provider, status, timestamps) — **never** transactions/balances/holdings. The connection-health read-model is already non-PII; per-connection targeting adds an id + institution label, not customer content.

---

## 6. Roadmap

- **PO-4A — per-connection operator actions** (additive; highest operational value; no schema). Connection RightPanel + `resync` / `request-reauth` routes reusing the per-item body + `setPlaidItemHealth`, on the WRITE+confirm+audit contract. Ship first.
- **PO-4B — provider authorization lifecycle** (new schema + policy). `authorizedAt`/`lastReauthorizedAt` + `reauth_after_days` + `REAUTH_DUE` + proactive prompt. Prompt-not-revoke.
- **Deferred (still separate slices):** customer-success CRM / per-customer profiles (Track N3); resume-from-checkpoint job bodies (the only case the reserved `retry`/`backfill` kinds await); any cache `invalidate` target.

---

## 7. Key question

> *Can a Fourth Meridian operator safely fix a single broken connection from HQ?*

**Almost — PO-4A closes it.** The per-item sync body, the per-connection handle, the reactive-reauth flow, and the WRITE+audit contract all exist; PO-4A is the operator route + RightPanel action that wires them together (resync one connection; request reauth for one connection), never touching customer financial data and never auto-revoking. PO-4B then makes authorization *age* visible and promptable, so a connection is reauthorized *before* it breaks — the last piece of "run the platform safely."

---

*Sources: `lib/platform/operations/{registry,execute}.ts`; `lib/connections/{health,health-transitions}.ts`; `lib/plaid/{errors,exchangeToken,refreshCooldown,disconnect,sync-lock}.ts`; `jobs/sync-banks.ts`; `lib/platform/provider-health.ts`; `app/api/platform/platform-ops/connection-health/route.ts`; `app/api/plaid/refresh/route.ts`. Read-only, 2026-07-19.*
