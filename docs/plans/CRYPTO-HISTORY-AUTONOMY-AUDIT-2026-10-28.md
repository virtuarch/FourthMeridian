# Autonomous crypto history — audit, Preview evidence and Production gaps (2026-10-28)

Owner requirement: *a customer connects a wallet once; Fourth Meridian handles the rest.* Manual Operations is for diagnostics, recovery and authorized reprocessing only.

## 1. Preview Solana backfill test (PR #101 + #102), owner's public wallet, owner-run Manual Operation

| Check | Result |
|---|---|
| Execution | **Real run** (`trigger: manual`, `PLATFORM_OPERATION_EXECUTED` audit row, operator via PLATFORM_OPS grant), deployment `08823f8`, 05:16:25–05:16:36 UTC, **10.8 s**, `succeeded`, no error |
| Requests | **37** = 36 `getTransaction` + 1 `getSignaturesForAddress`; **≈ 1,480 CU** (40 CU/call) — 0.25 % of the 15,000-request daily cap |
| Throughput | ≈ 3.4 requests/s against the 4 req/s limit (rate-limit bound, as designed) |
| History | 36/36 transactions processed, 0 continuity gaps, 0 retries/throttles |
| Reconstruction | **1,678 daily rows, 2022-03-26 → 2026-10-28, 0 mismatches** vs the independent public-RPC truth set; no row before the first transaction day; basis `CHAIN_STATED`, version 2 |
| Anchor | 2026-10-28 OBSERVED **0.751600602 SOL** = DERIVED 0.751600602 |
| Coverage / checkpoint | `PositionCoverage COMPLETE 2022-03-26…2026-10-28 (solana-rpc+chain-continuity)`; checkpoint `DIRECT`, `reachedBeginning`, `failures 0`, `usage 37 (2026-10-28)`, no pending snapshot work |
| Wallet sync while enabled | head-only: wrote nothing for a fresh wallet (history left to the worker) — row showed "History incomplete" |
| Snapshots | regenerated (1 wallet). Space snapshots exist for **2026-09-27 → 2026-10-28 only**: Preview's SOL daily-close archive starts 2026-09-27, so earlier days refuse (no price) rather than invent value |
| SPL | 1 of 36 transactions touched an SPL token; tokens are **not** reconstructed and nothing claims they are (Overview "Assets tracked: SOL (native)") |
| Stop / budgets | `ALL_RUN`, deferred 0, within job (120 s), wallet (20 s) and daily caps |
| Not exercised on Preview | multi-run continuation (the wallet finished in one run) and the 15-minute self-continuation (crons do not fire on Preview) — both covered by the deterministic tests |
| After test | **worker disabled on Preview** (`SOL_BACKFILL_ENABLED` removed, develop redeployed); checkpoints and rows preserved |

## 2. Scheduler / dispatcher / ledger — as it actually runs

- **Production dispatch is real**: `vercel.json` cron `*/15 * * * *` → `/api/jobs/dispatch`; Production logs show 50 wakes in 12 h, median gap 15.0 min (mostly "no jobs due" no-ops). Vercel crons fire on **Production deployments only** — Preview has no automatic dispatch (hence Manual Operations there).
- Each wake runs due jobs **sequentially in one 300 s invocation**; each through `runJob` (JobRun ledger, one running row per job = the claim; stale rows finalized next wake).
- Continuation: `selfContinues` jobs re-run ≥ 15 min after a run whose summary reports `deferred > 0`; otherwise they wait for their cadence.
- **Production runs `main` (v2.7)** — none of #99–#102 is there yet.

## 3. Requirements A–M — status

| | Status |
|---|---|
| A/B scheduler audited, Production cron verified | **Done** (above) |
| C durable queue, checkpoints, bounded, fair, idempotent | **SOL: implemented** (checkpoint = the queue entry; CAS commits; per-wallet budget; oldest-progress-first). BTC/ETH: see §4 |
| D shared provider budgets incl. syncs | **Partial**: SOL backfill requests from worker *and* syncs are metered into durable daily usage and capped. ETH (same Alchemy key) and SOL balance/quote reads are **not** metered |
| E no global bottleneck | SOL: per-wallet budget per run; one large wallet cannot starve others |
| F isolation / least privilege | worker: `fm_system` under `jobs/` (allow-listed), per-wallet sync lock, no cross-wallet writes |
| G extensible, chain-honest | lifecycle concepts reusable; ingestion per chain stays separate |
| H separate readiness facets | holdings / native history / snapshots are separate authorities; **token history is not modelled** |
| I no "complete" while tokens incomplete | coverage is native-only and labelled; a token-history facet is needed before any wallet-level "complete" claim |
| J truthful persisted states in UI | **Gap** — the checkpoint states are not yet read by Connections (next PR) |
| K retry/backoff, dead-letter, monitoring | SOL: bounded backoff, FAILED (daily retry) and RECOVERY_REQUIRED (operator); **no Ops view of checkpoints yet** |
| L existing infra sufficient? | **Yes for beta scale**: the 15-min dispatcher + selfContinues + Alchemy Free at 4 req/s / 15k req/day. No new paid service needed |
| M Production untouched | **Yes** |

## 4. Per-chain gaps

- **Solana** — autonomous once enabled, with one latency gap: after a run reports `deferred 0`, a *newly added* wallet waits for the job's cadence (6 h slots) before history starts. *Fix (small):* give the job a 1-hour default cadence (a no-op run is two indexed reads).
- **Bitcoin** — history runs inline in every wallet sync (autonomous), but `BTC_TX_PAGE_BUDGET` caps one run at **1,000 confirmed transactions per address with no checkpoint** — the Solana ceiling class. *Fix:* the same resumable pattern (Esplora pages are cursorable by last txid), moved behind the worker.
- **Ethereum** — incremental, checkpoint-verified history inline in syncs (autonomous), bounded by a 4,000-block probe budget per run; a full rebuild measured 157 s inline. *Fix:* move ETH's full-rebuild path behind the worker so syncs stay responsive; meter its Alchemy calls into the shared budget.
- **Tokens (SPL / ERC-20)** — not reconstructed on any chain; needs its own coverage facet before wallet-level completeness can be claimed.

## 5. Smallest safe changes to full autonomy (proposed — not implemented)

1. **Truthful history progress in Connections/onboarding** (next PR): read checkpoint status — *History queued / Importing (proven back to {date}) / Complete / Needs attention* — and say "continues in the background" **only while the worker is enabled**.
2. **Solana job cadence 1 h** so new wallets start promptly without a manual run.
3. **Shared Alchemy budget**: meter ETH history + SOL sync reads into the same durable daily usage; one cap per provider.
4. **Ops visibility**: a read-only per-wallet backfill table (state, proven interval, last failure code, requests today) in Platform Ops; "Resume history" as an audited operator action for FAILED / RECOVERY_REQUIRED.
5. **Bitcoin resumable history** behind the worker (removes the 1,000-tx ceiling).
6. **Token-history facet** (design first).

## 6. Production activation requirements (owner decisions)

- Promote develop → main (normal release approval; the Growth migration and #78 holds are independent).
- Verify the Alchemy plan for the **Production** key (separate from Preview's? not determinable from here — the variable is Sensitive).
- Set Production `SOL_BACKFILL_ENABLED=true` with plan-appropriate `SOL_BACKFILL_MAX_RPS` / `SOL_BACKFILL_DAILY_REQUEST_CAP`.
- No migration. Existing licensed SOL histories are preserved (STAGING) until replacement history is validated and promoted atomically.

## 7. Why the owner's Solana wallet shows ~32 days of snapshots (Preview)

| Stage | Earliest date | Source |
|---|---|---|
| 1. On-chain activity | **2022-03-26** | independent public-RPC scan: 36 signatures, 2022-03-26 → 2026-02-27 |
| 2. Imported transactions | **2022-03-26** (36 processed) | Solana writes no `Transaction` rows by design; the checkpoint records 36 proven signatures |
| 3. Reconstructed native SOL balances | **2022-03-26** | 1,678 DERIVED daily rows, COMPLETE licence 2022-03-26 → 2026-10-28 |
| 4. Stored SOL/USD prices | **2026-09-27** | Preview archive: 31 RAW_CLOSE (2026-09-27 → 10-27) + today's INTRADAY |
| 5. Persisted snapshots | **2026-09-27** | 32 SpaceSnapshot rows, 2026-09-27 → 2026-10-28 |
| 6. Chart API (`GET /api/spaces/[id]/snapshots`) | **2026-09-27** | 32 points, 2026-09-27 → 2026-10-28 |

**The limiting stage is 4 — historical USD prices.** Balance history reaches 2022; valuation stops where the price archive stops, exactly as designed (no price ⇒ the day refuses; it is never valued at zero).

Why the archive is only 31 days on Preview:
- The price archive is **per asset, shared by every customer** (`PriceObservation @@unique([instrumentId, date, basis])`, no customer column) — prices are already acquired once per asset/date.
- It widens through `reconcileProviderCapability` + held-close maintenance in **`sync-crypto`, a cron job** — and crons never fire on Preview. The snapshot regeneration that the worker triggered prices only the window it rebuilds, and that window is clamped to the existing price floor, so it cannot widen the archive by itself.
- In Production (cron every 15 min, sweep every 6 h) the same wallet would be valued back to the provider's floor: **CoinGecko serves a rolling 365 days** (`COINGECKO_DEFAULT_HISTORY_DAYS = 365`). Older balance history (2022 → ~2025-10) is retained and remains unvalued until an older price source is licensed.

## 8. Owner requirement (2026-10-28) — four separate stages, incorporated

1. **Blockchain transaction ingestion** · 2. **Historical balance reconstruction** (native; tokens separate) · 3. **Historical USD price availability** · 4. **Valuation / snapshot generation** — reported separately, never one "complete" badge.

| Requirement | Status |
|---|---|
| Prices acquired once per asset, not per customer | **Already true** (shared archive, unique per instrument/date/basis) |
| Keep blockchain/balance history when prices are missing | **Already true** (rows retained; valuation refuses) |
| Never value a missing price as zero / extrapolate | **Already true** |
| Determine each asset's earliest valid price date and show it | **Proposed** — the History tab shows the balance licence; it should also show "prices from {date}" and "valued from {date}" |
| Queue bounded historical price ingestion for a newly held asset (autonomously) | **Gap** — widening rides on the 6-hourly `sync-crypto` capability pass; a newly connected asset waits up to 6 h. Proposed: trigger the existing capability reconciliation for that instrument when a wallet's history first completes |
| Platform-wide re-valuation when older prices appear | **Partly exists** (`capability-reconciliation` emits `newlyAvailable` → `impactedFromISO`); proposed: drive it through the worker with checkpoints and Ops visibility |
| Connections shows the four stages truthfully | **Next PR** (crypto-history progress) |
