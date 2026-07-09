# Provider Connection UX Doctrine — connect → sync → ready

**Status:** doctrine (durable). Applies to every data provider — Plaid today;
Wallet chains, Coinbase, Schwab, Tink, and future providers tomorrow.

## The standard lifecycle

Every provider connection follows the same user-visible lifecycle, modeled on
Plaid:

```
Connect  →  initial sync (automatic)  →  ready state in the Connections surface
```

- **Connect** establishes the `Connection` (credentials/watch descriptor/API key).
- **Initial sync happens automatically, immediately** after connect — the user
  never has to press a button to see their first data.
- **Ready state** is reflected consistently in the Connections surface as one of
  `synced` / `pending` / `error`.

**Manual refresh/sync is recovery or freshness — never the normal happy path.**
A user pressing "Sync"/"Refresh" is for pulling newer data or recovering from a
failed sync; it is not how data first appears.

## Source of truth

`Connection.status` / `Connection.lastSyncedAt` / `Connection.errorCode` are the
**authoritative** provider-sync record. Per-account mirrors
(`AccountConnection.syncStatus/lastSyncedAt`, `FinancialAccount.syncStatus`) are
kept fresh for compatibility/UI but are not authoritative.

## How Wallets conform (v1 / v1.5)

- **Add → immediate sync:** adding a wallet triggers a balance sync inline
  (run-on-add), so the wallet shows its balance without a manual step.
- **Consistent state:** a successful sync sets `Connection` (truth) and mirrors
  `syncStatus="synced"`, `lastSyncedAt=now` onto the wallet's `AccountConnection`;
  a failure leaves the account visible and `pending` and records a `SyncIssue`.
  The Connections surface should read these consistently as
  synced / pending / error.
- **Manual "Sync wallet" button** is the recovery/freshness affordance, not the
  first-load path — matching the doctrine.

## Requirement for future providers

Any new provider (Coinbase, Schwab, Tink, additional wallet chains, …) must
implement the same **connect → automatic initial sync → ready** lifecycle,
surface `synced/pending/error` consistently, and treat manual refresh as
recovery/freshness only. New providers ride the shared spine
(`Connection → ProviderAccountIdentity → FinancialAccount → Holding/Transaction`)
so this lifecycle is provider-agnostic by construction.

## Wallet sync retry — current vs. future

**Current (as of this slice): there is NO automatic background retry for
wallets.** A wallet sync (including xpub address discovery) runs only:

- **run-on-add** — the initial sync attempted synchronously when the wallet is
  added (`app/api/accounts/wallet/route.ts`);
- **manual Refresh** — the `SyncWalletButton` on the card / Accounts
  (`POST /api/accounts/[id]/sync`);
- **re-add** — adding the same address/xpub again.

`jobs/sync-crypto.ts` (`syncAllBtcWallets`) exists but is **deliberately
unregistered** in `lib/jobs/registry.ts` ("deferred — R7"), so the daily
dispatcher never re-runs wallet sync. No worker revisits a `Connection(WALLET)`
left in an error/pending state. **Therefore the error card must not promise
background retries** — its copy says "Press Refresh to retry", not "we'll keep
retrying" (that phrase remains only for Plaid, which *is* retried daily by
`sync-banks`).

**Future retry model (not implemented — design intent):**

1. **Register `sync-crypto` in the dispatcher.** Add it to `SCHEDULED_JOBS` on a
   slot; it iterates active BTC wallets via `syncAllBtcWallets()`. This alone
   gives a daily baseline retry for wallets stuck in `pending`/`error`.
2. **Targeted retry of failed connections.** A dedicated pass (mirroring
   `retry-notifications`' claim-first pattern) selects
   `Connection(provider=WALLET)` where a recent sync failed
   (`status/errorCode`), and re-runs discovery+sync — so a rate-limited or
   timed-out onboarding self-heals without the user pressing Refresh.
3. **Cadence + exponential backoff.** Retries space out per connection (e.g.
   ~15m → 1h → 6h → daily), keyed off `Connection.lastSyncedAt`/attempt count,
   so a persistently rate-limited explorer isn't hammered. Reuse the request-
   level 429/timeout backoff already in `lib/crypto/btc-explorer.ts`; add a
   connection-level attempt counter for the coarse cadence (needs a small
   additive field — out of scope here).
4. **Transient vs. permanent failures.** *Transient* (rate-limit / timeout /
   explorer 5xx) → keep retrying with backoff, card shows `pending`.
   *Permanent* (invalid/parse-failed xpub, unsupported descriptor) → stop
   retrying, card shows a terminal `error` with a "remove or re-add" action —
   never silently loop. (Today the abort/timeout case is classified
   `DISCOVERY_FAILED`; the future model should treat it as transient/retryable.)
5. **Cleanup.** A half-onboarded wallet (Connection + account, zero
   `ProviderAccountIdentity`) should remain (the user's intent + retry
   affordance), not auto-delete on a transient failure. An optional janitor may
   remove connections that never completed discovery after a long grace period
   with no user retries.

**Rule:** the UI reflects the CURRENT implementation. When automatic retry
ships, update the card copy to match — never before.
