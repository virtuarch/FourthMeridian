# 04 — Financial Integrity

Pre-beta audit of Fourth Meridian · `v2.6` · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · 2026-10-21 · read-only. Finding IDs `FIN-nnn`. The local dev Postgres was down, so installed constraints are evidenced from `prisma/schema.prisma` and `prisma/migrations` only; nothing was executed.

## 1. Verdict

Headline money is coherent: net worth is one function (`lib/account-classifier.ts:321-384`) and agrees across Overview, Daily Brief, AI tools, snapshots and history; provider identities are unique at the database; FX never silently substitutes 1.0; prices and FX are insert-only archives; the pending→posted lifecycle is one event with the current projection at the read boundary and a required CI audit guarding desync. The audit brief's two premises are both stale at HEAD: the AI allowance reservation fix is merged and fail-closed, and the payroll head-outlier defect is fixed.

What is not clean: a sibling of the fixed payroll defect remains (one paycheck more than three days late, or a lagging feed, removes every remaining paycheck from `project_cash` while the result is still labelled a complete evidence-based estimate: FIN-001); a user's category correction cannot change the economic classification of any Plaid row carrying a personal-finance-category code, so the only customer-facing correction lever does not reach money (FIN-002); negative income rows add to income; the Cash Flow page and the AI compute "monthly spending" over different populations (pending vs settled, local clock vs UTC); holdings are refreshed only by manual actions; and every money column is `Float` with rounding scattered across 15 local `round2` copies. No P0: no double charging, no unbounded spend, no wrong-customer assignment, no confirmed silent corruption of stored money. Weighted financial-integrity score: **6.1 / 10**.

## 2. Financial data lifecycle

### 2.1 Plaid transactions
| Stage | Where | Behaviour | Status |
|---|---|---|---|
| Ingestion | `lib/plaid/syncTransactions.ts:414-446` | `/transactions/sync` pages with `withPlaidRetry` (2 attempts); `MUTATION_DURING_PAGINATION` restarts from the persisted origin cursor, max 3 | IMPLEMENTED |
| Validation / identity | `:845-937` | `plaidTransactionId @unique` lookup, fingerprint fallback (`lib/transactions/fingerprint.ts:103-130`), create | PARTIAL: ambiguity picks `matches[0]` (FIN-009) |
| Normalisation | `lib/transactions/economic-date.ts:160-217`; `flow-classifier.ts:439-530`; `merchant-write.ts:257-258`; `flow-authority.ts:196-221` | economic date (first credible pending observation → bounded `authorizedAt` → posting date, UTC); classifier v5, PFC first; user category sources preserved on modify | IMPLEMENTED |
| Storage | `:1189-1192`, `:1163-1171` | each row its own statement; cursor persisted per page after rows; cursor-safety gate throws before advancing if any row failed | PARTIAL (no transaction per page; replay idempotent on the id) |
| Pending → posted | `:1116-1119`; `lib/transactions/event-write.ts:230-499` | pending id in `removed[]` ⇒ tombstone; posted row carries `pendingTransactionRef`; one `TransactionEvent`; dangling refs heal on replay | IMPLEMENTED; `audit-pending-posted-desync` REQUIRED in CI |
| Removed | `:1138-1140` | tombstone only; first removal time preserved; events reprojected | IMPLEMENTED |
| Reconciliation | `lib/plaid/refresh.ts:388-434` | `BALANCE_TX_MISMATCH` incidents, partial-unique incident key | IMPLEMENTED |
| Aggregation | `lib/transactions/cash-flow.ts:325-376` | spend by sign within cost flows; income sign-blind (FIN-003) | PARTIAL |
| Analytics | `canonical-spending.ts:273-287`; `lib/ai/forecast/streams.ts:141-242` | trailing 3 complete months net; income streams grouped merchant@account over 730 days, newest 100 rows flagged `truncated` | IMPLEMENTED |
| AI context | `tools.ts:2325-2440`; `lib/ai/measures/baseline.ts:186-226`; `lib/ai/brief/package.ts:270-300` | `project_cash`, `get_baselines` (STATED > CADENCE > MEASURED), Brief | PARTIAL (FIN-001) |
| Display | `lib/currency.ts:15-107` | Space = cents, outside = whole dollars (Intl) | IMPLEMENTED |

Loss/duplication/staleness points: reparenting-refused `modified` payloads are dropped while the cursor advances (FIN-010); fingerprint ambiguity can bind the wrong twin (FIN-009); a killed routine webhook sync on a settled Item is recovered only by the daily cron; `Holding` rows are refreshed only by manual refresh/enable/connect (FIN-006).

### 2.2 Plaid balances and holdings
`refreshBalancesForItem` (`lib/plaid/refresh.ts:179-265`): one `/accounts/get` per Item; `balance = current ?? existing` with `balanceLastUpdatedAt` always overwritten (FIN-011); last-writer-wins is correct for a provider snapshot; the billable real-time balance endpoint is never called. Holdings reconcile in one transaction on `Holding @@unique([financialAccountId, symbol])`; `PositionObservation @@unique([account, instrument, date, origin, source])`; `InvestmentEvent @@unique([source, externalEventId])`, re-pulled as a rolling 24 months on every call and in the cron outside the Item lock.

### 2.3 CSV / XLSX imports
Parse (`lib/imports/pipeline.ts:118-169`) → batch `PROCESSING` → **one tenant phase per row** (`app/api/accounts/[id]/import/route.ts:461,524,554`) → final status. Dedup per row: exact `(financialAccountId, externalTransactionId)` under a partial unique index when a reference column exists, otherwise a fingerprint read (`lib/imports/csv.ts:532-597`). No file hash, no batch idempotency key, no `maxDuration`, no row cap. Rollback (`app/api/imports/[id]/rollback/route.ts:179-270`) claims status first in one transaction and soft-deletes; match-updated rows are not reverted; `PROCESSING` batches are ineligible. Authorisation requires an ACTIVE link in the current Space plus owner/creator or FULL visibility with OWNER/ADMIN. Nothing ties file content to the target account (the URL id is the authority). See IDEMP-001 in `05-IDEMPOTENCY-CONCURRENCY.md`.

### 2.4 Crypto wallet observations
Scheduled sweep (`jobs/sync-crypto.ts:69` → `lib/crypto/wallet-refresh.ts:197`) takes no wallet lock (IDEMP-004); manual sync and Refresh All do. Row idempotency is sound: `PositionObservation` upsert per day; BTC movements `createMany skipDuplicates` on a partial unique; history rebuilds are `deleteMany + createMany` inside one transaction per chain. BTC moves balance only on a priced run; SOL/EVM stamp `lastUpdated` on every successful quantity read.

### 2.5 Manual accounts and assets
Create in one tenant transaction, not idempotent (a retry creates a second asset). `AssetValuation` has no uniqueness per (account, date) by design; the series keeps the latest `recordedAt` per date (equal-millisecond tie non-deterministic). No reparenting route exists; `lib/accounts/account-reparenting.ts:314-372` refuses cross-owner FK moves; the share route requires `fa.ownerUserId === userId`.

### 2.6 FX and prices
FX archive: USD-base daily closes, `@@unique([date, base, quote])`, raw `INSERT … ON CONFLICT DO NOTHING`; Open Exchange Rates → Frankfurter failover; each row converts at its economic date, live balances at yesterday UTC; a ≤ 7-day walk-back is flagged; a known-currency miss yields `amount: null`, excluded and counted, never 1.0; whole-display failure reverts to USD without persisting (contract-tested). Prices insert-only on `PriceObservation @@unique([instrumentId, date, basis])`.

### 2.7 Snapshots
`SpaceSnapshot @@unique([spaceId, date])` upsert, read-then-upsert with no version; regeneration from cron, wallet and price paths is best-effort and swallowed, so a failed regen leaves yesterday's row for today (IDEMP-012); wealth-history regeneration writes per day with no transaction. Totals persisted unrounded; `realAssets` is a `round2 + max(0, …)` residual at read.

## 3. Calculation engines (where money math happens)

| # | Engine | Rule | Pending | Refunds | Window | Consumers |
|---|---|---|---|---|---|---|
| E1 | `foldEconomicRow`/`economicTotals` (`cash-flow.ts:325-381`) | spend = SPENDING+FEE+INTEREST by sign; income = INCOME minus `NOT_INCOME`, sign-blind | included | net, clamp ≥ 0 | caller's rows | Cash Flow workspace, AI monthly rows |
| E2 | `categorySpendLedger` (`cash-flow.ts:693-740`) | per-category SPEND/CREDIT | included | per-category clamp | caller's | Cash Flow categories, `get_spending` |
| E3 | `readCanonicalSpending` (`canonical-spending.ts:273-287`) | E1 over assembler months | settled | net | trailing 3 complete months | assessment, runway, Brief, `get_baselines`, `project_cash`, goal seek |
| E4 | `computeAverageMonthlySpending` / `resolveExpenseBaseline` | STATED > DECLARED > MEASURED | settled | net | canonical months | assessment, Liquidity, Brief |
| E5 | `measure_flows` (`lib/ai/measures/measure.ts:190-230`) | headline spending **gross**, `netOfRefunds` beside | settled | disclosed | any period | AI tool |
| E6 | `get_baselines` (`baseline.ts:186-226`) | income STATED > CADENCE > MEASURED | settled | net | canonical | AI tool |
| E7 | `deriveObservedSpendingRate` (`observed-spending.ts:115-146`) | canonical months, interest removed | settled | net | last N complete months | forecast spine |
| E8 | `deriveSpendingBaseline` (`spending-baseline.ts`) | 28-day median gross | — | none | 28 days | **no production caller (dead)** |
| E9 | `projectCash`/`foldWindow` (`projection.ts:146-290`) | dated events + daily spend rate | — | — | horizon | `project_cash`, checkpoints, reconcile |
| E10 | `deriveCurrentPeriodicAmount` (`periodic-amount.ts:208-370`) | backward walk, 5% band, head-outlier symmetry | — | — | regime | income streams |
| E11 | `resolveStreamActivity` (`stream-activity.ts:143-365`) | tolerance 3 d; `MAX_MISSED_FOR_PROJECTION: 0` | — | — | — | projection eligibility |
| E12 | `classifyAccounts` (`account-classifier.ts:321-384`) | balances by type at yesterday UTC; `totalLiquid` = unrestricted | — | — | now | AI, Brief, snapshot writer, Overview |
| E13 | `computeSnapshotFields` (`backfill-core.ts:315-331`) | `netWorth = stocks+crypto+cash+savings+realAssets − debt`; `netLiquid` includes restricted | — | — | per day | Wealth hero/trend, history, Liquidity history |
| E14 | debt aggregates / `totalDebtPaid` | owed per row; DEBT_PAYMENT cash legs only | included | — | window | Debt, Cash Flow |
| E15 | Brief `impliedMonthlyIncome` (`metrics.ts:396-400`) | mean of monthly E1 income | settled | — | reliable months | Brief |
| E16 | AI allowance pricing (`allowance-core.ts:65-76`) | priced returned rows only; unpriced ⇒ refuse | — | — | UTC day | chat/brief admission |

Confirmed disagreements (same words, different numbers): "monthly spending" gross (E5) vs net (E3/E4/E6); Cash Flow page includes pending rows and uses local-clock period boundaries vs AI settled-only UTC (FIN-004); liquid now excludes restricted cash while liquid history includes it (FIN-005); three income bases (E9/E10/E11 cadence events, E6 measured fallback, E15 window mean), each labelled, but a late paycheck flips E6 from CADENCE to MEASURED and E9 to zero while E15 is unaffected (FIN-001, FIN-012). Net worth agrees everywhere. Three projection engines coexist (`forecastCash`, `projectCash`, the scenario ledger, plus `lib/debt/payoff.ts`); their numeric parity could not be established read-only (CQ-017).

## 4. Paycheck-level inference (the brief's special attention)

The 2026-10-16 fix (head-outlier symmetry in `lib/forecast/periodic-amount.ts:264-285`; `INCOMPLETE_ESTIMATE` with a bound in `lib/ai/forecast/income-completeness.ts`) is present. The untouched sibling: `ACTIVITY.MAX_MISSED_FOR_PROJECTION: 0` and `SETTLEMENT_TOLERANCE_DAYS: 3` (`stream-activity.ts:157,170`) make one covered miss `SILENT` and one unobserved due occurrence `UNKNOWN`, both non-projectable; `observedThroughISO` is derived from the newest income row rather than the account's sync clock (`streams.ts:209-211`), so a paycheck more than three days late reads as the ledger "not reaching" it; `incomeCompleteness` maps `!projectionEligible` to `LAPSED`, which is non-blocking (`income-completeness.ts:135-136,162`); `project_cash` then returns `kind: 'EVIDENCE_BASED_ESTIMATE'` with only a prose qualification that no recurring income is counted (`tools.ts:2107-2109, 2400`). Any biweekly or monthly payroll whose latest occurrence is ≥ 4 days past its slot at `asOf` (holiday shifts, Plaid lag, employer delay) drops every remaining paycheck from the year-end projection under a "complete" label while the Brief (E15) is unaffected, so the two surfaces disagree. A refund, transfer or bonus does not trigger this path (income streams skip `amount ≤ 0`; bonuses are handled by the regime walk and disclosed), but a negative income row overstates E1/E15 income by twice the clawback (FIN-003).

## 5. Findings

| ID | Finding | Sev | Status | Evidence | Impact | Remediation | Blocker | Conf. |
|---|---|---|---|---|---|---|---|---|
| **FIN-001** | One late or missing paycheck (or a lagging feed) removes all projected payroll from `project_cash` while the result is still `EVIDENCE_BASED_ESTIMATE`; `get_baselines` silently falls from CADENCE to MEASURED | P1 | IMPLEMENTED by design, mis-labelled | `stream-activity.ts:157,170,337-365`; `streams.ts:209-211,235`; `income-completeness.ts:45-46,135-136,162`; `tools.ts:2107-2109,2400`; `baseline.ts:197` | year-end cash falls by every remaining paycheck (tens of thousands on the measured Space); the same customer-visible collapse the owner escalated on 2026-10-16, from an ordinary calendar event | treat a current-eligible stream that went silent/unknown within one occurrence as a blocking `RECENTLY_SILENT` ⇒ `INCOMPLETE_ESTIMATE` with the bound; split LAPSED from UNKNOWN; derive `observedThroughISO` from the account's sync clock; regression: 11 flat paychecks, newest slot 5 days overdue ⇒ INCOMPLETE | **Yes** | high |
| **FIN-002** | A user's category correction cannot change `flowType` on any Plaid row carrying a PFC code; the correction surface is silently ineffective for income/transfer/spending relabelling (prior FM-AUDIT-014 still open) | P1 | defect | `merchant-corrections.ts:124-146`; `plaid-flow-input.ts:435-447`; `flow-classifier.ts:443-446`; `flow-authority.ts:65-69` (no USER authority); tests cover PFC-null rows only | the user sees the new category on the row while every total, baseline, stream and projection keeps the old economics | run the classifier with PFC suppressed when `categorySource ∈ {USER_RULE, USER_OVERRIDE}` or add a USER flow authority; pin with a PFC-bearing fixture | **Yes** | high |
| FIN-003 | Negative INCOME rows (clawback, reversed deposit) increase income (FM-AUDIT-015 open) | P2 | defect | `cash-flow.ts:318,361-370` | E1/E15/E5 income and Brief `impliedMonthlyIncome` overstated by 2× the clawback | sign-aware income or a named reversal side | No | high |
| FIN-004 | Cash Flow workspace folds pending rows and uses local-clock period boundaries; AI/Brief use settled-only UTC (FM-AUDIT-013 open) | P2 | PARTIAL | `lib/data/banking-population.ts`; `cash-flow.ts:109-114,230-232`; `lib/ai/assemblers/transactions.ts:585,696-699` | same month, two income/spending figures; MTD moves as pendings settle | one rule or an explicit split on the page | No | high |
| FIN-005 | Liquid "now" excludes restricted cash; liquid history and snapshot `netLiquid` include it | P2 | PARTIAL | `account-classifier.ts:329-348` vs `backfill-core.ts:319-330`; `lib/liquidity/cash-history.ts:8-12` (comment claims parity) | Liquidity chart ≠ hero by the HSA/retirement-cash amount | align history with `totalLiquid` | No | high |
| FIN-006 | `Holding` rows go stale between manual refreshes; the `HOLDINGS/DEFAULT_UPDATE` webhook and the cron never refresh holdings (comment claims otherwise) | P2 | STUBBED | `webhook-receiver.ts:96-98` vs `backgroundHistorySync.ts:492-674`; `jobs/sync-banks.ts:105-157` | position-level enrichment stale while net worth is current | consent-gated holdings stage in the pipeline | No | high |
| FIN-007 | `ITEM/ERROR`, `PENDING_EXPIRATION`, `USER_PERMISSION_REVOKED` webhooks are recorded but change no state | P2 | PARTIAL (documented "for now") | `webhook-receiver.ts:118-130`; `route.ts:24-26` | an Item stays ACTIVE and keeps being selected by the cron (billable) until a sync fails | map codes to health transitions | No | high |
| FIN-008 | Brief never discloses FX-excluded (unconverted) balances | P2 | PARTIAL | `package.ts:373-374` carries `totalsUnconverted`; no reader | only non-USD reporting currencies | surface in the prompt | No | medium |
| FIN-009 | Fingerprint adoption on ambiguous matches binds `plaidTransactionId` to `matches[0]` | P2 | PARTIAL | `fingerprint.ts:124-129`; `syncTransactions.ts:946-1052` | wrong twin bound; the real twin creates a duplicate | refuse adoption when more than one match; record an issue | No | medium-high |
| FIN-010 | Reparenting-refused `modified` payloads are dropped permanently while the cursor advances | P2 | named trade-off | `syncTransactions.ts:895-927` (`cursorBlocking:false`) | data loss recoverable only from `SyncIssue.detail` | quarantine row + operator replay | No | high |
| FIN-011 | Plaid null `current` balance keeps the prior value but the freshness stamps are updated (FM-AUDIT-023) | P2 | UNVERIFIED | `refresh.ts:233-242` | freshness overstated | clock disclosure | No | medium |
| FIN-012 | Three income bases across surfaces (cadence events / measured / Brief mean) with no cross-surface reconciliation | P3 | labelled | E6/E9/E15 | different numbers with different labels | document; reconcile | No | high |
| FIN-013 | Monetary precision: all-`Float` storage (63 columns, 0 `Decimal`), raw f64 folds, ≥ 15 local `round2` copies, 3 `MONEY_EPSILON` definitions, one unguarded `< 0` crossing test | P3 | — | schema (`Transaction.amount :2434`, `FinancialAccount.balance :1243`, `SpaceSnapshot :3107-3120`, `FxRate.rate :3697`); `engine.ts:485-488`; `convert.ts:22-24` | 1e-14-class residue; display safe; maintenance risk | one `lib/money/round.ts` + one epsilon; lint rule | No | high |
| FIN-014 | Null-currency legacy rows are relabelled as the reporting currency with `estimated` | P3 | documented | `convert.ts:73-77` | non-USD Spaces only; magnitude needs a DB count | — | No | medium |
| FIN-015 | `SpaceSnapshot` stores no `realAssets`; residual is `round2 + max(0, …)`; schema comment omits real assets | P3 | — | `backfill-core.ts:315-331`; `schema:3117` | — | persist; fix comment | No | high |
| FIN-016 | Card in credit contributes 0 liability and 0 asset (`creditHeld` unused) | P3 | — | `lib/debt/balance-semantics.ts:66-68` | — | — | No | high |
| FIN-017 | `allowanceUsdOf` floors to whole dollars; an override of $0.99 ⇒ 0 ⇒ every turn refused | P3 | — | `lib/ai/allowance.ts:67-70` | operator surprise | validation message on the override field | No | high |
| FIN-018 | Historical amendment: disabled correctly (503 `AMENDMENT_DISABLED` after the OWNER gate, before `req.json()` and any engine work) | — | STUBBED by owner ruling | `amendment-availability.ts:28`; `wealth/amend/route.ts:41-55` | — | — | — | high |
| FIN-019 | Billing / subscription | — | NOT APPLICABLE | no payment provider, model or route | — | — | — | high |

Strengths verified: net worth one function across five surfaces; FX miss never 1.0 and never relabelled for a known currency; insert-only archives with DB uniqueness for prices, FX, observations, investment events; provenance fields persisted per row (`flowAuthority`, `classifierVersion`, `categorySource`, `economicDate`, `transferEvidence`, `pendingTransactionRef`); conversation provenance per figure; refund netting with `refundsUnapplied`; transfer admission by flow with same-owner/currency/amount/5-day rules and mutual uniqueness.

## 6. Scores

| Item | Score | Weight | Evidence | Strengths | Weaknesses | Conf. | Beta impact | Improvement |
|---|---|---|---|---|---|---|---|---|
| Monetary precision | 6 | 6 | FIN-013 | signed dollars end-to-end; FX never rounds; Intl display; epsilon in most comparisons | all Float; scattered rounding; 3 epsilons | high | low | one rounding module |
| FX conversion / freshness | 8 | 5 | §2.6 | never 1.0; miss excluded and counted; walk-back flagged; contract-tested revert | null-currency relabel; Brief silent on unconverted | high | low (USD beta) | FIN-008 |
| Reconciliation (provider vs ledger) | 6 | 6 | §2.2 | mismatch incidents converge | no holdings refresh outside manual; null-balance stamping | medium | medium | FIN-006/011 |
| Duplicate prevention | 6 | 8 | §2.1, §2.3 | Plaid replay idempotent; investment events unique | CSV concurrent duplicates (IDEMP-001); fingerprint ambiguity; duplicate-Item TOCTOU | high | medium-high for import users | file-hash key; refuse ambiguous adoption |
| Balance consistency | 7 | 6 | §2.2, FIN-005 | provider snapshots last-writer-wins; BTC moves only on priced runs | restricted cash in history; stale holdings | high | low | FIN-005 |
| Account aggregation | 7 | 7 | §3 | net worth one function; refund netting | gross vs net headline in `measure_flows`; pending in UI only | high | low-medium | make `measure_flows` headline net |
| Income / expense classification | 5 | 9 | FIN-002/003 | classifier v5 with liability vetoes; desync audit required | PFC outranks the user's correction; negative income adds | high | medium | USER flow authority; sign-aware income |
| Transfer detection | 7 | 6 | `transfer-admission.ts:149-160`; `transfer-maturation.ts:680-830` | admission by flow, mutual uniqueness, cross-owner counted not paired | cross-currency never pairs | high | low | flag unresolved legs |
| Pending vs posted | 7 | 5 | §2.1, FIN-004 | one event; current projection at the read boundary; required audit | UI includes pending; AI excludes | high | low | one rule or explicit split |
| Historical corrections | 5 | 5 | FIN-002, FIN-018 | correction route transactional and visibility-gated; amendment gated before engine | correction cannot move money | high | medium | FIN-002 |
| Financial snapshots | 6 | 6 | §2.7 | unique per day; completeness tier | read-then-upsert; swallowed regen failures; non-atomic history regen | high | low-medium | version stamp; surface failures |
| Forecast consistency | 5 | 10 | FIN-001/012 | head-outlier symmetry; `INCOMPLETE_ESTIMATE` with bound; reconcile attribution | late paycheck ⇒ payroll dropped under a complete label; three income bases; spending window changed 2→3 months without a definition version on stored checkpoints (UNVERIFIED) | high | **high** | FIN-001 |
| Timezone / UTC boundaries | 7 | 4 | §2.1 | UTC everywhere for economic date, periods, allowance day, snapshots | Cash Flow local-clock boundaries; no user-timezone concept | high | low | one date convention; tell users days are UTC |
| Completeness disclosures | 7 | 6 | freshness bands, completeness tiers, coverage envelope | measures carry completeness; absence contract | Cash Flow page has no stale-source caveat; LAPSED vs UNKNOWN conflated | high | low-medium | split statuses; caveat on Cash Flow |
| Missing records / stale provider data | 6 | 5 | FIN-006/007/010 | freshness clocks per source | inert health webhooks; dropped reparent payloads; stale holdings | high | medium | FIN-007 |
| Data lineage | 8 | 5 | provenance fields | per-row and per-figure provenance | refused payloads not retained; no definition version on checkpoints | high | low | quarantine table; definition version |
| Paycheck-level inference | 5 | 6 | §4 | regime walk, slot contention, head symmetry, materiality, bound | one late paycheck collapses the projection | high | high | FIN-001 |

Weighted mean: **6.1 / 10**. Confidence high (end-to-end code reads; nothing executed); the prior audit's FM-AUDIT-003/004/005/016/021/022/025 remain UNVERIFIED (no code marker, not re-probed).

## 7. Contradictions and open questions
- Audit brief vs HEAD: `89a46ad` is merged; `docs/plans/AI-RELIABILITY-BETA-REPORT-2026-10-16.md` header still says "not merged" (stale when read).
- STATUS.md records the cost controls as "Preview-verified" although the 2026-10-16 report states those checks exercised the plain check; STATUS does not mention `89a46ad`, `e67fa58`, the fail-closed rule or the new CI step.
- `webhook-receiver.ts:96-98` claims the holdings webhook runs the full pipeline (FIN-006); `cash-history.ts:8-12` claims parity with `totalLiquid` (FIN-005); `income-completeness.ts:45-46` calls LAPSED "correctly not projected" (FIN-001); `schema.prisma:3117` net-worth comment omits real assets.
- Prior audit §26 status at HEAD: fixed 006, 007, 008, 009, 024, 027 (partial); open 013, 014, 015, 023 (unverified), dead E8; unverified 003, 004, 005, 016, 021, 022, 025.
- Open: whether stored checkpoints carry a definition version for the spending window; whether `deriveSourceHealth` disambiguates a null provider balance; counts of null-currency and pending-in-complete-month rows (needs a read-only DB query).
