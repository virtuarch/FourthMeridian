# Agent B — Financial Integrity · remediation report

Branch `remediation/b-financial` (worktree `FourthMeridian-remediation/b`), cut from `cde8fa0`. Local commits only; nothing pushed or merged; no live database, no provider keys. All tests are deterministic and DB-free (injected readers / in-memory fakes).

| Finding | Status | Commit |
|---|---|---|
| FIN-001 (P1) | FIXED | `07d59a8` |
| FIN-002 (P1) | FIXED (follow-ups outside B listed below — **one is required before merge**) | `f51ed98` |
| FIN-003 (P2) | FIXED | `66ed6bf` |
| FIN-005 (P2) | PARTIAL by design: split computed + basis labelled; stored column unchanged (schema is C's) | `dad72a6` |
| FIN-015 (P3) | FIXED in B's file; schema comment reported to C | `dad72a6` |
| FIN-009 (P2) | FIXED | `db5ee8d` |
| FIN-011 (P2) | FIXED | `ff2480f` |
| FIN-013 (P3) | PARTIAL (owned paths migrated; remaining copies listed) | `59dd238` |
| FIN-004 (P2) | DOCUMENTED, UTC change DEFERRED (not contained) | — |

---

## FIN-001 — one late paycheck / stale feed dropped all payroll under a "complete" label

**Root cause.** Three independent facts combined: (1) `streams.ts` took the ledger's reach (`observedThroughISO`) from the newest **INCOME** row, so an overdue slot always looked "unobserved"; (2) `stream-activity.ts` (correctly) withholds the licence for any SILENT/UNKNOWN stream; (3) `income-completeness.ts` mapped every unlicensed stream to `LAPSED`, which was non-blocking ⇒ `COMPLETE` ⇒ `project_cash` said `EVIDENCE_BASED_ESTIMATE` with the paychecks at $0.

**Semantic rule implemented (for the owner).**
- *The feed's reach is the feed's clock.* For each account, how far the ledger "looked" is the later of (a) the UTC date of the last successful transaction sync on its canonical connection (`Connection.lastSyncedAt` for Plaid — the item sync *is* the transaction sync; `Connection.transactionsSyncedAt` for wallets) and (b) the newest income row (the old behaviour, still the floor when no clock is on record), never later than the as-of date.
- *Continuation statuses* (disclosure only — the engine's licence to generate cash is unchanged):
  - `CURRENT` — licensed; projected as before.
  - `RECENTLY_SILENT` — schedule intact; the feed covered the due slot(s) and **at most 2** unpaid slots since the last paid one. **Blocking** when material.
  - `UNKNOWN` — schedule intact; due slot(s) the feed has **not reached** (stale feed). **Blocking** when material, however far behind.
  - `LAPSED` — 3+ unpaid covered slots, user said it ended, or no schedule. Disclosed, never blocking.
- A blocking stream carries the same bound the 2026-10-16 `AMOUNT_UNESTABLISHED` fix uses: `omittedAtLastObserved` = remaining scheduled slots in the horizon (after the last paid slot) × last observed amount, under the same 1%/$50 materiality rule. INTEREST streams never block. The projected figure still counts these streams at $0 — it is now labelled INCOMPLETE with the bound beside it.
- `get_baselines`: a recently-silent / unobserved stream no longer falls from CADENCE to MEASURED in silence — the income baseline carries `incomplete { streams, omittedMonthly, cadenceIfContinuing, meaning }` (when other streams are live the basis stays CADENCE at the live total). A savings rate still requires a recurring basis, so it is not computed from the silent stream.

**Files.** `lib/forecast/stream-activity.ts` (new `unobservedDueOccurrences` on `StreamActivity`; licence untouched), `lib/ai/forecast/streams.ts` (reader contract `AccountFacts.ledgerObservedThroughISO`, optional so all fakes still fit; production reader selects the canonical connection's clocks), `lib/ai/forecast/income-completeness.ts` (`RECENT_SILENCE`, `continuationOf`, `RECENTLY_SILENT`/`UNKNOWN`, `OMITTED_STATUSES`, `isOmittedLine`, `silence`), `lib/ai/measures/baseline.ts` (`IncomeStreamEvidence.continuation`, `IncomeBaseline.incomplete`).

**Tests** (audit fixture: biweekly $3,000 × 11, newest slot 2026-10-02, as-of 2026-10-21, horizon to 2026-12-31):
- `income-completeness.test.ts` F1 — 5 days overdue, feed current ⇒ SILENT(1 miss) ⇒ `RECENTLY_SILENT`, INCOMPLETE, bound **$15,000** (slots 10-30, 11-13, 11-27, 12-11, 12-25), fold still $0, `silence` = {2026-10-02, 1, 2026-10-21}.
- F2 skipped one cycle then resumed ⇒ CURRENT, PRESENT, $3,000, COMPLETE. F3 new level ⇒ PRESENT $3,300, $16,500 projected. F4 five unpaid ⇒ LAPSED, COMPLETE, no bound. F5 boundary: 2 unpaid ⇒ RECENTLY_SILENT ($15,000), 3 ⇒ LAPSED. F6 feed clock 2026-10-10 ⇒ UNKNOWN (0 misses, 1 unobserved), INCOMPLETE, $15,000; a feed months behind is still UNKNOWN, never LAPSED. F7 on-time control ⇒ PRESENT, **$15,000 projected**, COMPLETE. F8 immaterial $20 stream doesn't block. F9 INTEREST never blocks.
- `stream-read.test.ts` S16–S21 — through the loader with an injected reader: sync clock at as-of ⇒ SILENT; clock 2026-10-10 ⇒ UNKNOWN; no/null clock ⇒ old floor (2026-10-02); future clock clamped to as-of; older clock never shortens the reach; source pin on the canonical-connection select.
- `stream-activity.test.ts` D7/F6b — unobserved-due counts (null when unanswerable). `measures.test.ts` — four FIN-001 baseline checks (6,500 / 1,000 + 7,500).
- Unchanged and green: `lib/forecast/engine.test.ts` (145, incl. the 16 real-mutant checks), assemble, forecast integration paths, spending/scenario conversation suites.

**Required change outside B — `lib/ai/conversation/tools.ts` (D/H):**
1. `incompletenessBlock` (≈ line 2082): filter with `isOmittedLine(l) && l.material` (import from `@/lib/ai/forecast/income-completeness`) instead of `l.status === 'AMOUNT_UNESTABLISHED' && l.material`, and add `status: l.status, silence: l.silence ?? null` to each `omittedStreams` entry. Change the `meaning` sentence so it names the reason by status: AMOUNT_UNESTABLISHED = "its amount is not established"; RECENTLY_SILENT = "its latest scheduled payment has not arrived"; UNKNOWN = "the account's feed has not reached its due date". **Without this change, `project_cash` correctly returns `kind: 'INCOMPLETE_ESTIMATE'` (the mapping at ≈2400 needs no change) but `incomplete.omittedStreams` is empty.**
2. `projectionQualification` (≈2101): the INCOMPLETE sentence "could not be priced" → "is not counted (its amount is not established, or a scheduled payment is late or not yet visible)"; the `minor` filter should use `isOmittedLine(l) && !l.material`.
3. `get_baselines` (≈1236): pass `continuation: continuationOf(s)` into `incomeStreamEvidence(...)`, and add an optional `continuation` field to `incomeStreamEvidence` in `lib/ai/forecast/income-evidence.ts` (B can do that adapter change if the orchestrator wants it). Until then the baseline behaves exactly as before (no `incomplete` block).
4. `get_income` sources (≈937): optionally add `continuation: continuationOf(s)` beside `stillPaying`.

**Residual risk.** `RECENT_SILENCE.MAX_UNSATISFIED_OCCURRENCES = 2` is a judgement (one late + one skip), not measured; the corpus has no healthy stream with any miss. A Plaid item whose sync succeeds while the institution itself lags still reads as an observed miss ⇒ RECENTLY_SILENT (blocking, with bound) — the safe direction. `Connection.lastSyncedAt` is the item-level clock; a per-account lag inside one item is not visible.

---

## FIN-002 — a user's category correction never changed flowType on PFC-bearing rows

**Root cause.** `classifyFlow` takes the Plaid PFC first; `recomputeFlowFields` passed the row's unchanged PFC, so the re-derived flow was the provider's.

**Rule implemented.** When a row's category source is `USER_RULE` or `USER_OVERRIDE`, the user's category is the classification signal: the PFC is carried on the input (and persisted verbatim — immutable provider fact) but flagged `providerTaxonomySuppressed`, and `classifyFlow` skips its PFC step. The row stays `CLASSIFIER`-owned at the current classifier version; the ownership gate is unchanged (a TRANSFER_AUTHORITY / CRYPTO_LEDGER row still writes nothing).

**Why this, not a USER flow authority:** no schema/enum change (prisma is C's), no change to the flow-ownership model or the INV-A..C invariants of `audit-flow-desync`, and it composes with the existing "preserve USER_* on sync" rule. A USER authority would require an enum migration, new labels in two exhaustive maps, a write-site, and an answer to "who may displace USER" — a larger design.

**Files.** `lib/transactions/flow-classifier.ts`, `plaid-flow-input.ts` (`FlowRowInput.categorySource`, `isUserCategorySource`), `merchant-corrections.ts`.

**Tests.** `merchant-corrections.test.ts` §9: PFC=INCOME row → Transfer ⇒ TRANSFER; → Dining ⇒ REFUND (+500) / SPENDING (−500); → Payment ⇒ DEBT_PAYMENT; PFC/confidence persisted unchanged; still CLASSIFIER; PFC-null control unchanged; TRANSFER_AUTHORITY-owned row refuses; fold before/after (income 500 → 0; Dining −500 → 500 gross spend); end-to-end `applyTransactionOverride` stores TRANSFER. `flow-row-input.test.ts`: suppression only for USER sources.

**Required changes outside B (scripts are F/unowned; sync update arm is outside B's FIN-009 scope):**
- **`scripts/audit-flow-desync.ts` (REQUIRED audit) ≈ line 168 — MUST before merge:** select `categorySource` and pass `categorySource: r.categorySource` into `buildFlowInputFromRow`. Otherwise any user-corrected PFC row is reported as desynced (stored TRANSFER vs recomputed INCOME). The CI seed has no such rows, so CI stays green, but any real corpus fails.
- **`scripts/backfill-flowtype.ts` ≈ line 263:** same one-field change — otherwise a write-mode backfill would revert user corrections.
- **`lib/plaid/syncTransactions.ts` ≈ line 741 (miData OVERRIDE path, a USER rule applied to a newly synced row):** `buildPlaidFlowInput(...)` then `classifyFlow(input)` still lets the PFC win, so a USER merchant rule never moves the flow of *future* PFC rows. Fix: `classifyFlow({ ...input, providerTaxonomySuppressed: true })`. (The PRESERVE path is already correct: it does not touch existing USER rows.)

**Residual risk.** Existing rows the user corrected **before** this change still carry the PFC-derived flow; they change only on the next correction. A one-off reclassification of `categorySource IN (USER_RULE, USER_OVERRIDE) AND pfcPrimary IS NOT NULL AND flowAuthority='CLASSIFIER'` (via the fixed backfill-flowtype) would converge them — owner decision.

---

## FIN-003 — negative INCOME rows increased income

**Rule.** The economic fold sums INCOME **signed** (a clawback / reversed deposit subtracts). The window total is floored at 0 by `clampEconomicIncome` — the same policy refunds get on spend: a reversal nets within its window and never makes income negative; a window holding only a clawback reads $0 (the excess is not carried). `NOT_INCOME` rows remain excluded.
**Files.** `lib/transactions/cash-flow.ts` (fold + `clampEconomicIncome`, used in `economicTotals`), `cash-flow-projection.ts` (`perspectiveTotals`).
**Tests.** `cash-flow.test.ts`: +5000 then −500 ⇒ **4500** (was 5500); accumulator signed; clawback-only window ⇒ 0; NaN ⇒ 0; NOT_INCOME reversal excluded.
**Consumers outside B.** `lib/ai/assemblers/transactions.ts:950` reads `eco.income` directly (no clamp) — now signed; a month of only clawbacks yields a negative `incomeTotal` there. `measure_flows` and Brief `impliedMonthlyIncome` (`lib/ai/brief/metrics.ts`) consume those monthly `incomeTotal`s: they now net clawbacks (the fix) but a month could be < 0. Recommend (D/H): `incomeTotal = clampEconomicIncome(eco.income)` at `transactions.ts:950`. The DayFacts per-day `income` is signed by design (per-day facts honest; perspective totals clamp).
**Residual risk.** A clawback dated in the month after its deposit lowers that later month to ≥ 0, not the original month.

## FIN-005 — restricted cash in liquid history but not in the Hero

**Decision.** The stored `netLiquid = cash + savings − debt` (restricted included) is pinned as a stored-row invariant by `lib/snapshots/series-integrity.core.ts:167`, `aggregate-authorisation.core.ts:94/172` and the REQUIRED `check-snapshot-integrity` audit, and `SpaceSnapshot` has no restricted column; changing its meaning would break those invariants and silently re-base existing rows. So: `computeLiquidSplit(totals)` returns `{ liquid, restrictedCash, netLiquidUnrestricted }` (= `classifyAccounts.totalLiquid` basis) and `null` when totals carry no split (never an all-cash substitute); `computeSnapshotFields` adds no persisted key (it is spread into the row by `backfill.ts`). The Liquidity history slice now states `basis: 'ALL_CASH'`, and the false parity comment in `cash-history.ts` is replaced.
**Tests.** checking 10,000 + HSA 5,000 + savings 2,000 ⇒ `totalLiquid` 12,000 = `netLiquidUnrestricted` 12,000; stored `netLiquid` 17,000; gap 5,000; no-restricted case agrees; slice labelled ALL_CASH, plots 17,000.
**Needed to finish (C, schema):** add `SpaceSnapshot.restrictedCash Float @default(0)`, write `computeLiquidSplit(c).restrictedCash` in `regenerate.ts`/`backfill.ts`/`regenerate-history.core.ts`, then `clipCashHistory` can plot `totalCash + totalSavings − restrictedCash`. UI (Liquidity widget) should label the curve until then.

## FIN-015
`computeSnapshotFields` doc now states `netWorth = stocks + crypto + cash + savings + realAssets − debt`. **For C:** `prisma/schema.prisma` ≈3117 comments `netWorth … // stocks + crypto + cash + savings − debt` and `totalAssets … // stocks + crypto + cash + savings` omit `+ realAssets`.

## FIN-009 — ambiguous fingerprint bound `matches[0]`
**Rule.** `resolveFingerprint` answers NONE / MATCH / AMBIGUOUS. The Plaid sync, on AMBIGUOUS, adopts nothing, persists the incoming row as its own (same destination the pending-ref refusal uses), and records a non-cursor-blocking SyncIssue (`UPSERT_ERROR`, `detail.stage = "fingerprint-adoption-ambiguous"`, candidate ids, provider id in `detail` only — not customer-actionable). `findByFingerprint` keeps its legacy first-of-several contract for the CSV import, which already SKIPs on its own ambiguity re-check.
**Tests.** `fingerprint.test.ts` (AMBIGUOUS/MATCH/NONE + legacy); `lib/plaid/fingerprint-ambiguity.test.ts` through `syncTransactionsForItem`: two twins ⇒ 3 rows, neither twin gets the id, created=1, issue with both candidates, cursor advances; one twin ⇒ DF-4 adoption unchanged. Existing `pending-ref-fingerprint-guard`, `cursor-safety`, `removed-tombstone`, `csv-fingerprint-outcome` green.
**Residual risk.** If the incoming row really is one of the twins, a duplicate is created (and recorded) rather than a wrong binding — the recoverable direction. `UPSERT_ERROR` is the closest existing kind; a dedicated kind would need a C migration.

## FIN-011 — null `current` still advanced freshness
**Rule.** `planBalanceWrite` (pure): a null / non-finite `current` writes no balance, no `balanceLastUpdatedAt`, and the caller adds no `lastUpdated` (balance-verified stamp); coverage reports `freshnessAdvanced: false`. Side facts (available, limit, subtype, syncStatus) are still written. An observed balance behaves as before.
**Tests.** `lib/plaid/refresh-balance-write.test.ts` (15); `freshness-pipeline.test.ts` pin preserved.
**Residual risk.** `syncStatus: "synced"` is still written on a null balance (it reflects the connection, not the value).

## FIN-013 (partial)
`lib/money/round.ts` exports `round2` and `MONEY_EPSILON = 0.005`. Migrated: `lib/transactions/debt-service.ts`, `lib/transactions/cash-flow.ts` (`r2`), `lib/ai/forecast/income-completeness.ts`, `lib/ai/measures/baseline.ts` (both), `lib/forecast/projection.ts` and `lib/forecast/spending-change.ts` (0.005 literals). `lib/money/round.test.ts` pins values and scans owned paths for private copies. `TRANSFER_AMOUNT_EPSILON` (`transfer-maturation.ts`) is a matching tolerance, deliberately left separate.
**Remaining copies (other owners):** `round2` in `lib/perspective-engine/reconciliation.core.ts:87`, `lib/snapshots/series-integrity.core.ts:182`, `lib/debt/payoff.ts:279`, `lib/ai/intelligence/annotations/classification-reason.ts:31`, `lib/ai/intelligence/annotations/metrics.ts:194`, `lib/ai/measures/measure.ts:79`, `lib/ai/brief/recent-activity.ts:56`, `lib/ai/conversation/{scenario-rules.ts:46, scenario.ts:74, scenario-change.ts:49, reconcile.ts:53, scenario-ledger.ts:466, scenario-checkpoints.ts:191, scenario-crossing.ts:26, tools.ts:289}`; `MONEY_EPSILON` in `lib/ai/measures/measure.ts:78`, `lib/data/snapshot-window.ts:220`. A lint rule (F) can follow once those move.

## FIN-004 — Cash Flow page vs AI population and clock (documented; UTC change deferred)
- **Pending:** the page population `lib/data/banking-population.ts` (≈172–174) keeps the current projection of each event, so pending charges are folded; the AI drilldown filters `{ pending: false, economicDate }` (`lib/ai/assemblers/transactions.ts:585`) and partitions settled/pending (≈690–699).
- **Clock:** `lib/transactions/cash-flow.ts:109` `toISODate` uses `getFullYear/getMonth/getDate` (local); `:230` `asOfAnchor` builds `new Date(\`${asOf}T00:00:00\`)` (local midnight); `:121–132` explicit periods use local `new Date(y, m, d)`; `:160` relative presets end at `toISODate(now)`. AI/Brief windows are UTC.
- **Why not changed:** explicit periods and `asOfAnchor` round-trip losslessly in any timezone (local construction + local formatting), so they are not the divergence. The only timezone-sensitive output is `toISODate(now)` for relative presets: browser = local date, server = UTC. Forcing UTC there would make every evening in the Americas show *tomorrow* as "today" on the page (and shift MTD/QTD ends), a product-visible change with ~10 widget/insight callers (`components/space/widgets/*`, `cash-flow-compare.ts`, `cash-flow-space-data.ts`). The right fix is a decision: (a) a user-timezone setting used by both surfaces, or (b) one convention with the page labelling "days are UTC" — plus the pending decision (one rule, or an explicit settled/pending split on the page). Owner decision; no code changed.

---

## Verification
See the final message for exact counts (typecheck, lint, `npm run test:unit`).

## Out-of-scope needs (summary)
1. **`scripts/audit-flow-desync.ts` + `scripts/backfill-flowtype.ts`: pass `categorySource` (FIN-002) — required before merge.**
2. `lib/ai/conversation/tools.ts`: `incompletenessBlock` / `projectionQualification` / `get_baselines` per FIN-001 above (needed for the bound to reach the model).
3. `lib/plaid/syncTransactions.ts:741` USER-rule override suppresses PFC (FIN-002).
4. `lib/ai/assemblers/transactions.ts:950` clamp signed income (FIN-003).
5. C: `SpaceSnapshot.restrictedCash` (FIN-005); schema net-worth/totalAssets comments (FIN-015).
6. Remaining `round2` / `MONEY_EPSILON` copies (FIN-013).
7. Owner: FIN-004 timezone + pending convention; whether to reclassify pre-fix user-corrected PFC rows (FIN-002).
