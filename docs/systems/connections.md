# Connections

## Purpose

The connections system owns the provider-MANAGEMENT surface: the list of a
user's data connections (Plaid items and self-custody wallets today; exchanges,
brokerages, and other providers tomorrow), their sync health, and the accounts
each connection brought in. It is deliberately NOT a money view — it never reads
balances, valuations, or Space visibility tiers. Its job is to answer "what have
I connected, is it healthy, and which accounts did it produce" for the owning
user.

## Authority

- `lib/connections/space-data.ts` (PCS-2) — THE canonical loader behind the
  Connections surface: `loadConnectionsSpaceData` (status + per-connection
  account inventory) and `loadConnectionsSyncStatus` (lean status-only read for
  the poller). `groupConnectionAccounts` is the pure name-resolution/dedup core.
- `lib/sync/status.ts` — the single sync-STATE authority
  (`buildSyncStatus` / `buildWalletSyncStatus` / `deriveConnectionState` /
  `finalizeSyncStatus`). Connection state is NOT re-implemented in the loader;
  it comes verbatim from here.
- The provider spine, defined in `prisma/schema.prisma`:
  `Connection` (provider-agnostic credential/login layer),
  `PlaidItem` (the Plaid-specific connection, unchanged), `AccountConnection`
  (the account↔credential link), `FinancialAccount`, and
  `ProviderAccountIdentity`.
- `lib/connections/health.ts` — a DELIBERATELY SEPARATE admin/Ops bounded
  context (`getConnectionHealth`), aggregate and no-PII; intentionally NOT
  merged into the user-facing loader.

## Inputs

- `userId` — connections are USER-owned (`PlaidItem.userId` / `Connection.userId`),
  not Space-visibility scoped. This is the ownership gate on every read.
- `PlaidItem` rows (excluding `REVOKED`) and their `AccountConnection` links.
- Wallet connections via `loadWalletSyncConnections` (`lib/sync/wallet-connections.ts`).
- Account display-name fields (`displayName`, `officialName`, `plaidName`,
  `name`) resolved in that canonical order.

## Outputs

- `ConnectionsSpaceData` — `{ status: SyncStatus, accountsByConnectionId:
  Record<string, AccountLite[]> }`. `status` is the provider-agnostic
  `SyncStatus` (Plaid + wallet connections + a building flag);
  `accountsByConnectionId` is the per-connection account inventory (NAMES/TYPES
  only) keyed by `SyncConnection.id`.
- `SyncStatus` alone from `loadConnectionsSyncStatus`, for the poller.

## Canonical contracts

- **One loader, one envelope.** Both the first render and the poll derive state
  from the same assembly, so they can never disagree.
- **Accounts joined per connection by STABLE id, never by institution string.**
  Plaid accounts join `AccountConnection.plaidItemDbId → PlaidItem` (keyed by
  `PlaidItem.id`); wallet accounts arrive already keyed by connection id. Both
  live in ONE id space (`SyncConnection.id`), so a card looks up its accounts
  with `accountsByConnectionId[connection.id]` regardless of provider.
- **No portfolio read, no visibility redaction.** The loader must never call the
  heavyweight Space-visibility portfolio read (`getAccounts`) — a connection is
  the user's own, so the accounts it produced are theirs to see by definition.
  Account count is free (`accountsByConnectionId[id].length`); position/holding
  counts are intentionally OUT of contract (they are valuation-derived).
- **`Connection` is the sync-truth authority.** `Connection.status /
  lastSyncedAt / errorCode` are authoritative for provider-sync health (wallet
  included). The per-account mirrors (`AccountConnection.syncStatus/lastSyncedAt`,
  `FinancialAccount.syncStatus`) are compatibility mirrors, not authoritative.
- **Lifecycle doctrine:** `connect → automatic initial sync → ready`. Initial
  sync happens automatically and immediately after connect; manual Refresh/Sync
  is recovery or freshness, never the happy path. Ready state surfaces
  consistently as `synced` / `pending` / `error`. Any new provider must
  implement this same lifecycle and ride the shared spine
  (`Connection → ProviderAccountIdentity → FinancialAccount → Holding/Transaction`).

- **One writer for the shared spine middle (PROV-4).** `persistAccountSpine`
  (`lib/accounts/persist-account-spine.ts`) is the SINGLE writer of the
  per-account `AccountConnection` + `SpaceAccountLink` pair, committed atomically.
  The Plaid exchange loop and the Wallet add route both consume it — the two real
  producers that earned the abstraction. What it deliberately does NOT own,
  because it genuinely diverges between those two producers (and folding it would
  be designing a neutral shape from providers that don't share it): the
  `FinancialAccount` RESOLUTION strategy (Plaid: provider-identity → legacy →
  fingerprint via `resolveAccountByFingerprint`; Wallet: `walletAddress`), the
  `ProviderAccountIdentity` mirror (`dualWriteProviderAccountIdentity` vs
  `alignWalletProviderSpine`), and the `Connection` write (per-Plaid-item vs
  wallet-align). A new provider resolves/creates its own `FinancialAccount`,
  writes its own identity mirror + `Connection`, and calls `persistAccountSpine`
  for the shared middle.

- **Dedupe stages, not entrypoints (PROV doctrine).** The Plaid exchange and
  refresh paths keep INDEPENDENT orchestration envelopes — retry, locking,
  health reporting, fatality, atomicity — because they are genuinely different
  operations (create/reconcile vs update-only). Only the shared STAGES are
  shared: `mapAccountType` (`lib/plaid/account-type.ts`),
  `resolvePlaidAccountByExternalId` (`lib/accounts/reconcile.ts`), and
  `syncInvestmentsForItem` (`lib/plaid/sync-investments.ts`). Merging the
  entrypoints themselves would collapse their distinct failure semantics.

## Persistence

- `PlaidItem` holds the Plaid credential (`encryptedToken`, AES-256-GCM — never
  plaintext), sync cursor, status, and freshness/lock timestamps
  (`syncIncompleteAt`, `syncLockedAt`, `lastManualRefreshAt`,
  `investmentsConsent`). It is the LIVE Plaid connection and is not migrated onto
  `Connection`.
- `Connection` is the provider-agnostic generalization (`provider`,
  `credential` — encrypted, null for MANUAL, an xpub/descriptor for WALLET
  watch-only, never a private key). It is LIVE for Plaid (written by
  `lib/plaid/exchangeToken.ts`) and is the home for non-Plaid providers.
- `AccountConnection` links a `FinancialAccount` to exactly one credential
  source (`plaidItemDbId` and/or `connectionId`), carries `isCanonical` (the
  authoritative balance source) and `deletedAt` (soft delete on account removal,
  preserving Holding/Transaction history).
- `ProviderAccountIdentity` generalizes ad-hoc provider-identity columns
  (`plaidAccountId`, `walletAddress`) into one row per (provider,
  externalAccountId); PLAID read cutover is complete with a warn-and-fallback to
  the legacy `plaidAccountId` lookup.

## Consumers

- `app/(shell)/dashboard/connections/page.tsx` — the Connections management page,
  first render via `loadConnectionsSpaceData`.
- `app/api/sync/status/route.ts` — the `GET /api/sync/status` poller, via the
  shared status assembly.
- `components/connections/ConnectionCard` (and its `AccountLite` type) — the
  per-connection card rendering the account inventory and sync state.
- The Accounts perspective (`app/api/spaces/[id]/accounts/detail`) shares the
  same `lib/sync/status.ts` state authority.

## Invariants

- Reads are gated to the owning user; a shared-Space member never sees another
  member's connections. (The prior institution-string match papered over this
  ownership mismatch — the stable-id join fixes it.)
- The user-facing loader is a management surface: it never depends on balances,
  valuations, or visibility tiers.
- Sync state is derived in exactly one place (`lib/sync/status.ts`); the loader
  and the poller consume it, never recompute it.
- The UI reflects the CURRENT implementation, not aspirational behavior — error
  copy must not promise background retries that do not run (see below).

## Known limitations

- **No automatic background retry for wallets.** Wallet sync runs only
  run-on-add (`app/api/accounts/wallet/route.ts`), manual Refresh
  (`POST /api/accounts/[id]/sync`), or re-add. `jobs/sync-crypto.ts`
  (`syncAllBtcWallets`) exists but is deliberately unregistered in
  `lib/jobs/registry.ts`, so the daily dispatcher never re-runs wallet sync.
  Error-card copy therefore says "Press Refresh to retry", not "we'll keep
  retrying" (the latter is true only for Plaid, retried daily by `sync-banks`).
- WALLET is not yet backfilled/dual-written into `ProviderAccountIdentity`; the
  legacy `walletAddress`/`walletChain` columns remain the de-facto read/write
  source, and no NEW readers should be added there.
- `Connection` is populated for Plaid; other provider types are not yet
  populated at runtime.
- Position/holding counts are intentionally excluded from the contract, so the
  surface cannot show per-connection holding totals without re-becoming a
  portfolio consumer.

## Extension points

- **New provider (Coinbase, Schwab, Tink, new wallet chains):** implement the
  `connect → automatic initial sync → ready` lifecycle, write `Connection` as
  the sync-truth record, and ride the shared spine. Emit accounts keyed by
  connection id so they unify into `accountsByConnectionId` with no loader
  change. Concretely: resolve/create your `FinancialAccount`, write your
  `ProviderAccountIdentity` mirror + `Connection`, then call `persistAccountSpine`
  for the `AccountConnection` + `SpaceAccountLink`. Begin from the proven
  duplication a third provider surfaces — do NOT pre-build a generic
  `ProviderAdapter` / `ProviderIngestionPayload` interface. Plaid + Wallet prove
  only the account-spine writer; they do NOT yet prove a universal ingestion
  contract (PROV-5B / PROV-6 are deferred for exactly this reason, per the
  CCPAY-2G doctrine: introduce a provider-neutral abstraction from the SECOND
  proven implementation, not the first). The dead `plaidAdapter` re-export was
  deleted (PROV-5A) precisely because it was a zero-importer abstraction built
  ahead of that proof.
- **New sync-state signal:** add it in `lib/sync/status.ts` so both the loader
  and the poller pick it up.
- **Provider health / Ops needs:** extend the separate `lib/connections/health.ts`
  bounded context — do not merge admin aggregates into the user-facing loader.
- The designed (not-yet-built) wallet retry model — register `sync-crypto`,
  targeted failed-connection retry, per-connection backoff, transient-vs-
  permanent classification — is documented as design intent; when it ships, the
  card copy must be updated to match, never before.

## Why the architecture is this way

Before this design, the Connections page assembled its view from three glued-
together reads, the worst of which grouped a heavyweight Space-visibility
portfolio read (`getAccounts`) by the institution DISPLAY NAME. That coupling was
wrong on three axes: it made a management surface depend on money data; it mixed
USER-owned connections with SPACE-visibility scoping (so a shared-Space member
could see accounts that were not their connection); and it joined on a fragile
display string — the exact anti-pattern the import path had already abandoned in
favor of stable ids. The canonical loader removes all three by joining accounts
to connections by stable id, gated to the owning user, with no portfolio read.
Making `Connection` the single sync-truth record (with per-account fields as mere
mirrors) and defining one provider-agnostic lifecycle means every future provider
plugs into the same spine and the same `synced/pending/error` vocabulary, rather
than each reinventing connection state.
