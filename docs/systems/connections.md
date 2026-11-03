# Connections

## Purpose

The connections system owns the provider-MANAGEMENT surface: the list of a
user's data connections (Plaid items and self-custody wallets today; exchanges,
brokerages, and other providers tomorrow), their sync health, and the accounts
each connection brought in. It is deliberately NOT a money view — it never reads
balances, valuations, or Space visibility tiers. Its job is to answer "what have
I connected, is it healthy, and which accounts did it produce" for the owning
user.

A **Connection** is an ingestion relationship with an external provider — it is
NOT the financial account itself. A single provider can expose many accounts, and
each account participates in Spaces independently of the connection that produced
it. Every provider normalizes into ONE canonical spine:

```
provider (Plaid · wallet · future aggregators / exchanges / imports)
    ↓
Connection            (the provider-agnostic ingestion credential/relationship)
    ↓
ProviderAccountIdentity  (one row per (provider, externalAccountId))
    ↓
FinancialAccount      (the account the money view reads)
    ↓
SpaceAccountLink      (per-Space visibility grant — set independently)
```

Plaid is one implementation on this spine, not the architecture; wallets ride the
same spine today, and new providers plug into it without changing the shape.

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
  is recovery or freshness, never the happy path. Any new provider must implement
  this same lifecycle and ride the shared spine
  (`Connection → ProviderAccountIdentity → FinancialAccount → SpaceAccountLink`,
  then `Holding` / `Transaction`). The conceptual states, and the concrete values
  they surface as, are:

  | Conceptual state       | `Connection.status` | Surfaced sync state       |
  | ---------------------- | ------------------- | ------------------------- |
  | created / authenticated| `ACTIVE`            | building (`importing`)    |
  | syncing                | `ACTIVE`            | building (`importing`)    |
  | active                 | `ACTIVE`            | `ready` (`synced`)        |
  | degraded               | `NEEDS_REAUTH` / `ERROR` | `needs_reauth` / `error` |
  | disconnected / removed | `REVOKED`           | (soft-deleted, hidden)    |

  Ready state surfaces consistently as `synced` / `pending` / `error`; sync-state
  derivation lives in exactly one place (`lib/sync/status.ts`).

- **Disconnect and Delete are not the same operation.** DISCONNECT (the one
  primitive `lib/accounts/disconnect.ts`, exposed at
  `POST /api/connections/[id]/disconnect`) stops synchronization: it soft-deletes
  the connection's accounts, revokes ACTIVE `SpaceAccountLink`s, and revokes
  provider access when the item is orphaned — but it NEVER hard-deletes data and
  does not touch historical snapshots, so financial truth and auditability are
  preserved and a reconnect revives the same rows by identity/fingerprint.
  DELETE / purge is a separate, destructive, controlled path (account deletion →
  `jobs/process-deletions`) that requires appropriate authorization. Both are
  owner-gated. They must never be treated as equivalent: disconnect is reversible
  and preserves history; delete is not.
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

## Status markers

Sections below added at the 2026-11 documentation closeout mark each material claim
**IMPLEMENTED** (with the code path or PR that proves it), **DECIDED BUT NOT
IMPLEMENTED**, **PROPOSED**, or **DEPRECATED**. The older sections above describe
current behaviour and were re-checked against the code at the same time.

## The three-layer connection model (CONN)

A connection's state is three separate questions, modelled and shown separately —
never one undifferentiated "syncing" spinner. **DECIDED** (CONN roadmap, 2026-07)
and **IMPLEMENTED** as described per layer.

1. **Data acquisition** — raw events (transactions, holdings, balances) obtained from
   the provider: Plaid transaction sync (`syncTransactionsForItem`), wallet sync
   (`lib/crypto/wallet-refresh.ts`). There is one sync engine per provider and no
   second one may be written. User truth: *"Your transactions are here."* Once
   imported, the product never implies transactions are missing. **IMPLEMENTED.**
2. **Financial-intelligence reconstruction** — derived history rebuilt from data that
   already exists (wealth snapshots, the historical net-worth timeline, cash-flow
   history). The authorities are the existing regenerators
   (`regenerateWealthHistoryForAccounts`, `regenerateSnapshotsForAccounts`,
   `backfillHistoryForItem`); the per-item completion anchor for the deferred Plaid
   pipeline is the `PLAID_HISTORY_SYNCED` audit row written by `recordSyncComplete`
   (`lib/plaid/backgroundHistorySync.ts`). **IMPLEMENTED.**
   - The per-connection readiness projection is `ConnectionIntelligenceStatus`
     (`lib/connections/intelligence.ts`), derived only from persisted state — no
     stored "complete" flag. **IMPLEMENTED** (CONN-2A).
   - The multi-account "build intelligence" action is
     `POST /api/connections/build-intelligence`: a layer-2 operation that reuses
     `regenerateWealthHistoryForAccounts` over the owner's selected connections. It
     never re-acquires provider data, never writes `FinancialAccount.balance` and
     never touches today's snapshot. **IMPLEMENTED** (CONN-2B; the roadmap's
     `includeItemIds[]` filter on `refreshAllActiveItemsForUser` was not the shape
     that shipped — **DEPRECATED** as a design).
   - Progress is stage-based and data-backed (no fabricated percentages); the
     lifecycle stages are derived by `deriveConnectionLifecycle`
     (`lib/sync/lifecycle.ts`: connected → accounts discovered → balances imported →
     transactions imported → history built → ready). **IMPLEMENTED.**
   - **Naming rule (binding):** "history rebuild" names only the technical operation
     (`regenerate*`, snapshot amendment). User-facing copy talks about building or
     restoring *financial intelligence*, never re-downloading data. **DECIDED.**
3. **Current freshness** — a sync can complete while balances or today's snapshot are
   stale. Transaction freshness, balance freshness and snapshot freshness are tracked
   and shown as separate timestamps. The routine Plaid paths (daily `sync-banks`,
   webhook/deferred pipeline) refresh balances and regenerate today's snapshot after
   importing transactions, the way manual refresh always did. **IMPLEMENTED**
   (CONN-3; `jobs/sync-banks.ts`, `lib/plaid/backgroundHistorySync.ts`,
   `lib/connections/intelligence.ts`). Wallet connections carry per-facet clocks of
   their own; see [crypto-networks.md](./crypto-networks.md#wallet-refresh-price-archive-maintenance-and-per-facet-freshness).

**Provider truth stays boring.** `PlaidItemStatus` / `ConnectionStatus` remain
`ACTIVE | NEEDS_REAUTH | ERROR | REVOKED`; richer UI phases are a pure derived
projection with no database authority of its own. **DECIDED** (CONN-2E) and
**IMPLEMENTED** (`lib/sync/lifecycle.ts`, `lib/sync/status.ts`).

**Completion semantics.** "Provider: sync complete" is not "financial profile ready":
the card reads ready only when acquisition and reconstruction are both complete.
**IMPLEMENTED** (CONN-2G).

Not built: operator-facing provider authorization-age visibility and prompt-to-reauth
(PO-4B; never auto-revoke) — **PROPOSED**, paused.

## Refresh paths and execution traceability

The refresh execution ledger and its standing gaps are specified in
[REFRESH_EXECUTION_DOCTRINE.md](../architecture/REFRESH_EXECUTION_DOCTRINE.md); this
section records how the connection refresh entry points map onto it.

- **Manual refresh has two branches, both ledgered.** `POST /api/plaid/refresh` with a
  `plaidItemId` (per-connection menu) runs one MANUAL/FULL_REFRESH `RefreshExecution`
  via `runFullRefresh`. Without a body (the global topbar Refresh button and the
  sidebar "Refresh Data" row, via `components/plaid/useManualRefresh.ts`) it fans out
  through `refreshAllActiveItemsForUser`, which sends **each** item through
  `runManualItemRefresh` — one execution per eligible item, never one for the fan-out,
  with the sync lock claimed **inside** the envelope so contention records a SKIPPED
  execution. **IMPLEMENTED** (OPS-REFRESH-1A; `lib/plaid/refresh.ts`, doctrine §C).
- **The fan-out's snapshot is deferred.** Each item skips its own snapshot stage
  (recorded as SKIPPED) and one post-loop `regenerateCompletedSpaces` regenerates
  today's snapshot for the union of succeeded accounts. That write belongs to no
  per-item execution. **IMPLEMENTED** (current behaviour; standing gap, doctrine §N).
- **Reconnect differs materially from manual refresh.** Reconnect runs an inline fast
  slice (deliberately unledgered, doctrine §J) plus a deferred
  RECONNECT/RECONNECT execution that includes `HISTORY_BACKFILL` — the one-time
  reconstruction bootstrap. Manual refresh never runs `HISTORY_BACKFILL`; it only
  repairs an existing reconstruction (`repairReconstructionForAccount`, a no-op when
  no reconstruction summary exists). **IMPLEMENTED.**
- **Execution identity reaches telemetry, not financial rows.** `RefreshEndpointResult`,
  `RefreshEndpointAccountCoverage`, `ProviderCall` and `SyncIssue.detail.runId` carry
  the execution; `Transaction`, `PositionObservation`, `InvestmentEvent`,
  `PositionReconstruction` and `SpaceSnapshot` do not. "Which refresh changed this
  number?" is therefore not answerable on any path. `ImportBatch` (a nullable soft FK
  on the financial rows, `SetNull` on delete, carried by every import writer) is the
  only working row-provenance pattern and the model to copy. Open, together with
  reconstruction not being a declared stage, post-envelope cron / resume-sync writes,
  and `HISTORY_BACKFILL` recording no facts — all listed in doctrine §N. Closing them
  is **PROPOSED**.
- **Reconstruction never anchors on its own output.** Reconstruction reads anchors with
  `origin: OBSERVED` only, and a rerun deletes only its own rows (`origin: DERIVED`,
  `source: "reconstruction"`), so a rerun is idempotent and cannot compound.
  **IMPLEMENTED** (`lib/investments/reconstruction-runner.ts`). The stronger contract
  for any future quantity replay — a named, tested evidence-origin allowlist that
  excludes `DERIVED`; run and anchor identity on derived rows; supersede rather than
  hard-delete prior generations — is **PROPOSED** (not built). The crypto equivalent
  is stated as doctrine in [crypto-networks.md](./crypto-networks.md) (lifecycle stage 7).
- **Deliberately not ledgered** (verified, do not "fix"): owner-facing routes
  (`/refresh`, `/sync`, `/resume-sync`, `/investments/enable`) return a typed
  admission denial synchronously instead of recording it (pinned in
  `lib/platform/admission/producer-convergence.test.ts`); cron and
  `resume-stale-imports` record one dispatch finding rather than one denial per
  candidate. **IMPLEMENTED.**

## Provider orchestration (PROV) status

- **PROV-2** — `mapAccountType` has one owner (`lib/plaid/account-type.ts`); the inline
  identity→legacy lookups were replaced by the shared resolver
  (`resolvePlaidAccountByExternalId`, `lib/accounts/reconcile.ts`). **IMPLEMENTED.**
- **PROV-3** — one investments-ingest stage, `syncInvestmentsForItem`
  (`lib/plaid/sync-investments.ts`), consumed by exchange and refresh. Two drifts were
  resolved canonically: consent is **change-detected and logged** (a first link seeds
  it as "unknown → X"), and `investmentsHoldingsGet` is **always retried**.
  **IMPLEMENTED.**
- **PROV-4** — `persistAccountSpine` is the single writer of the per-account
  `AccountConnection` + `SpaceAccountLink` pair, consumed by the Plaid exchange
  (`lib/plaid/exchangeToken.ts`) and the wallet add route. (The manual-asset route
  writes its own links in a deliberately inverted order for RLS; it is not a
  consumer.) There is intentionally **no
  "update-only" spine mode**: refresh updates balances and writes no spine, so such a
  mode would have no producer. **IMPLEMENTED** (`lib/accounts/persist-account-spine.ts`).
- **PROV-5A** — the zero-importer `plaidAdapter` re-export was deleted. **IMPLEMENTED.**
- **PROV-5B** (typed `ProviderAdapter`) and **PROV-6** (`ProviderIngestionPayload`
  universal ingestion contract, `collect → normalize → persist → consequences`) —
  **PROPOSED**, deferred by design until a second proven provider shares the shape
  (see Extension points). PROV-6 is the gate before any native exchange/brokerage
  provider implementation.
- **Out of scope by decision:** merging `exchangeToken` and `refresh` into one pipeline.
  Their failure semantics differ on purpose — transaction-sync failure is fatal in
  refresh and swallowed in exchange; create mode is atomic per account; refresh never
  creates or restores; the cooldown applies to manual refresh only. **DECIDED.**
- **Ordering invariants** any shared code must keep: item/credential before accounts;
  account resolution before the `AccountConnection` + `SpaceAccountLink` pair (written
  together); observation capture before `syncCurrentHoldings`, which runs before
  `ingestInvestmentEvents`; the transaction cursor advances per page after that page's
  writes; refresh captures balances before transaction sync; the all-items refresh
  completes every item before `regenerateCompletedSpaces`. **IMPLEMENTED.**

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

- **Wallets are refreshed on a schedule.** `sync-crypto` (`jobs/sync-crypto.ts`) is
  registered in `lib/jobs/registry.ts` and sweeps every syncable wallet (BTC, ETH, SOL
  and any chain the sync registry can read) through `lib/crypto/wallet-refresh.ts`
  every 6 hours, with `sync-crypto-continuation` finishing work its budget deferred.
  Wallets also sync on add, on manual Refresh (`POST /api/accounts/[id]/sync`) and on
  re-add. Plaid items are retried by the daily `sync-banks` job. **IMPLEMENTED.**
  (This replaces an earlier note that the wallet sweep was unregistered; that was
  retired in July 2026.) What is still not built is targeted failed-connection retry
  with per-connection backoff and transient-vs-permanent classification — see
  Extension points; card copy must not promise it.
- **WALLET identity.** Wallet add dual-writes `ProviderAccountIdentity`
  (provider `WALLET`, external id = address) and `alignWalletProviderSpine`
  (`lib/accounts/wallet-connection.ts`) writes the wallet's `Connection` row.
  **IMPLEMENTED.** The legacy `walletAddress`/`walletChain` columns on
  `FinancialAccount` are still read by the wallet routes (dedupe on add); no new
  readers should be added there.
- `Connection` is written for Plaid items and wallets; other provider types do not
  exist at runtime yet.
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
- The designed (not-yet-built) targeted retry model — failed-connection retry,
  per-connection backoff, transient-vs-permanent classification — is
  **PROPOSED**; when it ships, the card copy must be updated to match, never
  before. (Registering the scheduled `sync-crypto` sweep, once part of this
  design, is done.)

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
