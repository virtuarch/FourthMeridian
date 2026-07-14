# Fourth Meridian — Historical Backfill Capability & Plaid Coverage Investigation

**Date:** 2026-07-11
**Branch:** `feature/v2.5-spaces-completion`
**Type:** Investigation only. No code written, no files modified, no architecture proposed.
**Established input:** the two completed Time Machine investigations (cross-perspective + implementation plan) and the prior Plaid-history investigations (`D4_PLAID_HISTORY_INVESTIGATION.md`, `PLAID_TRANSACTION_HISTORY_DEPTH_INVESTIGATION.md`, `INITIAL_DAILYSNAPSHOT_BACKFILL_INVESTIGATION.md`).
**Governing principle:** *"Did the data earn this?"*

---

## TL;DR

- **The event log is the only true history, and it is bounded by two things — not one.** Plaid *is* asked for 730 days (`app/api/plaid/link-token/route.ts:151`), so the ceiling is not the request. The real cap is that Fourth Meridian syncs transactions **once, synchronously, at Link time**, before Plaid finishes its asynchronous historical backfill, and there is **no webhook and no active scheduler** to ever re-sync (`D4_PLAID_HISTORY_INVESTIGATION.md` §7). So today's *observed* depth is often ~24–99 days even though ~730 is theoretically available and **recoverable by re-syncing**.
- **Cash and revolving-card balances can be walked backward honestly** within transaction depth (`lib/snapshots/backfill-core.ts`). **Investments, crypto, manual assets, and installment loans cannot** — they are held flat and flagged `isEstimated`.
- **"~30 days" is a product constant (`BACKFILL_DAYS = 30`), not an architectural, storage, or performance limit.** The same algorithm trivially produces 90/365/730 days; it is capped by transaction depth and by honesty (more days = more flat-held estimate), plus a membership-anachronism caveat.
- **The architecture is designed to backfill later.** Snapshots are additive, never-overwritten rows with an `isEstimated` flag and a `[spaceId, date]` unique key; richer observations dropped in later regenerate cleanly. The gaps that remain **permanently unknowable** are: transactions older than Plaid's 730-day window, historical *positions* (holdings are `deleteMany`+`create`d — no history), and historical *security prices* (only `FxRate` is a time series).
- **The single highest-leverage provider change is not a new product — it is a Plaid webhook + re-sync** to actually fetch the 730 days already being requested. After that: **Investments Transactions** (currently *not* called), **Liabilities**, and **Statements** are the ordered priorities.

---

## PART 1 — Current backfill capability (per perspective)

### Cash Flow

**How far back:** exactly as far as the persisted `Transaction` rows go — Cash Flow is a **pure fold over the event log** (`lib/transactions/cash-flow.ts`, `cash-flow-projection.ts`), so *every* sub-view has the same horizon:

- transaction history, Cash Flow History, Calendar, Spending (economic axis), Income, Debt payments, payment-app movements, transfers, cash withdrawals — **all** reconstruct for any period the transactions cover. There is no separate limit per view; they are all measures selected out of one `DayFacts`.

**Can the entire transaction history simply be replayed?** **Yes — this is the one perspective that genuinely replays.** There is no persisted Cash Flow state to reconstruct; it is recomputed on read from the rows. The only limit is which rows exist.

**What bounds "which rows exist":**
- Plaid's returned depth (theoretically 730 days requested; practically shallower until re-synced — see Part 3/Part 4).
- CSV/manual imports can inject **arbitrarily old** dated transactions (`ImportBatch`, `Transaction.externalTransactionId`), which deepen Cash Flow history beyond Plaid's window.
- Soft-deleted rows (`deletedAt`) and rolled-back imports are excluded.

**Assumptions:** economic vs liquidity axes are computed from `flow-predicates`/`classifyLiquidity` at read time (`flowType` columns exist but are nullable/unpopulated); ambiguous transfers are honestly bucketed as "needs classification," never guessed; per-row currency converts at the row's own date via `ConversionContext`.

### Liquidity

**How far back:** cash (checking/savings) balances can be **walked backward** to the earliest transaction, via the existing algorithm in `lib/snapshots/backfill-core.ts`:

```
reconstructDailyCashBalances:  eod(d) = eod(d+1) − Σ amount(txns dated d+1)
```

Below an account's earliest transaction there are no deltas, so the balance **holds flat — never fabricated** (module header). Marketable/illiquid components of the liquidity lens are current balances only (no history).

**Exactly what algorithms exist today:** the cash reverse-walk above (used by `backfillSpaceSnapshots`), plus the liability reverse-walk (below). The `liquidity.core.ts` lens is **pure over rows** — feed it reconstructed rows and it produces an as-of liquidity result unchanged, but **no code wires reconstructed rows into it yet** (that is the planned Liquidity as-of slice).

**Dependencies:**
- **Transaction depth** — the binding constraint; reconstruction stops at the earliest row.
- **Balance snapshots** — `SpaceSnapshot` stores aggregate `cash`/`savings`/`netLiquid` per day, so snapshotted dates can be read directly instead of walked.
- **Imports** — older imported transactions extend the walk.
- **Deleted accounts** — soft-deleted (`deletedAt`); `Transaction`/`Holding` history is *preserved* (schema comments), but `classifyAccounts`/`getAccounts` exclude deleted accounts, so a removed account **drops out of reconstructed aggregates** — an anachronism (it *was* liquid then).
- **Reconnects** — `/item/remove` + fresh Link creates a **new Item, new cursor, new `FinancialAccount`** (unless dedup/identity resolves it); reconnecting to deepen history restarts the sync cursor and can fragment continuity.

### Debt

**How far back (revolving cards):** reconstructable via the liability reverse-walk (`reconstructDailyLiabilityBalances`):

```
owed(d) = owed(d+1) + Σ amount(txns dated d+1)
```

Gated to **revolving cards only** (`isReconstructableCard`: explicit `credit_card`, or null-subtype debt with a `creditLimit`). Pending excluded to match the posted balance anchor.

**Can balances be replayed?** For revolving cards, yes (within transaction depth). **Installment loans (mortgage, auto, student, personal) are held flat** — their balance change is amortization, not transactions, so there is nothing to walk.

**Utilization history:** reconstructable **where `creditLimit` is known and stable** — utilization = reconstructed owed ÷ limit. But `creditLimit` is a **current** value with no history; if a limit changed, historical utilization is computed against today's limit (an approximation, should be stamped estimated).

**What cannot be reconstructed:** installment balances, principal-vs-interest split, statement balances, minimum-payment history, APR history, historical credit limits, payoff/closure dates beyond what balance→0 or `deletedAt` imply.

### Wealth

**Currently ~30 reconstructed days.** The constant is `BACKFILL_DAYS = 30` (`lib/snapshots/backfill.ts:74`). See Part 3 for the full "why."

**Could it reconstruct 90 / 180 / 365 / 5 years?** The **algorithm** could produce any of these unchanged — it is O(days × accounts). What actually caps honest Wealth history:
- **Cash component:** honest back to the earliest transaction (≤ 730 days via Plaid, or older via imports).
- **Non-cash (investments/crypto/manual/loans):** **held flat at today's value** for the entire window — so a longer window produces a *longer flat line*, which is estimate, not truth. 365 days of mostly-flat net worth is misleading, not informative.
- **Membership anachronism:** `SpaceAccountLink`/visibility is **not versioned over time** (`INITIAL_DAILYSNAPSHOT_BACKFILL_INVESTIGATION.md`), so reconstructing a Space aggregate 5 years back uses *today's* membership — increasingly wrong the further back you go.

**What would break at 5 years:** nothing computationally (see Part 3 costs), but the **honesty** breaks — beyond transaction depth there are no deltas, so every component holds flat and the entire series is `isEstimated`. It would render a canonical-looking net-worth line built almost entirely from today's balances projected backward. That violates "did the data earn this?"

**Could historical Wealth simply be regenerated if sufficient historical observations existed?** **Yes — this is the architecture's key property.** `SpaceSnapshot` rows are additive, never overwritten, keyed `[spaceId, date]`, with `isEstimated`/`reportingCurrency` stamps. If real historical observations arrived (deeper transactions, statement balances, position/price history), a regeneration pass would write the missing/estimated dates as observed. **The store is ready for richer backfill; it is the observations that are missing.**

### Investments

**Historical capability today: effectively none.** `investmentsHoldingsGet` is called and writes current `Holding` rows via **`deleteMany`+`create` on every refresh** (`lib/plaid/refresh.ts:317`) — so **no position history exists**, and each sync destroys the prior snapshot. There is **no historical security price series** (only `FxRate`). `investmentsTransactionsGet` is **not called at all** (endpoint inventory below), so even investment *activity* history is not ingested.

**What can already be reconstructed:** current holdings, current allocation, and — only where an investment account's cash transactions exist in the log — contribution/withdrawal *flows*. No historical valuation, allocation-over-time, return, or gain.

**What is missing:** append-only position history, a security/crypto price time series, and normalized investment events (trades/dividends/fees/corporate actions). This is the subject of Parts 4–6.

**Endpoint inventory (every Plaid call in the repo):** `linkTokenCreate`, `itemPublicTokenExchange`, `accountsGet`, `transactionsSync`, `investmentsHoldingsGet`, `itemRemove`. **That is the complete list.** No `investmentsTransactionsGet`, `liabilitiesGet`, `statementsList`, `assetReportCreate`, `incomeGet`, `signalEvaluate`, `transferCreate`, `transactionsRecurringGet`, `accountsBalanceGet`, or `authGet`.

---

## PART 2 — Can we backfill later?

**Assume in six months: richer Plaid data, brokerage APIs, Coinbase, manual imports, wallet adapters, historical prices.** Can the architecture rerun historical backfills?

**Largely yes — the architecture was explicitly built for it** (additive snapshots, never-overwrite, `isEstimated` flag, `[spaceId,date]` idempotency, the `FxRate` walk-back precedent). But the answer splits by *what kind of gap* each perspective has: a **coverage gap** (data exists somewhere, just not fetched yet) is fully recoverable; an **observation gap** (the fact was never recorded by anyone) is permanently lost.

| Perspective | Fully regenerable if data arrives | Must remain incomplete forever |
|---|---|---|
| **Cash Flow** | All transactions within Plaid's 730-day window (coverage gap — recoverable by re-sync); any period covered by CSV/manual imports | Transactions **older than 730 days** with no import and no statements — never observed, unrecoverable |
| **Liquidity** | Cash/card as-of within transaction depth; deeper once transactions arrive | Pre-transaction-depth balances (no deltas to walk); liquidity of accounts closed before connection |
| **Debt** | Revolving-card balances within depth; utilization once limits are known | Installment amortization history, principal/interest split, historical APR/limits, statement history — unless **Statements/Liabilities** are ingested |
| **Wealth** | Cash-driven net-worth history within depth; **fully historical** once statements/positions/prices arrive → regenerate the `isEstimated` rows as observed | The window before any observation exists for non-cash assets; anything before account creation |
| **Investments** | **Becomes fully historical only prospectively** — position snapshots + price observations captured *going forward* accumulate real history | **All pre-capture position history is lost forever** unless a provider supplies historical holdings/transactions (Plaid does *not* — Part 5). Cost basis for pre-connection lots is unrecoverable without brokerage/CSV history |

**The decisive asymmetry:** Cash Flow / Liquidity / Debt / Wealth have mostly **coverage gaps** (the transactions exist at Plaid for 730 days; fetch them and history regenerates). Investments has an **observation gap** — nobody is recording positions daily, so every day that passes without position/price capture is a day of history that can never be reconstructed. **This is the single strongest argument for standing up `PositionSnapshot` + `PriceObservation` capture early, even before the Investment Time Machine UI exists** — not to show anything yet, but to stop the permanent loss.

**Should current snapshot tables be regenerated or versioned?** **Regenerated, not versioned** — for now. `SpaceSnapshot` rows are cheap, stamped `isEstimated`, and never anchor an irreversible decision, so a backfill that replaces estimated rows with observed ones is safe and desirable. **Versioning (`KnowledgeVersion`) becomes necessary only** when a regeneration would silently move a figure a user already made a decision against — the bitemporal trigger from the prior investigations, still not earned. Recommendation: regenerate freely while rows are `isEstimated`; freeze-and-version only observed rows, and only once decisions anchor to them.

---

## PART 3 — Why only ~30 days?

**Root cause: a single product constant.** `const BACKFILL_DAYS = 30` in `lib/snapshots/backfill.ts`, chosen by the backfill design (`INITIAL_DAILYSNAPSHOT_BACKFILL_INVESTIGATION.md`) as the "smallest safe window" for a brand-new Space. It is **not** architectural, performance, or storage driven.

**Classification of the ~30-day limit:**
- **Architectural?** No — the algorithm is window-agnostic (`reconstructDailyCashBalances` walks any `[start, today]`).
- **Product choice?** **Yes — primarily.** 30 days was picked as a safe, useful, honest default for a new connection.
- **Performance?** No (see costs below).
- **Provider limitation?** **Indirectly, yes** — the honest output is capped by transaction depth, which the depth investigation observed at ~24–99 days per account; a 30-day window was chosen partly because deeper windows were *data-starved* on exactly the accounts that reconstruct best.
- **Snapshot cadence?** **Contributing** — backfill runs **once**, new-Space-gated (≤1 existing snapshot); after that, daily rows accrue only from the event-driven "today" writer (`regenerateSpaceSnapshot`). There is **no active daily cron** materializing history — `jobs/take-snapshot.ts` is a stub (`export {}`) and the scheduler is dormant. So history does not grow backward on its own; only forward, one day at a time, as events fire.

**Could the same algorithm produce 90 / 180 / 365 / all-available?** Yes — change the constant. Output honesty still capped by transaction depth (cash) and flat-hold (non-cash).

**Would it take longer / cost more?**

| Window | Compute (per Space) | Storage (per Space) | Verdict |
|---|---|---|---|
| 30 days | O(30 × ~10 accts) + 1 `groupBy` — milliseconds | ~30 rows ≈ ~6 KB | trivial |
| 90 days | ~3× the above — still milliseconds | ~90 rows ≈ ~18 KB | trivial |
| 365 days | ~12× — tens of ms | ~365 rows ≈ ~70 KB | trivial |
| 2000+ days (5.5 yr) | ~65× — still well under a second | ~2000 rows ≈ ~400 KB | trivial storage/compute; **honesty is the limit, not cost** |

Order-of-magnitude: even 2000 daily rows per Space is sub-megabyte and a single-digit-second reconstruction. **Storage and performance are non-issues.** The reasons not to blindly extend the window are (1) transaction depth starves the cash walk beyond ~730 days, (2) non-cash flat-hold makes long windows misleading, and (3) the membership-anachronism grows.

**Would incremental backfills solve it?** They already are the model — backfill is one-shot + forward event-driven writes. The right lever is **not a bigger one-shot window** but (a) fixing transaction depth (Part 4) so the cash walk has data, and (b) a bounded, on-demand "extend history" regeneration when richer observations arrive.

---

## PART 4 — Plaid capabilities

Grouped by priority. "Already used" reflects the endpoint inventory (Part 1). Impact columns note which perspectives each unlocks.

### Already used
- **Transactions** (`transactionsSync`) — the entire Cash Flow / Liquidity / Debt-payment substrate. 730 days requested.
- **Investments — Holdings** (`investmentsHoldingsGet`) — current positions only, overwritten each sync.
- **Balance** (implicitly, via `accountsGet`) — current balances; the dedicated `/accounts/balance/get` is *not* used.

### CRITICAL for Time Machine (highest leverage, not a new product)
- **A Plaid `webhook` + a re-sync mechanism.** This is the number-one finding of `D4_PLAID_HISTORY_INVESTIGATION.md`: 730 days is requested but only the ~30-day `INITIAL_UPDATE` window is fetched because the one sync runs synchronously at Link time and **nothing re-syncs** (no `webhook` on the Link token; scheduler dormant). Configuring `SYNC_UPDATES_AVAILABLE` / `HISTORICAL_UPDATE_COMPLETE` webhooks (or a scheduled re-sync) would fetch the full 730 days Plaid already backfills asynchronously. **This costs no new product or permission — it is the single change that most deepens Cash Flow, Liquidity, Debt, and cash-driven Wealth history.** *(A manual Refresh does re-sync and would eventually catch it, but users won't reliably trigger it.)*

### CRITICAL for Investments
- **Investments Transactions** (`investmentsTransactionsGet`) — **not currently called.** Provides buys/sells/contributions/withdrawals/dividends/fees going back up to ~24 months. This is the minimum to compute contribution-vs-growth and to seed `InvestmentEvent`. Without it, even investment *activity* history is absent.
- **Investments Holdings** — keep, but **stop overwriting**: append to `PositionSnapshot` so history accrues prospectively.

### CRITICAL for Simulation / Debt accuracy
- **Liabilities** (`liabilitiesGet`) — **not used.** Supplies **APR, minimum payment, statement balances, due dates, last-payment amount/date, and (for loans) origination/principal/interest breakdown** directly from the issuer. This replaces user-asserted `DebtProfile` guesses with observed terms, and is what makes **principal-vs-interest** and **honest payoff simulation** possible. High value for Debt Time Machine and every debt-related forecast.

### Nice to have (meaningful, second wave)
- **Statements** (`statementsList`/`statementsDownload`) — PDF statements can extend **balance and transaction history well beyond the 730-day Transactions window** and provide statement-close balances (the observation that de-estimates historical debt/cash). The one Plaid product that can push history past 730 days.
- **Recurring Transactions** (`transactionsRecurringGet`) — Plaid's own recurring-stream detection; improves recurring-income/spending estimates that today are derived heuristically, sharpening baseline forecasts and the onboarding "confirm your income" step.
- **Income** (`/credit/...` income products) — verified payroll cadence/amount; strengthens simulation payroll inputs and the minimum-onboarding confirmation.
- **Assets** (`assetReportCreate`) — a point-in-time multi-account asset report with up to ~2 years of balances/transactions; useful for a one-shot deep historical seed and for net-worth verification.

### Low priority / not aligned
- **Auth** (account/routing) — only needed for money movement; Fourth Meridian is read-only analytics. Skip.
- **Signal / Transfer** — payments/risk products; out of scope (no fund movement).
- **Identity** — KYC/identity; marginal for analytics, minor dedup help; low priority.
- **CRA / Credit products** — heavier consent + use-case restrictions; revisit only if lending features emerge.

### Per-product historical impact summary

| Product | New historical info | Cash Flow | Wealth | Debt | Liquidity | Simulation | Timeline | LLM |
|---|---|---|---|---|---|---|---|---|
| Webhook + re-sync | Full 730-day transactions (already requested) | ★★★ | ★★ | ★★ | ★★★ | ★★ | ★★★ | ★★ |
| Investments Transactions | Trades/dividends/fees ~24 mo | — | ★★ | — | — | ★★ | ★★ | ★★ |
| Liabilities | APR, statement balances, min pay, due dates | — | ★ | ★★★ | ★ | ★★★ | ★★ | ★★ |
| Statements | History beyond 730 days; statement balances | ★★ | ★★ | ★★ | ★★ | ★ | ★★ | ★ |
| Recurring Transactions | Provider recurring streams | ★★ | — | — | ★ | ★★ | ★ | ★★ |
| Income | Verified payroll | — | — | — | — | ★★ | ★ | ★ |
| Assets | ~2-yr multi-account balances (one-shot) | ★ | ★★ | ★ | ★★ | ★ | ★ | ★ |

---

## PART 5 — Investment history (what Plaid actually provides)

Direct answers, grounded in Plaid's product model and the repo's current usage:

| Data | Plaid provides? | Notes |
|---|---|---|
| **Historical holdings** | **No** | `investmentsHoldingsGet` returns **current** holdings only. No as-of/historical positions. FM compounds this by overwriting each sync. |
| **Historical (investment) transactions** | **Partially** | `investmentsTransactionsGet` returns activity for up to ~24 months — buys/sells/contributions/withdrawals/dividends/fees/transfers. **Not currently called.** Positions must be *derived* by replaying these; Plaid does not give position-as-of directly. |
| **Position history** | **No** | Must be reconstructed from investment transactions (imperfect for pre-window lots) or captured prospectively via snapshots. |
| **Cost basis** | **No (reliably)** | Not a dependable Plaid field; must be derived from trade history + a lot policy, or sourced from the brokerage/CSV. |
| **Historical prices** | **No** | Plaid gives an `institution_price` on current holdings and price on transactions; **no historical price time series.** Requires a dedicated market-data provider. |
| **Dividends / interest** | **Yes (as transactions)** | Via `investmentsTransactionsGet` subtypes — but only within its window. |
| **Fees** | **Yes (as transactions)** | Same. |
| **Corporate actions** (splits/mergers/spin-offs) | **No / unreliable** | Not modeled by Plaid; needs a corporate-actions dataset or manual handling. |
| **Cash positions (brokerage sweep)** | **Yes** | Appears as a holding/position; FM already models `Holding.isCash`. |

**Conclusion:** Plaid alone can give **~24 months of investment *activity*** (once `investmentsTransactionsGet` is enabled) from which positions can be *partially* reconstructed, plus current holdings. It **cannot** give historical positions, historical prices, reliable cost basis, or corporate actions. Therefore Fourth Meridian must additionally ingest:

- **A market-price provider** (historical daily prices for equities/funds; a crypto price source for 24-hour pricing) — the `PriceObservation` supplier and the single most important non-Plaid dataset.
- **Brokerage-direct APIs / CSV** for cost basis and lots where accuracy matters.
- **Wallet/on-chain adapters** for crypto positions and movements (already partially built).
- **A corporate-actions dataset** (later; for splits/mergers/spin-offs/symbol changes).

---

## PART 6 — Provider strategy

**Do not rely on one provider. Normalize all providers into one canonical, provider-neutral investment model** — this is already the repository's established doctrine (the TE-1 transfer-evidence adapter pattern, `ProviderAccountIdentity`, `MerchantEnrichmentSource`, and the `ProviderType` enum which already includes `PLAID | MANUAL | WALLET | CSV | EXCHANGE | BROKERAGE`). The prior implementation plan's `PriceObservation` / `PositionSnapshot` / `InvestmentEvent` contract is the canonical target; every provider adapts *into* it.

| Provider | Role | Strength | Gap it cannot fill |
|---|---|---|---|
| **Plaid** | Primary banking + baseline investment activity | Broad institution coverage; transactions; liabilities; ~24 mo investment activity | No historical positions/prices; no corporate actions; 730-day transaction ceiling |
| **Coinbase / exchanges** | Crypto activity + balances | Authoritative for on-exchange crypto trades/staking | Off-exchange/self-custody; historical prices |
| **Brokerage APIs (Schwab, etc.)** | Authoritative positions + cost basis | Real lots, real cost basis, corporate actions handled by the broker | Coverage limited to that broker |
| **Wallet adapters (xpub/watch-only)** | Self-custody crypto | On-chain truth, already partially built | Fiat valuation (needs price source) |
| **CSV imports** | Universal fallback + deep history | Can inject arbitrarily old, arbitrarily detailed history | User effort; mapping reliability (`ImportMappingProfile` exists) |
| **Manual assets** | Uncovered assets (real estate, private) | Fills what no API can | User-asserted, `isEstimated` |
| **Market-price providers** | The valuation backbone | Historical daily + crypto 24h prices — the `PriceObservation` source | Not a holdings source; pairs with the above |

**Ruling:** single-provider reliance is a strategic dead end — Plaid structurally cannot supply historical positions, prices, or corporate actions. The canonical-model-with-adapters approach the codebase already uses is correct; extend it to the three investment tables and add a market-price provider as a first-class, provider-neutral `PriceObservation` source.

---

## PART 7 — Recommendation

**1. How far Fourth Meridian can honestly reconstruct history today.**
- **Cash Flow:** any period the persisted `Transaction` rows cover — today often ~24–99 days (until re-sync fetches the full requested 730), plus anything imported. Full replay, no estimation.
- **Liquidity:** cash/savings balances walked back to the earliest transaction (same depth), stamped derived; non-cash liquidity is current-only.
- **Debt:** revolving-card balances walked back within depth (derived); installment loans flat/estimated; no principal-vs-interest.
- **Wealth:** ~30 materialized days today (product constant), extendable to transaction depth for the cash component; **all non-cash held flat and `isEstimated`**. Net-worth history is honest only to the extent it is cash-driven.
- **Investments:** current holdings/allocation only. **No honest history.**

**2. Exactly what to request from Plaid, in priority order.**
1. **Webhook + re-sync mechanism** (no new product) — fetch the 730 days already requested. Highest leverage.
2. **Investments Transactions** — enable `investmentsTransactionsGet`; unblocks ~24 mo of investment activity and contribution-vs-growth.
3. **Liabilities** — observed APR/statement balances/min payments/due dates; unblocks honest Debt history and payoff simulation.
4. **Statements** — the only Plaid path past the 730-day transaction ceiling; statement-close balances de-estimate history.
5. **Recurring Transactions + Income** — sharpen recurring-income/spending and payroll inputs for simulation.
6. **Assets** (optional) — one-shot ~2-yr multi-account historical seed.

**3. What investment/history data is still missing (beyond Plaid).**
Historical positions, a historical security/crypto **price series**, reliable **cost basis**, and **corporate actions** — none of which Plaid supplies. These require prospective `PositionSnapshot` capture, a market-price provider, and brokerage-direct/CSV sources.

**4. Is today's architecture sufficient to backfill richer data later?**
**Yes, for the bank/cash/debt/wealth perspectives** — additive never-overwrite snapshots with `isEstimated`, `[spaceId,date]` idempotency, and the `FxRate` walk-back precedent mean richer observations regenerate cleanly. **No, for investments** — because holdings are overwritten and no price series exists, so **history not captured is lost forever.** The architecture can *receive* richer investment data, but it is not currently *capturing* the raw material, which is the one urgent gap.

**5. Recommended sequence for acquiring provider capabilities.**
(a) Plaid webhook + re-sync → (b) enable Investments Transactions **and stop overwriting holdings / start `PositionSnapshot` capture** (halts permanent loss) → (c) add a market-price provider (`PriceObservation`) → (d) Liabilities → (e) Statements → (f) brokerage/Coinbase/wallet adapters into the canonical model → (g) corporate-actions dataset (last).

**6. The smallest next implementation slice after provider approval.**
**Add the Plaid `webhook` to the Link token and a re-sync entry point that runs `transactionsSync` on `SYNC_UPDATES_AVAILABLE` / `HISTORICAL_UPDATE_COMPLETE`.** It is the smallest change with the largest historical payoff: it fetches the 730 days already being requested, which immediately deepens Cash Flow, Liquidity, Debt, and cash-driven Wealth reconstruction with **zero schema changes and no new Plaid product** — and it is the prerequisite that makes every read-only Time Machine slice (Wealth/Liquidity/Debt as-of) worth more on real data.

*Investigation scope note:* this slice is provider-plumbing, distinct from the Time Machine implementation plan's "Phase 1 (as-of + completeness seam)." They are complementary and can proceed in parallel — the webhook deepens the data the as-of engine reads.

---

*End of investigation. No code was written, no files modified, no architecture proposed.*
