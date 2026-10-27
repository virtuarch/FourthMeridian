# Solana history backfill — root cause, completeness model, recovery design (2026-10-28)

Read-only code audit and fixes on develop. **No Production data was read or changed and no backfill was run.** Nothing here invents history: where the chain evidence doesn't reconcile, the system still refuses.

## Root causes (fixed in this PR)

1. **The replay window collapsed to the connection date.** This is the cause when a run succeeds but writes almost nothing.
   - `refreshWalletHistory` passes the earliest `Transaction`/`PositionObservation` date as the window floor (`lib/crypto/wallet-history-refresh.ts`).
   - Solana stores no Transaction rows, so on first connect the floor is today. `reconstructSolHistory` replayed only today.
   - Later runs start from the DERIVED rows the previous run wrote, so the collapse was **permanent**.
   - Ethereum had already fixed the same thing with ETH-H2, the licence-union rule. Its comment wrongly assumed Solana imports its movements first.
   - **Fix:** the replay window is now the union of the reconciled licence (`coveredFromISO`) and the caller's floor (`lib/crypto/sol-history-sync.ts`).
2. **v0 (Address Lookup Table) transactions crashed the parser.** This is the cause when a run writes nothing and the log shows `PROVIDER_FAILED`.
   - With `encoding:"json"`, the static `accountKeys` leave out the loaded addresses, but `pre/postBalances` include them. `deriveNativeMovements` threw "balance arrays do not align".
   - Most wallets that have ever made a DEX swap contain such a transaction.
   - **Fix:** the keys are now built as static, then `loadedAddresses.writable`, then `loadedAddresses.readonly`, which is the RPC's documented order. A transaction that is still misaligned is still refused.
   - Residual uncertainty: this relies on the RPC's standard ordering, which I haven't checked against Alchemy live.

Tests: `lib/crypto/sol-history-backfill.test.ts`.

## Remaining gaps (not fixed; ranked)

1. **No signature checkpoint.** `refreshWalletHistory` never passes or saves the cursor. A wallet with more than 5,000 signatures (5 pages × 1,000) always ends at `PAGE_BUDGET_EXHAUSTED`, then fails as `LEDGER_DOES_NOT_RECONCILE`.
2. **Refusals are recorded as SKIPPED.** `HISTORY_BACKFILL` records a refusal as SKIPPED/NOT_APPLICABLE and logs the code only to the console, so nothing alerts and Ops can't see why.
3. **Change detection misses Solana.** `historical-work-window.ts` misses rewritten Solana DERIVED positions, so an existing Space won't deep-rebuild snapshots after a widened replay.
4. **Price floor.** It accepts an INTRADAY quote, so with no older SOL closes the floor sits near today. CoinGecko Demo only reaches back 365 days.
5. **No timeouts or 429 backoff** on the Solana history calls, and the routes set no `maxDuration`.
6. **No SPL tokens** anywhere.

## Completeness model (derived from existing records; proposed for the customer and Ops surfaces)

| State | Evidence |
|---|---|
| complete | `PositionCoverage.kind=COMPLETE` with no blocking caveats; DERIVED `MIN(date)` ≈ `coveredFromDate`; `historyRebuiltAt` set |
| partial | coverage PARTIAL, or a `PAGE_BUDGET_EXHAUSTED`/`ARCHIVE_DEPTH_LIMIT` caveat, or DERIVED `MIN(date)` ≫ `coveredFromDate` (the window-collapse signature), or the price floor after the activity start |
| pending | wallet sync pending or `historyRebuiltAt` null, with an execution RUNNING or none at all |
| unavailable | the chain isn't HISTORY_SUPPORTED, or the refusal was `NO_PROVIDER_CONFIGURED` |
| failed | `HISTORY_BACKFILL` SKIPPED after a successful `WALLET_SYNC`, or a `WALLET_SYNC_FAILED` SyncIssue |

**Prerequisite:** persist the refusal code (on `RefreshEndpointResult` or the Connection). Today it is not stored anywhere.

## Customer disclosure (proposed copy)

- **partial:** "History shown from {date}. Earlier activity couldn't be fully verified."
- **failed:** "We couldn't rebuild this wallet's history. Your current balance is up to date."
- **unavailable:** "History isn't available for this network yet."

## Recovery design (Platform Ops; not built; needs owner approval for Production use)

- **Per-wallet "Rebuild history" CONTROL action.** It goes through `recordOperatorAction` with a reason, and its core is `syncWalletByChain` (`reconstruct` then `regenerate`).
  - Idempotent under the existing wallet lock (`claimWalletSyncLock`, 360 s TTL): a second click while one run is in flight returns IN_FLIGHT.
- **Dry-run first.** `reconstructSolHistory({dryRun:true})` reports the would-be coverage, row count and impacted-from date. The operator applies only after that.
- **Notify the customer** only after a validated recovery: coverage COMPLETE or PARTIAL with an earlier start, and snapshots regenerated.
- **Read-only checks to run against Production first** (owner approval needed for each read): `Connection.historyRebuiltAt`, `PositionCoverage`, `MIN(PositionObservation.date)` by origin, `RefreshEndpointResult(HISTORY_BACKFILL)`, and the Vercel log line `history not refreshed for <id>`.
