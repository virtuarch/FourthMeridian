# Overnight report — Connections 2.0 + autonomous crypto history (2026-10-28)

Scope: owner overnight mandate (Connections 2.0, real assets, autonomous multichain history, price-gap backfill, truthful progress UX, Platform Ops visibility, Preview verification). **develop / Preview only. Production unchanged. No promotion to main.**

Legend — **IMPL** implemented · **TEST** deterministic tests pass · **PREV** deployed to Preview · **VER** verified on Preview by hand · **READY-OFF** production-ready but not activated · **BLOCKED** blocked / incomplete.

## 1. Executive summary

- Connections now has category tabs (All / Banks / Crypto / Real assets) and real assets are managed inside it. Wallet details are specific and honest: native vs token history, blockchain-verified vs chart-ready ranges, absolute dates, "Used in" destinations without false Cash Flow claims. "Restore Financial Intelligence" is gone from the customer menu (automatic rebuilds remain). **IMPL · TEST · PREV · VER.**
- History is autonomous by design on all three chains behind per-chain worker flags: SOL (hourly worker, resumable), BTC (resumable checkpoint; removes the 1,000-tx/address ceiling), ETH (FULL rebuilds moved off the sync path into a bounded, resumable worker pass). All metered into one shared Alchemy/Esplora daily budget. **IMPL · TEST · PREV · READY-OFF** (workers disabled everywhere).
- The 32-day Solana chart is explained and now *said* in the product: balances are proven back to 2022-03-26; stored SOL prices start 2026-09-27 (Preview has no crons, so the price archive never widened). The Net Worth chart states this when (and only when) prices bound its start. **VER.**
- Nothing touched Production. Owner decisions are listed in §14/§16.

## 2. PR numbers and merge commits (all into `develop`)

| PR | Merge | What |
|---|---|---|
| #103 | 4448e64 | Docs: crypto-history autonomy audit + Preview SOL backfill evidence |
| #104 | f65113d | Wallet History: blockchain vs chart-ready ranges |
| #105 | 70b9979 | Platform Ops: per-wallet history backfill status |
| #106 | 64ffdef | Connections 2.0 categories + real assets in Connections |
| #107 | 744f6dc | Hourly SOL worker, shared Alchemy budget, historical price-gap backfill, revaluation |
| #108 | f00810e | BTC resumable checkpointed history — **includes migration** `20261028120000_connection_history_checkpoint` |
| #109 | 9b3e721 | Honest connection-specific details; customer rebuild action removed |
| #110 | 3793aec | Net Worth: explain price-bounded history start |
| #111 | b2f0713 | Connections: in-progress strip for wallet history imports |
| #112 | 0205cd4 | Price note only when prices bound the plotted start (Preview finding) |
| #113 | 154fc61 | ETH FULL rebuild off the sync path — resumable worker pass |
| #114 | 751bb38 | ETH RECOVERY_REQUIRED exit (syncs keep refreshing incrementally; operator `resume`) + failure-specific copy |

## 3. Features implemented

- **Connections 2.0** (#106, #109, #111): category bar with counts, per-chain grouping under Crypto, row badges (Holdings current / Importing history / History queued / History needs attention / History incomplete), drawer tabs Overview · Health · History, facts accordion (Watching since, On-chain transactions, Transactions imported, Balances updated, Net Worth history built, Used in), history-import strip gated on the worker actually being enabled.
- **Real assets** (#106): add, list, detail (Overview/Health/History), rename, update valuation (history kept as corrections), remove = archive (restorable from Settings → Data & privacy → Archived assets).
- **History honesty** (#104, #109, #110, #112): blockchain-verified range vs chart-ready range per wallet; token (SPL/ERC-20) history explicitly "not reconstructed"; Net Worth note "SOL balances are known from Mar 26, 2022, but its historical prices start Sep 27, 2026 …".
- **Autonomy** (#107, #108, #113): SOL worker hourly cadence; BTC checkpoint in `Connection.historyCheckpoint`; ETH queued/resumable FULL rebuild with bounded failures (FAILED daily retry, RECOVERY_REQUIRED after 3; refuses a non-zero balance at the provable floor); per-chain `historyWorkerEnabled`.
- **Prices** (#107): price-gap detection per held instrument, bounded backfill through the existing capability reconciliation, holder revaluation (≤10 accounts / 60 s per run). Prices remain shared per asset (never per customer).
- **Ops** (#105, #113): History backfill group in connection diagnostics for SOL/BTC/ETH (state, proven interval, last failure code, requests).

## 4. Features verified on deployed Preview (test account, owner's public SOL wallet)

| Check | Result |
|---|---|
| Category bar, counts | PASS (All · 2 → 1, Crypto · 1, Real assets · 1 → 0) |
| Wallet drawer Overview / Health / History | PASS on 9b3e721 and again on 154fc61 (after #113): Native SOL verified since Mar 26, 2022; chart-ready since Sep 27, 2026 (32 days); SPL not reconstructed; 36 on-chain processed |
| Wallet menu | PASS — Disconnect only (no customer rebuild) |
| Real-asset lifecycle | PASS — Add $18,000 → list → detail → Update valuation $19,500 → rename → History shows Renamed / Valuation recorded / Added → Remove (confirm) → row gone, "Real assets · 0" |
| Net Worth note | PASS — shown on All-time; not shown on 1-month (after #112) |
| History-import strip | PASS (absent — correct: worker disabled) |
| Trusted deployment health (develop) | success on 0205cd4 and 154fc61 |

Not verified on Preview: BTC/ETH worker passes (flags off; owner decision), multi-run continuation (covered deterministically), mobile widths (see §13).

## 5. Capability matrix

| | Solana | Bitcoin | Ethereum |
|---|---|---|---|
| Current holdings | ✅ live | ✅ live | ✅ live |
| Native history | ✅ resumable worker; Preview run COMPLETE, 1,678 days, 0 mismatches | ✅ resumable checkpoint (no 1,000-tx ceiling); inline when flag off | ✅ incremental inline; FULL rebuild deferred to worker when flag on |
| Token history | ❌ SPL not reconstructed (stated) | n/a | ❌ ERC-20 not reconstructed (stated) |
| Metered / capped | ✅ ALCHEMY | ✅ ESPLORA | ✅ ALCHEMY |
| Worker flag | `SOL_BACKFILL_ENABLED` | `BTC_BACKFILL_ENABLED` (+SOL) | `ETH_BACKFILL_ENABLED` (+SOL) |
| Preview live test | ✅ owner-run | ❌ not run | ❌ not run |

## 6. Historical price ingestion and coverage

- Archive is per asset, shared by all customers (`PriceObservation @@unique([instrumentId,date,basis])`).
- Preview today: SOL RAW_CLOSE 31 days 2026-09-27 → 10-27 (+ INTRADAY 10-28); BTC RAW_CLOSE 1 day (10-21). Cause: Preview has no crons, so `sync-crypto` capability passes never ran.
- Production (cron every 15 min) would widen to the CoinGecko Demo floor — a rolling **365 days**. Older balance history stays unvalued (never zero) until an older price source is licensed.
- #107 adds gap detection + bounded backfill + revaluation; not exercised on Preview (needs the cron / worker).

## 7. Real asset management acceptance

PASS for Add → List → Detail → Edit (rename) → Revalue → History → Remove(archive). Known limitations: asset kind and notes are not persisted; edit = rename only; no manual liabilities; a same-day revaluation is labelled "corrected (1 earlier entry kept)" (accurate but reads oddly).

## 8. Connections / onboarding UX verification

Honesty rules verified on Preview: no "Wealth timeline built" / "Cash flow available" / "Transactions available"; crypto shows no Cash Flow destination; absolute dates; "continues in the background" only when the worker is enabled. Mobile widths: see §13.

## 9. Platform Ops

History backfill group per wallet (SOL/BTC/ETH): state, proven-from, last progress, requests, last failure code (#105, #113). Worker run via Manual Operations Run Now (owner) on Preview; Production dispatcher every 15 min (verified from logs).

## 10. Test counts and CI

- #113 full suite 905/906 (one load timeout, `derived-cash-identity.test.ts`, passes alone ~1 s, re-run by me); ETH backfill tests 71/71. #108 suite 903/905 (load flakes) and 110/110 BTC. #110 16→17/17. Connections lifecycle +3 pins.
- Every PR: `test`, Architecture audits, status-drift-guard, Vercel builds green. tsc, eslint, audit-db-authority clean on each.
- Per-PR "Deployment health" (Post-deploy smoke) fails on every PR: Vercel Deployment Protection answers 401 to the per-commit URL (no bypass configured, by policy). The develop "Trusted deployment health" workflow succeeds.

## 11. Security and financial-integrity review

Independent adversarial reviews on #107, #108, #113 (two rounds). All should-fixes resolved before merge: unlocked revaluation flag, unbounded regeneration, cap undercount (#107); migration order, stats host, non-monotonic block times, large xpubs (#108); reconcile-restart loop draining the shared cap, double budget per step, forward-gap stall, stale checkpoint badge, uncounted evidence calls (#113). Final should-fix (RECOVERY_REQUIRED dead end with the ETH flag on) + failure-specific copy fixed in #114 (751bb38); an audited per-wallet "resume history" Platform Ops action does not exist for any chain yet (library `resume` only) — owner decision. Invariants held: no partial history that looks complete; missing price ⇒ unvalued, never zero; wei integer-exact; no financial classification changes; new readers take a client (no global db).

## 12. API request / cost measurements

- Preview SOL backfill (owner wallet): 37 requests (36 getTransaction + 1 getSignaturesForAddress), ≈1,480 CU, 10.8 s, 0.25 % of the 15,000/day cap.
- ETH (historical measurement): inline FULL rebuild 157 s / 551 requests; incremental ≈4.7 s / 18 requests. Worker steps default to 1,500 probes (`ETH_BACKFILL_PROBE_BUDGET`), estimated ~60 s/step (not measured live).
- No ALCHEMY counter rows on Preview since #107 (no wallet sync has run there since).

## 13. Known limitations and blocked items

- Token history (SPL/ERC-20) not reconstructed on any chain — stated in the UI; needs a token-coverage facet design.
- Price archive limited to CoinGecko's rolling 365 days; older history unvalued.
- **Mobile 375/390/430 not re-verified for this batch**: the method used before (local prod build + throwaway Postgres + CDP) needs Docker and ~3–4 GB RAM; Docker was closed and the owner asked not to overload the 8 GB machine. Changes are CSS-light (one strip, one note line, accordion rows).
- BTC/ETH worker passes not exercised on Preview (flags off).
- Real-asset gaps in §7.
- Preview test account `fm_backfill_qa` (invite `qa_backfill_20261028`) **kept** — it holds the owner's verified SOL history evidence the owner asked to preserve; credentials file `tmp/onboarding-qa/creds2.env` kept (git-ignored, 0600). Owner decides; the guarded deletion SQL pattern is ready.

## 14. Production activation requirements (owner)

1. Promote develop → main (normal release approval).
2. **Apply migration `20261028120000_connection_history_checkpoint` to Production before the code** (`ALTER TABLE "Connection" ADD COLUMN "historyCheckpoint" TEXT;` — additive, nullable).
3. Verify the Alchemy plan of the Production key (Sensitive variable; not readable here).
4. Optionally enable workers with plan-appropriate caps: `SOL_BACKFILL_ENABLED=true`, `SOL_BACKFILL_MAX_RPS`, `SOL_BACKFILL_DAILY_REQUEST_CAP`; then `BTC_BACKFILL_ENABLED`; `ETH_BACKFILL_ENABLED` (#114 merged).

## 15. Rollback

- Code: revert the merge commits on develop (each PR is one merge); Production rollback unchanged (`dpl_GKUMFmtb` per release doc).
- Workers: remove the `*_BACKFILL_ENABLED` variable and redeploy — syncs revert to inline behaviour (pinned by tests); checkpoints and rows are preserved.
- Migration: additive nullable column; safe to leave in place on rollback.

## 16. Exact next release steps

1. Decide whether to add an audited per-wallet "Resume history" Platform Ops operation (all chains) before enabling workers in Production.
2. Owner: decide on the Preview test account; optionally a bounded Preview BTC/ETH worker run (Manual Operations Run Now) with a public address.
3. Owner: confirm Alchemy plan; approve promotion.
4. Apply the Production migration, then promote develop → main; verify Trusted deployment health on Production.
5. Enable `SOL_BACKFILL_ENABLED` on Production with caps; watch Platform Ops History backfill and the ALCHEMY counters for one day; then BTC, then ETH.
