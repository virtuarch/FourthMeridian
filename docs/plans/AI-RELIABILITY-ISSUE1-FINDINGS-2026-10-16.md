# AI Reliability — Issue 1: Financial projection discrepancy — findings (2026-10-16)

Branch `fix/ai-reliability-beta` @ 595886e. Investigation only; no code changed. All database access was
read-only against the **Development** DB (session `default_transaction_read_only = on`, verified in-script);
harness tool contexts carried no `memoryWrites`, so no checkpoint or memory could be written. No model or Plaid call.
Scripts: `tmp/aireliab/issue1-recompute.ts`, `issue1-streams.ts`, `issue1-payroll.ts` (gitignored).
Space: the owner's personal Space (`cmrrm846…`). Merchant/employer names and account ids deliberately omitted.

## 0. Verdict in one paragraph

Every figure the AI reported is a real tool output, reproduced to the cent. **$5,929.85 is `project_cash`
to 2026-12-31 as of 2026-10-16** and it is wrong in a specific, deterministic way: **the primary biweekly
payroll stream (CURRENT, projection-eligible) was dropped from the projection** because the amount
authority refused to state its level after the latest paycheck (2026-10-09, $6,770.32) came in 28% above
the established $5,286.64 level. Projected income fell from $31,720.50 to **$0.65** (interest only), while
the tool still labelled the result an `EVIDENCE_BASED_ESTIMATE` whose qualification text says "future
payroll is inferred from the observed deposit cadence". **$27,126.97 is a stored checkpoint (SpaceMemory)
from 2026-10-03**, computed under a spending-window definition that changed the next day (67be59a).
**"+$178.79 daily drift" is the projection's daily SPENDING rate** (an outflow), not a drift. The
`reconcile_projection` tool returned the −$21,197.12 variance with a basis diff in which no field explains
it, so the model had no evidence for an explanation and produced unsupported ones.

## 1. Pipeline (where each figure is made)

| Figure | Producer | Evidence |
|---|---|---|
| Current liquid $19,517.62 | `project_cash` `openingCash` (spine opening, checking+savings) | recompute: `openingCash: 19517.62` |
| Oct 16 year-end $5,929.85 | `project_cash {to:"2026-12-31"}` → `projection.endingCash` | recompute: `endingCash: 5929.85` |
| Oct 3 year-end $27,126.97 | `SpaceMemory` checkpoint `liquid-2026-12-31`, class PROJECTION, stated 2026-10-03 (3 rows: 1 live, 2 superseded, identical value, written 22:01–22:17Z) | DB query |
| Deterioration $21,197.12 | `reconcile_projection` → `variance.difference` (`compareToStatement`, `lib/ai/conversation/reconcile.ts:62`) | recompute: `difference: -21197.12, direction: BEHIND` |
| "+$178.79 daily drift" | `project_cash.basis.spending.dailyRate = 178.7949…` (and `reconcile.basisChanged[dailyRate].now`) — a **spending** rate | recompute |
| "Recurring income ≈ $0" | `project_cash.basis.components[0]` "projected income from the observed payroll pattern" = **0.65** | recompute |

Pipeline (`lib/ai/conversation/tools.ts` `buildCashSpine` :1912 → `lib/forecast/projection.ts` `projectCash` :218):
- Opening cash: accounts domain, liquid = checking + savings (historical snapshot when `asOf` < today).
- Income: `loadForecastIncomeStreams` (`lib/ai/forecast/streams.ts:141`) — INCOME/INTEREST credits, newest 100
  rows over 730 days, grouped by merchant@account → `deriveCadence` → `resolveStreamActivity` (CURRENT/SILENT)
  → `deriveCurrentPeriodicAmount` (`lib/forecast/periodic-amount.ts`). Future occurrences are generated on the
  cadence; an occurrence whose amount is not assertable is **excluded** in `foldWindow` (`projection.ts:146`).
- Spending: `readCanonicalSpending` — trailing three complete months before `asOf` (since 67be59a, 2026-10-04);
  `dailyRate = monthlyRate / (365/12)`, accrued × horizon days. Transfers and DEBT_PAYMENT are excluded from
  the fold; card purchases sit in the spending rate; liabilities are not modelled by `project_cash`.
- Closing = opening + Σ counted inflows − Σ dated outflows − dailyRate × days (`projection.ts:256`).
- There is **no "drift" figure anywhere in the AI layer** (grep: none). The term was the model's.

## 2. Mathematical reconciliation (exact to the cent)

Stored 2026-10-03 basis (SpaceMemory payload): openingCash 15,925.25; dailyRate 230.5481 (Aug+Sep only);
15 income events; horizon 89 days.

| | Oct 3, code of Oct 3 (stored) | Oct 3, today's code (retrospective) | Oct 16, today's code |
|---|---:|---:|---:|
| Opening liquid | 15,925.25 | 15,925.25 | 19,517.62 |
| + projected income | 31,720.50 | 31,720.50 | **0.65** |
| − spending (rate × days) | 20,518.78 (230.548 × 89) | 15,912.75 (178.795 × 89) | 13,588.42 (178.795 × 76) |
| **= year-end** | **27,126.97** | **31,733.00** | **5,929.85** |

Income 31,720.50 = 6 × 5,286.64 (payroll, 31,719.84) + 0.66 interest. Income 0.65 = interest only.

Attribution of −21,197.12 (sums exactly):

| Cause | Effect |
|---|---:|
| A. Spending-window definition change (2 → 3 months, 67be59a, 2026-10-04) | **+4,606.03** |
| B. Opening cash rose (includes the 10-09 paycheck) | **+3,592.37** |
| C. 13 fewer days of spending (89 → 76) | **+2,324.33** |
| D. **Payroll stream dropped from projected income** | **−31,719.85** |
| Total | **−21,197.12** |

Without defect D, the Oct 16 figure would have been ≈ 19,517.62 + 5 × 5,286.64 + 0.65 − 13,588.42 =
**32,363.05** at the established level, or ≈ 39,781.45 if the $6,770.32 level persists (which level is
current is genuinely unknown after one paycheck — see §4). Either way the user is roughly **on or ahead of**
the Oct 3 statement, not $21k behind it.

## 3. Root causes (ranked)

**RC-1 (engine defect) — head-outlier asymmetry in `deriveCurrentPeriodicAmount`.**
`periodic-amount.ts:264-285`: the backward walk seeds `level = v.value` from the **newest** observation when
nothing is included yet. A single deviating paycheck at the head therefore becomes the reference, every older
point "deviates" from it, the run reaches `BREAK_RUN = 2`, and the regime is truncated to that one point →
`assertable: false` ("the most recent 1 observation(s) form a stable level, and 3 are required").
This contradicts the module's documented intent (`REGIME.BREAK_RUN`, :160-168): "One deviation is an outlier;
two in a row is a new level. This is what lets a strong regime survive a single supplemental payment" —
the identical situation mid-series (06-18, $6,275.07) IS classified OUTLIER and the 13-point regime survives.
Measured: as of 10-03 the stream asserts 5,286.64 (13 obs, 1 outlier); as of 10-16 it refuses.

**RC-2 (projection-integrity defect) — a CURRENT income stream with no assertable amount is silently dropped,
and the result is still presented as a complete estimate.** `foldWindow` excludes the occurrences
(`projection.ts:146`), `projectCash` returns `EVIDENCE_BASED_PROJECTION` regardless (`:286`), the range
(`low 432.73 / high 13,796.33`) varies spending only, and `tools.ts:2341` hard-codes the qualification
"future payroll is inferred from the observed deposit cadence" even when payroll contributed $0. The only
trace is `basis.excluded` ("5 occurrences … no amount is established for this event").

**RC-3 (contradictory tool output).** `tools.ts:2329` `incomeEventsCounted: f.events.length` counts *generated*
events including excluded ones: it said **12 counted** while 7 were excluded and income was $0.65.

**RC-4 (reconciliation tool cannot explain its own variance).** `reconcile_projection` (`tools.ts:4352-4467`)
diffs `{dailyRate, incomeEvents, monthsAveraged, openingCash, …}` but carries **no income or spending dollars**
and no attribution. Its actual output on 10-16: `dailyRate −51.75`, `incomeEvents −3`, `monthsAveraged`
changed, `openingCash +3,592.37` — every change except a count of 3 *improves* the projection, yet the
variance is −21,197.12. `dailyRate` is unlabelled (it is spending; the model read it as positive drift).
It also does not flag that the statement was made under a different definition (A above), so the stored
$27,126.97 is not reproducible by today's code (it would say 31,733.00).

**RC-5 (model behaviour, consequence not cause).** Given RC-2..4, the model had a large unexplained variance
and no dollar evidence; it improvised (income events, spending patterns, "daily drift"), then withdrew and
asked for income. The system instruction has a general rule (`EVIDENCE_RULE`, `turn.ts:56`: "use its output
and never fill in values it did not return") but nothing requires a variance explanation to be backed by an
attribution, and no tool output tells it that payroll exists and is current but unpriced — so "ask the user"
was the only honest move it could see. **The data the model needed (11 paychecks at ~$5,286, one at $6,770,
cadence CURRENT) was in the platform; the tools did not surface it.** Labelled inference: the actual
transcript is client-cached and not stored server-side (AiInvocation stores no payloads), so the model's
exact wording could not be read; the tool outputs above were reproduced deterministically and match the
reported figures to the cent.

## 4. Payroll evidence (Q4)

- Present: 23 settled, non-pending deposits on the primary biweekly stream, classified `INCOME` / category
  Income, into a depository account (`settledDepository: true`), cadence BIWEEKLY anchored 2026-10-09,
  activity CURRENT, 0 missed occurrences, `projectionEligible: true`. Visible to the engine — not a
  classification, transfer, pending, or detection-window problem.
- Last 12 amounts: 5,267–5,316 (within 1.3%) except 06-18 6,275.07 (outlier, correctly) and **10-09 6,770.32**.
  Whether 6,770.32 is a raise or a one-off is **not established** by the data (one observation).
- A second payroll stream is SILENT since 2025-12-24 (18 missed occurrences) — correctly lapsed, not projected.
- One interest stream is unassertable (variable amounts) — immaterial (cents).
- Page truncation (`truncated: true`, 100-row cap, newest-first) did not affect the verdict: the regime is
  well inside the page.

## 5. Other questions

- **Q5 drift sign**: "+$178.79/day" is the spending accrual (outflow). It is consistent with a *lower* ending
  balance; the model mislabelled it. No tool emits a drift.
- **Q8 contradictory outputs**: yes — `incomeEventsCounted: 12` vs income 0.65; qualification text claims
  payroll is inferred; reconcile basis diff points the opposite way from the variance.
- **Q9 invented explanations**: yes, by elimination: no tool output contained a quantified cause for the
  variance, so any causal narrative with numbers was unsupported.
- **Q10 stale context**: the $27,126.97 came from durable memory (a checkpoint), not chat history; it was
  stale in *definition* (pre-67be59a spending window), which nothing flagged. Three identical rows were written
  within 16 minutes on 10-03 (two superseded) — harmless but noisy.
- **Q6 instruction**: no instruction tells the model to ask for income; the ask was a fallback. The memory
  tools tell it to ask the user to *say* a figure before remembering it (`memory-model.ts:794,865`) — unrelated.

## 6. Recommended fixes (deterministic; none hard-codes the example values)

1. **`lib/forecast/periodic-amount.ts` — head symmetry (fixes RC-1).** Apply the documented outlier rule at the
   head: if the newest observation deviates from the median of the immediately preceding `MIN_OBSERVATIONS`
   eligible points, and those points are mutually in-band, classify the head `OUTLIER`-provisional, assert the
   established level, and return `latestDeviation: { dateISO, value, pctFromLevel }`. Two consecutive head
   deviations remain a regime break (existing `BREAK_RUN`). Regression test: 11 flat + 1 head spike ⇒
   assertable at the flat level with `latestDeviation`; 11 flat + 2 head spikes ⇒ refused (new regime, too
   young); the existing mid-series outlier fixture unchanged.
2. **`lib/forecast/projection.ts` + `project_cash` (fixes RC-2/3).** Add
   `incomeCompleteness: { status: 'COMPLETE' | 'INCOMPLETE', omitted: [{ stream label, occurrences, reason,
   lastObservedAmount, priorLevel? }] }` derived from `excluded` ∩ eligible INCOME streams. When INCOMPLETE:
   the tool must not present `endingCash` as the estimate without the omission — either refuse the single
   figure or return an explicit bracket (omitted stream at 0 / at prior level / at latest amount) with
   `kind: 'INCOMPLETE_ESTIMATE'`. Make `qualification` conditional (never claim payroll is inferred when it
   contributed nothing). Replace `incomeEventsCounted: f.events.length` with the fold's real `counted` and add
   `incomeEventsExcluded`. Add `recurringIncome: { status: 'PRESENT' | 'AMOUNT_UNESTABLISHED' | 'LAPSED' |
   'NONE_DETECTED', projectedTotal }`.
3. **`reconcile_projection` (fixes RC-4).** Return a deterministic `attribution` whose parts sum to the variance
   with a zero residual: opening cash, projected income $, dated outflows $, spending split into rate effect and
   horizon-days effect, and `definitionChange` (same evidence date, today's code vs stored statement, via the
   retrospective run). Legacy checkpoints are attributable exactly: `income − outflows (then) = value −
   openingCash + dailyRate × days`. Store `incomeTotal`, `spendTotal`, `days`, `definitionVersion` in new
   checkpoint bases. Rename the diffed field to `spendingDailyRate` (outflow) in the output.
4. **Instruction/tool description.** One sentence: a variance or change may be explained only by the
   `attribution` lines the tool returned; when `recurringIncome.status` is `AMOUNT_UNESTABLISHED`, state the
   observed deposits and the bracket and ask the user only to confirm which level applies — never to supply
   income the platform already holds.
5. **Acceptance check on Dev data (no values pinned):** for every IN_FLIGHT checkpoint, `Σ attribution ==
   variance` to the cent; `project_cash` on a Space whose only payroll stream is CURRENT never returns income
   < its prior established level × occurrences without `incomeCompleteness.status = INCOMPLETE`.
