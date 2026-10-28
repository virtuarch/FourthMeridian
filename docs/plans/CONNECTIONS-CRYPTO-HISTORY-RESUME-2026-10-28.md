# Connections 2.0 + Autonomous Crypto History — RESUME HANDOFF (2026-10-28)

Written by Claude 2 at owner-ordered shutdown (~15:10 UTC, 2026-10-28). A fresh session must be able to resume from this file and the repository alone. Every fact below was read from git/GitHub/Preview DB at writing time unless marked *(reported by agent, not re-verified)*.

**PRODUCTION IS UNCHANGED. No promotion, no Production migration, no Production flag changes were made.**

---

## 1. Executive state

**Goal:**
- Connections 2.0: All / Banks / Crypto / Real assets, honest per-connection details, real-asset management.
- Autonomous, budgeted, resumable crypto history for SOL, BTC and ETH, including tokens (SPL, ERC-20).
- Historical price-gap backfill, shared per asset.
- Truthful progress UX.
- Platform Ops recovery.
- Preview verification at mobile and desktop widths.

| Status | Items |
|---|---|
| **Complete and verified (Preview)** | BTC native history live: 1,845 tx, exact Esplora reconciliation, crash/resume. ETH async connect (2.9 s) and bounded worker. Shared 365-day price archive for SOL/BTC/ETH. Connections honesty fixes. Mobile/desktop structural audit at 6 widths. Real-asset lifecycle at 375 px. Worker fairness and metering fixes proven by live symptoms. |
| **Implemented, not fully verified** | #116 Platform Ops "Resume history": not clicked live, needs an owner operator session. #117 token holdings: current capture seen live (13 ERC-20 on the ETH test wallet), valuation not inspected in depth. #119 all-holder price sweep: verified it inserted 692 closes, but snapshots did not grow (see §4). |
| **In progress** | ETH native history (proof walking toward block 4.37 M). ETH early-origin proof (branch pushed, WIP, unreviewed). SPL history #120 review fixes (WIP). |
| **Blocked by correctness issues** | **P0 snapshot regeneration `skip-membership-changed`** (§4): chart-ready history stuck at 32 days. **SPL #120: 3 balance-correctness blockers** (§7). |
| **Not started** | ERC-20 #122 independent review. SPL/ERC-20 live Preview verification. Production readiness package (Phase 12). Final acceptance report. |
| **Deferred / owner decisions** | Owner operator click for Platform Ops recovery. Alchemy plan confirmation. Production activation. Preview DB credential rotation (§11). |

Native blockchain history ≠ token history ≠ historical prices ≠ persisted snapshots ≠ served chart. Each is tracked separately below.

---

## 2. Exact git state

- `origin/develop` = **`6320a845a0adcaa9a94d12272ef85e887b2ff46e`**
- `origin/main` = **`6a1ed44d1e90df15bb15c7830c1639187bb80d86`** (v2.7, untouched)

### Merged PRs

| PR | Merge commit | What |
|---|---|---|
| #103–#115 | various → 0a84049 | Overnight work. See `docs/plans/OVERNIGHT-CONNECTIONS-CRYPTO-HISTORY-REPORT-2026-10-28.md` |
| #116 | a93d644 | Platform Ops audited per-wallet "Resume history" (SOL/BTC/ETH). ETH deadline threading; halve-on-clock-stop. |
| #117 | e3369ea | Token holdings foundation (current SPL/Token-2022/ERC-20 positions, valuation guards, CoinGecko budget) |
| #118 | 989ad0f | Connections honesty + a11y (state-aware History headline, ⋯ menu focus, archive name, restore path copy, stale-holdings headline) |
| #119 | 0a84f67 | Worker fair chain rotation, crash-safe incremental metering, all-holder price-gap sweep |
| #121 | 6320a84 | Drawer re-reads state after a manual wallet refresh |

CI on every merged head: all checks passed except per-PR **"Deployment health"**. That check fails on every PR because Vercel Deployment Protection returns 401; this is expected and not an app failure. The develop "Trusted deployment health" workflow is the real gate.

### Open PRs and branches

| PR / branch | Head | State |
|---|---|---|
| **#120** `feat/spl-token-history` | b9ee3c5 (+ a WIP commit may follow, see §3) | MERGE AFTER FIXES. 3 blockers + 5 should-fixes (§7). Flag `SPL_HISTORY_ENABLED` defaults off. |
| **#122** `feat/erc20-token-history` | 6ad99cb | **Not yet reviewed.** Author reports 108 new checks and 912/912 *(not re-verified)*. Flag `ERC20_HISTORY_ENABLED`. |
| `feat/eth-origin-proof` (no PR) | bf29ffe | WIP, unreviewed. Author reports 36/36 new checks and 912/912 suite *(not re-verified)*. |
| #71, #78 | — | Must NOT be merged (owner rule). |

### Worktrees

All under `/Users/chrstn/dev/`. Their `node_modules` are symlinked to `../FM-plat-v2/node_modules`.

| Worktree | Branch | State |
|---|---|---|
| FM-conn | develop @ 6320a84 | Clean. Contains the git-ignored live-QA harness in `tmp/live-qa/` (§13). |
| FM-spl | feat/spl-token-history | **Had 11 dirty files at writing.** Agent instructed to commit WIP and push; check `git -C FM-spl status` and `git log origin/feat/spl-token-history`. |
| FM-erc20 | feat/erc20-token-history @ 6ad99cb | Clean. |
| FM-ethorigin | feat/eth-origin-proof @ bf29ffe | Pushed. |
| FM-uifix, FM-fix2, FM-fair, FM-tok, FM-opsrec | merged branches | Clean. Can be removed with `git worktree remove`. |
| FM-handoff | docs/connections-crypto-resume-2026-10-28 | This document. |

Uncommitted at risk: only FM-spl, if its agent did not push (see §3).

---

## 3. Agents at shutdown

All agents were background subagents of this session. They do not survive the session, so a new session must not wait for them.

| Agent task | Worktree / branch | Last verified result | Safe to stop |
|---|---|---|---|
| ETH early-origin proof | FM-ethorigin / feat/eth-origin-proof | Pushed bf29ffe. Reports tsc ok, 912/912, origin test 36/36, about 90% probe reduction in tests *(measured in fake-provider tests, not live)*. The inline sync path (`eth-history-sync.ts`) still walks the full window. | Yes (done) |
| SPL review fixes | FM-spl / feat/spl-token-history | Was running tsc + suite + audits under the heavy lock at shutdown. Told to commit "WIP …" and push. **Verify on resume.** | Yes once pushed. If not pushed, the dirty files in FM-spl are the only copy. |
| ERC-20 history | FM-erc20 / #122 | Finished. PR open. | Yes |
| Token foundation, ops recovery, fairness, reviewers | — | Finished; their PRs are merged. | Yes |

---

## 4. P0 — Snapshot regeneration `skip-membership-changed`

**Symptom.** QA Space `cmvrmtwtr0005gwismmsgwdlx` ("Robin's Space", PERSONAL, created 2026-10-28 04:46 UTC) has only **32 SpaceSnapshot rows, 2026-09-27 → 2026-10-28**. This is despite:
- SOL native coverage COMPLETE from 2022-03-26 (1,679 daily rows);
- BTC COMPLETE from 2013-10-02 (4,775 rows);
- SOL/BTC/ETH RAW_CLOSE prices for 365 days (2025-10-28 → 2026-10-27).

**Planner evidence.** A read-only probe (`tmp/live-qa/regen-dryrun.ts`) ran `resolveHistoricalWorkWindow` for SOL with impacted-from 2025-10-28. It returned:

```
{"fromDate":"2025-10-28","toDate":"2026-10-27","mode":"initial-full","reasons":["evidence reaches 2022-03-26","provider prices reach only 2025-10-28 — the binding constraint","initial build — taking the whole supportable interval"],"providerFloor":"2025-10-28","evidenceFloor":"2022-03-26"}
```

So the planner is correct. Then `regenerateWealthHistory({spaceId, fromDate:"2025-10-28", dryRun:true})` gave all **365 days → `action: "skip-membership-changed"`**.

**Code path.** In `lib/snapshots/regenerate-history.ts`:
- around line 795, `revokedDates` = every `SpaceAccountLink` of the Space with `status = REVOKED` and `revokedAt` not null, mapped to `truncDateUTC(revokedAt)`;
- around line 1158, the per-day guard `membershipChangedSince: revokedDates.some((r) => r.getTime() > d.getTime())`;
- the decision lives in `regenerate-history.core.ts` ("MEMBERSHIP CHANGED" guard), and the rationale in `docs/initiatives/wealth-timeline/WEALTH_TIMELINE_AMENDMENT_SYSTEM_PROPOSAL.md` §9.

**Membership evidence** (read-only query on `SpaceAccountLink` for that Space):

| Link | Account | Status | Created | revokedAt |
|---|---|---|---|---|
| cmvrnogza… | Owner SOL (backfill test) | ACTIVE | 2026-10-28 | — |
| **cmvrs9t9z…** | **QA Test Car (renamed)** (manual real asset, overnight QA) | **REVOKED** | **2026-10-28** | **2026-10-28 07:22:04 UTC** |
| cmvs4b1ie… | BTC paging test | ACTIVE | 2026-10-28 | — |
| cmvs4ivaq… | ETH async test | ACTIVE | 2026-10-28 | — |
| cmvs57g6p… | QA mobile test car (renamed) | ACTIVE (archived + restored today) | 2026-10-28 | — |

The 32 existing rows were written at about 05:16 UTC, *before* the 07:22 revocation.

**Defect.** The guard is Space-wide and date-only. One revocation today blocks regeneration of every earlier day, for every account. That includes days the revoked account was never a member: its link was created the same day, and it had no value history before. So after any archive or removal, a Space can never grow its history again.

**Safety invariant to keep.** Never rewrite a historical day without the contribution of an account that genuinely belonged to the Space on that day. Regeneration only queries currently ACTIVE links, so a rewrite would silently drop a removed member's real contribution.

**Proposed safe fix** (needs review; do not just delete the guard):
1. Make the guard per revoked link, using its membership interval. Day `d` is blocked only if some revoked link has `link.createdAt ≤ end-of-d` and `revokedAt > d`, meaning the revoked account was a member on `d`.
2. Tighten further: block only if the revoked account also had evidence on or before `d`. That evidence is its earliest dated valuation, position or transaction (a manual asset's first valuation date; a wallet's licensed-from). A member with no value that day contributed nothing that could be lost.
3. Keep blocking days where a revoked member did contribute. Those days need the amendment system, not automatic regeneration.

Tests to add:
- the revoke-same-day-as-created case;
- a revoked account with an earlier valuation (must still block);
- a revoked-then-restored account;
- a multi-member shared Space.

**Risk of getting it wrong.**
- Retroactively excluding a real past member understates history.
- Including accounts for periods they weren't linked is a separate, existing semantic. History represents current members' evidence back to their own evidence floors, and this fix must not change it.
- Review with the financial-correctness lens. This touches the frozen-row/amendment area, so Claude 1 or the owner may need to sign off.

**Repro (read-only).**

```
cd /Users/chrstn/dev/FM-conn
# set DATABASE_URL from tmp/rls-preview-cutover/preview.env and COINGECKO_API_KEY (see §13)
npx tsx --require ./scripts/lib/server-only-preload.cjs tmp/live-qa/regen-dryrun.ts cmvrnogys000665qfawpb8sa6 cmvrmtwtr0005gwismmsgwdlx 2025-10-28 2025-10-28
```

Also: `skippedMembershipChanged` counts in the regeneration result.

**Served chart today.** Net Worth starts Sep 28, 2026 at 1M, with 32 points. The real-asset contribution is correct: the 2026-10-28 snapshot = crypto $26,745.29 + asset $13,500 = $40,245.29.

---

## 5. Bitcoin live proof (Preview)

- **Wallet:** public address 1F1tAa…4xqX, linked to the QA account. Connection `cmvs4b1ji000dl2o6lvmnirot`, account `cmvs4b1hx0007l2o6szcym4t5`.
- **Connect:** `/api/accounts/wallet` took 15.9 s, the bounded inline sync. Current balance 0.33061617 BTC, exactly matching Esplora. The UI showed "History queued" and the importing strip.
- **Worker:** the real `dispatchDueJobs` restricted to `sol-history-backfill`, plus `runJob`, from a local harness against the Preview DB (Preview has no crons; this is the controlled test trigger).
  - Passes processed 100, then 399 / 224 / 297 / 27 transactions.
  - **SIGKILL mid-pass test:** the JobRun stayed `running`. The next dispatch finalized it as `failed/stale` and resumed exactly from 100 to 499, with no duplicates.
- **COMPLETE at 13:37:56 UTC:**
  - tx 1,845 = Esplora `chain_stats.tx_count` 1,845;
  - funded 2,967,967,069,393 and spent 2,967,934,007,776 sats, identical to Esplora;
  - reconstructed balance 0.33061617 BTC;
  - PositionCoverage COMPLETE 2013-10-02 → 2026-10-27, source `esplora:txs-chain+chain-stats`;
  - **4,775 daily PositionObservation rows** (2013-10-02 → 2026-10-28).
- **Requests:** 85 Esplora requests (txs 76, tip 8, stats 1). The ledger and checkpoint agree. The killed pass's requests were *not* metered (defect, fixed by #119 incremental metering).
- **Chart-ready USD:** BTC prices from 2025-10-28. **Snapshots NOT extended** (the §4 blocker). BTC regeneration ran in the 14:21 run (before the sweep inserted prices), and the regeneration owed afterwards is blocked by §4.

## 6. Ethereum live proof and early-origin

- **Wallet:** public EOA 0xba7e…1730. Connection `cmvs4ivc500tnl2o60pyvt1dx`, account `cmvs4iv9a00thl2o69sphdj7q`. First on-chain activity is block 21,736,759 (2025-01-30).
- **Connect:** **2.9 s** with no synchronous rebuild. Current holdings 0.003234852… ETH, in the position spine. `FinancialAccount.balance` stays 0 by design (see the `eth-sync.ts` header).
- **Worker:**
  - Pre-#116 code ignored the deadline: one pass took **322 s**, over the 260 s wake bound and the 300 s Vercel maxDuration. This was a live repro, since fixed.
  - After #116, passes take about 117 s.
  - Before #119, ETH starved behind BTC (75 s reserve vs a 120 s job). Live repro, fixed by #119 rotation.
- **Checkpoint at shutdown:**
  - provenFromISO **2019-07-21** (block 8,191,536), anchor block 26,291,536;
  - 119 movements; reachedFloor false; 0 failures;
  - **5,740 Alchemy requests** today in checkpoint usage;
  - the ledger shows eth_getBalance/getTransactionCount/getCode 1,791 each, getBlockByNumber 195, getBlockReceipts 172.
- **The waste.** The resumable proof calls `acquireEthHistory(fromBlock: EARLIEST_PROVABLE_BLOCK = 4,370,000)` (`lib/crypto/eth-history-backfill.ts:168`). It walks to Byzantium even though the wallet was empty before Jan 2025. Proof cost is about 1.8 requests per 1,000 blocks.
- **Fix:** branch `feat/eth-origin-proof` @ bf29ffe (WIP, unreviewed). Its rule: nonce 0 ∧ balance 0 ∧ no code at a proven boundary ⇒ no earlier native history. That holds because spending needs a signed tx (nonce++), and EIP-7702 delegation also increments the nonce. The proof then jumps to the window start with the full walk's result.
  - Reported savings: about 90% **in tests** (fake provider). **Not measured live.**
  - The inline sync path is not covered.
- **Remaining:**
  - independent review;
  - apply to `eth-history-sync.ts`;
  - one bounded live pass expecting immediate completion;
  - verify coverage starts at the first movement;
  - **ETH remains not COMPLETE.**

## 7. Solana and token history

**SOL native** (owner's public wallet 9nPL…ijER, QA account; connection `cmvrnoh0k000c65qfe7hmxvyn`, account `cmvrnogys000665qfawpb8sa6`):
- COMPLETE 2022-03-26 → 2026-10-28, source `solana-rpc+chain-continuity`, 1,679 daily rows.
- Checkpoint is on `Connection.cursor`; readers must use `isSolBackfillCursor`.
- Prices from 2025-10-28.
- Pending revaluation from 2025-10-28, blocked by §4.
- No SPL holdings (`getTokenAccountsByOwner` found none).

**Token holdings foundation, #117 (merged):**
- **Capture:** current SPL, Token-2022 and ERC-20 positions (`source "wallet-token"`), identity via CAIP-19 `InstrumentAlias`, one Instrument per token shared across customers.
- **Valuation eligibility:** priced tokens only; unpriced tokens are never zero.
  - CoinGecko daily cap `COINGECKO_DAILY_CALL_CAP` (default 250), with tokens limited to `COINGECKO_TOKEN_SHARE` 0.6.
  - Native quotes are deduped at 30 min.
  - 24 h unlisted/thin memory.
  - Thin-market floor: volume ≥ $10k; market cap ≥ $1M when known.
- **Sold tokens:** an explicit zero closes the position; a token is valued only on its own fresh observation.
- **Exclusions:** readers (Holdings, AI context, export) exclude tokens (`NOT_TOKEN_INSTRUMENT`), so no spam names reach the LLM. Connections shows no quantities (PCS-2).
- **Snapshot consistency:** one day rule (`token-valuation.core`) for live and regenerated days, plus a chart note that tokens are included from when tracking began.
- **Live:** the ETH test wallet holds 13 ERC-20s captured with current balance only. The live valuation result was not inspected.

**SPL history, #120 (open; flag `SPL_HISTORY_ENABLED` default off).** Three blockers from review, each required before merge:
1. **Account cap:** accounts past `MAX_TRACKED_ACCOUNTS` (48) only bump `overflow` (`spl-history.core.ts:503-506`), and `decideMint` ignores them. A mint can then read COMPLETE while missing an account. The native discovery hook also merges without priced-first ordering.
2. **Flag toggle:** a flag off→on toggle can make discovery falsely complete. The hook is installed only while the flag is on, and `discoveryComplete` trusts native `reachedBeginning`.
3. **Trimmed day lists:** after commit (`spl-history.ts:480`), a later backward rewrite (`markChanged`/`spanFrom` 423/468-474) can overwrite proven rows with wrong sums.

Should-fixes:
- an unknown program is treated as extension-OK (core:518);
- token-only work starves native work and has no backoff (`sol-backfill-worker.core.ts:78-86`);
- no request cap on the sync path (`wallet-history-refresh.ts:147`);
- checkpoint JSON growth inside `Connection.cursor`;
- a frozen licence still reads COMPLETE (`spl-history.ts:455`).

Nits: a "complete as far as discoverable" caveat; price coverage marker recorded as wider than what was returned.

The fix agent was mid-way at shutdown (WIP commit expected). Check `git log origin/feat/spl-token-history` and per-finding status in the WIP commit message / PR comment.

**ERC-20 history, #122 (open; flag `ERC20_HISTORY_ENABLED`; runs inside the ETH phase).** Author-reported, not re-verified:
- **Reconciliation:** transfers by `alchemy_getAssetTransfers` (raw hex BigInt), deduped by uniqueId.
- **Anchors:** `balanceOf` at (first-transfer − 1 must be 0), last block of up to 6 active months, and the finalized head. Every anchor must match exactly.
- **Unsupported tokens:** a mismatch makes the token UNSUPPORTED with a reason, writes no rows (earlier rows are deleted), and keeps the evidence count.
- **Checkpoint:** a token section in `Connection.historyCheckpoint`.
- **Budget:** ≤ 120 calls per step, 8 tokens per step, priced first.
- **Readers:** 5 readers were fixed to exclude tokens.
- **Limitations:** anchors are sampled (a mismatch between anchors that cancels out is undetectable), UNSUPPORTED is final, and prices cover 365 d.
- **Remaining:** **an independent review has not started.** Rebase if #120 merges first; both wire the token-price seam.

## 8. Worker and provider architecture

- **One job:** `sol-history-backfill` (`jobs/sol-history-backfill.ts`, registry hourly at :30, `selfContinues` +15 min while `summary.deferred > 0`). It runs SOL, BTC and ETH passes with a rotation persisted in `JobRun.summary.schedule` (#119). Every chain with work steps within 3 runs.
- **Flags** (names only):
  - `SOL_BACKFILL_ENABLED`. The job is gated on it, so BTC and ETH need it too.
  - `BTC_BACKFILL_ENABLED`.
  - `ETH_BACKFILL_ENABLED`.
  - `SPL_HISTORY_ENABLED` and `ERC20_HISTORY_ENABLED` (in the open PRs).
  - `WALLET_TOKEN_CAPTURE_ENABLED` (default on).
  - `WEALTH_REGENERATION_ENABLED`.
- **Budgets and tuning:**
  - `SOL_BACKFILL_DAILY_REQUEST_CAP` (shared Alchemy cap for SOL + ETH), `SOL_BACKFILL_MAX_RPS`, `SOL_BACKFILL_WALLET_BUDGET_MS`, `SOL_BACKFILL_JOB_BUDGET_MS` (120 s);
  - `BTC_BACKFILL_DAILY_REQUEST_CAP` (Esplora), `BTC_BACKFILL_MAX_RPS`, `BTC_BACKFILL_WALLET_BUDGET_MS`;
  - `ETH_BACKFILL_START_RESERVE_MS` (75 s, clamped), `ETH_BACKFILL_PROBES_PER_SECOND` (25);
  - `COINGECKO_DAILY_CALL_CAP`, `COINGECKO_TOKEN_SHARE`, `COINGECKO_NATIVE_QUOTE_FRESH_MINUTES`, `WALLET_TOKEN_QUOTE_DEADLINE_MS`.
  - Wake bound `WAKE_SAFE_MS` 260 s.
- **Shared ledger:** `ApiUsageCounter` (provider, metric, unit, day, count) for ALCHEMY, ESPLORA and COINGECKO. Incremental flush every 100 calls or 10 s (#119).
- **Price gaps:** a per-run all-holder sweep (≤ 5 instruments, once per instrument/floor/day) acquires into the shared `PriceObservation`. Holders are flagged or revalued through pending markers. §4 blocks the snapshot effect.
- **Recovery:** Platform Ops → Providers → Connection Diagnostics → History recovery.
  - Route `GET/POST /api/platform/platform-ops/connections/[id]/history-resume`, fresh CONTROL on PLATFORM_OPS, audit `WALLET_HISTORY_RESUMED`.
  - Only RECOVERY_REQUIRED/FAILED, and the chain flag must be on.
  - Bounded one pass, no reset.
- **Flag states at shutdown:**
  - **Preview:** the env vars `SOL/BTC/ETH_BACKFILL_ENABLED` were **removed** from Preview (develop) at about 15:05 UTC. The *currently deployed* Preview build (develop 6320a84, built 17:23 local = 14:23 UTC) still has them in its baked env until the next deploy. Nothing invokes the worker on Preview (no crons, no harness running), so there are no writes.
  - **Production:** none of these flags are set; Production is unchanged.
- **Known issues:**
  - Concurrent syncs can overshoot a budget by one allotment (recheck, not reservation).
  - A halved ETH chunk never grows back (nit).
  - Holders are revalued without the sync lock (matches existing `sync-crypto`).
  - CoinGecko Demo: **10,000 calls/month, about 30–100/min, 1 year of daily history, attribution required**. Storage terms are not stated, so owner to confirm.

## 9. Connections and mobile

**Verified on Preview with the QA user, via a script-opened popup** (an injected button plus a real click gives a true 375 px viewport). DOM audit from the opener at **375 / 390 / 430 / 768** in the popup and **1280 / 1440** in the main window:
- no horizontal overflow, no clipped controls, no unlabelled buttons;
- category tabs and counts correct;
- filtering and empty states specific;
- detail sheet is a labelled modal with focus inside and Overview/Health/History tabs;
- Escape closes it and focus is restored;
- ⋯ menus are in view and hittable;
- Add wallet / Add asset dialogs fit.

Additional checks:
- **Customer menus:** only Disconnect (wallet) / Refresh (Plaid). No "Restore Financial Intelligence".
- **Real-asset lifecycle at 375:** add → list → open → rename → same-day revaluation, which keeps one value ("corrected (1 earlier entry kept)", no duplicate) → History and Activity → archive → restore from Settings → Data & Privacy → Archive & Trash → back with the renamed name and full activity log. The Net Worth contribution is correct.

Fixed (#118, #121):
- the History headline for queued imports read as a failure;
- ⋯ menu focus;
- the archive list showed the pre-rename name;
- the restore path copy was wrong;
- the stale-holdings Health headline;
- the drawer didn't refetch after Refresh.

Remaining:
- the "Explore My Space →" link is a 20 px touch target (nit);
- the archive page uses relative "Archived today" (Settings, out of scope);
- the ⋯ menu tests are source-regex;
- the ownership-isolation check was code/RLS-suite only, not live with a second user.

## 10. Preview DB and test data (PRESERVE; do not delete)

- **QA user:** `fm_backfill_qa`, id `cmvrmtwt10004gwisnszyhzva` (invite `qa_backfill_20261028`).
  - Creds in `tmp/onboarding-qa/creds2.env` in the main worktree; git-ignored, 0600.
  - The Chrome profile was signed in as this user.
- **Space:** `cmvrmtwtr0005gwismmsgwdlx`.
- **Wallets:** SOL `cmvrnoh0k000c65qfe7hmxvyn`, BTC `cmvs4b1ji000dl2o6lvmnirot`, ETH `cmvs4ivc500tnl2o60pyvt1dx`.
- **Real assets:** "QA mobile test car (renamed)" active ($13,500). "QA Test Car (renamed)" archived; its REVOKED link is the §4 trigger, so keep it as the reproduction.
- **Preview migrations:** the latest applied is `20261028120000_connection_history_checkpoint`. No newer migrations exist in the merged or open PRs (all reported "no migration").
- **Production:** that migration must be applied **before** promoting this code.

## 11. Security incident — Preview database credential

- **What:** the Preview Supabase project (`lqagrryecvhbaqvczjgc`) database password, i.e. the password inside `DATABASE_URL` / `DIRECT_URL` for the `postgres` owner role via the Supavisor pooler.
- **Where:**
  - it was printed twice in Claude tool output during this session, while parsing `tmp/rls-preview-cutover/preview.env`;
  - it is visible in the local session transcript (`~/.claude/projects/-Users-chrstn-dev-FourthMeridian/*.jsonl`) and possibly the terminal scrollback.
  - It was **not** written to any commit, PR, doc or chat message body.
- **Status:** still active (not rotated).
- **Rotation (owner):**
  1. Supabase dashboard → Preview project → Database → reset the password.
  2. Update `tmp/rls-preview-cutover/preview.env` (local, git-ignored).
  3. Update the Vercel Preview env vars that embed this role: `DATABASE_URL`, `DIRECT_URL`, and any `DATABASE_URL_*` using the owner role (`DATABASE_URL_APP/AUTH/SYSTEM` use separate roles, so check each).
  4. Redeploy Preview.
  5. Verify: a read-only `psql -1 … SET TRANSACTION READ ONLY` connects, and the Preview app loads.
  6. Consider purging the transcript copies.
- Treat rotation as **required before further sensitive operations**. Do not rotate automatically.

## 12. Resumption order

**P0, serial where noted:**
1. Confirm the credential rotation (§11), and update `preview.env` before any harness use.
2. Recover the SPL WIP state (`FM-spl`) and push it if needed.
3. §4 membership-guard fix, as its own PR with a financial-correctness review. Then a bounded harness run: expect QA Space snapshots from 2025-10-28 and the chart API showing about 365 points. **This gates every "chart-ready" claim.**
4. Finish the #120 blockers 1–3 plus should-fixes, then re-review.
5. Independent review of #122. This can run in parallel with 3 and 4.

**P1:**
6. Review the ETH early-origin branch, extend it to `eth-history-sync.ts`, open a PR, and merge. Then one bounded live pass: expect completion, and report measured savings.
7. Live SPL/ERC-20 verification: flags on Preview only, bounded, using the ERC-20 test wallet's 13 tokens. For SPL, pick a public wallet with a few hundred signatures and USDC.
8. Platform Ops Resume live click. Needs the owner's operator session or explicit approval.
9. Mobile/Connections regression after the token UIs land.

**P2:**
10. Production readiness package (Phase 12 list in the owner's closeout directive).
11. Final acceptance report.

**Parallelism:** 3 ∥ 4 ∥ 5 ∥ 6 are code-independent. 4 and 6 both touch SOL/ETH backfill files, so merge sequentially and rebase. Live verification (7) needs 3, 4, 5 and 6 merged.

## 13. Commands

Read-only unless marked **[WRITES PREVIEW]**. Never print env values.

```bash
# repo / PRs / CI
cd /Users/chrstn/dev/FourthMeridian && git fetch origin && git log --oneline -1 origin/develop
gh pr list --state open --json number,title,headRefOid
gh pr checks 120; gh pr checks 122
git -C /Users/chrstn/dev/FM-spl status --short; git -C /Users/chrstn/dev/FM-spl log --oneline -3

# tests (Node 24; single files need no lock)
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/spl-history.test.ts
# heavy (take the lock first: mkdir /private/tmp/claude-501/-Users-chrstn-dev-FourthMeridian/ea350dbc-6e74-4cd6-b6a1-288412dc4bc5/scratchpad/locks/heavy)
npx tsc --noEmit -p tsconfig.json
TEST_FILE_TIMEOUT_MS=400000 npx tsx scripts/run-tests.ts
npx tsx scripts/run-audits.ts      # DB-backed audits need DATABASE_URL; CI runs them

# Preview read-only SQL helper (reads DIRECT_URL from preview.env, redacts errors)
/Users/chrstn/dev/FM-conn/tmp/live-qa/q.sh "select count(*), min(date), max(date) from \"SpaceSnapshot\" where \"spaceId\"='cmvrmtwtr0005gwismmsgwdlx';"
/Users/chrstn/dev/FM-conn/tmp/live-qa/q.sh "select provider, metric, count from \"ApiUsageCounter\" where day=current_date and provider in ('ALCHEMY','ESPLORA','COINGECKO');"
/Users/chrstn/dev/FM-conn/tmp/live-qa/q.sh "select f.name, pc.kind, pc.\"coveredFromDate\", pc.\"coveredToDate\" from \"PositionCoverage\" pc join \"FinancialAccount\" f on f.id=pc.\"financialAccountId\" where f.\"ownerUserId\"='cmvrmtwt10004gwisnszyhzva';"

# [WRITES PREVIEW] bounded worker pass (real job code vs Preview DB, local dev Alchemy/CoinGecko keys,
# caps set inside run.sh). Space runs >= 5 min apart (wake budget = earliest JobRun in last 5 min).
/Users/chrstn/dev/FM-conn/tmp/live-qa/run.sh run            # runJob
/Users/chrstn/dev/FM-conn/tmp/live-qa/run.sh dispatch       # real dispatcher (due-selection)
# extra env: e.g. ETH_BACKFILL_ENABLED=false  BTC_BACKFILL_WALLET_BUDGET_MS=8000

# [WRITES PREVIEW ENV] flags for deployed-app lifecycle tests; remove + redeploy afterwards
printf true | vercel env add SOL_BACKFILL_ENABLED preview develop   # same for BTC_/ETH_
vercel env rm SOL_BACKFILL_ENABLED preview develop --yes

# deployed Preview check (Chrome profile has Vercel SSO; app login = QA user)
#   https://preview-app.fourthmeridian.com/dashboard/connections
#   true mobile width: inject a button that window.open(url,'x','popup,width=375,height=812') and click it for real
```

The harness files (`run.sh`, `worker-harness.ts`, `q.sh`, `regen-dryrun.ts`, `pricegap-dryrun.ts`) live in git-ignored `FM-conn/tmp/live-qa/`. If missing, recreate them from these descriptions:
- `worker-harness.ts` = `dispatchDueJobs(now,{jobs: SCHEDULED_JOBS.filter(name==="sol-history-backfill")})` or `runJob(name, body, {trigger:"script"})`.

## 14. Production boundaries

Each of the following requires separate owner authorization:
- promotion to main;
- Production migrations (`20261028120000_connection_history_checkpoint` must precede promotion);
- Production worker activation (order SOL → BTC → ETH; then SPL/ERC-20 after review);
- paid vendor upgrades;
- destructive customer-data operations;
- security bypasses (never disable deployment protection or expose the bypass secret).

Also: never merge #71 or #78, and don't change login DB privileges.

## 15. Acceptance matrix (at shutdown)

| Workstream | Implemented | Tests | Live Preview verified | Remaining blocker | Prod ready |
|---|---|---|---|---|---|
| SOL native history | ✅ | ✅ | ✅ blockchain COMPLETE 2022-03-26 | snapshots blocked (§4) | No (§4) |
| SOL SPL history | 🟡 #120 | ✅ 64 (pre-fix) | ❌ | 3 blockers | No |
| BTC history | ✅ | ✅ | ✅ 1,845 tx exact, resume after kill | snapshots blocked (§4) | No (§4) |
| ETH native history | ✅ async + bounded | ✅ | 🟡 proven to 2019-07-21, not COMPLETE | early-origin unreviewed; cost | No |
| ETH ERC-20 history | 🟡 #122 | reported 108 | ❌ | review not started | No |
| Current token holdings | ✅ #117 | ✅ | 🟡 13 ERC-20 captured; valuation not inspected | — | Needs live valuation check |
| Autonomous continuation | ✅ | ✅ | ✅ dispatcher self-continuation, stale-claim recovery | — | Flags off |
| Shared provider budgets | ✅ | ✅ | ✅ ledger = checkpoint (85 Esplora; ETH 5,740) | Alchemy plan unconfirmed | Owner |
| Historical price backfill | ✅ | ✅ | ✅ 365 d SOL/BTC/ETH, shared | CoinGecko Demo terms | Owner |
| Snapshot rebuilding | 🟡 | ✅ | ❌ **32 days only** | **§4 membership guard** | **No** |
| Served chart data | — | — | ❌ 32 points from Sep 27/28, 2026 | §4 | No |
| Connections progress UX | ✅ | ✅ | ✅ | — | Yes (with workers) |
| Mobile UX | ✅ | 🟡 | ✅ 6 widths structural | minor nits | Yes |
| Real assets | ✅ | ✅ | ✅ full lifecycle at 375 px | archive triggers §4 | After §4 |
| Platform Ops recovery | ✅ #116 | ✅ 89 + 22 route | ❌ no operator click | owner session | After live check |
| Honest status reporting | ✅ | ✅ | ✅ | — | Yes |

## 16. Restart checklist (first ten actions)

1. Read this file, then `docs/plans/OVERNIGHT-CONNECTIONS-CRYPTO-HISTORY-REPORT-2026-10-28.md`.
2. `git fetch` and confirm develop = 6320a84 (or newer), main = 6a1ed44, and that open PRs #120/#122 exist.
3. Check `FM-spl` for uncommitted changes. If any, commit them as WIP and push; read the WIP commit's per-finding status.
4. Confirm with the owner that the Preview DB password was rotated (§11). Update `preview.env` locally; never print it.
5. Confirm the Preview env has no `*_BACKFILL_ENABLED` (`vercel env ls preview | grep BACKFILL`), and that no harness or worker processes run (`pgrep -fl worker-harness`).
6. Write the §4 fix (membership-interval guard, plus account-evidence refinement) with tests, in a new worktree off develop. Get an independent financial-correctness review.
7. Launch the #122 review and the #120 blocker fixes in parallel (≤ 2–3 agents; 8 GB machine; heavy lock).
8. After the §4 merge: one bounded harness pass (`run.sh run ETH_BACKFILL_ENABLED=false`, 5-min spacing). Verify QA Space snapshots from 2025-10-28 and the served chart point count in the browser.
9. Review, finish and merge the ETH early-origin work. Then one bounded ETH pass: expect COMPLETE, and record measured requests.
10. Live SPL/ERC-20 verification, then the Production readiness package and final acceptance report. No Production changes without the owner.
