# Fourth Meridian — Cross-Perspective Time Machine Investigation

**Date:** 2026-07-11
**Branch:** `feature/v2.5-spaces-completion`
**Type:** Architecture & product investigation. No code written, no schema changed, no migrations.
**Governing principle:** *"Did the data earn this?"*

---

## 1. Executive conclusion

Time Machine **should** become a shared *capability* — but not a single generic engine, and not with the scope the phrase invites. The repository has already, quietly, built most of the seam it needs: a **deterministic, non-persistent, visibility-gated `perspective-engine`** whose lenses take an injected clock and emit a result carrying a verdict, metrics, labeled assumptions with a `source` provenance, and a `dataAsOf` freshness stamp. That engine answers *"now"* only because its lenses read **current** account balances — the injected clock sets `computedAt`, not the data. The single load-bearing change is to let the engine resolve state **as of a chosen date** and to attach a **completeness/trust envelope** to the result. Everything else the prompt lists (compare mode, playback, evidence drawer, milestone markers) is a **consumer** of that seam, not new architecture.

What the data has genuinely earned differs sharply by perspective:

- **Cash Flow** already *is* a period Time Machine (definition **A**). It is transaction-derived, pure, two-axis (liquidity + economic), with History, Calendar, drill-downs, and a period selector. The only earned increment is **period-vs-period comparison ("Then vs Now")** — pure compute over functions that already exist.
- **Wealth** is the only perspective whose **point-in-time state is already persisted** — `SpaceSnapshot` stores ten daily aggregate totals per Space. It earns definition **B** (point-in-time net worth) *today*, bounded to ~30 reconstructed days and with non-cash held flat.
- **Liquidity** earns **B** by reconstruction (the cash walk-back already exists in `lib/snapshots/backfill-core.ts`), bounded by transaction depth.
- **Debt** earns **B partially** — revolving-card balances are already reverse-walked; installment loans are held flat. It does **not** earn **C** (principal-vs-interest decomposition): that needs statements/amortization the platform does not hold.
- **Investments** earns **almost nothing** beyond period filtering. Holdings are `deleteMany`+`create` on every refresh — **there is no position history**, and there are **no historical security prices** (only FX is a time series). It cannot flow through a shared Time Machine until a canonical investment event/position contract exists.

**Recommended definition:** the smallest earned Time Machine is **B (point-in-time state) layered on the already-shipped A (period filtering)**, with an explicit completeness stamp — *not* general change-decomposition (**C**) and emphatically *not* bitemporal knowledge-as-known-then (**D**). Recommended architecture: **a shared shell + per-perspective adapters, built by adding `asOf` + a completeness envelope to the existing `perspective-engine`** — not a new universal abstraction. Recommended first slice: a **read-only Wealth "as-of" that reads existing `SpaceSnapshot` rows and surfaces the completeness stamp**, because it is the only slice that proves the two shared primitives (as-of resolution + trust envelope) with **zero new schema**.

---

## 2. Current historical capability map

For each historical record: what it is, granularity, source, persisted vs recomputed, replayable, whether later imports/corrections rewrite it, and scoping.

| Record | What it represents | Granularity | Source | Persisted / recomputed | Replayable? | Rewritten by later imports/corrections? | Owner-scoped & Space-gated? |
|---|---|---|---|---|---|---|---|
| **`SpaceSnapshot`** (`schema.prisma:1776`) | 10 daily aggregate totals per Space (stocks, crypto, cash, savings, debt, netWorth, totalAssets, cashOnHand, netLiquid, total) | Daily, **Space-aggregate** (not per-account) | `regenerateSpaceSnapshot` (live "today") + `backfillSpaceSnapshots` (≤30d, new-Space only) | **Persisted** | Partially — today's row recomputed on every balance change; past rows **never overwritten** (`createMany skipDuplicates`) | No — past rows are frozen. A later correction changes today forward, not history | Yes — `spaceId`, `@@unique([spaceId,date])`, `reportingCurrency` stamped |
| **`Transaction`** (`:1393`) | Canonical money-movement event | Per-event, `@db.Date` (day precision) | Plaid sync / manual / CSV import | **Persisted** (event log) | Yes — the true replay substrate | Soft-delete via `deletedAt`; import rollback flips `ImportBatch.status`; re-sync dedups on `plaidTransactionId` | Via `financialAccountId → SpaceAccountLink` |
| **`FxRate`** (`:2003`) | Daily close FX, USD base | **Daily time series** | FX adapter batches | **Persisted, append-only** | Yes — the one truly bitemporal-ish store (walk-back to latest ≤ asked) | New fetches add rows; `@@unique([date,base,quote])` keeps one canonical rate/day | Global (not tenant data) |
| **`Holding`** (`:1188`) | Current position (symbol, qty, price, value) | **Point-in-time only** | Plaid holdings / crypto sync | **Persisted but overwritten** — `deleteMany`+`create` every refresh (`lib/plaid/refresh.ts:317`) | **No** — no position history exists | Fully rewritten each sync | Via account FK |
| **`FinancialAccount.balance`** (`:764`) | Current/ledger balance | Point-in-time | Canonical `AccountConnection` | **Persisted, overwritten** | Only via reconstruction from transactions | Overwritten each sync; `balanceLastUpdatedAt` records provider freshness | `ownerType`/`SpaceAccountLink` |
| **`DebtProfile`** (`:877`) | APR, min payment, due day, statement close, promo end | Current only | **User-entered** (falls back to flat `FinancialAccount` cols) | **Persisted, current** | No statement history, no amortization | User edits overwrite | Via account |
| **`CreditScore`** (`:1845`) | Credit score over time | Time series (append row per update) | Manual / bureau | **Persisted, append** | Yes | New row per update | `userId`-scoped |
| **Net-worth history** | — | — | — | **Only exists as `SpaceSnapshot.netWorth`** | — | — | — |
| **Provider sync timestamps** | `Connection.lastSyncedAt`, `cursor`, `AccountConnection.lastSyncedAt`, `PlaidItem` cursor | Current | Sync pipeline | Persisted | — | — | Per connection |
| **Import provenance** | `ImportBatch` (+ `Transaction.importBatchId`, `externalTransactionId`) | Per batch | Import pipeline | Persisted | Rollback = soft-delete rows | `ROLLED_BACK` status soft-deletes | Per account |
| **Domain events** | `lib/events/emit.ts` bus + handlers | Per event | App mutations | **Ephemeral dispatch** (no event store) | — | — | Envelope carries `spaceId` |

**Load-bearing facts that shape everything below:**

1. **The only persisted point-in-time store is `SpaceSnapshot`, and it is Space-aggregate, ~30 days deep, and mostly flat for non-cash.** Its `isEstimated` flag already distinguishes reconstructed rows from live ones — the seed of a trust model.
2. **The event log (`Transaction`) is the real replay substrate,** but its depth is bounded by Plaid: default **90 days**, max **730** (`PLAID_TRANSACTION_HISTORY_DEPTH_INVESTIGATION.md`), and observed depth is often 24–99 days. Reconstruction is honest only within that window; below an account's earliest transaction, balances hold flat by construction — never fabricated (`backfill-core.ts`).
3. **`FxRate` is the platform's only genuine historical-value time series.** There is no equivalent `PriceObservation` for securities/crypto assets.
4. **Holdings have no history at all.** This is the hard wall for Investments.
5. **`flowType`/`flowDirection` are schema'd but nullable and not yet populated** — the canonical economic classification runs at read time via `flow-predicates`/`classifyLiquidity`, not from persisted columns.

---

## 3. Precise Time Machine definition

The prompt's five candidate meanings, mapped to what the platform has earned:

| Def | Meaning | Earned today? | Where |
|---|---|---|---|
| **A** | Period filtering (transactions + aggregates in a window) | **Shipped** | Cash Flow (Summary/History/Calendar), transaction drill-downs |
| **B** | Point-in-time state (balances/debt/net worth on a date) | **Partially earned** | Wealth (persisted snapshots), Liquidity + revolving Debt (reconstruction), bounded by depth |
| **C** | Change decomposition (why state changed between two dates) | **Cash Flow only, as flows** — not as balance/valuation decomposition | Cash Flow axes explain *movement*; contribution-vs-market-growth is **not** earned |
| **D** | Knowledge-as-known-then (bitemporal: what FM knew then vs corrected truth) | **Not earned** (except `FxRate` is incidentally bitemporal-ish) | — |
| **E** | Phased combination | **This is the recommendation** | See §11 |

**Recommendation: the smallest definition the platform has earned is `A` (already shipped) + `B` (point-in-time state, bounded and trust-stamped).** Ship `B` per perspective only where the data earns it, always with a completeness stamp; treat `C` as a *narrow, flow-based* explanation on top of `A`/`B` (Cash Flow first), never as full valuation attribution; refuse `D` for now.

**When bitemporal (`D`) becomes necessary — and only then:** the day Fourth Meridian must answer *"what did we believe your March net worth was, as we knew it in March"* as distinct from *"what we now know March was after a backfill/correction."* That requires versioning every historical fact by *knowledge time* as well as *valid time*. The platform does **not** need this until (a) provider **backfills routinely rewrite already-shown history** (Plaid re-deliveries, restatements), **and** (b) users make **decisions or receive advice** anchored to a historical figure that a later correction would silently move. Until both hold, bitemporal is cost without a claim to defend. The one place a lightweight version is already justified is **provider corrections to past transactions**: today a re-sync can change a past day's reconstructed balance with no record that it did. A single `KnowledgeVersion`/"as-recorded-at" stamp on *corrections* (not on all state) is the earned minimum — deferred to the last phase.

---

## 4. Perspective-by-perspective feasibility

### A. Cash Flow

- **Answerable today:** period Cash In / Cash Out (liquidity axis) and economic Spending (economic axis); movement/context buckets ("Moved, not spent", "Needs classification"); Calendar; History; per-row evidence drill-down. Two honest axes are already separated so a card purchase is spending (economic) but not Cash Out (liquidity) until paid.
- **State to reconstruct:** none — it is a pure fold over `Transaction` for a window (`cash-flow-projection.ts`, `cash-flow.ts`).
- **Existing support:** complete. `DayFacts` per-day/per-total, liquidity/economic classifiers, drill drawers, relative + explicit periods.
- **Missing:** **period-vs-period comparison** and a "what changed" delta (Cash In Δ, Spending-by-category Δ). This is compute + UI, **no new data**.
- **Recompute vs snapshot:** compute-on-read; no snapshot needed at current volumes.
- **Inaccurate/impossible:** anything before transaction depth; economic classification of ambiguous transfers (already honestly bucketed as "needs classification").
- **Smallest viable slice:** "Then vs Now" — same two period selections, diff the existing `DayFacts` totals and the category breakdown.
- **Complexity:** **Low.** Mostly UI; the math already exists and is tested.
- **Already complete vs UI work:** the *engine* is complete; comparison is UI + a thin diff helper.

### B. Liquidity

- **Answerable today:** spendable cash now, marketable (sellable) assets, illiquid, FULL-only unused credit (never counted as liquidity) — via the registered `liquidity` lens (`lenses/liquidity.core.ts`).
- **State to reconstruct (as-of):** checking/savings balances on the date. The **exact algorithm already exists** (`reconstructDailyCashBalances`): `eod(d) = eod(d+1) − Σ amount(d+1)`.
- **Existing support:** the pure lens core accepts rows; feed it reconstructed rows instead of current ones and it computes an as-of liquidity result unchanged.
- **Missing ontology:** none new for cash. Physical-cash ambiguity is already modeled (`cash-movement.ts` — withdrawal/deposit form change), and runway/reserve need a user "expense buffer" setting that **does not yet exist** (the snapshot writer notes `cashOnHand = max(cash,0)` with no buffer).
- **Recompute vs snapshot:** reconstruct-on-read from transactions; `SpaceSnapshot.cash/savings/netLiquid` can serve the aggregate headline directly for dates already snapshotted.
- **Balance-based, transaction-derived, or both?** **Both, by tier:** the *aggregate* liquidity figure should read the persisted snapshot where present (authoritative, cheap); *per-account* liquidity and any date without a snapshot should reconstruct from transactions and be stamped **derived**. Transfers between liquidity tiers are already visible as classifier reasons.
- **Inaccurate/impossible:** dates before transaction depth (balance holds flat — stamp **incomplete**); "available vs current" (the data layer doesn't expose `availableBalance` to the lens — already an assumption).
- **Smallest viable slice:** as-of aggregate liquidity from `SpaceSnapshot` (`netLiquid`/`cash`/`savings`) with completeness stamp; per-account reconstruction is a later slice.
- **Complexity:** **Low–Medium** (reconstruction path exists; the work is wiring `asOf` and the stamp).

### C. Wealth

- **Answerable today:** historical net worth, total assets, assets-vs-debt — **directly from persisted `SpaceSnapshot`** (`netWorth`, `totalAssets`, `debt`), already currency-stamped and estimated-flagged.
- **State to reconstruct:** none for snapshotted dates; **missing dates** need handling.
- **Existing support:** strong. `SpaceSnapshot` + `lib/data/snapshots.ts` (stamp-aware, currency-converting reads) + the Wealth adapters. Wealth is deliberately assets-only in the UI today; net-worth history lives on the snapshot.
- **Missing ontology/data:** contribution-vs-market-growth decomposition (**not earned** — needs per-asset flows + prices); account additions/removals as events (derivable from `createdAt`/`deletedAt` + `SpaceAccountLink`, not yet surfaced); imported historical balances (no path to assert a manual past balance).
- **Are daily snapshots sufficient?** **For the headline net-worth-over-time line, yes.** For decomposition ("why did it change"), **no** — snapshots hold non-cash flat, so a rising line during a flat-held window is not evidence of market growth.
- **Missing-date handling:** three honest options, in order of preference — (1) **carry-forward the last snapshot** and stamp the gap **incomplete/derived**; (2) reconstruct via the existing cash walk-back for the cash component only; (3) leave a visible gap. Never interpolate silently into a canonical-looking line.
- **Smallest viable slice:** as-of net worth read from `SpaceSnapshot`, with `isEstimated` surfaced as "reconstructed" and gaps stamped.
- **Complexity:** **Low** (read path exists) for the headline; **High** for decomposition (defer).

### D. Debt

- **Answerable today:** total debt, estimated monthly interest (balance × APR/12, flagged estimated), blended APR, minimum payments, next promo-APR expiry — via the registered `debt` lens. Debt payments by creditor and "debt eliminated" as flows via Cash Flow's liquidity axis (`DebtPaymentsWidget`).
- **State to reconstruct:** per-liability balance on a date. **Revolving cards already have a reverse walk** (`reconstructDailyLiabilityBalances`, `owed(d) = owed(d+1) + Σ amount(d+1)`); installment loans are **held flat**.
- **Existing support:** balance history for cards (reconstruction), payment facts (Cash Flow), APR/min/promo (`DebtProfile`, user-asserted).
- **Missing / requires more:** **principal-vs-interest split**, projected payoff schedules, and per-statement interest **require APR + statement dates + an amortization model** the platform does not run. `DebtProfile` holds APR and due/statement days but **no statement history and no amortization engine**. Account closure / payoff is derivable (balance → 0, or `deletedAt`) as a **derived event**, not a stored one.
- **Recompute vs snapshot:** card balances reconstruct-on-read; installment balances have no honest historical value beyond flat.
- **Inaccurate/impossible now:** principal vs interest, true payoff date, statement-level interest. Do **not** synthesize these.
- **Smallest viable slice:** as-of total debt + per-card reconstructed balance, with installment loans explicitly stamped "held flat / incomplete."
- **Complexity:** **Medium** (reconstruction exists; the boundary discipline — refusing principal/interest — is the real work).

### E. Investments

- **Answerable today:** essentially **only** transaction-level activity where an investment account's transactions exist (contributions/withdrawals as flows), and *current* holdings/allocation. There is **no historical portfolio value, no historical position, no historical price.**
- **State to reconstruct:** positions (qty per symbol per date), valuations (qty × historical price), cost basis, realized/unrealized gain. **None of the required inputs are persisted historically.**
- **Existing support:** current `Holding` rows only (overwritten each sync); `ProviderType` includes `EXCHANGE`/`BROKERAGE` and `Connection`/`ProviderAccountIdentity`/`ImportBatch` foundations exist; Plaid investments consent gating exists. But holdings history and security prices do **not**.
- **Missing ontology (substantial):** `Position`/`Holding` **history**, `PriceObservation` (security/crypto price time series — the analog of `FxRate`), `Trade`, `Contribution`/`Withdrawal`, `Dividend`/`Interest`, `Fee`, `CorporateAction`, `CostBasis`/tax-lot.
- **Recompute vs snapshot:** portfolio value **cannot** be recomputed without a price series; positions **cannot** be reconstructed reliably from transactions without normalized trade events. This perspective **requires persisted history**, not compute-on-read.
- **Inaccurate/impossible now:** any historical portfolio valuation, allocation-over-time, return decomposition, realized/unrealized gain, cost basis.
- **Smallest viable slice:** **none until provider data is normalized.** The honest first step is the *contract*, not a TM feature.
- **Complexity:** **High**, and gated on data that does not exist.

**Explicit answer — can normalized investment data flow through a shared Time Machine framework?** **Yes, but only after two persisted time series exist that mirror the FX pattern:** (1) a **position/holding history** (qty per symbol per account per date, append-only — the exact opposite of today's delete+recreate), and (2) a **`PriceObservation`** series (symbol → date → price, structurally identical to `FxRate`). Once those exist, the shared shell reuses cleanly: valuation = Σ(qty × price@date) converted via the existing FX context, and the completeness/trust stamp degrades exactly as FX misses do today.

**Minimum canonical investment contract required (and no more):**

- `PriceObservation { symbol, date, price, currency, source, fetchedAt }` — a securities/crypto twin of `FxRate`, same walk-back semantics, same provenance.
- `PositionSnapshot { accountId, symbol, quantity, date, source, isEstimated }` — append-only, never overwritten; the honesty-valve mirror of `SpaceSnapshot.isEstimated`.
- A normalized **investment event** vocabulary — `Trade | Contribution | Withdrawal | Dividend | Interest | Fee | CorporateAction` — expressed as `FlowType`/`Transaction` extensions where possible, so it flows through the same event log.

Do **not** build full tax-lot / cost-basis accounting to ship a Time Machine. Cost basis and realized gain are a *later* claim that requires the trade series above plus lot-matching policy; define the boundary and stop there.

---

## 5. Shared architecture recommendation

**Recommended pattern: shared shell + per-perspective adapters, implemented by extending the existing `perspective-engine` — not a new generic engine, and not independent per-perspective rebuilds.**

The evidence for this is that the pattern already exists in three layers and just needs one new axis:

1. **Engine layer** (`lib/perspective-engine/`): pure lenses, injected clock, `LensResult` with `verdict`/`metrics`/`assumptions{source}`/`provenance{dataAsOf, tierCounts, redactions}`/`estimated`. Add **`asOf?: string`** to `ComputeOptions` (or a sibling of `PerspectiveScope`) and a **completeness envelope** to `LensResult`. Lenses that can reconstruct consume as-of rows; lenses that cannot **fail shaped as "no coverage."**
2. **Data layer**: `getAccountsWithVisibility` (current) + an **as-of resolver** that returns reconstructed rows for a date (cash walk-back + card walk-back already exist; non-reconstructable types stamped). `SpaceSnapshot` serves aggregate reads directly.
3. **UI layer** (`components/space/widgets/*-adapters.tsx`): the shell already renders Cash Flow / Wealth / Debt / Liquidity through a `SectionRegistry` with per-perspective adapters. A **shared as-of / compare control** replaces the Cash-Flow-local `CashFlowPeriodSelector` as the top-level time control.

**Genuinely shareable (put in the shell):** as-of date + period selection; previous-period comparison; playback/navigation; chart cursor; snapshot provenance (`dataAsOf`, `reportingCurrency`); completeness indicator (from `isEstimated` + coverage); the "what changed?" *frame*; evidence drawer (already shared — `TransactionSliceDrawer`); Space privacy (already inherited via visibility tiers); reporting currency (already shared — `ConversionContext`, stamp-aware reads); annotations/financial events (derived-event surface).

**Must stay perspective-specific (adapters):** the state model (what "state" means — balances vs positions vs owed); aggregation; **valuation** (Wealth/Investments differ fundamentally); **change decomposition** (flows vs contribution-vs-growth vs principal-vs-interest); **confidence/completeness rules** (a flat-held investment is far less trustworthy than a reconstructed cash balance); event semantics.

**Rejected alternatives:**

- *One generic Time Machine engine* — premature. The valuation and completeness semantics are irreducibly different per perspective; a generic engine would either lie (uniform confidence) or collapse into per-perspective branches anyway. Violates "did the data earn this?"
- *Independent per-perspective implementations* — wasteful and inconsistent; they would each re-derive as-of, currency, and provenance that the engine already centralizes.

**One-line ruling:** *flexibility belongs in scope (add `asOf`), never in what a lens computes* — which is exactly the existing engine's own stated doctrine ("Do not generalize this into a query engine").

---

## 6. Investment-data funnel requirements

Ordered gates before Investments can join the shared Time Machine (each a stop condition for the next):

1. **Normalize provider activity into the canonical event log.** Trades/contributions/withdrawals/dividends/interest/fees arrive as `Transaction` rows with populated `flowType` (`INVESTMENT`/`INTEREST`/`FEE` already exist in the enum). Stop condition: an investment account's flows reconcile to its balance change over a window.
2. **Persist position history** (`PositionSnapshot`, append-only). Reverse today's `deleteMany`+`create`. Stop condition: a prior day's positions are queryable and never silently overwritten.
3. **Persist a security/crypto price series** (`PriceObservation`, the `FxRate` twin). Stop condition: `value@date = qty × price@date` resolves, degrading to `estimated` on a miss exactly like FX.
4. **Only then** wire an `investments` lens into the engine with the shared as-of + completeness envelope. Return/allocation/gain decomposition is a *further* slice gated on cost-basis policy.

Minimum canonical contract restated: `PriceObservation`, `PositionSnapshot`, and an investment-event vocabulary on the existing log. No tax lots to ship the first Investment TM.

---

## 7. Data / compute / storage impact

Order-of-magnitude, not invented precision.

- **Transactions:** the event log grows roughly linearly with connected accounts × activity — plausibly **10²–10⁴ rows per active Space per year**. Period folds are indexed (`@@index([financialAccountId, date])`, `[flowType, date]`); compute-on-read is fine into the low millions per query scope. No materialization needed for Cash Flow at these volumes.
- **`SpaceSnapshot`:** **1 row/Space/day** ≈ **365 rows/Space/year** — negligible (kilobytes/Space/year). Years of net-worth history cost almost nothing. This is the cheap win.
- **FX lookups:** already a walk-back over an indexed daily series; cached per request via `ConversionContext`. Historical FX per day is already how backfill values each reconstructed day.
- **Reconstruction cost:** the cash/card walk-back is O(days × accounts) over a `groupBy` — cheap for a 30–730-day window; it is the compute floor for per-account as-of.
- **Price lookups (future Investments):** a `PriceObservation` series is the same shape/cost as FX; storage is symbols × trading days — still small.
- **Position history (future):** append-only per sync; **the only meaningful storage growth**, bounded by (accounts × symbols × sync frequency). Prefer **event-driven** writes (on holdings change) over blind daily rows.

**Model recommendation:**

- **Cash Flow / Liquidity / per-account as-of:** **compute-on-read** (reconstruct from the event log). No new rollups.
- **Wealth net-worth line:** keep the **persisted daily `SpaceSnapshot` rollup** — it is the right materialization and already exists.
- **Snapshot cadence:** the current **event-driven "today" write + bounded backfill** is correct. Do **not** move to blind daily cron snapshots of everything; write on balance-changing events (the `lib/events` bus already does this for share changes) and reconstruct the rest.
- **Recompute after backfills/corrections:** today past snapshot rows are frozen while new transactions can change what a past balance *should* be. Accept this for now and **stamp it** (completeness), rather than eagerly regenerating history — eager regeneration is the first step toward needing bitemporal, and the data hasn't earned it.
- **Retention:** snapshots and FX are cheap — retain indefinitely. Position/price series (future) get an explicit retention policy at design time.

---

## 8. Ontology gaps — "did the data earn this?"

| Candidate concept | Earned? | Verdict |
|---|---|---|
| **`SnapshotCompleteness` / trust stamp** | **Yes** | Highest-value small addition. `SpaceSnapshot.isEstimated` already exists; formalize into observed/derived/estimated/incomplete on any as-of result. **Build.** |
| **`FinancialEvent`** (account added/removed, payoff, closure) | **Partially (as derived)** | Derivable from `createdAt`/`deletedAt`/`SpaceAccountLink`/balance→0. Surface as a **derived** event stream; do **not** persist an event store yet. |
| **`PriceObservation`** | **No (needed for Investments only)** | The `FxRate` twin. Build **only** when Investment TM is scheduled. |
| **`PositionSnapshot` / `Holding` history** | **No** | Required for Investment TM; reverses today's overwrite. Gate behind provider normalization. |
| **`Trade` / `Contribution` / `Withdrawal` / `CorporateAction`** | **No** | Investment event vocabulary; express on the existing log where possible. Defer. |
| **`DebtTerms` / amortization** | **Partial** | `DebtProfile` holds APR/dates but no statement history/engine. Enough for balance + interest *estimate*; **not** for principal-vs-interest. Do not build amortization to ship TM. |
| **`CashPosition`** | **Already modeled** | `cash-movement.ts` (withdrawal/deposit form change). No new concept. |
| **`Valuation`** | **Partial** | Exists implicitly for cash/debt (balance) and via FX; missing only for securities (needs `PriceObservation`). |
| **`FinancialState`** | **No — resist** | A universal state object is the "elegant abstraction" the prompt warns against. Keep state perspective-specific. |
| **`KnowledgeVersion`** (bitemporal) | **No** | Only the *corrections* sub-case is arguably earned; defer to the final phase. |

**Net:** build exactly **one** new ontology concept now — the **completeness/trust stamp** — and a **derived** (non-persisted) financial-event surface. Everything else is deferred and gated.

---

## 9. Heuristic and trust model

Every place Time Machine relies on a heuristic, and the tier it must wear so an estimate never appears as a canonical fact:

| Reconstruction / inference | Trust tier |
|---|---|
| Posted transaction; today's live balance; a stored `FxRate` for the date | **observed** |
| Cash balance walked back from transactions; revolving-card owed walked back | **derived** |
| Non-cash held flat (investments/crypto/manual/installment loans); FX rate walked back / missing; estimated minimum payment; monthly interest = balance×APR/12 | **estimated** |
| `DebtProfile.apr`, manual account balances, manual asset values | **user-asserted** |
| Any date before an account's earliest transaction or before it was linked; portfolio value with no price series | **incomplete** |

**Recommended surface:** a single **completeness stamp** on every as-of/Time-Machine result — the worst tier among its contributors, plus a one-line reason ("Cash reconstructed from transactions; investments held at today's value; 2 accounts have no history before Apr 3"). This is a direct generalization of the `perspective-engine`'s existing `assumptions[].source` (`default|user|provider|estimate`) and `LensResult.estimated` — it is *already how the engine talks*. The rule: **estimated/incomplete values render visibly labeled and are never summed into a figure presented as observed.** This is the enforcement of "did the data earn this?" at the pixel.

---

## 10. UX recommendation

Smallest coherent cross-perspective UX:

- **One global time control** in the perspective shell: an **as-of date** (or period) that every perspective reads — replacing the Cash-Flow-local selector as the top-level control while keeping Cash Flow's fine-grained explicit-period picker inside its History widget.
- **Compare mode / "Then vs Now":** two selections, a delta readout. Start in Cash Flow (earned) and Wealth (earned via snapshots).
- **Completeness indicator:** a small, always-present badge driven by the §9 stamp. When a perspective **lacks coverage** for the chosen date, it shows an honest empty/partial state ("No history before you linked this account" / "Investments shown at today's value"), never a fabricated line. This reuses the engine's existing shaped-`empty` and `estimated` conventions.
- **"What changed?" drawer:** for Cash Flow, the flow deltas; for Wealth/Liquidity/Debt, the balance deltas with contributing accounts. Powered by the shared evidence drawer (`TransactionSliceDrawer`) — already built.
- **Milestone markers / playback / chart cursor:** shell-level chrome over whatever series the active perspective supplies; degrade gracefully where a perspective has no series (Investments today).
- **Keep ontology terminology internal:** users see "reconstructed," "held at today's value," "no history yet" — never "isEstimated," "derived tier," or "bitemporal."

**Behavior when a perspective lacks coverage:** the shared control stays; the perspective returns a shaped partial/empty result with the completeness reason. The shell never blanks the whole screen because one perspective can't answer — this is exactly the engine's fail-shaped, per-lens-degrade contract.

---

## 11. Phased roadmap

Ordering **revised from the prompt's suggested sequence based on repository evidence.** The prompt lists Cash Flow comparison first; the evidence says the *architecturally load-bearing* first move is to stand up the two shared primitives (as-of + completeness) against the one perspective whose history is already **persisted** — Wealth — because that proves the seam with **zero new schema**. Cash Flow comparison is equally low-effort but Cash-Flow-local and does not exercise the shared seam.

| Phase | User result | Required backend primitives | Files/subsystems | Migration? | Real-data validation | Stop condition | Complexity |
|---|---|---|---|---|---|---|---|
| **0. Shared seam via Wealth as-of** *(recommended first)* | Pick a past date → see net worth / assets / debt then, with an honest "reconstructed/complete" badge | `asOf` in engine options; completeness envelope on `LensResult`; a `wealth` (or net-worth) read from `SpaceSnapshot` | `lib/perspective-engine/types.ts`, new `lenses/networth.*`, `lib/data/snapshots.ts`, a shell as-of control | **None** (`isEstimated` already exists) | Against a Space with ≥30 snapshot days + a gap | As-of net worth reads correctly and gaps/estimates are stamped, never interpolated silently | **Low** |
| **1. Cash Flow "Then vs Now"** | Compare two periods; see Cash In/Out and spending deltas | Diff helper over existing `DayFacts` | `cash-flow-projection.ts` (read), new compare adapter, shell compare control | None | Two periods on a real Space | Deltas match independent recomputation of each period | **Low** |
| **2. Liquidity Time Machine** | Spendable cash / marketable / illiquid as of a date | As-of row resolver feeding the pure `liquidity.core` (cash walk-back exists) | `lenses/liquidity.*`, as-of resolver, completeness | None | Date within and beyond transaction depth | Reconstructed liquidity matches snapshot on snapshotted dates; stamps incomplete beyond depth | **Low–Med** |
| **3. Debt Time Machine (balances only)** | Total debt + per-card balance as of a date; installment loans stamped "held flat" | Card reverse-walk (exists) into `debt.core`; refuse principal/interest | `lenses/debt.*`, as-of resolver | None | Card-heavy + loan-heavy Spaces | Card balances reconstruct; principal-vs-interest is explicitly **not** shown | **Medium** |
| **4. Cross-perspective derived financial events** | Milestone markers (account added, debt paid off) on the timeline | Derived-event surface from `createdAt`/`deletedAt`/balance→0 | New `lib/events/derived-*` read model, shell markers | None (derived, not stored) | Real account lifecycle | Events are derived deterministically, none fabricated | **Medium** |
| **5. Investment funnel → Investment TM** | Portfolio value / allocation over time | `PriceObservation`, `PositionSnapshot` (append-only), investment-event normalization, `investments` lens | `prisma/schema.prisma`, `lib/plaid/refresh.ts` (stop overwriting holdings), new price/position writers, new lens | **Yes** (new tables) | Brokerage + exchange + wallet Spaces | Historical valuation resolves and degrades like FX; no value shown without a price | **High** |
| **6. Knowledge-as-known-then (corrections only)** | "As we recorded it then" vs "as corrected" | `KnowledgeVersion`/as-recorded-at stamp on corrections | Correction pipeline, snapshot writer | **Yes** | Spaces with provider restatements | Only reached if backfills routinely rewrite shown history **and** users anchor decisions to it | **High** |

---

## 12. Smallest recommended next slice

**Phase 0: read-only Wealth "as-of" from existing `SpaceSnapshot`, with a shared completeness stamp.**

Why this and not Cash Flow comparison: both are low-effort, but Phase 0 is the only slice that *forces the two shared primitives into existence* — an `asOf` on the engine and a completeness/trust envelope on `LensResult` — against the one perspective whose history is already **persisted**, with **zero migration**. It converts `SpaceSnapshot.isEstimated` (already shipped) into a user-visible trust badge, establishes the shell's global as-of control, and every later phase reuses both. Cash Flow "Then vs Now" (Phase 1) is the ideal fast-follow and can be built in parallel by a second pass, but it does not exercise the shared seam and so should not be the *first* proof.

Scope guardrails: **read-only**; no new tables; no interpolation of missing dates (carry-forward or gap, stamped); no change-decomposition; net-worth-line only (no contribution-vs-growth).

---

## 13. Exact investigation/implementation prompt for the next slice

> **Task: Implement Phase 0 — read-only Wealth "as-of" from existing `SpaceSnapshot`, with a shared completeness stamp. Branch `feature/v2.5-spaces-completion`.**
>
> **Do not** add or modify Prisma models or run migrations. `SpaceSnapshot.isEstimated` and `reportingCurrency` already exist — use them. Read-only feature: no writes to historical data, no interpolation that could be mistaken for observed data.
>
> **1. Investigate first (report inline before coding):**
> - Confirm `lib/data/snapshots.ts` read paths (`getRecentSnapshots`, `getPortfolioHistory`) and the exact `SpaceSnapshot` fields available (`netWorth`, `totalAssets`, `debt`, `cash`, `savings`, `isEstimated`, `reportingCurrency`, `date`).
> - Confirm the `perspective-engine` contract (`lib/perspective-engine/types.ts`): `ComputeOptions`, `PerspectiveScope`, `LensResult`, `LensProvenance`, `assumptions[].source`, and the existing `estimated` flag. Confirm the registration pattern in `registry.ts`/`index.ts` and the visibility read via `getAccountsWithVisibility`.
> - Confirm the shell/adapter wiring in `components/dashboard/SpaceDashboard.tsx` + `components/space/widgets/wealth-adapters.tsx` and how `CashFlowPeriodSelector` feeds a single `period` today.
>
> **2. Add the shared primitives (minimal):**
> - Add `asOf?: string` (YYYY-MM-DD) to `ComputeOptions` (or a documented sibling of `PerspectiveScope`). Absent ⇒ byte-identical current behavior (kill switch).
> - Add a **completeness envelope** to `LensResult`: `completeness: { tier: "observed" | "derived" | "estimated" | "incomplete"; reason: string }`. Derive `tier` deterministically (snapshot present + `isEstimated=false` ⇒ observed; `isEstimated=true` ⇒ estimated/derived; no snapshot on/before the date ⇒ incomplete). Name-free, deterministic, serialisable — respect all existing engine invariants (no `Date.now()`, no Prisma import in the engine dir, fail-shaped).
>
> **3. Add a read-only net-worth/Wealth as-of lens:**
> - Pure core `lenses/networth.core.ts` + binding `lenses/networth.ts` that, given `asOf`, reads the nearest `SpaceSnapshot` on/before the date via the data layer, returns net worth / total assets / debt as metrics with the completeness stamp. Carry-forward from the last snapshot is allowed **only** with `tier: "derived"`/`"incomplete"` and an explicit reason; a date with no prior snapshot returns a shaped partial/empty result. **No interpolation.**
> - Preserve currency behavior via the existing stamp-aware conversion in `lib/data/snapshots.ts`.
>
> **4. UI (shell, minimal):**
> - A shared as-of date control in the perspective shell (reuse Atlas controls) that sets a single `asOf`. Wealth reads it; other perspectives ignore it this slice.
> - Render the completeness badge from `completeness` ("Reconstructed" / "No history before …") using existing empty/estimated conventions. Keep ontology terms internal.
>
> **5. Tests (mirror existing suites):**
> - `lenses/networth.test.ts`: determinism (injected clock + fixed `asOf` ⇒ byte-identical JSON), tier privacy (visibility tiers), completeness-tier derivation (observed vs estimated vs incomplete), empty/gap states, and that estimated values are never presented as observed.
> - Confirm context-less / `asOf`-less calls stay byte-identical (kill-switch guard).
>
> **6. Validate against real data:** a Space with ≥30 snapshot days including at least one `isEstimated` row and at least one gap. Verify observed vs reconstructed labeling and that gaps never render as a smooth canonical line.
>
> **Stop conditions:** as-of net worth reads correctly for snapshotted dates; gaps/estimates are stamped, not interpolated; no schema/migration; all engine invariants and existing tests still pass. Do **not** implement change-decomposition, contribution-vs-growth, per-account reconstruction, or any other perspective in this slice.

---

*End of investigation. No code was written, no files modified, no schema or migrations created.*
