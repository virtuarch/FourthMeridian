# Connections 2.0 + Autonomous Crypto History — CLOSEOUT, ACCEPTANCE & PRODUCTION READINESS (2026-10-30, updated 2026-10-31)

Continues [the 2026-10-28 resume handoff](CONNECTIONS-CRYPTO-HISTORY-RESUME-2026-10-28.md). Every fact was read from git/GitHub at writing time unless marked otherwise.

**PRODUCTION IS UNCHANGED BY THIS WORKSTREAM.** It made no promotion, no Production migration, no Production flag change and no Production data access. Separately, a peer session released the marketing site to Production on 2026-10-30 (`main` `4dda8dc`, PR #128, site and copy only). **No Preview DB writes this session** (§2).

---

## 1. Summary

| | |
|---|---|
| **Code status** | Every planned code item is merged into `develop` with an independent review: #124 (snapshot membership guard), #126 (ETH early origin), #120 (SPL history), #122 (ERC-20 history plus the single valuation model, §3.4), #143 (guard nits) and #144 (SPL probe parity). All new history features are **flag-OFF** everywhere. |
| **Live status** | Live Preview verification of the code merged this session is **NOT DONE**. It is blocked by the un-rotated Preview DB credential (§2). Every "chart-ready" claim stays **unproven** until the §6 runs pass. |
| **Production** | **Not ready to promote.** §7 lists the gates. |

Native blockchain history, token history, historical prices, persisted snapshots and the served chart are distinct things. This report tracks each one separately.

### 1.1 Exactly what is verified and what is not (2026-10-31)

**Verified** (by reading code, tests, CI or Preview health in this session):
- Every merged PR's logic, through independent review, behavioural tests and mutation testing (§3).
- `tsc`, the full test runner and `audit-db-authority` on each merged tree, locally.
- The DB-backed audits, in CI only.
- develop CI, Trusted deployment health and the drift guard for each merge. Each Preview build answers `/api/health` with HTTP 200 HEALTHY through the bypass header.
- That Preview carries no history flags, so none of the new workers run there.

**NOT verified** (each needs the live Preview DB, which waits on the credential rotation in §2):
1. That the regenerated snapshots actually reach about 365 days for the QA Space, and how many days the #124/#143 guards block on real data (R1, including the #143 precheck count).
2. That stored rows are re-stamped correctly on real data: no day with a held unpriced token reads `supported` or shows $0 (R2).
3. Whether the #126 early-origin shortcut fires for the Preview ETH wallet, and the measured call savings (R3).
4. ERC-20 and SPL history, probes, prices and coverage copy end to end against real providers, plus the real `ApiUsageCounter` rows for `ERC20_HISTORY` / `SPL_HISTORY` attempts (R4).
5. The Platform Ops "Resume history" click and the CONTROL-gated Run Now (R5, which also needs the owner's operator session).
6. The mobile Connections layout with token surfaces visible (R6).
7. The served Net Worth chart in a browser.

No Preview DB read or write was made after the single 2026-10-30 read-only state check (§2). §5 is that check's snapshot and has not been re-read.

## 2. Blocker — Preview DB credential incident (owner action)

On 2026-10-30, a read-only connection using the credential leaked on 10-28 **still authenticated**. Two other signs point the same way: the local `tmp/rls-preview-cutover/preview.env` was last modified on 2026-10-06, and Vercel's Preview `DATABASE_URL`/`DIRECT_URL` were last changed 136 days ago.

This session used that credential for exactly one consolidated read-only state check (`psql -1` + `SET TRANSACTION READ ONLY`), and nothing after it. It did not use it for any write.

Rotation steps are in [handoff §11](CONNECTIONS-CRYPTO-HISTORY-RESUME-2026-10-28.md#11-security-incident--preview-database-credential). Until they are done, the bounded harness runs (§6) must not run.

## 3. What merged this session (develop)

| PR | Merge | What | Review | CI / develop gate |
|---|---|---|---|---|
| #123 | `5639c25` | Resume handoff doc | docs only | green |
| #124 | `2482d65` | **P0: snapshot regeneration membership guard.** The guard is now per revoked link and evidence-based, and it fails closed. | Independent financial-correctness review: MERGE. Follow-up `79c9dd9` pins `ManualAssetProfile` immutability with a source scan (mutation-checked). | PR CI green; develop CI, Trusted deployment health and drift guard all `success` |
| #126 | `122d261` | **ETH early-origin proof.** The shortcut is gated on proof-of-signing (K), plus empty state at B (G) and an endpoint check (P). | Independent review: MERGE. Nits fixed in `418e8dc`. | PR CI green; develop CI, Trusted deployment health and drift guard all `success` |
| #120 | `121d7aa` | **SPL / Token-2022 history.** Three blockers and five should-fixes from the 10-28 review, plus a re-review blocker (token licences suppressed native SOL revaluation) and four should-fixes. | Three review rounds; the final delta verification said MERGE. | PR CI green; develop CI, Trusted deployment health and drift guard all `success` |
| #122 | `6adf014` | **ERC-20 history.** Rebased onto #120's price module; B1 (sold tokens silently unvalued), B2 (default-on flag), S1–S5 and N1–N4 fixed. | Independent review: MERGE AFTER FIXES. The owner-ruling delta (`5061d11`, `19b62b3`) was reviewed independently: PASS-WITH-NITS, plus one ruling gap (an unpriced held day could be stored as $0 when the wallet is empty today). That gap, behavioural regeneration tests, interior price-gap disclosure and a reported budget stop were fixed in `5488903` (CI green). The owner-gated independent historical-valuation review of `5488903` returned **BLOCK**: regeneration never re-stamps the status on an already stored row when no value changes. So a pre-existing crypto=$0 row (wallet empty today, unpriced holding in the past), or a native-only row marked "supported", keeps its old verdict. Other findings: the gate wiring was pinned only by a regex (one mutation survived), the copy for a valuation that stops early pointed the wrong way, and SPL price-run stops were not surfaced. Fourteen mutations were run: 12 were caught, one survived, and the other changed no outcome. Fix `7a09f55`: one pure per-day persistence decision (`planDayPersistence`), so a changed verdict is stamped on an estimate row even when no value changes; it never stamps a frozen, manual or absent row. The token decision for each day is now pure (`cryptoTokenDayDecision`), the copy for valuations that stop early is corrected, and SPL now surfaces price stops the same way ERC-20 does. The re-review returned **PASS-WITH-NITS**: 22 mutations, 17 killed. The two that mattered (M10b, the call-site wiring, and M11c, priced excluded tokens joining the total) were sent to a final test-only round before merge. A price-run stop leaves JobRun `succeeded` and puts `outcome: PARTIAL` in the summary. This is by design, since a budget stop is not a failure. Platform Ops does not yet display it (§8). Final round `64d3cf1` killed M10b (verified by re-mutation by the lead) and M11c. The branch was merged with develop (`be7c58a`); on that tree, locally: `tsc` clean and `run-tests` 932/932. | PR CI green on `be7c58a`, including Architecture audits (the DB-backed audits run only in CI: no local Postgres). develop `6adf014`: CI `41080059387`, Trusted deployment health `41080059328` (Preview HTTP 200 HEALTHY, deployed SHA `6adf014`) and drift guard `41080059188` all `success` |
| #143 | `2d99f62` | **History guard nits (#124/#126).** The membership guard now fails closed on two missed exits: a REVOKED link with a null `revokedAt` exits at today, and an ACTIVE link to a trashed account exits at `deletedAt` (pure `membershipExitLinks`, two batched reads). The ETH key proof is bound to this address, the Ethereum network and the writer's normalisation. A dangling doc citation is fixed. | Independent review: MERGE-WITH-NITS. Nit fixed in `db97b13` (address normalisation; a mixed-case test kills the surviving mutation). Mutations killed: null-revokedAt skip, trashed exit dropped, earlier exit overwritten, role-only proof. | PR CI green; locally `tsc` clean, `audit-db-authority` passed, `run-tests` 932/932. develop `2d99f62`: CI `41083856508`, Trusted deployment health `41083856462` (Preview HTTP 200 HEALTHY, deployed SHA `2d99f62`) and drift guard `41083856512` all `success` |
| #144 | `f798ed6` | **SPL first-time quote probe (parity with ERC-20).** The chain-neutral probe logic is extracted to `token-history-probe.ts`; ERC-20 is unchanged (ERC20_HISTORY / coingecko-probe / attempts, the same env names, cap 20, reserve 0.5, 7-day retry). SPL adds a durable daily cap `SPL_HISTORY_PROBE_DAILY_CAP` counted under `SPL_HISTORY` / coingecko-probe / **attempts**, respects the held-token reserve on the TOKEN share, skips never-held mints, and sends no probe if the ledger is unreadable. Thin or unlisted mints become NO_MARKET, never excluded. A swallowed price-step failure on either chain now reports `STEP_FAILED`, which makes the job outcome PARTIAL. | Independent review: MERGE-WITH-NITS (8 mutations). N1 (a silent COMPLETE after a swallowed failure) and N3 (a missing test for reserve rounding) were fixed in `1849dc6`; the lead verified the N1 change. | PR CI green on `c020c12` (develop merged in, including #151 follow-redirects); locally `tsc` clean, `audit-db-authority` passed, `run-tests` 940/940. develop `f798ed6`: CI `41151857813`, Trusted deployment health `41151857761` (Preview HTTP 200 HEALTHY, deployed SHA `f798ed6`) and drift guard `41151857665` all `success` |

The per-PR "Deployment health" check fails on every PR because Vercel Deployment Protection returns 401. That failure is expected. The develop "Trusted deployment health" workflow is the real gate.

### 3.1 #124 — the rule that shipped

Day *d* is blocked iff some REVOKED link has `d < truncUTC(revokedAt)` and that account **could have contributed** to *d*'s stored row. The only accounts with a positive floor are **manual real assets that have valuations**. Their floor is the earliest of:
- the first valuation;
- the link createdAt;
- the account createdAt;
- the earliest transaction;
- the earliest valuation in any currency;
- the acquisition date.

Every other kind has no floor, so it **blocks every earlier day, as before**. That covers banks, cards, investments, crypto, legacy assets, unknown kinds and failed reads.

Why the handoff's link-`createdAt` rule and its wallet position floor were **rejected**: history represents current members back to *their own* evidence floors. In earlier code versions, cash walks back from the current balance, and investments and crypto were held flat at today's quantity. So stored rows can contain a revoked account's value from before its link existed, and before its first position.

Residual risks:
- A Space that revokes a crypto, bank or investment account still needs the amendment system to rewrite earlier days.
- A hard permanent delete removes the link row, so neither the old guard nor the new one protects that account's history. This predates #124.

### 3.2 #126 — what the ETH shortcut does and does not cover

The shortcut is sound only for an address that has **signed a transaction**. A receipt with `from == address` proves the address is key-derived, so no CREATE/CREATE2 can target it.

Receive-only addresses and counterfactual smart-wallet addresses fall back to the full walk.

Estimated saving for the Preview test wallet, from probe math (**not measured**): about 6.9k calls down to about one chunk plus 3. This holds only if that wallet has a signed transaction above its origin.

**Pre-existing gap, not caused by #126 (new item):** the walk's pruning test compares endpoints only. A counterfactual CREATE2 address that is funded and then swept within one transaction can be missed. The pair nets to zero, but coverage would claim COMPLETE. It is rare and low severity, and should be tracked separately.

### 3.3 #120 — known limits that stay

- **750-day per-account staging cap.** An account over the cap keeps its newest 750 days, proven from the first kept day. The mint then reads PARTIAL. Older days are never recoverable.
- **Accounts that never resolve.** A mint whose accounts together need more than 6,000 staged days stays PENDING. It is never shown as complete.
- **Flag toggles.** Any off→on toggle forces a full re-walk, which costs requests.
- **Withdrawal can remove correct rows.** If a later account cannot prove it held zero of a frozen mint, the whole licence is withdrawn. That fails closed and can remove rows that were correct.
- **Spam-farmed wallets.** A full discovery queue resets the token walk, even mid-walk. A spam-farmed wallet's first backfill can therefore burn its small token request limit (LOW).
- **Deferred:**
  - stale rows for sibling mints after a rebuild;
  - the recovery pass runs without the discovery hook;
  - a checkpoint version bump orphans token state;
  - checkpoint size is about 0.6–0.8 MB.

### 3.4 #122 — the valuation model that shipped (native assets + ERC-20 + SPL)

- **Three separate states.** Balance-history completeness ignores prices (`walletHistoryComplete`; the Connections "limited" state is driven by balances only). Price coverage is per token, from RAW_CLOSE rows only, and INTRADAY rows never extend it. Valuation/chart coverage is decided per day.
- **Day rule** (`cryptoTokenDayDecision` → `regenerateDay`). A day is valued only if every held, non-excluded token has a price dated that day or the day before. Otherwise the day is refused or marked `unavailable`, never $0, whatever the wallet holds today. Native assets got the same tightening: a wallet emptied today with an unpriced past holding is refused, where it used to be written as $0.
- **Stored rows** (`planDayPersistence`). A changed verdict is stamped onto an *estimate* row even when no value changes, and a row earns "supported" back when its prices arrive. Frozen, manual and absent rows are never touched.
- **Classification.** "No market" (thin or unlisted) limits and blocks. Only an explicit alias classification that names a source excludes a token, and excluded tokens are counted separately in the copy. **No writer exists yet** (§7 item 8). Never-held tokens are ignored.
- **Coverage states and copy.** `VALUED`, `VALUED_UNTIL_EARLIER` ("later token holdings lack historical prices", with the valued span), `VALUED_WITH_GAPS` ("held days without a price aren't valued"), `NOT_VALUED_YET`, `NO_MARKET`, `NEVER_HELD`.
- **Sold ERC-20 tokens.** A first-time quote probe through the current-quote path. It has a durable daily cap (`ERC20_HISTORY_PROBE_DAILY_CAP`, default 20, counted as `ApiUsageCounter` ERC20_HISTORY / coingecko-probe / **attempts**) and a reserve held back for currently held tokens. An unreadable ledger means no probe. SPL got the same probe in #144 (own cap, `SPL_HISTORY` / attempts).
- **Stops.** Price-run stops (BUDGET_STOPPED / ALLOWANCE_EXHAUSTED / TOKEN_LIMIT, for SPL and ERC-20 alike) set the job summary to `outcome: PARTIAL` with `partialReasons`. JobRun.status stays `succeeded`, because a budget stop is not a failure. An unservable page reaches a terminal state that an operator reset clears.
- **Known limits.**
  - M10b is pinned by an exact source match plus the "BOTH writers" pin. A behavioural kill would need a full regeneration run against a stub database.
  - M22 (the SPL store adapter dropping `status`) is untested at the database adapter.
  - A token whose latest quantity observation is stale contributes nothing and does not block. This is existing, documented behaviour, and it does not arise inside verified token history, which writes a row for every held day.

## 4. Acceptance matrix (2026-10-30)

| Workstream | Implemented | Tests | Live Preview verified | Remaining blocker | Prod ready |
|---|---|---|---|---|---|
| SOL native history | ✅ | ✅ | ✅ blockchain COMPLETE from 2022-03-26 (10-28) | snapshot growth unproven (§6 R1) | No |
| SOL SPL history | ✅ #120 + probe #144 (flag off); valuation shared with #122 | ✅ spl-history 131, spl-history-prices 28 | ❌ | live run (§6 R4) | No |
| BTC history | ✅ | ✅ | ✅ 1,845 tx exact, resume after kill (10-28) | snapshot growth unproven (§6 R1) | No |
| ETH native history | ✅ + early origin #126 | ✅ origin 51, backfill 90 | 🟡 proven to 2019-07-21 (10-28), not COMPLETE | live completion pass (§6 R3) | No |
| ETH ERC-20 history | ✅ #122 (flag off) | ✅ erc20-history 285, token-holdings 149; 22-mutation review | ❌ | live run (§6 R4) | No |
| Current token holdings | ✅ #117 | ✅ | 🟡 13 ERC-20 captured; valuation not inspected | live valuation check | No |
| Autonomous continuation | ✅ | ✅ | ✅ (10-28) | — | Flags off |
| Shared provider budgets | ✅ | ✅ | ✅ (10-28) | Alchemy plan unconfirmed | Owner |
| Historical price backfill | ✅ | ✅ | ✅ 365 d SOL/BTC/ETH (10-28) | CoinGecko Demo terms | Owner |
| **Valuation coverage (owner ruling)** | ✅ #122: balance ≠ price ≠ valuation; unpriced held days refused, never $0; stored rows re-stamped | ✅ behavioural + mutation | ❌ | §6 R1/R2 | No |
| **Snapshot rebuilding** | ✅ **#124** | ✅ 60 new | ❌ **still 32 rows** | **§6 R1** | **No** |
| Served chart data | — | — | ❌ 32 points | §6 R1 + browser check | No |
| Connections progress UX | ✅ | ✅ | ✅ (10-28) | token surfaces not yet seen live | Yes, with workers |
| Mobile UX | ✅ | 🟡 | ✅ 6 widths (10-28) | regression after token UI (§6 R6) | Yes |
| Real assets | ✅ | ✅ | ✅ (10-28) | archive no longer freezes history (#124), proven live only by R1 | After R1 |
| Platform Ops recovery | ✅ #116 | ✅ | ❌ no operator click | owner session (§6 R5) | After R5 |
| Honest status reporting | ✅ | ✅ | ✅ | — | Yes |

## 5. Worker and budget state (read-only, 2026-10-30)

- **No JobRun since 2026-10-28 14:41 UTC.** No JobRun is `running`.
- **Provider usage.** `ApiUsageCounter` shows no ALCHEMY/ESPLORA/COINGECKO usage after 2026-10-28. The 10-28 totals:
  - ETH `eth_getBalance`/`getTransactionCount`/`getCode`: 1,791 each;
  - `eth_getBlockByNumber` 195, `eth_getBlockReceipts` 172;
  - Esplora 85;
  - CoinGecko 5.
- **Preview env.** No `*_BACKFILL_ENABLED` / `*_HISTORY_ENABLED` variables. Re-listed by name on 2026-10-31, values not read: the only related variables present are the budget variables (`SOL_BACKFILL_WALLET_BUDGET_MS`, `_DAILY_REQUEST_CAP`, `_MAX_RPS`) and `WEALTH_REGENERATION_ENABLED`. The last is the snapshot-regeneration switch, not a history worker, and Vercel runs no crons on Preview. None of `SPL_HISTORY_ENABLED`, `ERC20_HISTORY_ENABLED` or the `*_PROBE_*` settings is set, so the probe defaults apply if R4 enables the flags. The develop redeploys this session (#123 onwards) dropped the flags that the 10-28 build had baked in.
- **Preview migrations.** The latest applied is `20261028120000_connection_history_checkpoint`. No PR merged this session adds a migration.
- **QA Space.** 32 SpaceSnapshot rows, from 2026-09-27 to 2026-10-28.

## 6. Live verification runbook (after rotation; Preview only)

Each run is bounded. Runs are spaced at least 5 minutes apart, use the `FM-conn/tmp/live-qa/` harness (handoff §13), and never print environment values.

| # | Run | Pass criterion |
|---|---|---|
| R1 | **Precheck (read-only, #143):** count per Space the ACTIVE links on trashed accounts, and the REVOKED links with a null `revokedAt`. Each one blocks earlier days. Duplicate merges made before 27ef3a8 (10-04) left ACTIVE links on archived losers. Then run `regen-dryrun.ts` for the QA Space from 2025-10-28 (read-only), then one `run.sh run` with `ETH_BACKFILL_ENABLED=false` | The dry run shows **0** `skip-membership-changed` before 2026-10-28. After the run, SpaceSnapshot reaches back to about 2025-10-28 (about 365 rows). In the browser, Net Worth serves about 365 points, with crypto never valued at $0 on unpriced days. |
| R2 | Spot-check three regenerated days against `PositionObservation` × `PriceObservation`, plus every stored row whose `cryptoValuationStatus` changed in R1 | Totals equal the sum of the components, to the cent. No day with a held unpriced token reads `supported` or carries crypto = $0 with a null status. Previously stamped rows are re-stamped `unavailable` where #122's day rule says so. |
| R3 | One bounded ETH pass on #126 code | Either the proof completes, with requests recorded from the ledger and checkpoint, or it walks because the wallet is receive-only. Report which, and the measured calls. |
| R4 | Set `SPL_HISTORY_ENABLED` / `ERC20_HISTORY_ENABLED` on Preview (develop scope), then make bounded passes on the ETH test wallet (13 ERC-20s) and on a public SOL wallet with USDC | Each token is COMPLETE, PARTIAL, UNSUPPORTED or "not valued yet", with an honest reason. Anchors match. No $0 from a missing price. Afterwards, remove the flags and redeploy. |
| R5 | Platform Ops → Providers → Fleet diagnostics → Connections → History recovery → Resume history (the path after PR #135; before #135 it was Providers view → Connection diagnostics card). (Separately, now that PR #131 has merged, a mutating **Jobs → Manual operations → Run Now** of `sol-history-backfill` needs fresh PLATFORM_OPS CONTROL and a structured reason.) | Needs the owner's operator session or explicit approval. Expect audit `WALLET_HISTORY_RESUMED` and one bounded pass. |
| R6 | Connections at 375/390/430/768/1280/1440 (popup technique) once token surfaces are visible | No overflow; token states are honest; PCS-2 holds (no unit counts). |

## 7. Production readiness package — gates before any promotion (owner authorization required for each)

1. **Preview DB password rotated** (§2), and **R1–R4 passed** on Preview.
2. **Production migration first.** `20261028120000_connection_history_checkpoint` must be applied to Production **before** this code is promoted. It is additive, and was applied on Preview on 2026-10-28. Use the `db:migrate:safe` procedure with a backup ([database-safety.md](../operations/database-safety.md)). **`develop` now also carries Session 2's `20261030120000_policy_group_editor`**. Any `develop` → `main` promotion therefore needs every Production-pending migration on `develop` applied first, in order. That migration's readiness belongs to Session 2's report.
3. **Promotion PR** `develop` → `main`. From this workstream it carries #103–#126, #122, #143 and #144, all flag-OFF. It also carries Session 2's Platform Ops 2.0 and policy work, which has its own readiness report. The site-only marketing release on `main` (`4dda8dc`, PR #128) was back-merged into `develop` by PR #130, which changed no files. `main` is therefore an ancestor of `develop`, so the promotion diff contains only `develop`'s own work.
4. **Provider decisions (owner):**
   - **Alchemy plan:** confirm it covers `SOL_BACKFILL_DAILY_REQUEST_CAP` (shared SOL+ETH) at PAYG pricing. The 10-28 ETH day used about 5.7k calls; #126 should cut repeat walks.
   - **CoinGecko Demo:** 10k calls/month, 1-year daily history, attribution required, storage terms unstated. Either confirm the terms or upgrade (paid; owner only).
4a. **Historical valuation coverage — OWNER RULING 2026-10-30 (decided).** Native assets and tokens follow one model, with three things tracked separately: balance-history completeness, price coverage, and valuation/chart coverage.
   - A missing price never marks a balance import incomplete.
   - Charts start at the earliest date with both balance and price coverage.
   - Days inside the plotted window where a materially held asset has no price are marked partial or unavailable.
   - Never: $0 for an unknown price, a silent omission, one earlier price used as coverage for later dates, or complete valuation claimed from balance completeness alone.
   - Disclosure copy: "Balance history verified through [date]" · "Valuation available from [date]" · "Older holdings exist but lack historical prices".
   - Implemented in #122 through shared code, so SPL is covered too.
   - **Clarification (owner, same day):** "no market price" does not mean spam. A verified non-zero held token with no price makes the affected dates partial or unavailable. Tokens are excluded only on an explicit, defensible classification (spam, non-economic, explicitly excluded), and excluded tokens stay visible and distinct from unpriced holdings. Zero-balance-throughout (NEVER_HELD) is not a holding.
5. **Production worker activation**, in order, each with a soak window:
   1. `SOL_BACKFILL_ENABLED`;
   2. `BTC_BACKFILL_ENABLED`;
   3. `ETH_BACKFILL_ENABLED`;
   4. then `SPL_HISTORY_ENABLED` / `ERC20_HISTORY_ENABLED`.

   Each ships with explicit daily caps. `WEALTH_REGENERATION_ENABLED` must be on for snapshot growth.
6. **Rollback:** unset the flags. Workers stop at the next wake and checkpoints persist. Then redeploy the previous Production deployment. The migration is additive and stays.
7. **Not to merge:** #71 and #78 (owner rule).
8. **Owner decision (not blocking): token exclusion source.** Under the clarification, only an explicit classification excludes a held token. The code honours a classification with a source on the token's alias. No writer exists, so today every held token without a price limits valuation; none is ever excluded. Before anything writes a classification, the owner needs to approve which sources count. Options: an operator decision with a reason in Platform Ops, a curated list, or a vendor spam flag. Until then, spam-farmed wallets will show "partial" valuation for airdropped junk. That is honest, but noisy.

## 8. Follow-ups (not blocking the flags-off promotion)

- #124 nits:
  - revoked links with a null `revokedAt` are ignored;
  - an active link to a soft-deleted account is not treated as a membership change;
  - the cited `WEALTH_TIMELINE_AMENDMENT_SYSTEM_PROPOSAL.md` does not exist on develop.
- #126 nits:
  - `ownerSignedIn` should also check the movement's address and network;
  - the ×5 incremental cost margin is thin;
  - no test covers the deadline on the extra probe.
- ETH walk endpoint-only pruning gap (§3.2).
- **Merged-into-winner exits (design, #143 review).** A duplicate-merge loser's link, whether revoked or left ACTIVE on the archived account, is treated as "left the Space", so every earlier day stays blocked (there is no floor for banks or cards). After a merge, the loser's history lives on the winner, so the right model is "merged into the winner" and those days could be regenerated. This needs the amendment system or a merge-aware guard. It is consistent with #124 today: it fails closed and is never wrong, but it can shorten the backfill.
- #120 deferred items (§3.3). (The SPL first-time quote probe is DONE in #144.)
- #144 low items: the allowance read and the attempt record are not atomic, so concurrent runs can overshoot the cap by the number of runs in flight (ERC-20 has the same); the SPL and ERC-20 held reserves are separate env settings, and setting either to 0 lets that chain's probes spend into the held-quote share; closes fetched right after a probe bypass the reserve (≤ ~40/day); expect a steady trickle of SPL probe attempts, because wallets close spam token accounts to reclaim rent, which makes those mints genuinely held.
- Connections nits from 10-28:
  - the 20 px "Explore My Space" target;
  - the relative "Archived today" wording;
  - the ⋯ menu tests are source-regex only;
  - no live second-user isolation check.
- Platform Ops Jobs view: show `sol-history-backfill` runs whose summary has `outcome: PARTIAL` (BUDGET_STOPPED / ALLOWANCE_EXHAUSTED / TOKEN_LIMIT / PRICES_INCOMPLETE) as "completed with limits". JobRun.status stays succeeded|failed. This was handed to Session 2.
- #122 low-severity mutation survivors: M11b, harmless because `regenerateDay` still refuses; and M22, the SPL store adapter dropping `status`, untested at the DB adapter.
- `resolveHistoricalWorkWindow` passes the module `db` into the now-explicit `resolveEvidenceFloor` (`historical-work-window.ts`). The file is on the db-authority baseline, so the audit is satisfied, but the call has only moved up a level.
- Token exclusion classification has no writer yet. An explicit spam/non-economic classification needs an owner-approved source allow-list before anything writes it (§7 item 8).
- STATUS.md beyond §6 is stale: it predates the 10-23 Production cutover and the v2.7 release. It needs a full re-baseline (owner or Claude 1).
