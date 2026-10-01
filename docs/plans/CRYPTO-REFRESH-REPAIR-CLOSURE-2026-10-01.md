# CRYPTO REFRESH REPAIR — CLOSURE REPORT

**2026-10-01 · branch `v2.6` · authority `docs/plans/CRYPTO-REFRESH-INCIDENT-2026-10-01.md`**

---

## 1. Start HEAD → final HEAD

```
start   e750055   S1-9a — DOGFOOD FIXES …                      (= origin/v2.6, 0/0)
final   317a30c   CRYPTO-LATCH-3 — the gap-repair tool is classified
pushed  e750055..317a30c  v2.6 -> v2.6
```

## 2. Commits by slice

| Commit | Slices | Subject |
|---|---|---|
| `6fbb601` | 0 | The investigation, committed as the authority for the repair |
| `ef043cb` | 1, 2 | **The price archive is a prerequisite of valuation, not a consequence of it** |
| `7981925` | 3, 4, 5, 6, 8, 9, 10 | **Every freshness line reads the fact it names** |
| `317a30c` | 3 | The gap-repair tool is classified (OPERATIONAL) |

## 3. Files changed

**New (7)** — `lib/crypto/crypto-close-coverage.ts` · `lib/crypto/crypto-close-coverage.test.ts` ·
`lib/crypto/wallet-refresh-invariants.test.ts` · `lib/crypto/crypto-repair-dogfood.test.ts` ·
`lib/connections/wallet-facet-freshness.test.ts` · `scripts/repair-crypto-close-gaps.ts` ·
`prisma/migrations/20261001120000_connection_facet_freshness/migration.sql`

**Modified (13)** — `lib/crypto/btc-sync.ts` · `lib/crypto/wallet-sync-dispatch.ts` ·
`lib/crypto/wallet-refresh.ts` · `lib/crypto/crypto-price-window.ts` ·
`lib/crypto/wallet-history-refresh.test.ts` · `lib/crypto/btc-partial-sync.test.ts` ·
`lib/crypto/wallet-refresh.test.ts` · `lib/accounts/wallet-connection.ts` ·
`lib/connections/intelligence.ts` · `lib/connections/space-data.ts` ·
`components/connections/ConnectionCard.tsx` · `components/dashboard/SyncWalletButton.tsx` ·
`jobs/sync-crypto.ts` · `lib/plaid/refresh-execution-types.ts` · `prisma/schema.prisma` ·
`scripts/audit-registry.ts` · plus two docs.

**Untouched, as instructed** — the five `docs/audits/status-drift/*` files, and
`docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md` (peer work that appeared
mid-session). Every commit used explicit paths. No stash, reset, clean or checkout.

## 4. The exact RAW_CLOSE latch repair

The latch was:

```
valuation needs a RAW_CLOSE within maxStaleDays (7)
  → the ONLY RAW_CLOSE refresher is backfillHeldInstrumentPrices
  → reached only from the wealth-history regeneration
  → gated on outcomeRevalued, on BOTH call sites
  → outcomeRevalued is false exactly when the valuation was UNAVAILABLE
```

Repaired by giving the close authority its own maintenance and by making the
schedule maintain the archive independently:

- **`lib/crypto/crypto-close-coverage.ts`** (new) answers one question — "can the
  RAW_CLOSE archive value this asset on this date?" — and, when it cannot, repairs
  exactly the walk-back window. Statuses are stated, never fall-through: `COVERED`
  (no vendor call at all), `REPAIRED`, `UNRESOLVED`, `NO_INSTRUMENT`, `FAILED`.
- **`btc-sync.ts: canonicalBtcCloseUsdMaintained`** — read, then repair, then
  **re-read through the same reader**. Never trusts `inserted`: a vendor can write
  rows that still do not reach the day. An injected `priceFetcher` replaces the
  authority wholesale and runs no maintenance, which is why every pre-existing test
  still sees a plain `UNAVAILABLE` and never reaches the network.
- **`jobs/sync-crypto.ts`** maintains held assets **before the sweep**, main slot
  only, non-fatal.
- The repair window is `minusDaysISO(asOfISO, maxStaleDays)` → **derived from the
  tolerance, not a second literal** — `CRYPTO_CLOSE_MAX_STALE_DAYS` is now exported
  so the valuation's tolerance and its maintenance cannot drift apart.
- Clamped to **yesterday**: the archive stores closed dates only.

**Constraints honoured:** `maxStaleDays` unchanged at 7 · `INTRADAY` never read or
promoted (the incident's archive held an Oct-01 INTRADAY at \$84,406 the whole time;
taking it would have destroyed the dated-close/live-quote distinction) · nothing
fabricated, interpolated or carried · no second price authority (it delegates to the
ONE acquisition path) · no Instrument minted (read-only lookup).

## 5. The price-maintenance lifecycle after repair

| When | Who | Scope | Gated on valuation? |
|---|---|---|---|
| Every 00/06/12/18 UTC | `sync-crypto`, before the sweep | every **held** native asset | **No** |
| Any BTC refresh whose close read misses | the close authority itself | that asset's walk-back | **No** |
| On demand, bounded | `scripts/repair-crypto-close-gaps.ts` | operator-chosen window | **No** |

The happy path costs nothing: a covered archive issues no vendor request.

## 6. Is BTC-only recovery now guaranteed?

**Yes, by two independent paths, neither needing any other chain.** Pinned by
`crypto-close-coverage.test.ts` §10: a BTC repair acquires against BTC's own
instrument, never ETH's or SOL's; the close authority performs its own maintenance;
and the sweep's maintenance call precedes `refreshScheduledWallets` in source order.

One honest caveat: recovery is guaranteed **only if the vendor serves a close in the
window**. If CoinGecko has nothing, the status is `UNRESOLVED` and the wallet stays
truthfully unpriced — which is correct, and is now *said* rather than latched.

## 7. Removal of the ETH/SOL accidental `outcomeRevalued` behaviour

Was `outcome.valuation?.status !== "UNAVAILABLE"` — so a chain reporting **no**
valuation satisfied it via `undefined !== "UNAVAILABLE"`. That accident was
load-bearing: it was the only reason a Solana sync regenerated wealth history, the
only thing that refilled the archive.

Now `WalletValuationModel` is **declared per adapter** and the predicate switches on
it: `ADAPTER_VALUED` requires a stated `PRICED` (so an absent valuation **fails
closed**), `READ_TIME_VALUED` returns true **by declaration**. The pre-existing test
that asserted the accident (`outcomeRevalued({ ok: true })` is true) was rewritten to
assert the opposite, with the reason in the assertion text.

## 8. Historical gap-repair capability

The existing acquisition path already satisfied every requirement, verified against
its contract rather than assumed: coverage-driven (interior gaps planned, which the
old edge arithmetic could not represent), missing-only, idempotent, insert-only,
closed-dates-only, no interpolation, provider outcomes classified. **So nothing was
added to acquisition.** What was missing was detection and an entry point.

`scripts/repair-crypto-close-gaps.ts` — **dry run by default**, found the documented
hole exactly, with the live fingerprint unchanged afterwards:

```
BTC   9 missing of 13: 2026-09-21..2026-09-29
ETH   9 missing of 13: 2026-09-21..2026-09-29
SOL   9 missing of 13: 2026-09-21..2026-09-29
```

It re-reads after acquiring and reports days the vendor still does not serve.
Classified `OPERATIONAL` in the audit registry: never run by CI or `--tier=all`.

## 9. Freshness model, before vs after

| Line | Before | After |
|---|---|---|
| Top-level | `min(oldest FinancialAccount.lastUpdated, Connection.lastSyncedAt)` | unchanged (correct) |
| Transactions | **`Connection.lastSyncedAt`** ⇒ "Updated today" after an aborted import | `Connection.transactionsSyncedAt` (wallet) / `lastSyncedAt` (Plaid) |
| Financial profile | audit anchor **else `lastSyncedAt`** for any ready wallet | audit anchor else `Connection.historyRebuiltAt`; **null stays null** |
| Balances / valuation | `FinancialAccount.lastUpdated`, labelled "Balances" | split: **USD valuation** (stored-value chains only) |
| Current position | **no reader existed** | **`PositionObservation` max date** — new row, listed first |

## 10–13. The four freshness authorities

| Facet | Authority | Advanced by |
|---|---|---|
| **Transaction history** | `Connection.transactionsSyncedAt` (Plaid: `lastSyncedAt`) | a **completed** import only |
| **Current position** | `PositionObservation.date` (max, non-superseded) | any successful quantity read, **priced or not** |
| **Valuation** | `FinancialAccount.lastUpdated` | a **priced** run only; read-time chains report none |
| **Financial profile** | audit anchor, else `Connection.historyRebuiltAt` | a reconstruction that **actually refreshed** |

NULL means *never successfully established* and renders as **silence**. No facet ever
borrows another's clock. New state was used rather than `RefreshExecution`, because
that ledger is operational history with its own retention lifecycle and product
freshness must not become whatever the log still happens to hold.

## 14. BTC partial-success semantics

**Unchanged and pinned** (`wallet-refresh-invariants.test.ts` §5): position written
before the import; a capture refusal aborts before any column is written; the import
is complete-or-throw so a failure writes no rows; valuation and history failures stay
non-fatal; an unpriced run still does not move the legacy pair or its clock; a failed
balance read writes no position and returns failed.

## 15. ETH / SOL failure semantics

**Unchanged — fail closed.** The authoritative quantity read is the first network
call on both chains and the capture comes after it, so a timeout has nothing to
write, advances no freshness, and returns `ok:false` → 502. **No partial success was
invented**: neither adapter reports a valuation stage, and the registry now declares
them `READ_TIME_VALUED` explicitly. Only the user-facing wording changed (§16).

## 16. Timeout / retry changes

**NONE — deliberately.** Documented architecture:

| Path | Budget | Env knob | Retries | Fallback |
|---|---|---|---|---|
| BTC balance / history | 10 s per attempt | `BTC_SYNC_TIMEOUT_MS` | 0 on abort; 4 on 429/503, 500 ms × 2ⁿ cap 8 s | none by design |
| ETH balance | 10 s | **`EVM_SYNC_TIMEOUT_MS`** | 0 | none at request time |
| SOL balance | 10 s | `SOL_SYNC_TIMEOUT_MS` | 0 | host resolved once |
| ETH / SOL history | **none** | — | 6 on throttle (ETH) | — |
| CoinGecko quote & close | **none** | — | 0 | none |

None is overridden in `.env.local`. The jitter was environmental — a phone hotspot in
a moving car, sharing the link with Docker and a dev server — so tuning production
around it would be optimising for a degraded development network. Pinned at 10 s by
test so a future change is a decision, not drift. **None of the correctness fixes
depends on retries.**

Instead, the **classification** improved: `walletSyncUserMessage` derives a stable
product sentence from the same classifier the ledger's verdict uses. The abort now
reads *"Balance provider timed out. Existing position was kept."* instead of undici's
*"network error: This operation was aborted"* — which described the **server's** own
timeout and read as "your internet failed" (there is no client-side timeout on that
request at all). `reason` still carries the provider's text for the operator.

**Deferred, with evidence:** ETH/SOL history transports have no budget at all
(P1-3 stands) — real, but it is reconstruction-path work, not this incident's cause.

## 17. Parallelization changes

`CURRENT_QUOTE` ∥ `HISTORY_BACKFILL`. Both already gated on `result.ok`, so nothing
runs earlier relative to success. Safe because: both are non-gating; they cannot
collide in the archive (quote writes `INTRADAY`, reconstruction reads `RAW_CLOSE` —
**basis isolation**, a structural guarantee); each carries its own measured clock;
**each catches its own failure** so one cannot discard the other's completed result;
and **recording order is fixed** (quote, then history) so neither the ledger nor the
outcome depends on completion order.

**Evaluated and NOT done:** `TRANSACTIONS` ∥ `CURRENT_QUOTE` — the larger win
(18.1 s → 10.0 s on the incident run). It would require issuing the quote before
knowing the sync succeeded, changing `outcomeRequoted` semantics and spending vendor
budget on failed runs. That is a correctness/semantics change, not a speed one, so it
is deferred rather than smuggled in. Reconstruction internals were **not** touched.

## 18. BTC critical path, before vs after

```
BEFORE (incident run, 28 248 ms):
  balance 9 740 → valuation 36 → transactions 10 006 → quote 8 124 → history 253

AFTER (same provider behaviour):
  balance 9 740 → valuation 36 → transactions 10 006 → max(quote 8 124, history 253)
  ≈ 19 906 ms   — about 29 % off, with no outcome changed
```

A healthy run (the 17:15 retry) goes 7 665 ms → ≈ 7 400 ms: the overlap matters most
exactly when a provider is slow.

## 19. History-backfill latency decision — **DEFERRED, and my report corrected**

I claimed ETH "spent 43 784 ms to write ZERO rows". **That was wrong.**
`recordHistoryStage` **hardcodes** `recordsWritten: 0` when `mode === "NO_CHANGE"`.
The run did not accomplish nothing — it **proved nothing had changed**, which
`eth-history-incremental.ts:178-182` does by writing the checkpoint quantity forward
and reporting NO_CHANGE.

That proof needs real chain reads (verify the stored checkpoint at the resume block,
then walk ~10 days of new blocks), and it is **not deterministically skippable**: ETH
has no transfer index here (`alchemy_getAssetTransfers` is refused by design), so
"has anything happened?" cannot be answered more cheaply than by asking the chain.

So there was **no obviously unnecessary zero-work reconstruction to eliminate**.
Moving it off the synchronous refresh is genuine architecture → deferred. The
available win was taken instead (§17), and `freshnessAdvanced: false` for NO_CHANGE
is already correct.

## 20. Observability — and a second correction

New **`PRICE_ARCHIVE`** stage (PROVIDER), recorded **only** on runs where the archive
was short — so its presence means "the archive needed work", and a latch can never
again be invisible. A failure makes the run PARTIAL, never FAILED on its own.

The five conditions are now distinguishable:

| Condition | Signal |
|---|---|
| quantity failure | `WALLET_SYNC` FAILED + `SyncIssue` stage=balance + `Connection.errorCode` |
| valuation unavailable | `VALUATION` FAILED + `SyncIssue` stage=price |
| transaction-history failure | `TRANSACTIONS` FAILED + no facet clock written |
| current-quote failure | `CURRENT_QUOTE` FAILED |
| archive gap / maintenance failure | **`PRICE_ARCHIVE` FAILED** (new) + the valuation reason now names the attempt |

**Correction to my own P1-4.** I reported that BTC's PARTIAL runs left no `SyncIssue`.
They did not: `recordSyncIssue` converges retries into one **episode**, and the row is

```
stage=price chain=BTC  firstOccurredAt 2026-09-15 17:19:44  lastOccurredAt 2026-10-01 17:15:19
```

My query filtered `createdAt > '2026-10-01'`, so it was invisible, not missing. **The
real lesson is sharper than the defect I claimed:** a latched failure is precisely the
one that looks *old* by `createdAt`, so an incident reader must sort by
`lastOccurredAt` or it will systematically hide the longest-running problems. No new
dedupe semantics were needed — the existing episode machinery is correct.

## 21. Regression tests added — 104 assertions, 4 files

| File | Assertions | Covers |
|---|---|---|
| `crypto-close-coverage.test.ts` | 44 | the latch, incl. the **exact incident replayed** |
| `wallet-refresh-invariants.test.ts` | 36 | slices 5, 6, 7, 8 |
| `wallet-facet-freshness.test.ts` | 29 | slice 4 |
| `crypto-repair-dogfood.test.ts` | 39 | dogfood A–J |

Mapped to the 25 requested items: (1) §1 · (2,22,23) §2,§10 + `sync-crypto` ordering ·
(3,4) §10 · (5) §5 both source and behaviour · (6) §5,§6 · (7) §11 · (8) inv §5 ·
(9) dogfood C · (10) dogfood B2 · (11) dogfood E · (12,13) inv §6 + dogfood F/G ·
(14) dogfood C + freshness §1 · (15) freshness §1,§2 · (16) dogfood J · (17,18)
freshness §1,§8 · (19,20) inv §8 · (21) coverage §9 + dogfood I · (24) inv §7 ·
(25) 22 REQUIRED audits green.

**Direct incident regression** (`crypto-close-coverage.test.ts` §2): newest RAW_CLOSE
2026-09-20, asOf 2026-10-01, quantity succeeds, history may fail ⇒ walk-back floor is
2026-09-24, the archive genuinely cannot value, the repair is reachable, and the
system is never permanently latched. Plus §6: the walk-back reached 09-20 on **09-27**
and missed it on **09-28** — the exact day every BTC refresh went silently unpriced.

## 22. Dogfood A–J — 39/39, deterministic fixtures, no live mutation

A clean refresh · B stale RAW_CLOSE reaches maintenance · B2 unresolved archive is
*said* (and the unpriced run still does not move the legacy pair) · C history timeout
keeps the position and existing history, and writes **no** transaction clock ·
D quote-independence · E quantity timeout writes nothing · F/G ETH/SOL product copy ·
H recovery after a transient · I gap repair idempotent · **J** the UI shows
*Position: Updated today* / valuation stale / transaction history not claimed, and
**not** "Transactions: Updated today".

## 23. `npm run ci`

**PASSED**, Node **24.21.0**, clean copy of HEAD `317a30c`:

```
✓ test  npm ci · prisma generate · test:unit · typecheck · lint
✓ architecture  npm ci · prisma generate · prisma migrate deploy · db seed · audit:ci
[AUDITS] PASSED — 22 audit(s), every required invariant holds. ✓
[ci] PASSED — both CI jobs green on a clean copy of HEAD. ✓
```

Node 24 was not installed on this machine and the CI script correctly **refused** to
run on Node 26 ("results from another runtime are not evidence"); `brew install
node@24` was added and put first on PATH for the run. `prisma migrate deploy` applied
the new migration cleanly on the throwaway database.

## 24. GitHub Actions

Run `36910273356` on `317a30c` — see the live status appended below / in
`gh run list --branch v2.6`.

## 25. Live DB before / after — **no acceptance mutation**

```
BEFORE  wallets=5 positions=6622 prices=10426 tx=4929 execs=115 stages=418 syncissues=45
AFTER   wallets=5 positions=6622 prices=10426 tx=4929 execs=115 stages=418 syncissues=45
        btc_newest_rawclose=2026-09-30   (unchanged)
        facet_columns_present=0          ← the migration was NOT applied to live
```

Every live statement was a `SELECT`. No sync was triggered. Provider probes were
unauthenticated public reads against a non-user address; no secret was printed.

## 26. Remaining limitations

1. **The migration is not applied to the live dev DB**, by instruction. **The
   Connections page will error there until it is** — `Connection.transactionsSyncedAt`
   / `historyRebuiltAt` do not exist yet. See the operator procedure. Production needs
   it too; deploy does not run `migrate deploy` in this repo.
2. **The 2026-09-21…09-29 RAW_CLOSE hole is still open** (27 day-gaps across three
   assets). Detection shipped; closing it is an authorized write.
3. **Facet clocks start NULL for existing connections** — deliberately. Those lines
   stay silent until the next successful run of each facet. No backfill, because
   inventing a success date is the dishonesty being removed.
4. **ETH/SOL history transports still have no timeout**, and history still dominates
   wall-clock (~44 s).
5. **Recovery depends on the vendor** serving a close in the window; otherwise
   `UNRESOLVED` — truthful, not latched.
6. **`TRANSACTIONS` ∥ `CURRENT_QUOTE`** not taken (§17).
7. Pre-existing, unrelated: an index-rename drift on
   `ProviderCapabilityObservation`, deliberately excluded from my migration.

## 27. Deferred items

| Item | Why |
|---|---|
| Timeout/retry tuning | Evidence was environmental; the brief forbids tuning for it |
| History transports' missing budget | Reconstruction-path work, not this incident's cause |
| Async history backfill | Genuine architecture; latency is real but non-gating |
| `TRANSACTIONS` ∥ `CURRENT_QUOTE` | Would change `outcomeRequoted` semantics |
| Live schema apply + gap repair | Authorized operator actions |

## 28. Final verdict

**The P0 is closed.** The latch cannot re-arm: archive maintenance is now a
prerequisite on two reachable paths, neither gated on a valuation having succeeded,
and a BTC-only holder recovers without any other chain. The accident that was
load-bearing is gone and its replacement is declared, not inferred.

**The correctness model was repaired rather than the symptom.** No timeout was
raised, no retry added, no `maxStaleDays` widened, no `INTRADAY` consumed. The system
now says truthfully what quantity was observed, what price authority was available,
what history was refreshed, what was rebuilt, and when each last *succeeded* — and
where it has never succeeded, it says nothing rather than borrowing another fact's
clock.

**Two of my own investigation findings were corrected in the authority document**
rather than left standing: the "missing" `SyncIssue` (a query artifact — with a
sharper real lesson) and ETH's "zero rows" (a reporting convention, not waste).

**Two authorized live actions remain** before the repair is fully in effect — the
schema apply, and optionally the historical gap repair.
