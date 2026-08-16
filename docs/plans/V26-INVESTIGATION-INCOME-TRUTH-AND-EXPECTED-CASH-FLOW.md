# V26 Investigation — Income Truth and Expected Cash Flow

**Status:** Empirical investigation. No code, no schema, no migration, no data modified. All database access read-only (`SELECT` only).
**Repository:** `v2.6` @ `146a0dd` · **Database:** local development copy, `localhost:5432/fintracker` (PostgreSQL)
**Scope:** does the evidence support an Income Truth layer and an Expectation compiler between sealed truth and assessment?

**Privacy:** no descriptors, employer names, account numbers, transaction ids or credentials appear in this document. Income streams are referenced by stable pseudonyms (**Stream A**, **Stream B**) derived from a hash of the descriptor. Amounts are rounded.

**Marking:** **[EXISTS]** verified in repo · **[ABSENT]** verified missing · **[PROPOSED]** recommendation · **[INFERRED]** reasoned, not directly observed.

---

## 1 · Current income-model inventory

| Question | Finding |
|---|---|
| How is income represented? | **Only** as `Transaction` rows with `flowType = INCOME`. **[EXISTS]** There is no income entity. |
| Is there an income/stream model? | **[ABSENT]** — no `IncomeStream`, `RecurringSeries`, or `Obligation` model exists (`prisma/schema.prisma`, 55 models) |
| Raw provider descriptor preserved? | **[EXISTS]** — `Transaction.description` holds Plaid's verbatim `name`; `merchant` holds the enriched value. DF-4 made the dedupe fingerprint key on the **raw** descriptor precisely because the enriched one drifts (`lib/transactions/fingerprint.ts:52-64`) |
| Payroll-specific classification? | **[EXISTS]** — `lib/transactions/descriptor-evidence.ts:61` `PAYROLL_INCOME_DESCRIPTORS` (payroll/salary/…) with a **veto list** at `:74` `PAYROLL_NEGATIVE_DESCRIPTORS` so "payroll deduction"/"payroll tax" cannot be rescued as income, and matching only on a positive amount (`:81`) |
| Payroll **identity resolution**? | **[ABSENT]** — merchant normalization is explicitly **SPENDING-only**: `lib/ai/assemblers/transactions.ts:661-664` states the rollup groups only `flowType=SPENDING` "…keeps payroll, internal transfers, debt payments, fees and refunds out". Income is rolled up separately as `incomeSources` **[EXISTS]** but with no alias/identity layer |
| Recurring detection? | **[EXISTS] but insufficient.** `buildRecurringCandidates` (`transactions.ts:1190-1234`) groups by lowercased merchant, requires ≥2 sightings, and computes a **mean**. **It never reads `date`.** No interval, cadence, weekday or periodicity analysis exists anywhere. "Recurring" currently means "seen twice" |
| Pending→posted duplication risk? | **[EXISTS] as a guard** — `pendingTransactionRef` + `settlementState` + fingerprint fallback. Empirically **zero pending INCOME rows** in this dataset, so no duplication contaminates the analysis |
| Can transfers/refunds be mistaken for income? | **Structurally separated** — `FlowType` has 10 values (`SPENDING, INCOME, REFUND, DEBT_PAYMENT, TRANSFER, INVESTMENT, FEE, INTEREST, ADJUSTMENT, UNKNOWN`), and transfer evidence carries 7 axes with confidence. Empirically the separation held (§7) |
| Timestamp precision? | **[EXISTS] as a limitation** — `Transaction.date` and `authorizedAt` are both `@db.Date`. **Day precision only, no time of day** |
| Reusable pure core / as-of reader? | **[EXISTS]** — 23 `*-core.ts` modules, including `lib/data/accounts-asof.core.ts` and `lib/data/transaction-query-core.ts`. The house pattern for a pure resolver already exists |

**Summary:** the repository has the *inputs* for income truth (raw descriptors, payroll evidence, flow classification with confidence, transfer separation) and **none of the structure** (no stream entity, no cadence detection, no payer identity resolution).

---

## 2 · Local database methodology

- **Technology:** PostgreSQL, local development copy. Connection via `.env.local` → `localhost:5432/fintracker`. Not production; production is a separate Supabase project.
- **Access:** read-only. Every statement was a `SELECT`. No `INSERT`/`UPDATE`/`DELETE`/DDL was issued.
- **Real vs seeded separation — essential to the result.** The database mixes genuine Plaid-linked data with seeded demo data. I partitioned on `FinancialAccount.plaidAccountId IS NOT NULL`:

| Class | Accounts | Window |
|---|---|---|
| **Real (analysed)** | Amex ×3, Chase ×3 (checking/savings/debt) | 2024-07-21 → 2026-07-26 (~24 months) |
| **Seeded (excluded)** | "Demo Bank", "Beacon Bank", "Example Credit Union", "Alpha/Sample Brokerage", "Summit Business Bank", "Fictional Crypto Exchange" | all begin 2026-03 |

Seeded accounts were excluded from **every** conclusion. Analysing them would have manufactured fictional income streams.

- **Payroll destination:** Chase/checking — 600 transactions, 111 inflows, the only account with a sustained large-credit pattern.
- **Coverage:** 25 months examined, **zero months with no activity**. No disconnected period, no gap that would hide a stream.

---

## 3 · Candidate regular-income streams

Two dominant streams, both into Chase/checking, both carrying payroll vocabulary, both above a $500 floor.

| | **Stream A** | **Stream B** |
|---|---|---|
| Payments observed | 35 | 17 |
| Observed from | 2024-07-25 | 2025-12-19 |
| Observed to | 2025-12-24 | 2026-07-17 (last in data) |
| Median amount | ≈ $4,395 | ≈ $5,316 |
| Range (excl. outliers) | $3,868 – $5,544 | $5,267 – $6,275 |
| Destination | Chase/checking | Chase/checking |
| Descriptor tokens (len>2) | 4 | 4 |
| Names a known payroll processor? | **No** | **No** |

**Excluded from the income set** (present but not regular income): Chase/savings 24 credits with median ≈ $0 and Amex/savings 10 credits median ≈ $6 — **interest**, not income. Six further single-occurrence credits form the ambiguity set (§7).

---

## 4 · Detected cadence patterns

Interval histograms (days between consecutive payments) and weekday distribution:

**Stream A — SEMI-MONTHLY.** Confidence **HIGH**.
```
gap 15 → 15×    gap 14 → 9×    gap 17 → 5×    gap 16 → 2×  gap 18 → 2×  gap 13 → 1×
weekday: Fri 13 · Tue 7 · Thu 5 · Wed 5 · Mon 5      ← scattered
```
Mode 15 days with a 13–18 spread, and weekday **scattered across all five business days**, is the signature of payment on two fixed *dates* per month (weekday drifts with the calendar). Exactly two payments in every complete month observed.

**Stream B — BIWEEKLY, Friday-anchored.** Confidence **HIGH**.
```
gap 14 → 12×    (plus one each of 3, 11, 13, 15)
weekday: Fri 14 of 17
```
Dominant 14-day interval, Friday anchoring, and — the discriminator the brief specifically asks for — **three payments in January 2026 and three in March 2026**, which semi-monthly cannot produce.

**This is a cadence change, not a continuation.** Stream A was semi-monthly on fixed dates; Stream B is biweekly on Fridays.

---

## 5 · Candidate raises and pay-level transitions (Stream A)

Monthly medians, with min/max used to separate level shifts from one-off payments:

| Month | n | Median | Note |
|---|---|---|---|
| 2024-08 → 2024-11 | 2 each | **4,081** | stable baseline, 4 months |
| 2024-12 | 2 | 4,235 | transition (min 4,081, max 4,389) |
| 2025-01 → 2025-03 | 2 each | **4,389** | new level (Feb *min* also 4,389) |
| 2025-02 | 2 | — | **max 10,669** — outlier |
| 2025-04 | 2 | 4,441 | transition |
| 2025-05, 08, 09 | 2 each | **4,487** | new level |
| 2025-06 | 2 | 3,946 | **dip**, min 3,868 |
| 2025-07 | 2 | — | max 5,873 — spike |
| 2025-10 | 2 | 5,280 | transition (min 5,016) |
| 2025-11 | 2 | **5,016** | new level |
| 2025-12 | 2 | 4,885 | final month |

### Transition 1 — ~December 2024
- Previous ≈ **$4,081** → new ≈ **$4,389** · **+$308 (+7.5%)**
- Cadence unchanged · descriptor unchanged · account unchanged
- **Evidence for:** sustained across Jan/Feb/Mar; the Feb *minimum* is 4,389, so every payment cleared the new level; four months at the old level before it
- **Evidence against:** none material
- **Alternatives:** a withholding/deduction reduction at the tax-year boundary would produce the same net step. January is exactly when W-4, benefit elections and contribution rates reset.
- **Classification: `LIKELY_RAISE`** · Confidence **MEDIUM-HIGH**. The timing is the reason it is not HIGH — a January net-pay step is genuinely ambiguous between a raise and an annual withholding reset.

### Transition 2 — ~April 2025
- ≈ **$4,389** → ≈ **$4,487** · **+$98 (+2.2%)**
- **Evidence for:** sustained May, Aug, Sep at exactly 4,487
- **Evidence against:** magnitude is within the range a benefits or contribution change produces
- **Classification: `DEDUCTION_OR_WITHHOLDING_CHANGE` or `POSSIBLE_RAISE`** · Confidence **LOW-MEDIUM**. 2.2% is too small to distinguish from a payroll-deduction adjustment on net-pay evidence alone.

### Transition 3 — ~October 2025
- ≈ **$4,487** → ≈ **$5,016** · **+$529 (+11.8%)**
- **Evidence for:** sustained into November at exactly 5,016; the step is large relative to prior variance
- **Evidence against:** it is followed within ~10 weeks by the stream ending entirely — a late-stage increase preceding departure is also consistent with a promotion/retention adjustment, a role change, or accrued-time payout beginning
- **Classification: `LIKELY_RAISE`** · Confidence **MEDIUM**. Downgraded from HIGH solely because of its proximity to the stream ending.

### Explicitly **not** raises
- **2025-02, ≈$10,669** — a single payment ≈2.4× the prevailing level, with the same month's other payment at exactly the level. **`BONUS_OR_VARIABLE_COMPENSATION`** · Confidence **HIGH**. Had a mean been used instead of a median, this one payment would have manufactured a false 2025-Q1 "raise" — the failure mode the brief warned about, and the reason `buildRecurringCandidates`' mean is unsuitable.
- **2025-06, ≈$3,868** — a dip *below* the established level. Unpaid leave, a payroll correction, a one-off deduction, or a benefits true-up are all consistent. **`INSUFFICIENT_EVIDENCE`**.
- **2025-07, ≈$5,873** — a spike. Overtime, commission, or reimbursement routed through payroll. **`INSUFFICIENT_EVIDENCE`**.

---

## 6 · Candidate employer/job transition — ~December 2025

**Five independent signals coincide:**

| Signal | Evidence |
|---|---|
| Old stream ends | Stream A final payment 2025-12-24 |
| New stream begins | Stream B first payment 2025-12-19 — **5 days before A ends** |
| Payer identity differs | Descriptors share **2 of 4** tokens, and **both shared tokens are generic payroll vocabulary — zero entity-like tokens in common** |
| Cadence changes | semi-monthly → biweekly |
| Weekday anchoring changes | scattered → Friday (14 of 17) |
| First payment is small | Stream B opens at ≈$2,306, roughly 40% of its later level — consistent with a **prorated first period** |
| Level then *declines* | B runs ≈$5,943 (Jan) → ≈$5,700 (Feb) → ≈$5,300 (Apr onward) — consistent with **benefit/contribution deductions starting after the first cycles**, a well-known new-employment pattern, **not** a pay cut |

**Classification: `LIKELY_JOB_CHANGE`** · Confidence **MEDIUM-HIGH**.

**Discipline on what is actually observable.** Banking data can directly evidence only:
- ✅ **the payer descriptor changed** — observed
- ✅ **the payment cadence changed** — observed
- ✅ **the deposit weekday anchoring changed** — observed

Whether the **employer** changed, the **payroll processor** changed, or the **job** changed is **inference**. The surviving alternative is that the same employer simultaneously migrated payroll providers, switched semi-monthly→biweekly, and re-anchored to Friday. That is possible — payroll migrations do change all three — but it requires three coincident changes plus a prorated first payment and a declining early level. The employer-change reading is better supported; it is not proven.

**A confirming signal that is present and matters:** the ~5-day overlap with a small final-period payment from A is more consistent with a *transition* (final pay from one payer, first prorated pay from another) than with a *migration* (which typically shows a clean cutover, not an overlap).

---

## 7 · Ambiguous and excluded credits

| Set | Count | Treatment |
|---|---|---|
| `TRANSFER` inflows > $500 to the payroll account | 33 (median ≈$1,000) | **Excluded.** Correctly classified; internal movement |
| `DEBT_PAYMENT` inflows (credit-card accounts) | 113 | **Excluded.** These are payments *to* cards, positive on the liability side — not income |
| `REFUND` | 21 | **Excluded** from income; separately tracked |
| `INTEREST` / savings credits | ~34 rows, median ≈$0–6 | **Excluded.** Interest, not income |
| `UNKNOWN` inflows | 8 | **Ambiguity set** — retained, not silently dropped |
| Single-occurrence payroll-shaped credits | 6 distinct descriptors, 1 payment each ($872–$4,553) | **Ambiguity set.** Could be a final settlement, a bonus routed separately, a reimbursement, or a one-off contract payment. Insufficient evidence for any stream |

No record was discarded silently. The classification layer performed well: no transfer, refund, or interest row contaminated the two income streams.

---

## 8 · What Fourth Meridian did **not** know

This section is part of the truth contract, not a caveat.

1. **Gross salary is unavailable.** Only net deposits are observed. Every figure here is net-of-everything. A raise and a withholding change are **not separable** from this evidence alone.
2. **Employer identity is unresolved.** The descriptor is a string, not an entity. No payer identity resolution exists (§1), and neither descriptor names a known payroll processor — so we cannot even distinguish "employer's own ACH" from "an unrecognised processor".
3. **Transaction dates have day precision only** (`@db.Date`). Intra-day ordering is impossible.
4. **The observed date is the bank's posting date, not the employer's scheduled payday.** Early availability, weekend/holiday shifts, and bank processing all move it. A "Friday" pattern is a *posting* pattern.
5. **History begins 2024-07-21, after employment began.** Stream A's first observed payment is not its first payment. No pre-history exists to establish the original level.
6. **Income outside connected accounts is invisible.** Any deposit to an unconnected institution is absent, and its absence is indistinguishable from non-existence.
7. **Stream B has no observed end.** The last payment is 2026-07-17; whether it continues is unknown, not assumed.
8. **The 2025-06 dip and 2025-07 spike are unexplained.** Both have multiple equally-consistent causes.
9. **Only two months of Stream B precede its level stabilising**, so its "typical" amount rests on ~6 months of evidence versus Stream A's ~17.
10. **No confirmation source exists.** No user-stated fact, no employer field, no income record — nothing can corroborate or refute any inference here (V26-F2 §2.3: zero personal context exists).

---

## 9 · Confidence summary

| Conclusion | Confidence | Basis |
|---|---|---|
| Two distinct income streams exist | **HIGH** | 35 + 17 payments, distinct descriptors, distinct cadence |
| Stream A was semi-monthly | **HIGH** | interval mode 15d, scattered weekday, 2/month |
| Stream B is biweekly on Friday | **HIGH** | 14d ×12, Friday 14/17, three-payment months |
| A bonus occurred ~Feb 2025 | **HIGH** | single 2.4× payment, level otherwise unchanged |
| Pay level rose ~Dec 2024 | **MEDIUM-HIGH** | sustained step; January timing admits withholding reset |
| Pay level rose ~Oct 2025 | **MEDIUM** | sustained step; proximity to stream end |
| ~Apr 2025 change is a raise | **LOW-MEDIUM** | +2.2% indistinguishable from deduction change |
| Payer identity changed ~Dec 2025 | **MEDIUM-HIGH** | 5 coincident signals, zero shared entity tokens |
| **Job/employer** changed | **INFERENCE, MEDIUM** | payroll-migration alternative survives |
| Gross compensation changed | **UNKNOWN** | not observable |

---

## 10 · Proposed Income Truth contract **[PROPOSED]**

Belongs **inside** sealed Financial Truth — it is *resolution* (identity + temporal), not judgment.

```ts
interface IncomeStream {
  id: string;
  spaceId: string;
  /** Resolved payer identity — NOT the raw descriptor. */
  sourceIdentity: {
    descriptorKey: string;          // stable hash of the normalized descriptor
    displayLabel: string | null;     // null when unresolved — never guessed
    resolutionState: 'RESOLVED' | 'UNRESOLVED_DESCRIPTOR' | 'AMBIGUOUS';
    isKnownProcessor: boolean | null;
  };
  destinationAccountIds: string[];
  observedFrom: string; observedTo: string | null;   // null = still active
  cadence: {
    class: 'WEEKLY'|'BIWEEKLY'|'SEMI_MONTHLY'|'MONTHLY'|'IRREGULAR'|'SEASONAL'|'UNDETERMINED';
    modalIntervalDays: number | null;
    intervalHistogram: Record<number, number>;   // the evidence, not a summary
    anchor: { kind: 'WEEKDAY'; value: string } | { kind: 'DAY_OF_MONTH'; values: number[] } | null;
    confidence: 'HIGH'|'MEDIUM'|'LOW';
  };
  amount: {
    median: number; p25: number; p75: number;    // robust — never a bare mean
    currency: string;
    outlierPaymentIds: string[];                  // excluded from the level, retained as evidence
  };
  levelSegments: Array<{                          // change points as first-class truth
    from: string; to: string | null;
    median: number; paymentCount: number;
    transitionClass: 'LIKELY_RAISE'|'POSSIBLE_RAISE'|'DEDUCTION_OR_WITHHOLDING_CHANGE'
                   |'BONUS_OR_VARIABLE_COMPENSATION'|'CADENCE_CHANGE'|'INSUFFICIENT_EVIDENCE';
    competingExplanations: string[];              // stored, not discarded
    confidence: 'HIGH'|'MEDIUM'|'LOW';
  }>;
  evidence: Array<{ kind: 'transaction'; ids: string[] }>;
  /** Required. A stream without an unknowns record is not truth. */
  unknowns: Array<{ code: string; detail: string }>;
}
```

**Design rules forced by this data:**
- **Median and IQR, never mean.** The Feb-2025 bonus would have created a phantom raise under a mean.
- **`intervalHistogram` is retained, not just the class.** Stream A's 13–18 spread *is* the semi-monthly evidence; collapsing it to "semi-monthly" destroys the ability to re-evaluate.
- **`levelSegments` belong to truth, not assessment.** "The level changed on this date" is observation. "That was a raise" is interpretation — hence `transitionClass` carries `competingExplanations` and a confidence, and never asserts.
- **`displayLabel: null` when unresolved.** Following the `amount: null` FX doctrine — no invented employer name.

---

## 11 · Proposed Expected Income contract **[PROPOSED]**

Belongs in a **separate Expected Financial State artifact**, not in Financial Truth.

```ts
interface ExpectedIncomeEvent {
  incomeStreamId: string;
  expectedDate: string;
  dateConfidence: 'HIGH'|'MEDIUM'|'LOW';
  expectedAmount: { p25: number; median: number; p75: number; currency: string };
  probability: number;                 // 0..1, from cadence stability + recency
  basis: { paymentsObserved: number; windowFrom: string; windowTo: string;
           cadenceClass: string; modelVersion: string };
  invalidationConditions: Array<
    | { kind: 'STREAM_SILENT_BEYOND'; date: string }
    | { kind: 'AMOUNT_OUTSIDE_RANGE'; p25: number; p75: number }
    | { kind: 'DESCRIPTOR_CHANGED' }
    | { kind: 'TRUTH_RECOMPILED_AFTER'; frameId: string }>;
}
```

**Why separate from Truth:** an expectation is *falsifiable by the passage of time* — truth is not. Sealing a forecast inside an immutable truth object means either the truth object mutates (violating F-1) or stale forecasts persist as though observed. Separation also gives forecasts their own `modelVersion`, so improving the forecaster does not invalidate history.

---

## 12 · Boundary: truth / forecast / assessment / decision

| Layer | Owns | Example from this data |
|---|---|---|
| **Evidence** | deposit rows + descriptors | 52 payroll-shaped credits |
| **Income Truth** (in Financial Truth) | streams, cadence, level segments, unknowns | "Stream B: biweekly Friday, median ≈$5,316, 17 payments" |
| **Expected Financial State** | forward events + probability + invalidation | "Next ≈2026-07-31, $5,267–$5,316, p≈0.85" |
| **Assessment** | judgment | "income is stable; volatility fell after Dec 2025" |
| **Decision** | options + constraints | "≈$X allocatable after runway floor" |

### On your hypothesis

Your chain was:
```
Transactions → Income-series resolver → Observed Income Truth →
Expectation compiler → Expected Income Events → Cash-flow projection →
Assessment → Decision Set
```

**Two refinements, both supported by this investigation:**

1. **The income-series resolver is not a separate compiler — it is a resolution step *inside* the Resolver.** Everything it does is identity resolution (which deposits are the same payer) plus temporal resolution (what the cadence and level were as-of). Those are precisely the operations already assigned to the Resolver. Making it a separate stage would create a second thing that seals truth, and then you would need to decide which seal is authoritative.

2. **"Cash-flow projection" is not a distinct layer — it is the Expected Financial State.** Expected income events and expected obligations are the same artifact viewed from two sides; splitting them creates two forecasts that can disagree about the same week. Fold it in.

So the corrected chain:
```
Evidence → Resolver (incl. income-series resolution) → Financial Truth (incl. Income Truth)
        → Expectation Compiler → Expected Financial State (income + obligations)
        → Evaluator → Assessment → Decision
```

**This does validate the core of your instinct:** the Expectation Compiler is a genuinely new artifact producer, not a renaming — it has a distinct input (sealed truth), a distinct output (falsifiable forward events), a distinct version (model version), and a distinct invalidation semantics (time and observation). It earns its place between Truth and Assessment.

---

## 13 · Architectural gaps

| Gap | Status | Blocks |
|---|---|---|
| No income/stream entity | **[ABSENT]** | all of Income Truth |
| No cadence/interval detection anywhere | **[ABSENT]** | forecasting, stability judgment |
| `buildRecurringCandidates` uses a mean and ignores dates | **[EXISTS — unsuitable]** | would manufacture false raises |
| No payer identity resolution for income | **[ABSENT]** (merchant normalization is SPENDING-only, `transactions.ts:661-664`) | employer continuity, job-change detection |
| Day-precision dates | **[EXISTS — limitation]** | intra-day ordering; acceptable for payroll |
| No obligations model | **[ABSENT]** | "after known obligations" claims |
| No confirmed runway floor | **[ABSENT]** (V26-F2 D2 open) | any allocation recommendation |
| No `BalanceObservation` | **[ABSENT]** (V26-F3) | reproducing historical income conclusions |

---

## 14 · Recommended implementation order

1. **Income-series resolver as a pure core** — `income-series.core.ts`, following the 23-module `*-core.ts` convention. Input: settled inflow rows. Output: `IncomeStream[]`. No DB, no persistence, fully testable against fixtures derived from this analysis.
2. **Cadence + level-segment detection** inside that core (median/IQR, interval histogram, weekday anchor, segment change points with competing explanations).
3. **Income Truth into the sealed frame** — once F-1's truth object exists.
4. **Expectation compiler** — separate artifact, own model version.
5. **Assessment consumes income stability** — only after 1–4.

Deliberately **not** first: persistence. The resolver is a pure function over data that already exists; it can be built, tested and validated against 24 months of real history without a single schema change.

---

## 15 · Exact first implementation ticket

> **V26-INCOME-1 · Income-series resolver (pure core, no persistence)**
>
> Build `lib/income/income-series.core.ts` — a pure function from settled inflow rows to `IncomeStream[]`. **No schema, no migration, no persistence, no surface change.**
>
> **1. Core**
> - `resolveIncomeStreams(rows, opts): IncomeStream[]` per §10.
> - Group by normalized descriptor key **and** destination account. Do not group on the enriched merchant — DF-4 established it drifts (`fingerprint.ts:52-64`).
> - Cadence: build the interval histogram, then classify. **Biweekly requires a dominant 14-day interval *and* a stable weekday; semi-monthly requires clustering on two days-of-month.** Never infer biweekly from "two payments most months" — Stream A satisfies that and is semi-monthly.
> - Amounts: median and IQR. Outliers excluded from the level, **retained** in `outlierPaymentIds`.
> - Level segments: compare rolling medians; a segment requires ≥3 payments at the new level. Emit `competingExplanations` always; never emit a bare "raise".
> - `unknowns[]` is **required**, non-empty by construction when gross pay is unobservable.
>
> **2. Fixtures — from this investigation**
> - Semi-monthly: 15/14/17-day mix, scattered weekday ⇒ `SEMI_MONTHLY`.
> - Biweekly: 14-day dominant, Friday-anchored, three-payment months ⇒ `BIWEEKLY`.
> - **Bonus rejection:** a single 2.4× payment must **not** create a level segment. This is the regression test that matters most.
> - **Small-step ambiguity:** a +2.2% step must classify as `DEDUCTION_OR_WITHHOLDING_CHANGE` or `POSSIBLE_RAISE`, never `LIKELY_RAISE`.
> - Stream handover: overlapping end/start with zero shared entity tokens ⇒ two streams, never one.
>
> **3. Purity guard** — the module imports nothing from `@prisma/client` or `lib/db`; source-scanned, matching the `*-core.ts` convention.
>
> **Out of scope:** persistence, the expectation compiler, assessment consumption, any UI, payer identity *naming*.
>
> **Done when:** suite green, `tsc` clean, lint clean, and the core reproduces §4–§6 when run against the 24-month history.

---

## 16 · Proposed user-facing language, tested against this data

**Supported today** (observation only):
> "You're usually paid every other Friday — about $5,300, most recently on 17 July. That pattern has held for about six months."

**Supported with explicit uncertainty:**
> "Your typical pay rose from about $4,080 to about $4,390 around December 2024, and again to about $5,020 around October 2025. Net pay can move for several reasons — a raise, or a change in tax withholding or benefit deductions — and I can only see net deposits, so I can't tell which."

**Supported, carefully hedged:**
> "Your income appears to come from a different source since December 2025 — the payer name, the pay schedule (twice monthly → every two weeks) and the payday all changed at once. That usually means a job or payroll change, but I can't confirm which from banking data alone."

**NOT supported — do not ship:**
> ~~"You got a raise in December 2024."~~ — gross pay is unobservable.
> ~~"You changed jobs in December 2025."~~ — payer identity changed; the job change is inference.
> ~~"After your next paycheck you could put $Y toward debt while preserving your runway."~~ — see below.

### Dependency breakdown of the forward-looking sentence

| Dependency | Status |
|---|---|
| Observed income pattern | **[EXISTS]** — derivable now |
| Expected next payment | **[EXISTS]** as a derivation — biweekly Friday, next ≈2026-07-31 |
| Current balance | **[EXISTS]** — but current only, no history (V26-F3) |
| Upcoming obligations | **[ABSENT]** — no obligations model |
| Runway requirement | **[ABSENT]** — no confirmed floor (V26-F2 D2 open) |
| Debt terms | **[EXISTS]** — APR present, confidence partial |
| Investment option | **[ABSENT]** — no decision engine |
| Confidence | **[EXISTS]** as a contract, not yet computed |
| Invalidation conditions | **[ABSENT]** |

**Five of nine dependencies are absent.** The sentence must not ship as a recommendation. Its *first half* — the observed pattern and the expected payment — is honest today.

---

## 17 · Compact answers

**When did typical pay materially change?**
Three level changes in Stream A: **~Dec 2024** ($4,081→$4,389, +7.5%), **~Apr 2025** ($4,389→$4,487, +2.2%), **~Oct 2025** ($4,487→$5,016, +11.8%). Then the stream ended and a new one began at a different level and cadence in **~Dec 2025**.

**Which look like likely raises?**
**~Dec 2024** and **~Oct 2025** — both sustained multi-month steps where even the minimum payment cleared the new level. The **~Apr 2025** step (+2.2%) is too small to separate from a deduction change. The **Feb 2025** payment of ≈$10,669 is a **bonus, not a raise** — and would have been misread as one by any mean-based detector.

**Which could indicate a job or employer transition?**
**~December 2025**, on five coincident signals: stream ended, new stream began five days earlier, zero shared entity tokens in the descriptors, cadence changed semi-monthly→biweekly, weekday anchoring changed to Friday, first payment prorated, and the early level then declined as deductions began.

**How confident can Fourth Meridian honestly be?**
- Cadence classification: **HIGH**
- Level changes occurred: **HIGH** (that they occurred), **MEDIUM** (that they were raises)
- Bonus identification: **HIGH**
- Payer identity changed: **MEDIUM-HIGH**
- *Job* changed: **inference, MEDIUM** — a simultaneous payroll migration remains consistent
- Gross compensation: **UNKNOWN** and not obtainable from this evidence

**Can it forecast the next paycheck well enough for financial decisions?**
**For the payment, yes. For a decision, no — and the gap is not in the forecasting.**

Stream B supports a defensible forecast: next ≈ **2026-07-31**, amount ≈ **$5,267–$5,316** (the last four payments span only ~$50), probability high on ~6 months of 14-day regularity. Caveat: the date is a *bank posting* date, not the employer's payday.

But a decision needs nine inputs and **five are absent** — no obligations model, no confirmed runway floor, no decision engine, no invalidation contract, and no balance history to validate the projection against. Fourth Meridian can honestly say *"you're usually paid ~$5,300 every other Friday, next around 31 July."* It cannot yet honestly say what to do with it.
