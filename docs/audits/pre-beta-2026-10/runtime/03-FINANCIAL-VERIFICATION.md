> Runtime verification deliverable · HEAD cde8fa0 (v2.6) · 2026-10-21 · isolated throwaway stack (synthetic data, OpenAI mocked, Plaid Items set REVOKED, no Preview/Production access). Classifications: CONFIRMED / SUPPORTED / REFUTED / PARTIAL / UNVERIFIED. This is the verifying workstream's report; the coordinator independently reproduced SEC-001 and cross-checked every promoted claim (see 09-STATIC-RUNTIME-RECONCILIATION.md).

# Workstream FIN (N=2) — Financial Integrity runtime verification

Repo HEAD under test: `cde8fa0` (v2.6). Source tree `/Users/chrstn/dev/FourthMeridian` read-only.
Method: exercised the **real pure/engine modules** with synthetic inputs via `tsx` (repo cwd, `@/` alias resolved
by tsx). No model calls, no `/api/ai/*`, no `/api/brief/*`. No server request was required for any finding
(the engine paths are pure); the running server and cookie jars were therefore not used, and no rate-limit
bucket (X-Forwarded-For 10.2.0.x) was touched.

Run harness for every script:
```
cd /Users/chrstn/dev/FourthMeridian && \
FM_DB_GUARD=clone-only DATABASE_URL="$(cat $S/rtv/owner.url)" \
npx tsx --require ./scripts/lib/server-only-preload.cjs <script>
```
- `FM_DB_GUARD=clone-only` set on every run.
- `DATABASE_URL` points at the throwaway clone `fintracker_rtv` **only to satisfy the module-load live-guard**
  (`lib/db/live-guard.ts`); for FIN-001/002/003/005/013 the DB reader is **injected** (fakes), so **no query
  executed** against it. `server-only-preload.cjs` is the repo's own stub for the Next `server-only` import.
- Scripts: `$S/rtv/fin/{fin001.ts, fin001-silent.ts, fin002.ts, fin003_005.ts, fin013.ts, fin013b.ts}`.

All results are deterministic (pure functions, fixed inputs) — reproducible verbatim on re-run.

---

## FIN-001 — one late/missing paycheck drops ALL projected payroll under a "complete" label — **CONFIRMED**

**Initial state.** A biweekly payroll, 11 flat on-time paychecks of $3,000, newest slot `2026-10-02`. The next
scheduled slot `2026-10-16` has come due (5 days before `asOf = 2026-10-21`) but is unpaid (late employer / lagging
feed). This is the sibling of the fixed 2026-10-16 head-outlier defect.

**Exact method.** `$S/rtv/fin/fin001.ts`: built the 11 paydays, derived the cadence with the real
`deriveCadence` (`lib/forecast/cadence.ts`), the level with the real `deriveCurrentPeriodicAmount`
(`lib/forecast/periodic-amount.ts`), the activity verdict with the real `resolveStreamActivity`
(`lib/forecast/stream-activity.ts`), the licensed future occurrences with the real
`expectedOccurrencesBetween`, and then the **end-to-end** path through `loadForecastIncomeStreams`
(`lib/ai/forecast/streams.ts`, injected `read` + `accountTypes`) → `incomeCompleteness`
(`lib/ai/forecast/income-completeness.ts`). Control = the identical history flipped to CURRENT by the engine's
own supported recovery (a `UserAssertion {kind:'CONTINUES'}`).

**Expected (a correct system).** A payroll that was CURRENT one occurrence ago and has a single overdue slot should
yield a **blocking / INCOMPLETE** projection (the owner's 2026-10-16 escalation), not a clean "complete" estimate
that silently zeroes payroll.

**Actual.**
```
cadence = BIWEEKLY anchor 2026-10-02 ; amount = assertable 3000 USD (11 obs)   ← level is FINE
BUG (observedThroughISO = newest INCOME row = 2026-10-02):
   state = UNKNOWN | mayGenerateExpectedOccurrences = false
   expected future paychecks 2026-10-21→2026-12-31 : 0 ; projected future income $ = 0
VARIANT (observedThrough reaches past the overdue slot):
   state = SILENT | may = false   (both SILENT and UNKNOWN collapse identically)
CONTROL (user says CONTINUES):
   state = CURRENT | may = true ; 5 future paychecks 10-30,11-13,11-27,12-11,12-25 ; $15,000
END-TO-END loadForecastIncomeStreams → incomeCompleteness:
   stream Acme Payroll: activity=UNKNOWN projectionEligible=false amount=3000 → line status = LAPSED
   incomeCompleteness.status = COMPLETE   (LAPSED is non-blocking)
   ⇒ project_cash would label this: EVIDENCE_BASED_ESTIMATE
```

**Evidence (numbers + refs).** Year-end payroll counted: bug **$0** vs control **$15,000** at identical opening
cash and spending ⇒ **$15,000 silently dropped** (scales to tens of thousands over a full horizon / larger level —
the measured Space figure in the audit). Root cause is exactly as the static audit states:
- `observedThroughISO` is derived from the **newest INCOME row only** (`streams.ts:209-211`;
  `page.rows` is `flowTypes:['INCOME','INTEREST']`), not the account's sync clock — so an overdue slot reads as
  "ledger not reached" → `UNKNOWN` (`stream-activity.ts` `unobservedDue` branch), or `SILENT` if income rows reach
  past it (`MAX_MISSED_FOR_PROJECTION:0`, `stream-activity.ts:157`).
- `!projectionEligible` maps to `LAPSED` (`income-completeness.ts:135-136`), and `LAPSED` is excluded from the
  `blocking` set (`income-completeness.ts:162`), so `status:'COMPLETE'`.
- `project_cash` sets `kind: incomplete ? 'INCOMPLETE_ESTIMATE' : 'EVIDENCE_BASED_ESTIMATE'`
  (`tools.ts:~2400`) → `EVIDENCE_BASED_ESTIMATE`, with only the prose "No recurring income is counted in this
  figure" (`tools.ts:2107-2109`).

**Reproducibility.** Deterministic; `fin001.ts` + `fin001-silent.ts`.

**Classification: CONFIRMED** (both the SILENT and the UNKNOWN sub-cases, and the end-to-end COMPLETE/
EVIDENCE_BASED_ESTIMATE label). The amount authority is **not** the fault here — it correctly keeps a $3,000
level across 11 obs; the fault is wholly in the activity gate + completeness mapping.

**Remediation (confirms the audit's).** Treat a stream that was projection-eligible and went SILENT/UNKNOWN within
one occurrence as a **blocking** `RECENTLY_SILENT ⇒ INCOMPLETE_ESTIMATE` carrying the last-observed bound; split
`LAPSED` from `UNKNOWN`; derive `observedThroughISO` from the account sync clock, not the newest income row.
Regression fixture: the 11-paycheck / overdue-slot case above ⇒ must be INCOMPLETE.

**Environment differences.** None material — pure deterministic engine, independent of DB/server/provider.

---

## FIN-002 — a user category correction cannot change `flowType` on any PFC-bearing Plaid row — **CONFIRMED**

**Initial state.** A Plaid row carrying a personal-finance-category code (`pfcPrimary`), `flowAuthority=CLASSIFIER`,
that the user re-categorises (the only customer-facing correction lever; `categorySource` → `USER_RULE`/
`USER_OVERRIDE`).

**Exact method.** `$S/rtv/fin/fin002.ts`: called the real `recomputeFlowFields`
(`lib/transactions/merchant-corrections.ts`) — the exact function both `applyCategoryRuleCorrection` and
`applyTransactionOverride` use — with a new category, for a PFC-bearing row and a PFC-null control. Also
`classifyFlow` directly to show the precedence.

**Expected.** Re-categorising INCOME→Transfer (or →Dining, →Payment) should move the row's economics so totals/
baselines follow.

**Actual.**
```
PFC row (pfcPrimary=INCOME): initial flowType = INCOME (PLAID_PFC_PRIMARY)
   → Transfer : recomputed flowType = INCOME  (UNCHANGED)
   → Dining   : recomputed flowType = INCOME  (UNCHANGED)
   → Payment  : recomputed flowType = INCOME  (UNCHANGED)
PFC-null control: initial flowType = INCOME (CATEGORY_FLOW_VALUE)
   → Transfer : TRANSFER  (CHANGED)
   → Dining   : REFUND    (CHANGED)
   → Payment  : DEBT_PAYMENT (CHANGED)
TRANSFER_AUTHORITY-owned row → Dining: recomputed = {}   (secondary gate: writes nothing)
```

**Evidence (refs).** `classifyFlow` step 1 is "Provider taxonomy first": `if (input.pfcPrimary || input.pfcDetailed)
{ return classifyFromPfc(...) }` (`flow-classifier.ts:443-446`), which wins before the `category` switch.
`buildFlowInputFromRow` passes `pfcPrimary/pfcDetailed` straight through (`plaid-flow-input.ts:435-447`), and the
correction never clears them, so the re-derived `flowType` is a function of the unchanged PFC, not the new category.
The flow-ownership model (`flow-authority.ts`) has **no USER authority** — `FLOW_AUTHORITIES =
[CLASSIFIER, TRANSFER_AUTHORITY, CRYPTO_LEDGER]` — so the user cannot displace a classifier verdict either.
**Money impact:** INCOME vs TRANSFER is exactly the income/neither split in the economic fold (`cash-flow.ts`
`economicSideOf`: INCOME→income, TRANSFER→neither), so every income total, `get_baselines`, income stream and
`project_cash` keeps the old economics while the row visibly shows the user's new category. The row is still written
(`category`, `categorySource`, and a `flowType` equal to the old value) — the correction lands everywhere except on
money.

**Reproducibility.** Deterministic; `fin002.ts`.

**Classification: CONFIRMED.**

**Remediation.** Run the classifier with PFC suppressed when `categorySource ∈ {USER_RULE, USER_OVERRIDE}`, or add a
USER flow authority that `recomputeFlowFields` stamps and that outranks CLASSIFIER. Regression: a PFC-bearing fixture.

**Environment differences.** None — pure function over stored columns.

---

## FIN-003 — negative INCOME rows increase income — **CONFIRMED**

**Method.** `$S/rtv/fin/fin003_005.ts`: real `foldEconomicRow` (`lib/transactions/cash-flow.ts`) with a +$5,000
paycheck then a −$500 clawback.
**Actual.** `income = 5500` (correct net = 4500) ⇒ overstated by **$1,000 = 2× the clawback**.
**Evidence.** `foldEconomicRow` INCOME case does `acc.income += Math.abs(row.amount)` (`cash-flow.ts:~366`);
`economicSideOf` returns `INCOME` sign-blind for any INCOME row. Flows into E1/E5/E15 and Brief
`impliedMonthlyIncome`.
**Classification: CONFIRMED.** Remediation: sign-aware income, or a named reversal side (as audit).

---

## FIN-004 — Cash Flow page (pending + local clock) vs AI (settled + UTC) — **SUPPORTED**

**Method.** Read the two divergent code paths (no settling-pending fixture run end-to-end, hence SUPPORTED not
CONFIRMED, but the divergence is unambiguous in code).
**Evidence.**
- Cash Flow page population `bankingTransactionWhere` (`lib/data/banking-population.ts`) does **not** filter
  `pending` — it keeps the currently-projected row (`eventProjectionWhere`), so pending charges fold in; and the
  page's period boundaries are **local-clock**: `toISODate` uses `getFullYear/getMonth/getDate`
  (`cash-flow.ts:108-114`) and `asOfAnchor` builds `new Date(\`${asOf}T00:00:00\`)` with no `Z`
  (`cash-flow.ts:~230`).
- AI/Brief reads are **settled-only, UTC**: the drilldown where is `{ pending: false, economicDate: {gte,lte} }`
  (`lib/ai/assemblers/transactions.ts:585`), and the settled/pending partition at `:690-699` keeps them separate.
**Impact.** Same month, two income/spending figures; MTD drifts as pendings settle; a transaction near a day
boundary can fall in different months on the two surfaces.
**Classification: SUPPORTED** (code-level, deterministic; an end-to-end numeric split needs a straddling fixture +
both renderers).

---

## FIN-005 — restricted cash: Hero `totalLiquid` excludes it, history/snapshot `netLiquid` includes it — **CONFIRMED**

**Method.** `$S/rtv/fin/fin003_005.ts`: real `classifyAccounts` (`lib/account-classifier.ts`) and
`computeSnapshotFields` (`lib/snapshots/backfill-core.ts`) over checking $10,000 + **HSA checking $5,000
(restricted)** + savings $2,000.
**Actual.**
```
totalLiquid (Hero)            = 12000   (excludes the restricted HSA)
totalChecking (all checking)  = 15000 ; totalSavings = 2000
snapshot netLiquid            = 17000   (cash + savings − debt, INCLUDES restricted)
cashNow history basis         = 17000
DISCREPANCY                   =  5000   (= the restricted HSA)
```
**Evidence.** `classifyAccounts` computes `totalLiquid` from **unrestricted** checking+savings
(`account-classifier.ts:366-369`) but `totalChecking/totalSavings` sum **all** of each type;
`computeSnapshotFields` sets `netLiquid = cash + savings − debt` from those unfiltered totals
(`backfill-core.ts:328`), and `cash-history.ts:8-12` plots `totalCash + totalSavings` while its own comment claims
parity with `classifyAccounts.totalLiquid` — false whenever restricted cash exists. The Liquidity chart/Ladder
endpoint therefore sits above the Hero by the HSA/retirement-cash amount.
**Classification: CONFIRMED.** Remediation: compute the history/`netLiquid` basis from `totalLiquid` (exclude
restricted), or relabel. Net worth is unaffected (restricted cash stays an asset).

---

## FIN-013 — all-Float money storage, scattered rounding, f64 residue — **CONFIRMED**

**Method.** Schema grep + real-fold residue (`$S/rtv/fin/fin013.ts`, `fin013b.ts`).
**Evidence.** `prisma/schema.prisma`: **64 `Float` money columns, 0 `Decimal`** (`Transaction.amount` Float:2434,
`FinancialAccount.balance` Float:1243, `FxRate.rate` Float:3697, …). **17** local `const round2 =` copies and **3**
`MONEY_EPSILON` definitions (`measure.ts:78`, `baseline.ts:48`, `snapshot-window.ts:220`, all `0.005`) — the audit
said 15 / 3; the Float/round2 counts are marginally **higher** than the static estimate, direction-consistent.
Residue through the real `foldEconomicRow`: `0.1 + 0.2 = 0.30000000000000004 ≠ 0.3` (residue 5.55e-17).
**Impact.** 1e-17-class residue; display is protected by `Intl`/`round2`, so low customer impact, but a real
maintenance/consistency risk (three epsilons, seventeen rounders).
**Classification: CONFIRMED.** Remediation: one `lib/money/round.ts` + one epsilon + a lint rule (as audit).

---

## Scores — Part-3 items touched

Runtime verification **corroborated** the static audit on every item it touched and **refuted none**; it raised
confidence and pinned the exact mechanism. Scores are kept at the audit's weighted values (the defects are real as
scored); the runtime column reflects that each was reproduced deterministically against the real code.

| Part-3 item | Finding(s) | Static score (§6) | Runtime-adjusted | Confidence | Remaining uncertainty |
|---|---|---|---|---|---|
| Forecast consistency | FIN-001 | 5 | **5 (confirmed)** | very high | Full `projectCash` fold not run; dollar delta computed from the engine's licensed generator × level (exact). Three-engine numeric parity (CQ-017) still unverified. |
| Paycheck-level inference | FIN-001 | 5 | **5 (confirmed)** | very high | Whether a real Space's sync clock would ever rescue the stream — no, by code (`observedThroughISO` = income rows only). |
| Income / expense classification | FIN-002, FIN-003 | 5 | **5 (confirmed; arguably 4)** | very high | Downstream total movement inferred from `economicSideOf`, not re-folded over a full corpus. |
| Balance consistency | FIN-005 | 7 | **6 (confirmed defect)** | very high | Magnitude of restricted-cash population in real data (needs a DB count). |
| Pending vs posted | FIN-004 | 7 | **7 (supported)** | high | No straddling pending fixture run through both renderers for a numeric split. |
| Timezone / UTC boundaries | FIN-004 | 7 | **7 (supported)** | high | Same as above; local-vs-UTC day-boundary case not numerically exercised. |
| Monetary precision | FIN-013 | 6 | **6 (confirmed)** | very high | None material; display-safe. |

Weighted financial-integrity headline (audit): **6.1 / 10** — unchanged by this runtime pass; no finding moved a
score up or down, two P1 defects (FIN-001, FIN-002) are now reproduced against the shipping code rather than inferred.

### Environment differences from Production (all findings)
Pure engine functions exercised off-server with injected DB readers; no Vercel, no Plaid, no OpenAI, no RLS path
involved (these modules are tenant-agnostic pure code). `DATABASE_URL` was set only to pass the module-load
live-guard; no SQL ran. Results are therefore identical to Production behaviour for these code paths by construction
(same `cde8fa0` source, deterministic inputs).
