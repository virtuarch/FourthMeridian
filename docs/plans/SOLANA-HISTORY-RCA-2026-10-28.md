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

---

## Addendum (same day) — the 5,000-transaction ceiling: confirmed cause and the resumable backfill

### Confirmed cause (code, not inference)

| Question | Finding |
|---|---|
| Origin | `DEFAULT_PAGE_BUDGET = 5` × `SIGNATURE_PAGE_LIMIT = 1000` in `lib/crypto/sol-history.ts`; the loop is `while (pagesFetched < pageBudget)`. |
| Enforced by | **The application.** Solana's RPC caps a page at 1,000 and pages with `before`; the 5-page budget is ours. |
| Pagination | Backward via `before` from the newest signature on every run. `until` was never passed. One sequential `getTransaction` per signature. |
| Cursor persisted | **No.** The "stored on `Connection.cursor`" comment described nothing; `refreshWalletHistory` passed no cursor and nothing wrote one. (`newestSignature` also never advanced.) |
| Timeouts | No timeout on history requests; whole runs were measured at 44 s. |
| Rate limits | None: a 429 threw, the whole run became `PROVIDER_FAILED`, all fetched pages were discarded. |
| Resume | Impossible — every run restarted at the newest signature. |
| Duplicates | Not possible: DERIVED rows were delete-and-replaced; no `Transaction` rows are written. |
| Reconstruction | Σ(movements) from **zero** had to equal today's balance. Past 5,000 signatures the opening balance is never reached, the residual equals it, and the run refuses `LEDGER_DOES_NOT_RECONCILE` — the same five pages, forever. |
| Projection impact | Unlicensed SOL quantity is null ⇒ the crypto component refuses for those days, and Solana never reported `impactedFromISO`, so a widened history never triggered a deep snapshot rebuild. |

### Implemented architecture (PR: feat/sol-history-resumable)

- **The chain states balances.** Each transaction reports the owner's lamports before and after it. Consecutive transactions must satisfy `post(older) === pre(newer)`; a match proves the stretch complete, a mismatch is a **proven gap** (a transaction the index did not list). History is therefore provable a chunk at a time without the opening balance and without persisting movements.
- **Two frontiers, one checkpoint.** `Connection.cursor` holds `{top, bottom, reachedBeginning, licensedFrom/To, gap, failures, lastFailure, signaturesProcessed}` (versioned JSON; no migration). Each run first extends the **top** (`until` = top signature, oldest-first) and verifies the newest transaction states the **observed** balance, then extends the **bottom** (`before` = bottom signature).
- **Bounded by wall-clock, not count** (`SOL_HISTORY_RUN_BUDGET_MS`, default 45 s, far inside the 360 s wallet lock). No total ceiling.
- **Commit per page**, in ONE transaction: the new days' DERIVED rows (`completeness = CHAIN_STATED`, `reconstructionVersion = 2`), the `PositionCoverage` licence (`COMPLETE` over the proven interval), and the checkpoint by **compare-and-swap** on the cursor the run started from — two concurrent runs can never both advance it.
- **Transport**: per-request timeout, ≤4 retries with exponential backoff honouring `Retry-After` (never past the run deadline), JSON-RPC rate-limit errors treated as throttling, a small fetch pool (4) that drops to 1 when throttled.
- **States**: QUEUED · IMPORTING (partial, with the proven interval) · COMPLETE · FAILED (6 consecutive failures; automatic retry once a day) · RECOVERY_REQUIRED (gap; proven history above it kept; automatic runs skip) · UNAVAILABLE. Operator `resume` clears failures/gap and retries.
- **Snapshots**: the refresh now returns `mode` + `impactedFromISO` for SOL, which `wallet-post-sync` already feeds to the historical work window (closes gap 3 above).

### Evidence

`lib/crypto/sol-history-resumable.test.ts` (65 checks, deterministic in-memory chain incl. v0 lookup-table and failed transactions): 4,999 / 5,001 (1 run), 12,000 (5 runs), 52,000 (6 runs) — every day equals the chain's true end-of-day balance and each transaction is fetched exactly once; interruption + resume; 429 backoff/exhaustion/deadline; duplicate page delivery; concurrent runs (exactly one advances); head extension with `impactedFromISO`; idempotent re-run; gap detection without guessing; anchor mismatch; empty wallet; failure → FAILED → paused → resume.

### Remaining limitations

- **Throughput**: one run per wallet sync (4 scheduled/day + continuation + manual). At ~45 s/run a 100,000-transaction wallet takes on the order of weeks to finish; it shows IMPORTING with its proven interval meanwhile. A dedicated self-continuing job is the lever if that is too slow (owner decision: provider cost).
- **SPL tokens** are still not reconstructed (native SOL only).
- **Gaps** need an operator; there is no automatic recovery of a transaction the index never lists.
- The `HISTORY_BACKFILL` execution stage still records refusals as SKIPPED; the code is now durable in the checkpoint (`lastFailure`) instead. Changing the ledger verdict is left for the Platform Ops pass so alerting is not altered silently.
- **Production**: no migration. On first run each existing SOL wallet starts a fresh checkpoint and replaces its old DERIVED rows (only `source = sol-reconstruction`). No backfill is triggered by deployment; it advances with normal syncs.
- **Release note (owner decision before Production):** a wallet that the old engine had fully licensed (under 5,000 signatures) gets a fresh checkpoint on its first new-engine run. That first commit replaces its old DERIVED rows with the newest proven page(s), so its licensed interval can be **narrower for a few syncs** until the bottom frontier passes the old start date. Nothing is fabricated in the meantime — older days refuse rather than guess — but charts for those days show "not available" briefly. Options: accept; or seed the first run with a larger one-off budget; or keep the old licence until the new bottom passes it (a follow-up change).

### Independent review (before merge) — fixed in the same PR

An adversarial review with probe scripts found, and this PR now fixes:
- **Same-slot ordering**: two transactions in one slot share a blockTime; end-of-day balances now follow the order continuity proved (never re-sorted), slots are permuted until their balances chain (the provider's within-slot order is undocumented), and a slot is only ever committed WHOLE (a page's trailing slot and a slot cut by the budget are re-listed next page).
- **Head gap licence**: without a verified head the licence now stops the day BEFORE the newest proven transaction — an unproven transaction may share that day.
- **Snapshot window**: committed progress followed by a failure still reports `impactedFromISO`, so the rebuild widens.
- **Busy wallets**: the head phase takes at most half a run while history is owed, and an unverified head (balance read raced new activity) is not a failure and never blocks the backward backfill.
- **Float anchors**: the stored quantity's representation error (above ~4.5M SOL) is carried as an explicit tolerance.
- Timeouts while reading a body are PROVIDER_TIMEOUT; the connection link is chosen stably.
