# Investigation — Daily Report / Snapshot Intelligence: Conflicting Net Worth Insights

**Date:** 2026-07-08
**Status:** Investigation only. No code, schema, migration, or UI changes made.
**Symptom:** "Today's Insight" says *"Net worth is up 442.1% over the last 34 days — $6.9K total. Stay consistent."* while "Needs Attention" says net worth is **down** over 34 days. The user reports the actual decrease happened over **1 day** and came from **investment balance movement**.
**Scope boundary:** Separate from TI4 / Transaction Relationship work. No overlap intended or found.

---

## 1. Executive summary

The Daily Report is internally consistent per Space but incoherent across Spaces, and its time language is wrong by construction.

- **"34 days" is not a time window.** It is `snapshotCount` — the number of `SpaceSnapshot` rows the Space has (capped at 90) — formatted into the sentence "over N days" in two independent places. Rows are only written when a refresh-type event occurs, so the count is neither a calendar span nor a chosen window; it is "how many days this Space happened to get snapshotted since it was created."
- **The contradiction is cross-Space signal aggregation without attribution.** The snapshot signal detector guarantees *exactly one* of `NET_WORTH_INCREASED` / `NET_WORTH_DECLINED` fires **per Space**, never both. The brief route then merges signals from **all** eligible Spaces: the insight card renders the primary (personal) Space's positive trend, while the attention card renders another Space's negative trend — with no Space name on either. Same account set shared into two Spaces → two "truths" on one screen. This is the same aggregation pattern that produced the inflated "Accounts tracked: 44" bug (`docs/INVESTIGATION_DAILY_BRIEF_ACCOUNTS_TRACKED.md`).
- **The +442.1% is a baseline artifact.** Trend = (latest − oldest) / |oldest| over the *entire* snapshot history. The oldest row is the Space's day-one snapshot, taken when it held almost nothing; accounts linked later read as "growth."
- **The engine cannot attribute cause.** Net worth is purely balance-derived (`FinancialAccount.balance` → `classifyAccounts` → `SpaceSnapshot`); transaction analysis lives in a separate 30-day summary domain. Nothing connects a net-worth delta to spending, deposits, or market movement — even though `SpaceSnapshot` already stores `stocks`/`crypto`/`cash`/`savings`/`debt` per day, so "the drop was investments" is computable from existing data. It just isn't computed.
- **Smallest honest fix:** scope net-worth trend cards to the primary Space only, label windows with real dates (or fixed 1-day/30-day windows), guard against near-zero baselines, and (optionally, cheap) attribute the day-over-day delta to the snapshot category that moved. No schema changes required.

---

## 2. Current data flow

```
UI     components/brief/DailyBriefClient.tsx        — dumb renderer of BriefPayload sections
API    app/api/brief/route.ts (GET /api/brief)      — assembles sections
         ├─ buildContext(spaceId, userId, {scopeHint:'brief'}) per eligible Space (OWNER/ADMIN/MEMBER)
         │    ├─ accounts domain        lib/ai/assemblers/accounts.ts     — LIVE FinancialAccount balances → classifyAccounts
         │    ├─ snapshot_history       lib/ai/assemblers/snapshot.ts     — last ≤90 SpaceSnapshot rows; trend = latest − oldest
         │    └─ transactions_summary   lib/ai/assemblers/transactions.ts — fixed 30-day window in brief scope
         ├─ signals per Space           lib/ai/signals/detectors/*.ts
         │    └─ snapshot.ts emits ONE of NET_WORTH_INCREASED (info) / NET_WORTH_DECLINED (warning)
         ├─ "In the last hour" title    sinceLabel(lastBriefViewedAt)     — route.ts:97-107
         ├─ since_last_visit section    buildSinceLastVisit()             — route.ts:151-214
         ├─ Needs Attention section     buildAttention(allSignals, primaryCtx) — route.ts:228-316
         └─ Today's Insight section     buildInsight(allSignals, primaryCtx, cachedAdvice) — route.ts:328-430

Writes  lib/snapshots/regenerate.ts — upserts ONE SpaceSnapshot row per Space per UTC day, only when:
          • Plaid refresh (manual Refresh button)      lib/plaid/refresh.ts step 4
          • Link-time import                           lib/plaid/exchangeToken.ts:534
          • Manual account create/edit/restore/wallet  app/api/accounts/*
          • Share/unshare events                       lib/events/handlers/snapshot.ts
        The 06:00 UTC cron (jobs/sync-banks.ts) syncs TRANSACTIONS only — it does not refresh
        balances or write snapshots. jobs/take-snapshot.ts is an empty stub (`export {}`),
        deferred with reasons in lib/jobs/registry.ts ("a scheduled snapshot would stamp stale
        balances as fresh daily facts" — OPS-4 S3/R7).
```

Key structural fact: `regenerateSnapshotsForAccounts()` writes a row for **every** Space an account is linked into (regenerate.ts:132-145). Spaces sharing accounts therefore have identical snapshot date-sets — which is why *both* conflicting cards said "34 days."

---

## 3. Root cause of the conflicting report

Two independent defects in `app/api/brief/route.ts`, plus one amplifier.

**(a) Cross-Space signal aggregation without attribution.** `allSignals` merges signals from every eligible Space (route.ts:523-529). `buildAttention` pushes any `NET_WORTH_DECLINED` signal using `sig.title` verbatim with no Space name (route.ts:261-267). The route header (lines 21-22) claims "signals from non-primary Spaces carry the Space name in their metadata for attribution" — **no code does this**; signal metadata carries `spaceId` only, and nothing renders it. So a decline in *any* Space appears as an unqualified "Net worth down…" warning.

**(b) Insight mixes one Space's signal with another Space's numbers.** `buildInsight` triggers on `allSignals.find(NET_WORTH_INCREASED)` — from **any** Space — then renders the **primary** Space's `netWorthTrendPct`, `netWorth`, and `snapshotCount` (route.ts:373-383). In the observed case the primary Space trended up (+442.1%) while a second Space holding the moved investment account trended down; both fired, one per Space, and the brief showed both. The detector's "never both" invariant (detectors/snapshot.ts:13) holds per Space and is silently voided by aggregation.

**(c) Amplifier — degenerate baseline.** `netWorthTrendPct = (latest − oldest) / |oldest|` over the whole ≤90-row history (assemblers/snapshot.ts:116-121). `oldest` is the Space's first-ever snapshot — typically taken at link time before most accounts existed. A ~$1.3K day-one baseline growing to $6.9K by *adding accounts* prints "+442.1%". There is a sparse-history guard (MIN_SNAPSHOTS=3, MIN_SPAN_DAYS=7 — detectors/snapshot.ts:33-36) but no near-zero-baseline or account-set-change guard.

A related honesty gap in the same section: the "Net worth +$Δ" item sits under the title "In the last hour" (from `lastBriefViewedAt`), but the Δ is the whole-history trend — the code comment admits it "covers the full snapshot history window rather than exact since-last-visit" (route.ts:146-150).

---

## 4. Why "34 days"

`snapshotCount` = number of `SpaceSnapshot` rows returned by the assembler's bounded read (last ≤90 rows, assemblers/snapshot.ts:53,72-88). It is formatted as a day count in two places:

- Signal titles: `` `Net worth up/down $X (pct%) over ${data.snapshotCount} days` `` — detectors/snapshot.ts:77, 97
- Brief insight: `` `over the last ${snap.snapshotCount} days` `` — route.ts:380

So "34 days" answers *none* of the candidate hypotheses cleanly — it is closest to "time since first account sync," but strictly it is **"this Space has 34 snapshot rows."** Because rows are written only on refresh-type events (no daily snapshot cron), days without a sync produce no row: 34 rows may span more than 34 calendar days. Conversely the D2.x backfill (`lib/snapshots/backfill-core.ts`, `isEstimated` rows) can create contiguous history — and the assembler **does not read `isEstimated`**, so reconstructed rows feed the trend indistinguishably from real ones. The real calendar span (`oldestDate` → `newestDate`) is already computed and carried in signal metadata; it just isn't used in the display string.

Also note: the trend compares **oldest vs latest only**. A one-day investment drop is truthfully "over 1 day," but the engine can only say "over the whole window" — exactly the user's complaint.

**Window recommendation:** anchor on intuitive fixed windows — **1 day** (latest two snapshots) as the headline, **30 days** (or month-to-date) as the trend line, labeled by actual dates ("since Jun 8"). "Since last visit" is honest only when snapshots straddle `lastBriefViewedAt`; otherwise say "since \<date\>". Avoid "since first sync" as a display window entirely; keep user-selected windows out of the brief (that's a chart feature).

---

## 5. Balance movement vs transaction activity

**Not distinguished in the insight pipeline.**

- Net worth is purely balance-derived: `FinancialAccount.balance` (from Plaid `accountsGet`, manual entry, or wallet sync) → `classifyAccounts` → live totals and `SpaceSnapshot` category columns (`stocks`, `crypto`, `cash`, `savings`, `debt` — schema.prisma:1703-1741). No snapshot delta is ever connected to transactions.
- Transaction activity lives in a **separate** domain with a **different window** (30 days in brief scope — assemblers/transactions.ts:140). `buildInsight` picks whichever rule fires first; the two figures are never reconciled against each other.
- The one place the distinction *does* exist is the M2 integrity gate: `lib/plaid/refresh.ts` `reconcileKind()` (lines 80-91) compares balance movement to transaction sums **for cash and credit-card accounts only**, explicitly excluding investments/crypto because they "move with the market," and flags `BALANCE_TX_MISMATCH` `SyncIssue` rows. This is flag-only plumbing for data integrity — nothing in the brief or insight engine consumes it. It proves the codebase already understands the taxonomy; the insight layer just doesn't use it.
- Pending vs posted: `Transaction.pending` is synced and `PENDING_CREDIT`/`PENDING_DEBIT` signals exist (detectors/transactions.ts), and a `SettlementState` enum is schema'd (FlowType Phase A), but balances are taken as Plaid reports them — no pending-adjustment modeling.

**Can the current model explain "net worth changed because investment balance changed, not because spending changed"?** Almost. The per-category columns on consecutive `SpaceSnapshot` rows make the decomposition (`Δstocks` vs `Δcash` vs `Δdebt`) a two-row subtraction on existing data. No code performs it.

---

## 6. Investment-account support today

- **Account type:** `AccountType.investment`; Plaid `investment` type maps to it (`crypto exchange` subtype → `crypto`) — refresh.ts:56-71. Plaid subtypes beyond that are not persisted per-account.
- **Holdings:** `Holding` model exists (symbol, quantity, price, value, `change24h`, synthetic `isCash` row, currency stamp — schema.prisma:1164-1204), FK'd to `FinancialAccount`, synced delete-then-recreate on each refresh via `investmentsHoldingsGet`, consent-gated.
- **Holdings intelligence:** `lib/ai/assemblers/holdings.ts` (D6.3C-1) computes portfolio value, invested-vs-cash, and concentration metrics — and explicitly documents its limits: *no cost basis, no realized/unrealized gains, no returns, no asset-class breakdown* ("require investment transaction sync… deferred").
- **Net worth valuation:** investment accounts contribute via `FinancialAccount.balance` (Plaid's account-level balance), not a holdings sum. `SpaceSnapshot.stocks` is the same balance sum. Adequate while Plaid supplies the balance; there is no independent positions-based valuation.
- **Investment transactions:** no model, no sync, no `investmentsTransactionsGet` anywhere in the codebase.
- **Balance snapshots:** daily per-Space aggregates only; no per-account balance history, and no holdings history (holdings are overwritten each refresh).

Verdict: investment accounts are modeled correctly as *balances with display-grade holdings*, and honestly documented as such. What's missing for the Daily Report is not the model — it's using the already-snapshotted `stocks` column to explain movement.

---

## 7. Plaid Investments readiness

- **Link products:** `[Products.Transactions]` only (AmEx compatibility — app/api/plaid/link-token/route.ts:114), so under Data Transparency Messaging **no new Item has Investments consent at link time**.
- **Consent machinery is built:** `PlaidInvestmentsConsent` enum (ENABLED / CONSENT_REQUIRED / UNSUPPORTED), derived zero-cost from `accountsGet`'s `item.consented_products` / `available_products` (lib/plaid/investmentsConsent.ts), persisted on `PlaidItem`, and gates the holdings step so `ADDITIONAL_CONSENT_REQUIRED` is never hit repeatedly. Pre-DTM Items get a single probe.
- **Ready today (code exists, consent-gated):** investment account balances; investment **holdings** (`investmentsHoldingsGet` in both refresh and link-time import).
- **Requires the consent-grant UX:** moving an Item from CONSENT_REQUIRED → ENABLED needs Link **update mode** with investments — the state machine anticipates it (see `docs/investigations/PLAID_INVESTMENTS_CONSENT_INVESTIGATION.md`); I did not find an update-mode link-token flow wired for it.
- **New provider work (nothing exists):** `investmentsTransactionsGet`, securities metadata persistence (security type/asset class), holdings history, cost basis / lots. All net-new: schema (InvestmentTransaction, Security), sync pipeline, and read layer.

---

## 8. Recommended smallest fix

All in `app/api/brief/route.ts` and `lib/ai/signals/detectors/snapshot.ts`; no schema, no migrations, no new sync.

1. **One Space, one truth.** In `buildAttention` and `buildInsight`, consider net-worth trend signals **only from the primary Space** (signals carry `spaceId`; the primary Space id is in hand). The detector's per-Space "never both" invariant then guarantees the two cards can never contradict. (If cross-Space declines must surface, prefix the label with the Space name — but the simplest correct behavior is primary-only.)
2. **Stop calling row counts "days."** Replace `over ${snapshotCount} days` with the real calendar span already available (`oldestDate` → `newestDate`): "since Jun 4". Fix both the signal titles and route.ts:380.
3. **Baseline guard.** Suppress the percentage (keep the dollar delta) when `|oldest.netWorth|` is small relative to the delta (e.g. pct would exceed ±100%) or below a floor — kills "+442.1%". A stricter variant — reset the baseline when the account set changed — needs account-count history and should be deferred.
4. **Honest window labels.** Don't render the whole-history trend under "In the last hour"; label the trend item with its own span, or show the since-last-visit delta only when snapshot dates straddle `lastBriefViewedAt`.
5. **(Optional, still small) One-line attribution from existing columns.** Diff the latest two snapshots: if `|Δstocks + Δcrypto| ≥ ~80%` of `|ΔnetWorth|`, append "driven by investment balances"; likewise for `Δdebt`. When no category dominates, say nothing about cause. This directly produces the sentence the user expected ("net worth moved 1 day, because investments") from data already on disk.

Items 1-3 alone remove the contradiction, the fake window, and the misleading percentage.

---

## 9. Recommended future architecture

The long-term Daily Report should explain net-worth movement as a **decomposition**, not a single trend:

- ΔnetWorth over an intuitive window = Δcash (attributable to transactions: income/spending/transfers via FlowType) + Δinvestments (market movement via holdings history, once it exists) + Δdebt (payments vs interest/spend) + Δmanual assets (user edits) + FX effect (MC1 stamps) + sync corrections (stale balance updated).
- Prerequisites, in dependency order: a **daily snapshot cadence** with balance-freshness semantics resolved (the OPS-4 R7 blocker — a snapshot writer must distinguish "balance refreshed today" from "yesterday's balance re-stamped"); **per-account or per-category attribution** on snapshot deltas (category-level is already possible; account-level wants a per-account snapshot or the M2 reconciliation promoted from flag-only to a consumed signal); **holdings history + investment transactions** for true market-vs-flow separation; **pending-aware cash** via SettlementState.
- The report should carry an explicit "unexplained" residual and say so rather than guess — the M2 gate's philosophy (flag, don't fabricate) is the right one to extend upward into the insight layer.

---

## 10. Risks and deferrals

**Risks in the current state / during the small fix**

- `isEstimated` backfilled rows feed trends unmarked (assembler never selects the column) — a reconstructed history can manufacture a "trend." Cheap to exclude or footnote.
- Snapshot staleness: with no daily snapshot job, `latest` can be days old while the brief's headline net worth is live — the trend and the headline can disagree on their own. The fix's date labels make this visible; the real cure is the deferred snapshot cadence.
- Space-name attribution on attention cards must respect `VisibilityLevel` — don't leak a Space's decline to a member who only sees sanitized balances. Primary-only scoping avoids this entirely.
- Doc rot: route.ts's header claims Space-name metadata attribution that doesn't exist — correct the comment when touching the file.

**Deferrals (by track)**

- **Snapshot Intelligence:** daily snapshot cadence + balance-freshness/`quality` provenance column (already deferred at OPS-4 S3 with reasons); per-account snapshots; `isEstimated`-aware trends.
- **Investment Intelligence:** holdings history, cost basis/lots, performance, market-vs-contribution decomposition; positions-based valuation cross-check against account balance.
- **Future Plaid Investments integration:** Link update-mode consent UX; `investmentsTransactionsGet` + Security/InvestmentTransaction schema and sync.
- **Transaction Intelligence:** FlowType-based cash attribution (income vs spending vs transfer) feeding the decomposition — TI Phase 2 scope, *not* TI4 relationship work.
- **Ambient Intelligence (v2.6b):** scheduled brief generation, signals→notifications, AI-written daily summaries consuming sync-health and estimated markers (already routed there by D2.x closeout).
- **MC1:** FX-effect term in the decomposition (needs the lot model per MC1 residual ledger).
