# The production `activity` frame — period decision

**Date:** 2026-09-13 · Investigation only. **No repository code changed.** 500/500 tests pass.

Authority: 658cfd2, bb2f6ec, 55a2c22, 70ac794, a774989, d34330b, 0c0a84b, 9ba7c3f.
The two-measured-frame architecture is settled and is not reopened here.

> ## Recommendation: **TRAILING 6 MONTHS** — `PAST_6_MONTHS`, the preset the repository already owns.
>
> Not calendar YTD. The prior was worth challenging and it does not survive contact with the
> calendar: **under any non-trivial materiality rule, a YTD frame is absent for the first 179 days of
> every year** — Jan 1 to ~Jun 28 — because year-to-date is simply not broader than a 90-day window
> until late June. It is also *behind* trailing-6-months on reach for that entire half-year.
>
> Not available settled history. It is eliminated by two measured repository limits, not by taste:
> the assembler's floor clamps at **800 days** (this Space is at 788 — the clamp bites in ~12 days,
> silently, with the served window differing from the stated one) and the row cap truncates at
> **5,000, dropping the oldest rows** (this Space is at 4,270).
>
> `activity` is emitted **iff** its window is at least twice the assessment window; otherwise the key
> is **omitted**.

---

## 1. Repository facts that constrain the answer

Established by reading and by instrumented measurement against the live Space
(`cmrrm846r000j7znwsl67gt1g`, corpus `2024-07-18..2026-09-12`, 4,270 settled rows).

| fact | location | consequence |
|---|---|---|
| `ASSESSMENT_WINDOW_DAYS = 90`, W4-invariant across `scopeHint` | `lib/ai/assemblers/transactions.ts:232` | `recent` is fixed. Untouched here. |
| `MAX_EXPLICIT_WINDOW_DAYS = 800` — an explicit window's **floor is clamped** | `transactions.ts:261, 1830` | **Any policy that can exceed ~26 months silently serves a different window than it states.** Measured below. |
| `TRANSACTION_FETCH_LIMIT = 5000`, newest-first with a `+1` sentinel; overflow **drops the OLDEST rows** | `transactions.ts:207, 600-640` | A wide frame deflates older-month totals exactly where a wide frame is supposed to help. |
| The summary is **row-materializing, not DB-aggregating** — `findMany` with ~25 columns, then FX conversion per row, `resolveTransferAssessments` per row, needs-classification, category/merchant/income/recurring rollups in JS | `transactions.ts:600-760` | Cost is **linear in rows**, not in period. Measured below. |
| `resolveWindow`'s default floor and the clamp floor use `startOfDay(-n)` = **wall clock**, not `asOf` | `transactions.ts:1764, 1816, 1830` | The *clamp* is not asOf-anchored. Relevant only to policies that can reach the clamp — another reason to stay well inside it. |
| `compareToForPreset(preset, asOf, coverageFrom)` already maps `YTD`, `PAST_6_MONTHS`, `PAST_YEAR`, `ALL` → a start date, asOf-anchored, with `subMonths` month-end clamping; `ALL` returns `coverageFrom ?? null` — *"never fabricate a start"* | `lib/perspectives/time-range.ts:87-155` | **The vocabulary already exists.** A production frame should ask this parser. |
| A guard forbids a second preset parser: *"the window authority derives no dates of its own — it asks the parser"* | `lib/perspectives/financial-window.test.ts:110` | The implementation slice **may not** compute Jan 1 or minus-six-months itself. |
| `transactionCorpusSpan({spaceId, asOf})` returns the record's bounds under the same population and the same ceiling | `lib/data/transaction-query.ts` (55a2c22) | The only sanctioned source for "earliest available", and it is already asOf-disciplined. |

### 1.1 Authority used for every candidate figure

Every candidate's five figures come from **`get_spending({from, to})` → `TRANSACTIONS_SUMMARY`** — the
same assembler that produces the corresponding `recent` figure, one-to-one, with no arithmetic
outside it:

```
window.{from,to,days} ← result.window.{from,to,days}       income  ← result.totals.income
transactionCount      ← result.window.transactionCount     spending ← result.totals.spending
cardAndDebtPayments   ← result.totals.cardAndDebtPayments  netCashFlow ← result.totals.netCashFlow
```

Window starts come from `transactionCorpusSpan` (candidate C) or calendar arithmetic matching
`compareToForPreset` (A, B). Nothing is hard-coded.

---

## 2. Assembly and query cost — measured, not estimated

Prisma middleware counting every query, 7 runs per candidate after a warm call, live Space,
asOf 2026-09-13.

| candidate | window | days | rows | truncated | **DB queries** | latency min/median/max | serialized |
|---|---|---|---|---|---|---|---|
| `recent` (90d) | 2026-06-16..2026-09-13 | 90 | 445 | no | **8** | 24 / **28** / 40 ms | 236 B / 59 tok |
| **B — trailing 6 mo** | 2026-03-13..2026-09-13 | 185 | 903 | no | **8** | 39 / **41** / 60 ms | 234 B / 59 tok |
| A — calendar YTD | 2026-01-01..2026-09-13 | 256 | 1,256 | no | **8** | 51 / **58** / 62 ms | 239 B / 60 tok |
| C — available history | 2024-07-18..2026-09-13 | 788 | 4,270 | no | **8** | 155 / **169** / 194 ms | 240 B / 60 tok |

**Query count is constant at 8 for every period** — `SpaceDashboardSection.findFirst` ×1,
`Transaction.findMany` ×2, `Space.findUnique` ×1, `FinancialAccount.findMany` ×3,
`SpaceAccountLink.findMany` ×1. Period changes **latency**, not query shape, and latency tracks rows
almost exactly (~0.038 ms/row).

**Marginal cost of the second frame, on top of `recent`'s 28 ms:** +41 ms (6 mo), +58 ms (YTD),
+169 ms (full history). A 6-month frame roughly **doubles** the orientation's transaction-assembly
time; YTD roughly triples it by September and more by December; full history is **6×**.

**What is not known:** this is one Space on one local Postgres. Per-Space row density varies, and no
production timing exists. What *is* known and does not vary is the shape — 8 queries, linear in rows,
no aggregation pushdown — so a Space with 3× the rows costs ~3× the time for the same period.

**The orientation build is per-request**, so this is a recurring cost on every conversation start.
No cache is proposed (out of scope, per the brief).

### 2.2 The two hard ceilings, measured

```
requested 2024-07-18 (788d) -> served 2024-07-18..2026-09-13 (788d)  rows=4270  CLAMPED=false
requested 2024-01-01 (987d) -> served 2024-07-04..2026-09-13 (802d)  rows=4270  CLAMPED=TRUE
requested 2023-01-01 (1352d)-> served 2024-07-04..2026-09-13 (802d)  rows=4270  CLAMPED=TRUE
```

The clamp is **silent in the tool payload**: `window.from` comes back as `2024-07-04`, and
`get_spending`'s shape carries no `LOOKBACK_CLAMP` marker. A frame built on "available history" would
therefore **state a period it did not measure** the moment a Space exceeds ~26 months — the exact
defect class this whole series has been closing. This Space is **12 days** from crossing it.

Separately, at ~5.4 settled rows/day this Space reaches the 5,000-row cap in roughly five months,
after which a full-history frame would silently drop its oldest rows.

---

## 3. Context cost (Q7)

The minimal shape is preserved exactly — `window`, `income`, `spending`, `cardAndDebtPayments`,
`netCashFlow`, `transactionCount`. No categories, merchants, monthly series, coverage notes or prose.

| period | bytes | ~tokens |
|---|---|---|
| trailing 6 months | 234 | 59 |
| calendar YTD | 239 | 60 |
| available history | 240 | 60 |

**Verified: period length does not materially change orientation cost** — the 6-byte spread is the
day-count and date strings. All are ~+7% of the orientation and **+1.0% of the turn-1 prefix**
(system instruction 196 tok + orientation 828 tok + tool schemas 4,868 tok). The token argument does
not distinguish the candidates.

---

## 4. Calendar behaviour (Q2, Q9) — where YTD loses

`recent.from = asOf − 89`. Materiality invariant under test: **`activity.window.days ≥ 2 × 90`**.

| asOf | recent.from | YTD days | YTD emits? | 6-mo days | 6-mo emits? | which reaches further |
|---|---|---|---|---|---|---|
| 2026-01-01 | 2025-10-04 | 1 | **no** | 185 | yes | 6 mo |
| 2026-01-15 | 2025-10-18 | 15 | **no** | 185 | yes | 6 mo |
| 2026-02-01 | 2025-11-04 | 32 | **no** | 185 | yes | 6 mo |
| 2026-03-01 | 2025-12-02 | 60 | **no** | 182 | yes | 6 mo |
| 2026-03-31 | 2026-01-01 | 90 | **no** | 183 | yes | 6 mo |
| 2026-04-01 | 2026-01-02 | 91 | **no** | 183 | yes | 6 mo |
| 2026-05-01 | 2026-02-01 | 121 | **no** | 182 | yes | 6 mo |
| 2026-06-28 | 2026-03-31 | 179 | **no** | 183 | yes | 6 mo |
| **2026-06-29** | 2026-04-01 | **180** | **yes** | 183 | yes | 6 mo |
| 2026-07-01 | 2026-04-03 | 182 | yes | 182 | yes | equal |
| 2026-09-13 | 2026-06-16 | 256 | yes | 185 | yes | YTD |
| 2026-12-31 | 2026-10-03 | 365 | yes | 185 | yes | YTD |

**Exact YTD activation: 2026-06-29, 2027-06-29, 2028-06-28** — suppressed for the **first 179 days of
every year**, computed with the repository's own calendar helpers.

**Reach crossover: 6 months reaches further from Jan 1 through Jun 30; YTD from Jul 2 onward.** YTD
is not merely absent for half the year — for that same half it would have been the *shallower* frame
anyway.

**Trailing 6 months emits every day of the year**, at 182–185 inclusive days (`subMonths`, calendar
arithmetic, not a fixed day count — the repository convention), i.e. always 2.02–2.06× `recent`.

**Weakening the invariant does not rescue YTD.** Under the trivial rule `activity.from < recent.from`,
YTD activates 2026-04-01 and adds **one day**; it is still under 30 days broader through late April.
Under "at least one full assessment window further back" the answer is identical to the 2× rule,
June 29. The suppression is intrinsic: year-to-date is *definitionally* shorter than a rolling 90-day
window until the year is 180 days old.

**Stability through one day passing (Q9):** trailing 6 months — both boundaries advance, width and
meaning constant, daily membership churn only. YTD — start pinned within the year, end advances, and
a **hard reset each Jan 1** that deletes the frame for six months. Available history — start pinned,
width grows without bound, meaning drifts from "medium term" toward "lifetime", and the user
population has wildly inconsistent frame lengths.

---

## 5. Sparse history (Q4) and deep history (Q5)

Emulated by reading the live corpus at `asOf = earliest + N`, so each row is a real Space with exactly
N days of record. `— NONE` means the candidate's effective start is not earlier than `recent.from`
after clamping to the record, i.e. it adds no period at all.

| history | asOf | YTD adds | 6-mo adds | full-history adds | rows(recent) | rows(6 mo) | rows(full) |
|---|---|---|---|---|---|---|---|
| 29 d | 2024-08-16 | **NONE** | **NONE** | **NONE** | 99 | 99 | 99 |
| 45 d | 2024-09-01 | **NONE** | **NONE** | **NONE** | 191 | 191 | 191 |
| 90 d | 2024-10-16 | 1 d | 1 d | 1 d | 401 | 402 | 402 |
| 120 d | 2024-11-15 | 31 d | 31 d | 31 d | 435 | 537 | 537 |
| 183 d | 2025-01-17 | **NONE** ← *January* | **94 d** | 94 d | 444 | 857 | 857 |
| 365 d | 2025-07-18 | 109 d | 92 d | 276 d | 673 | 1,183 | 2,040 |
| 730 d | 2026-07-18 | 109 d | 92 d | 641 d | 428 | 843 | **3,948** |
| 787 d | 2026-09-13 | 166 d | 95 d | 698 d | 445 | 903 | **4,270** |

**Under 90 days of history all three candidates collapse into `recent`** — identical windows,
identical rows, identical figures. A second frame there would be a duplicate wearing a different
label. **Absence is correct, and the materiality invariant produces it without a special case.**

The 183-day row is the January problem meeting a real Space: six months of genuine history, a second
frame finally worth having, and **YTD contributes nothing** while trailing-6-months contributes 94
days and nearly doubles the row base.

**Deep history, and the distinction the brief names.** At 788 days, an available-history frame is
truthful and semantically poor: **income $289,593.30, spending $223,155.08, card/debt payments
$251,088.39, 4,270 transactions.** Those are correct totals and an unusable behavioural frame — and
users would carry frames of wildly different length (3 months for one, 4 years for another), so
nothing is comparable between them.

> **Investigative coverage ≠ measured behavioural frame.** The reach that makes historical evidence
> findable is already provided by `get_transactions.coverage` (55a2c22), which costs nothing per turn
> and states the record's true bounds. The measured frame does not need to be the widest thing
> available, and 55a2c22 plus this investigation together say it should not be.

---

## 6. Retrospective / asOf behaviour (Q3)

Measured at the brief's asOf values, plus the calendar boundaries.

| asOf | corpus (under asOf) | YTD from | 6-mo from | YTD rows | end leak? |
|---|---|---|---|---|---|
| 2025-12-31 | 2024-07-18..**2025-12-31** | 2025-01-01 | 2025-07-01 | 2,251 | **no** |
| 2026-01-01 | 2024-07-18..**2026-01-01** | 2026-01-01 | 2025-07-01 | 10 | **no** |
| 2026-03-15 | 2024-07-18..**2026-03-15** | 2026-01-01 | 2025-09-15 | 366 | **no** |
| 2026-07-01 | 2024-07-18..**2026-07-01** | 2026-01-01 | 2026-01-01 | 879 | **no** |

- **No future transaction influences start or end.** Every candidate start is derived from `asOf`
  alone (`startOfYear(asOf)` / `subMonths(asOf, 6)`), and `to` is `asOf`.
- **No metadata discloses future history.** `transactionCorpusSpan` bounds its max at `asOf` (55a2c22),
  so "earliest available" under a retrospective read is the earliest **visible at or before asOf**,
  never today's corpus start reused.
- **Values are measured only from evidence at or before `asOf`** — `get_spending` clamps `to` to the
  ceiling; 0 end-date leaks in 9 retrospective reads.
- **One residual, and it argues for the recommendation:** the `MAX_EXPLICIT_WINDOW_DAYS` floor is
  computed from the **wall clock**, not `asOf` (`startOfDay(-800)`), so a deep retrospective read's
  allowed reach depends on today's date. A 6-month frame never approaches 800 days and is immune.
  Available-history is not — a second reason to reject it.

---

## 7. Targeted model evaluation (Q8)

Candidate C was eliminated by §2.2/§5 **before** any model call, so the probe ran the two survivors:
**4 prompts × 2 policies × 5 trials = 40 runs**, gpt-5.1, standalone A2, `recent` byte-identical in
both conditions, policies fixed before the prompts were chosen.

```
recent    2026-06-14..2026-09-12  90d   spending 13,919.69
YTD       2026-01-01..2026-09-12 255d   spending 57,587.84
SIX_MONTH 2026-03-12..2026-09-12 185d   spending 42,346.54
```

| prompt | policy | frame use | period labelled | tool windows | avg calls · hops · len |
|---|---|---|---|---|---|
| **P1** *"How have I been doing this year?"* | YTD | **5/5 answer as a year-to-date read**, both frames quoted | **5/5** | none | 0.0 · 1.0 · 2,319 |
| | 6-mo | answers *"2026 so far"* using 90-day + 6-month figures | **5/5** | none | 0.0 · 1.0 · 2,012 |
| **P2** *"How have I been doing lately?"* | YTD | 5/5 lead with the 90-day block | **5/5** | none | 0.0 · 1.0 · 2,456 |
| | 6-mo | 5/5 lead with the 90-day block | **5/5** | none | 0.0 · 1.0 · 2,143 |
| **P3** *"Do I usually spend this much?"* | YTD | **5/5 normalized to $/day or $/month** | 5/5 | 90-day re-read ×4 | 0.8 · 1.8 · 910 |
| | 6-mo | **5/5 normalized**, and **4/5 fetched a 12-month baseline** | 5/5 | `2025-09-12..2026-09-12` ×3, a 90d/275d split ×1 | 1.2 · 2.2 · 757 |
| **P4** *"Did I move any money out of my crypto accounts earlier in the year?"* | YTD | Feb-27 rows returned **4/5**, cited 4/5 | n/a | **`2026-01-01..2026-09-12`** 5/5 | 1.8 · 2.8 · 461 |
| | 6-mo | Feb-27 rows **0/5** | n/a | **`2026-01-01..2026-09-12`** 5/5 | 1.0 · 2.0 · 834 |

**Contamination: 0/40.** My proximity scorer flagged two trials; **both are false positives** — the
period heading sat more than five lines above the last figure in a list (*"**3. Year-to-date activity
(2026-01-01 to 2026-09-12)**"*, *"**6-month pattern (Mar 12–Sep 12)**"*). Re-read directly, every
figure in all 40 answers is correctly attributed. *(Recorded because the same class of marker error
produced the 3/5→0/5 erratum.)*

**P3 is the clearest shared win and answers the "usually" criterion:** **10/10 normalized before
comparing** — *"$155/day vs $226/day"*, *"$4,640/month vs $7,137/month"*. Zero raw-total comparisons.
The 6-month condition reached **beyond its own frame** to a 12-month baseline in 4/5, which is both
better evidence and proof that the frame is a default rather than a cage.

**P4 does not discriminate the policies, and I will not present it as if it did.** Both conditions
issued the **identical** first call `{from: 2026-01-01, to: 2026-09-12, flow: transfers}` — the
6-month condition searched from January, well outside its own frame. The window came from the
question's words *"earlier in the year"*, not from the orientation. What differed was persistence:
YTD followed up with `text: "Coinbase"` in 4/5; 6-month did not in 0/5 and stopped at *"I can't
tell"*. At n=5 that is a stochastic follow-up difference, not a period effect. **The useful finding
is the one both conditions share: a question that names a period overrides the frame.**

**P1 is the one genuine point for YTD.** *"How have I been doing this year?"* with a YTD frame gets a
year-to-date answer from the frame, 5/5, no retrieval. With a 6-month frame the model still writes
*"2026 so far"* and then supplies 90-day and 6-month figures — **correctly labelled, but silently
under-covering the question: 0/5 noted that the figures do not span the year.** Neither policy
fetched a YTD window (0 tool calls in all 10 P1 runs). This is a real, if soft, semantic mismatch.

**P2 confirms the gate result holds under both policies:** *"lately"* stays anchored to the 90-day
block 10/10.

---

## 8. Decision, against the brief's ordered criteria

| | trailing 6 months | calendar YTD | available history |
|---|---|---|---|
| **1 · Truth** | ✅ | ✅ | ❌ **clamped at 800 d, silently**; truncates at 5,000 rows dropping the oldest |
| **2 · Legibility** | ✅ *"the last six months"* | ✅✅ *"this year"* | ❌ *"everything we can establish"* means 3 months for one user, 4 years for another |
| **3 · Complementarity** | ✅✅ **2.02–2.06× recent, every day of the year** | ❌ **absent 179 days/year**; 1 extra day in April, 31 by May | ✅ reach, ❌ $289,593 income over 788 days is not a behavioural frame |
| **4 · Investigative utility** | ✅ uniform ~183 d | ◐ 1→365 d; deeper only Jul–Dec | ✅ maximal, but §2.2 |
| **5 · Temporal stability** | ✅✅ meaning constant | ❌ hard Jan-1 reset; frame vanishes for half the year | ❌ meaning drifts toward "lifetime" |
| **6 · Assembly cost** | ✅ **+41 ms, 903 rows**, bounded forever | ◐ +58 ms today, ~1,700 rows by December | ❌ **+169 ms, 4,270 rows**, unbounded |
| **7 · Context cost** | 59 tok | 60 tok | 60 tok |
| **Model evidence** | P2 ✅, P3 ✅ (+12-mo baseline), P1 ◐ under-covers a "this year" question silently | P1 ✅, P2 ✅, P3 ✅ | not run — eliminated first |

**Trailing 6 months wins on truth, complementarity, stability and cost; YTD wins only on legibility
and only on the "this year" question — and on 179 days a year it would not be present to win it.**

### 8.1 Rejected, and why

- **Calendar YTD.** Rejected on **complementarity and stability**, not on legibility. Absent for the
  first 179 days of every year under any materiality rule; the shallower of the two frames for that
  entire half-year; a hard annual reset that makes conversational meaning discontinuous; and by
  December it is 365 days and ~1,700 rows, drifting toward the behavioural-poverty problem that
  disqualifies candidate C. Its one advantage — P1 — is real and is the cost of this decision, stated
  plainly rather than argued away.
- **Available settled history.** Rejected on **truth**, first and decisively: the 800-day floor clamp
  serves a window different from the one stated, with no marker in the payload, and this Space
  crosses it in ~12 days; the 5,000-row cap drops the oldest rows, and this Space is at 4,270. Then
  on semantics (§5) and cost (169 ms, unbounded). **This does not remove
  `get_transactions.coverage`** — corpus coverage remains the right authority metadata, costs nothing
  per turn, and is what makes historical evidence *findable* without making it the *measured frame*.
- **`PAST_YEAR`.** Not evaluated as a primary candidate and not proposed: ~365 days would be 1,700+
  rows and ~80 ms today, 4× `recent`, and shades toward the behavioural-poverty problem without
  buying uniform reach over `PAST_6_MONTHS`. Worth a line in the implementation slice only if the
  6-month frame proves too shallow in practice.
- **Any model-chosen or adaptive period.** Out of scope by instruction and by architecture — the
  production period must be deterministic.

### 8.2 Name (Q10)

`activity` with a 6-month period is intuitive and is **not** renamed. The name would have become
misleading only under the available-history policy, where "activity" would mean a lifetime; that
policy is rejected. No naming experiment was run, per the brief.

---

## 9. Proposed production contract

Precise enough to implement without reopening product semantics. **Not implemented.**

```
recent    UNCHANGED. ASSESSMENT_WINDOW_DAYS = 90, W4, computeAssessment's window.
          Nothing in this contract touches it.

Let  asOf         = the orientation's information ceiling
     coverageFrom = transactionCorpusSpan({ spaceId, asOf }).from       // 55a2c22, asOf-bound
     wanted       = compareToForPreset('PAST_6_MONTHS', asOf, coverageFrom)   // lib/perspectives/time-range
                                                                         // = subMonths(asOf, 6)

activity.window.from = max(wanted, coverageFrom)     // never claim a period before the record
activity.window.to   = asOf
activity.window.days = the assembler's own inclusive count for [from, to]

activity.{income, spending, cardAndDebtPayments, netCashFlow, transactionCount}
     = TRANSACTIONS_SUMMARY measured over exactly [from, to], one-to-one, no arithmetic outside it.

activity EXISTS  iff  coverageFrom is not null
                AND   activity.window.days >= 2 * ASSESSMENT_WINDOW_DAYS      // = 180

Otherwise the KEY IS OMITTED — not null.

Retrospective reads use the retrospective authority only: the start derives from asOf, the corpus
bound is taken under asOf, and no figure is measured from evidence after asOf.

Field set is exactly: window, income, spending, cardAndDebtPayments, netCashFlow, transactionCount.
No categories, merchants, monthly series, coverage notes or prose.
```

**Why `max(wanted, coverageFrom)` and not `wanted` alone:** a Space whose record starts after
`subMonths(asOf, 6)` would otherwise state a period it cannot have measured. This mirrors
`compareToForPreset('ALL', …)`'s own doctrine — *never fabricate a start*.

**Why `days >= 180` and not `from < recent.from`:** the weaker rule emits a frame one day broader
than `recent` (§4) and, on a Space with 90–120 days of history, a near-duplicate (§5). The 2×
invariant is a single comparison of two integers already present in the payload, it produces correct
absence on sparse Spaces with no special case, and under the recommended policy it is satisfied on
every day of the year once a Space has six months of record.

**Why the key is omitted rather than null:** a `null` frame is a *statement* that something is
unavailable and invites narration about missing data; an absent key is simply the pre-gate
orientation, which is the control condition already proven safe across 25 trials in 9ba7c3f. d34330b
also established that a field carrying no measured figures does not become a frame — a null one
certainly would not, and it would cost tokens for nothing.

**Constraints the implementation slice inherits:**

- It must obtain the start from `compareToForPreset` — `lib/perspectives/financial-window.test.ts`
  forbids a second preset parser, and a hand-rolled `subMonths` would be exactly that.
- It must not touch `ASSESSMENT_WINDOW_DAYS`, `recent`, `computeAssessment`, the system instruction,
  tool descriptions or schemas.
- It adds one `TRANSACTIONS_SUMMARY` assembly per orientation build: **+8 DB queries, ~+41 ms, ~900
  rows** on this Space, bounded by the period for all time. No cache is proposed.

---

## 10. Edge cases, with the contract's answer

| case | outcome |
|---|---|
| Brand-new Space, < 30 days | `coverageFrom` exists, days < 180 → **omitted**. Measured: all candidates collapse into `recent` (99 rows vs 99). |
| 45 / 90 / 120 days | **omitted** (days 46 / 91 / 121 < 180). Avoids the 1-day and 31-day near-duplicates. |
| Exactly 180 days of record | emitted, `from = coverageFrom`, days = 180. First day the frame exists. |
| 6 months+ | emitted every day, 182–185 days, 2.02–2.06× `recent`. |
| Multi-year Space | still 182–185 days. **Never approaches the 800-day clamp or the 5,000-row cap.** |
| Space with no transactions | `coverageFrom` null → **omitted**. |
| Retrospective read at 2026-01-01 | `from = 2025-07-01`, `to = 2026-01-01`, figures measured under the ceiling, corpus bound taken under the ceiling. Emitted. |
| Retrospective read before the record begins | `coverageFrom` null under that ceiling → **omitted**. |
| `subMonths` at a month end (Aug 31 − 6 → Feb 28/29) | handled by the repository's own clamp; day counts vary 182–185 and are reported, not assumed. |
| A question that names its own period | Overrides the frame in both policies — measured, P4, 10/10. The frame is a default, not a cage. |

---

## 11. What this investigation did not settle

- **P1's cost is real.** With a 6-month frame, *"how have I been doing this year?"* is answered from
  sub-year figures, correctly labelled but silently under-covering, 5/5. Whether that matters enough
  to justify a second broader frame — or a `get_spending` call the model does not currently make — is
  a product question this decision leaves open. It should be re-measured after the slice ships.
- **n = 5 per cell, one Space, one model.** The 0/40 contamination count is unambiguous; the P4
  4/5-vs-0/5 split is not, and is explicitly not used.
- **Assembly cost is one local Postgres.** The shape (8 queries, linear in rows, no pushdown) is
  established; absolute numbers on production hardware are not.
- **Sparse-history behaviour is emulated** by reading the live corpus under an early `asOf`. It is a
  faithful emulation of *history length*, not of a genuinely new Space's data shape.
- **`PAST_YEAR`** was not measured against the survivors.

**Kept separate and untouched, per the brief:** card-payment ranking; R2→R3 causal calibration;
harness `AiInvocation` telemetry; bonus/scenario inherited-state; standing-preference memory shape.

---

## 12. What this investigation changed

**No repository code.** All measurement harnesses are in gitignored `tmp/causal/`.
`ASSESSMENT_WINDOW_DAYS`, `thinCore()`, the production AI route, tool descriptions, the model prompt,
transaction ranking, memory and the scenario tools are untouched. This document is the only artefact,
and the contract in §9 is a proposal.
