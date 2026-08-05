# Phase 2 — Economic-Date Calibration Report

**READ-ONLY.** Zero writes. Every query a `SELECT`; a static scan confirms no
`create|update|delete|upsert|executeRaw` in the calibration script. Corpus
identical throughout: `Transaction` 4,447 / 4,402 active, `FinancialAccount` 35,
persisted counterparties **353**, `SpaceSnapshot` 1,686.

Reproduce: `npx tsx --env-file=.env.local scripts/audit-economic-date-calibration.ts`

Baseline: Phase 1 (`689d8f6`) applied — 353 counterparties, 16 reclassifications,
payment-app veto shipped.

---

## 0. Chronology inventory

Every place transfer reasoning depends on a date. Nothing else does.

**Leg timestamp constructors** — all currently read `Transaction.date` (posting):

| location | role |
|---|---|
| `RelationshipResolver.ts:527` `toTransferLeg` | **the read boundary** — the only production path |
| `scripts/audit-transfer-authority.ts:165` | the census |
| `scripts/repair-transfer-authority.ts:135` | the repair |
| `scripts/repair-transfer-classification.ts:133` | historical, applied |
| `scripts/repair-type-certain-debt-payment.ts:106` | historical, applied |

**Window comparisons** — consume `leg.dateMs`, so they move automatically:

| location | bound |
|---|---|
| `transfer-maturation.ts:681` `legsQualify` | ± `TRANSFER_MATCH_WINDOW_DAYS` |
| `transfer-maturation.ts:713` `legsQualifyIgnoringOwner` | ± `TRANSFER_MATCH_WINDOW_DAYS` |
| `transfer-maturation.ts:792` `mutualPairsAt` | ± tier tolerance (stratification) |
| `transfer-chain.ts:218` `continues` | ± `CHAIN_CONTINUATION_WINDOW_DAYS` |
| `transfer-chain.ts:208` hop ordering | deterministic sort |

**SQL candidate-gathering filters** — on the STORED posting column:

| location | bound |
|---|---|
| `transfer-resolution.ts:240–254` | `GATHER_WINDOW_MS = (window + 1) days` |
| `lib/data/transactions.ts:556` | `RELATIONSHIP_WINDOW_MS = 7 days` (drawer) |

> ⚠️ **The two SQL filters are the one thing that cannot follow the chronology.**
> `economicDate` is derived and unpersisted, so a `WHERE date BETWEEN …` clause
> can only ever filter on posting. If the in-memory matcher moves to economic
> dates while the query still bounds on posting, a leg whose economic date is in
> range but whose posting date is not will simply never be loaded — a silent
> starvation, invisible to every probe that only inspects matcher output.
>
> **Mitigation (Phase 3):** widen both gather windows by
> `ECONOMIC_DATE_MAX_LAG_DAYS` (14). Measured lag reaches 8 days with a hard
> credibility bound at 14, so `window + 14 + 1` cannot starve any admissible pair.
> This is a bounded over-fetch, not a semantic change — the matcher still refuses
> anything outside the real window.

`RelationshipResolver.sameDay` (line 266) is used only for **duplicate**
detection, not transfers. It is out of scope and must stay on posting date.

---

## 1. Corpus lag distribution

Economic-date basis over the 598 admitted legs: **591 `AUTHORIZATION/OK`, 7
`POSTING/OK`**. Zero `CONTRADICTORY`. **158 legs (26.4%) carry an economic date
that differs from their posting date.**

Gap histogram over every same-magnitude, opposite-sign, cross-account pair — the
exact population the window bounds:

```
         0    1    2    3    4    5    6  │   7    8    9   10   11   12   13   14   15
POSTING  189  48   21   17   14    6    2 │  16    4    3   14    9   14   14   52   67
ECONOMIC 207  37   16   19   10    6    3 │  15    5    3   15    5    6   16   63   80
```

**The shape is preserved.** Both decay monotonically to a trough at day 6, then
jump at day 7 and climb into the 14–15 recurrence bulge (bi-weekly and monthly
cadence). Economic dates sharpen the head — day 0 rises 189 → 207 — and thin days
1–2, which is exactly what removing settlement skew should do.

Per destination type and per institution, the same structure holds:

| slice | posting (0–6) | economic (0–6) |
|---|---|---|
| savings | 84·19·4·11·5·5·2 | 86·18·3·12·4·5·3 |
| checking | 183·42·19·17·13·4·2 | 199·33·15·17·10·4·3 |
| debt | 110·34·19·6·10·3·0 | **129**·22·14·8·6·3·0 |
| same institution | 130·35·9·10·11·5·2 | **151**·22·4·11·7·5·3 |
| cross institution | 59·13·12·7·3·1·0 | 56·15·12·8·3·1·0 |

Debt and same-institution tighten most (+19 and +21 at day 0) — internal card
payments authorize and post on the same day, and posting skew was the only thing
separating them.

---

## 2. Candidate competition

| evidence level | POSTING | ECONOMIC | Δ |
|---|---|---|---|
| `ACCOUNT_CERTAIN` | 206 | **218** | **+12** |
| `ACCOUNT_CERTAIN_LEG_AMBIGUOUS` | 15 | 12 | −3 |
| `TYPE_CERTAIN_ACCOUNT_AMBIGUOUS` | 36 | 27 | **−9** |
| `TYPE_AMBIGUOUS` | 6 | 6 | 0 |
| `NO_DESTINATION_EVIDENCE` | 140 | 140 | 0 |
| `PROVIDER_LINKED` | 132 | 132 | 0 |
| `CASH_NO_COUNTERPARTY` | 63 | 63 | 0 |

**Persistable counterparties 353 → 362 (+9). Unresolved 3 → 3.**

> **Every maturity is identical.** `DEBT_PAYMENT` 237, `SAVINGS_TRANSFER` 79,
> `CASH_TRANSFER` 76, `CASH_MOVEMENT` 63, `EXTERNAL_PERSON_TRANSFER` 118,
> `EXTERNAL_VENUE_TRANSFER` 21, `EXTERNAL_DEPOSITORY_TRANSFER` 1,
> `UNRESOLVED_TRANSFER` 3. Not one movement changes what it *is*. The chronology
> change moves certainty about the **account** and nothing else.

---

## 3. Tier effectiveness

Ground truth: the 66 provider-asserted correlation-id movements (132 legs).
Tiers measured **with identifiers disabled**, so each is scored for what it
contributes rather than what the tier above it already did.

| tier | POSTING correct / wrong | ECONOMIC correct / wrong |
|---|---|---|
| ±0 mutual | 116 / **0** | 112 / **0** |
| ±1 | 88 / 0 | 90 / 0 |
| ±2 | 82 / 0 | 84 / 0 |
| ±3 | 74 / 0 | 74 / 0 |
| ±5 | 72 / 0 | 72 / 0 |
| ±7 / ±10 / ±14 | 72 / 0 | 72 / 0 |

**Precision is 100% in every configuration under both chronologies. Zero wrong,
anywhere.** Correctness is never the constraint; only coverage moves.

Two facts worth naming:

- **Coverage is flat from ±5 to ±14** (234 legs, both bases). Widening the outer
  window past 5 days buys literally nothing — it only admits recurrence.
- **±0 recall drops 116 → 112 under economic dates.** Two provider-asserted
  movements have legs authorized on *different* days, so economic dating splits
  them off day 0. In the full ladder they are still caught by `PROVIDER_LINKED`
  (which is why §2 shows no maturity change) — but for an institution with no
  identifiers, that is a real loss. See §8.

---

## 4. Phase-1 validation — the gate

| check | result |
|---|---|
| persisted counterparties in the database | 353 |
| **still supported and identical under economicDate** | **353** |
| unsupported / became ambiguous | **0** |
| **contradicted (resolves to a different account)** | **0** |
| lower certainty (same account, weaker level) | **0** |
| rows whose economic maturity disagrees with stored `flowType` | **0** |

The last line validates the 16 reclassifications more strongly than checking them
individually would: it is a sweep over **all 4,402 active rows**, and none
disagrees. Nothing applied in Phase 1 becomes ambiguous, unsupported,
contradicted, or lower-confidence under the new chronology.

**Gate passed. No STOP condition triggered.**

---

## 5. Collision audit

**Nine legs change their resolved account, and all nine are
`TYPE_CERTAIN_ACCOUNT_AMBIGUOUS → ACCOUNT_CERTAIN`.** No leg loses an account; no
leg moves from one account to another.

The mechanism, verified against descriptors the authority never reads:

```
2026-01-02  −1,500  Chase checking ••2058  "AMERICAN EXPRESS ACH PMT M7878"   auth 01-02 → Amex ••1009
2026-01-02  −1,500  Chase checking ••2058  "Payment to Chase card ending in 0202"  auth 01-01 → Chase ••0202
```

Two $1,500 card payments **posting on the same day**, to two different cards.
Under posting dates each sees both cards, so both are type-certain and neither
resolves. Under economic dates their authorizations differ (01-02 vs 01-01),
which separates them — and each pairs with the card **its own descriptor names**.
The same shape occurs on 2025-11-10 and 2025-06-23.

Independent corroboration across the nine: **3 of 3 Chase-card legs name the
destination mask *and* institution; 3 of 3 Amex legs name the destination
institution.** The remaining 3 are the card-side mates.

> This is a class of ambiguity posting dates **structurally cannot** resolve, and
> it is the strongest single argument for the cutover.

Per risk class — legs gaining an account that had none:

| class | n | gained | lost |
|---|---|---|---|
| payment-app rail (Zelle · Apple Cash · Venmo · Cash App · PayPal) | 118 | **0** | 0 |
| cash form (ATM withdrawals) | 63 | **0** | 0 |
| brokerage / exchange venue (broker sweeps) | 21 | **0** | 0 |
| depository venue (ACH · savings transfers) | 153 | **0** | 0 |
| card payment family | 243 | 9 | 0 |

Structural vetoes under the new chronology:

- payment-app legs maturing to `DEBT_PAYMENT`: **0** ✓
- cash legs carrying a counterparty account: **0** ✓

**No new false pairing is introduced in any risk class.** Wires are not a class
here — no provider attests them, and per the architecture they belong on the rail
axis, not as a destination.

---

## 6. Pending lifecycle

| | |
|---|---|
| live pending rows | 15 |
| carrying `authorizedAt` | 11 / 15 |
| **pending rows whose economic date differs from posting** | **0** |
| posted rows pointing at a pending predecessor | 61 |
| **pairs where BOTH legs are admitted (duplicate-candidate risk)** | **0** ✓ |

Two honest readings:

1. **economicDate removes no artificial delay for pending rows in this corpus** —
   every live pending row authorizes and posts on the same day. The benefit is
   real but lives in the *posted* population (158 movers), not the pending one.
2. **No duplicate candidates.** The write-path tombstone already prevents a
   pending row and its posted successor from both being live, and the admission
   gate never sees both. Confirmed independently by
   `audit:pending-posted` (0 defects).

---

## 7. Chain continuation

`TRANSFER_MATCH_WINDOW_DAYS = 5`, `CHAIN_CONTINUATION_WINDOW_DAYS = 14`;
continuation > match ✓ — the theorem still holds, and it is chronology-independent
(it is a relation between two constants, not between two dates).

Certified hops: POSTING 169 → ECONOMIC 175 (+6, consistent with +12
`ACCOUNT_CERTAIN` legs). Multi-leg chains remain zero.

---

## 8. Structural floor — the generalization risk

The full-ladder gain (+9) is partly the provider tier absorbing the hard cases.
For an institution that supplies **no identifier at all** — American Express: 0 of
147 measured rows — only the structural tiers exist. That floor is what most of
the world will actually experience.

| level (identifiers disabled) | POSTING | ECONOMIC | Δ |
|---|---|---|---|
| `ACCOUNT_CERTAIN` | 308 | 304 | −4 |
| `ACCOUNT_CERTAIN_LEG_AMBIGUOUS` | 36 | 34 | −2 |
| `TYPE_CERTAIN_ACCOUNT_AMBIGUOUS` | 33 | 36 | +3 |
| `TYPE_AMBIGUOUS` | 19 | 23 | +4 |
| **persistable** | **344** | **338** | **−6** |

| | |
|---|---|
| floor legs losing an account | 12 |
| **floor legs whose account CHANGES** | **0** ✓ |

> ⚠️ **The floor regresses by 6 legs (1.7%), and this is the one genuine cost of
> the cutover.** The cause is the same as §3's recall drop: when two legs of one
> movement carry different authorization dates, economic dating separates them and
> the day-0 tier loses its uniqueness.
>
> **But zero legs change account.** Certainty is redistributed, never
> misdirected. The cutover cannot make the product *wrong*; at worst it makes it
> *quieter* for institutions with poor metadata.

---

## 9. Window optimization

Tier sweep on the floor, where window choice actually matters:

| tiers | POSTING certain / wrong | ECONOMIC certain / wrong |
|---|---|---|
| `[0]` | 258 / 0 | 266 / 0 |
| `[5]` | 234 / 0 | 234 / 0 |
| `[0,1]` | 288 / 0 | 282 / 0 |
| `[0,2]` | 300 / 0 | 294 / 0 |
| `[0,3]` | **308** / 0 | **304** / 0 |
| **`[0,5]` (shipped)** | 306 / 0 | 302 / 0 |
| `[0,7]` | 306 / 0 | 302 / 0 |
| `[0,2,5]` · `[0,3,5]` · `[0,1,2,3,5]` · `[0,1,3,5,7]` | **308** / 0 | **304** / 0 |

**Zero errors in all twelve configurations under both chronologies.**

### Recommended values — derived, not inherited

**Outer window: `TRANSFER_MATCH_WINDOW_DAYS = 5`. Unchanged.**
Re-derived from the economic histogram rather than carried over: the decay runs
0→6, troughs at 6 (3 pairs), and jumps to 15 at day 7 as the recurrence bulge
begins. The bound belongs between 6 and 7; 5 sits inside the decay and stops
before the bulge. Coverage is *identical* at 5, 7, 10 and 14, so nothing is
purchased by widening. (±6 is equally defensible on the evidence; ±5 is stricter
and costs nothing.)

**Stratified tiers: `[0, 5]`. Unchanged.**
`[0,3]` and `[0,3,5]` score +2 legs — but they score **+2 under posting dates
too**. The improvement is chronology-independent, so it is not a calibration
finding and does not belong in this phase. It is a real, separately-approvable
+0.3% available at any time.

**`CHAIN_CONTINUATION_WINDOW_DAYS = 14`. Unchanged.** A relation between
constants; no date enters it.

> **economicDate does not change the optimal window.** The corpus, measured fresh
> on the new chronology, draws the same line it drew on the old one. That is the
> evidence-derived answer — the values are re-derived and happen to coincide, not
> assumed to survive.

---

## 10. Risk assessment

| # | risk | severity | evidence | mitigation |
|---|---|---|---|---|
| **R1** | **SQL gather windows stay on the posting column** and can starve an economic-date match | **High** | structural — `economicDate` is unpersisted | Widen both by `ECONOMIC_DATE_MAX_LAG_DAYS` (14). Non-negotiable, Phase 3. |
| **R2** | Structural floor loses 6 legs (1.7%) where no identifier exists | Medium | §8, measured | Accept: 0 account changes. Certainty is redistributed, never misdirected. |
| **R3** | Ordering / cursor / filter must move **together** | **High** | keyset cursor invariant | Phase 3 must migrate all four atomically; a mixed chronology mis-sorts. |
| **R4** | Two provider-asserted movements split off day 0 | Low | §3 | Absorbed by `PROVIDER_LINKED`; visible only at the floor, already counted in R2. |
| **R5** | One user, two institutions | Medium | corpus | Per-institution metrics already reported; production must be measured, not assumed. |
| **R6** | 158 legs (26.4%) move day; 147 corpus rows cross a month | Medium | measured | This *is* the point of the cutover — but every period-scoped surface must move together or two surfaces will disagree. |

**No blocker.** R1 and R3 are Phase-3 implementation requirements, not
calibration defects.

---

## 11. Recommendation for Phase 3

Every gate passed:

- Phase 1's applied state survives intact — **353/353 counterparties, 0
  contradicted, 0 weakened, 0 maturity disagreements across all 4,402 rows**
- **Zero wrong pairings** in twelve tier configurations under both chronologies
- **Zero new false pairings** in any risk class; both structural vetoes hold
- No duplicate candidates in the pending lifecycle
- The optimal window is unchanged when re-derived on the new chronology
- economicDate resolves a real ambiguity class that posting dates cannot

Phase 3 must carry two requirements out of this report:

1. **Widen the SQL gather windows by 14 days** (`transfer-resolution.ts`,
   `lib/data/transactions.ts`). The only way the cutover can silently lose data.
2. **Move ordering, cursor, date filters and grouping atomically.** A keyset
   cursor ordered on one basis and filtered on another mis-paginates.

**The transfer authority is calibrated for economicDate. Phase 3 (economic-date read cutover) is approved.**
