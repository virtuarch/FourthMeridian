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
