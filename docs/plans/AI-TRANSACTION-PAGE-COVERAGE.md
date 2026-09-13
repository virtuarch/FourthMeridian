# Page coverage — a page is not a population

**Date:** 2026-09-13 · Implementation + measurement. **502/502 test files**, typecheck clean, lint
unchanged. Authority: 58b352f (the blocker), 55a2c22 (window coverage), 597745a (complete-population
ranking).

> ## The blocker is closed, on both criteria.
>
> Focused discriminator on the exact failed sequence, 5 trials: **0/5 claim absence** (safety) and
> **5/5 return the Feb-27 rows and cite $8,141.98 / $1,902.12** (evidence retrieval).
>
> It took **two** changes, and the second exists because the first was *measured* insufficient:
> shipping only the honest count left gpt-5.1 asserting *"I pulled all transfers"* in **3 of 5**
> trials, over a payload that said `shown: 50, matchedInWindow: 80, searchIsComplete: false`.
>
> Broad gate re-run: **17 turns, 0 errors, the old turn-6 failure gone**, $0.0104/turn.

---

## 1–3. The failure, reproduced deterministically

**Turn-6 arguments, verbatim from the gate artifact:**

```
get_transactions({ from: "2026-01-01", to: "2026-09-12", flow: "transfers", limit: 50 })
```

**Root cause.** The window was right and the authority had the rows. `queryTransactions` returned
the newest 50 of an **80-row matching population**, ending `2026-03-03`. The evidence is at
`2026-02-27`.

```
page 1: 50 rows, 2026-09-11 .. 2026-03-03   hasMore=true
page 2: 30 rows, 2026-03-02 .. 2026-01-01   hasMore=false   <-- COINBASE at row 52
```

**The evidence was on page 2, at row 52 of 80.** `text: 'coinbase'` over the *identical* window
returns both rows immediately — so **text filtering is SQL-side, before pagination**; the evidence
was hidden by paging, not missing from the authority, and there is no deeper filter defect.

## 4–5. What the old fields meant

- **`moreAvailable`** = `!page.hasMore`, from the `limit + 1` sentinel. *"At least one more row
  matches beyond this page."* A **transport** fact. It says something is missing; it does not say how
  much, and it sits beside `shown: 50` which reads as a complete answer to a filtered query. One
  producer, **no consumers** besides the model.
- **`rankingIsComplete`** (the `sort: 'largest'` path only) = every row matching the filters inside
  the window was read and ranked, subject to `TRANSACTION_FETCH_LIMIT`. A genuine evidence ceiling —
  and the model never had its equivalent on the paged path.
- The tool **did not know** the matching population on the paged path at all.

## 6. Remedy chosen, and what was rejected

**Option 1 (completeness envelope) + Option 2 (bounded completion), in that order, because Option 1
alone was measured and failed.**

| rejected | why |
|---|---|
| Option 1 alone | Measured: 3/5 still claimed absence (§18). A truthful sample is still a sample. |
| Exhaust every query | Turns a browse into a 5,000-row materialization; explicitly out of bounds. |
| Raise the default `limit` | Pays tokens on every call to fix the minority that need it. |
| Auto-widen the date window | Forbidden, and the window was already correct. |
| Prompt doctrine / intent classifier | Forbidden, and 7859d6c showed structure moves behaviour where exhortation does not. |
| Reuse `readWindowToExhaustion` on the paged path | It materialises rows to get a size; a `count` gets the size for free and stays correct **above** the ceiling where exhaustion cannot. |

## 7. The result contract

```jsonc
// paged path only — sort:'largest' keeps rankedOver / rankingIsComplete / pagesRead untouched
shown: 80,
matchedInWindow: 80,
searchIsComplete: true,
// present only when the page was short:
searchCaveat: "Showed the 50 newest of 1221 transactions matching this search in the window.
               The rest were not read: absence from these rows is NOT absence from the window.
               Narrow with `text`, `category` or `flow`, or rank the whole set with sort:\"largest\"."
```

`moreAvailable` is **retired**, not left alongside — the block strictly subsumes it. Window coverage
(`coverage.*`, 55a2c22) stays a **separate** ceiling: the blocker failed *both*, and neither alone
described it.

New authority: `countTransactions` in `lib/data/transaction-query.ts` — one indexed aggregate over
`bankingTransactionWhere` + `buildFilterWhere`, **no keyset** (a cursor bounds a page, and a page is
what it is counting past), **no rows materialised**, no FX, no transfer assessment.

## 8. Internal exhaustion — required, and bounded

Yes, in one narrow form. When the matching population is **> `limit` and ≤ `COMPLETABLE_SEARCH_ROWS`
(100)**, the search is finished rather than sampled: one more bounded read of the **identical
filters**, changing only `limit`.

100 sits above the populations an ordinary filtered question produces (the blocker matched 80) and
far below the read ceiling. **Above it nothing changes** — measured: the 1,221-row annual all-flows
population stays a 15-row page, `searchIsComplete: false`, 696 tokens.

## 9. Hard ceiling

`TRANSACTION_FETCH_LIMIT` and `MAX_TRANSACTION_PAGE_SIZE` are untouched. Above
`COMPLETABLE_SEARCH_ROWS` a result is explicitly incomplete and carries the caveat; nothing is
silently truncated, and no count is fabricated.

## 10–15. Controls (`npm run ai:corpus-check` §6, 16 live assertions, all pass)

| | |
|---|---|
| **Positive** | `text: 'coinbase'`, Jan–Sep → `shown 2, matched 2, complete true`, both 2026-02-27 rows |
| **The blocker call** | now `shown 80, matched 80, complete true` — **Coinbase present in the returned rows** |
| **Complete absence** | `text: 'kraken'` → `shown 0, matched 0, complete true`, **no caveat** — absence is now supportable |
| **Browse** | 1,221-row population, `limit 15` → `shown 15, complete false`, caveat present, **not inflated** |
| **`sort: 'largest'`** | `rankingIsComplete true`, `rankedOver`/`pagesRead` intact, **no page-coverage block**, and ranking still surfaces the evidence |
| **Cursor** | the raw keyset walk is unchanged; `queryTransactions`' contract untouched |
| **Retrospective `asOf`** | `matched 19` at `asOf 2026-02-01` against `78` at the ceiling — **the count obeys the information ceiling** |
| **Visibility** | same `bankingTransactionWhere`, asserted by source scan |

## 16. Query and latency impact

| call | Transaction queries | median |
|---|---|---|
| browse 15, 90d | count, findMany ×2, aggregate | **22 ms** |
| annual all-flows 50 (pop 1,221) | count, findMany ×2, aggregate | **29 ms** |
| annual transfers 50 (pop 80, **completes**) | count, findMany ×4, aggregate | — |
| annual text-filtered | count, findMany ×2, aggregate | **24 ms** |
| `sort: 'largest'` annual | findMany ×2, aggregate — **no count** | **220 ms** |

A browse pays **one indexed count**, run concurrently with the page; measured latency is at or below
the pre-change numbers (22–29 ms vs 30–32 ms). Only the completing case pays an extra page read.
`sort: 'largest'` pays nothing.

## 17. Token cost

| | before | after |
|---|---|---|
| the blocker call | 2,929 tok | **4,507 tok** (now complete, evidence included) |
| filtered `coinbase` | ~294 | 294 |
| complete empty search | ~128 | 128 |
| 1,221-row browse | ~696 | **696** |

Paid only where it converts a broken answer into a complete one.

## 18–20. GPT-5.1 discriminator — the exact failed sequence, 5 trials

**With the count alone (Option 1):**

| | |
|---|---|
| Claimed absence | **3/5** — one wrote *"I pulled **all** transfers from 2026-01-01 to 2026-09-12"* over a payload saying `searchIsComplete: false` |
| Found the evidence | 2/5 — both via `sort: 'largest'`, which exhausts |

That is the measurement that justified the second change. Two of the three failures were
*flow*-misscoped text searches (`flow: 'income'`/`'spending'` with `text: 'Coinbase'`) which returned
`matched 0, complete true` — truthful, and truthfully useless.

**With both changes:**

| | |
|---|---|
| **Claimed absence** | **0/5** |
| **Returned the Feb-27 rows** | **5/5** |
| **Cited $8,141.98 / $1,902.12** | **5/5** |
| Hops | 2 in every trial |

> *"Yes — there's hard evidence you cashed out crypto this year… On 2026-02-27, two incoming
> transfers from Coinbase: $8,141.98, $1,902.12."*

**SAFETY SUCCESS: yes. EVIDENCE-RETRIEVAL SUCCESS: yes.**

## 21. Broad gate re-run

Same 17-turn shape as 58b352f, fresh session, no other fix applied.

| | 58b352f | re-run |
|---|---|---|
| Turns / errors / failed tool calls | 17 / 0 / 0 | 17 / 0 / 0 |
| **The blocker turn** | **FAIL** — *"don't show obvious crypto off-ramps"* | **PASS** — *"you did cash out crypto this year… $8,141.98, $1,902.12"*, **no tool call needed** (turn 5 had already found it) |
| Scenario established | turn 8, REPLACE, 50,898.84 | same |
| Scenario revised | turn 9, REPLACE, 51,598.84 | same |
| Advice on the scenario | turn 10, from the envelope | same |
| **Horizon change (banked MAJOR)** | `project_cash` + prose | **`scenario_projection`, REPLACE, 69,601.50** |
| Callback | exact | exact — and correctly returned the **December** figures while the envelope held the **February** scenario |
| Memory | $750k / 2029-12-31 | same |
| **`explain_net_worth_change` (banked MAJOR)** | levels as change | **recurred** — *"$19,341.08 … a big chunk of your change is market moves"* |
| Correction recovery | complete | complete, and it re-called the tool to restate correctly |
| Compaction | 12/12 elided | 16/17 elided |
| Cost | $0.1974 · $0.0116/turn · 80.2% cached | **$0.1774 · $0.0104/turn · 82.5% cached** |

The horizon-revision MAJOR **did not reproduce** — turn 11 used `scenario_projection` and produced
$69,601.50 deterministically. Nothing in this slice touched horizon routing, so this is **observed,
not fixed**; n=1, and the likely difference is that two scenario calls had just fired. It stays
banked.

The `explain_net_worth_change` MAJOR **did reproduce**, confirming it is stable and untouched.

## 22. Promotion

**The transaction paging blocker no longer produces a materially false absence claim under normal
conversational use** — 0/5 focused, and the broad gate's own instance of it now passes.

**Recommend promotion with the two MAJORs carried**, unchanged from 58b352f §22: the A2 runtime
whole, behind the frozen route, no prompt changes. The carried issues are
`explain_net_worth_change`'s name-vs-capability mismatch (reproduced, bounded, recovers under
challenge) and scenario horizon revision (did not reproduce this run, still unfixed).

## 23–25. Changes

`lib/data/transaction-query.ts` (+`countTransactions`) · `scripts/ai-baseline/tools.ts` ·
`scripts/ai-baseline/baseline.test.ts` (§13j, 12 tripwires) ·
`scripts/ai-baseline/transaction-corpus.check.ts` (§6, 16 live assertions) ·
`lib/data/transaction-corpus-coverage.test.ts`.

**Two existing tripwires were updated to the new truth, not relaxed.** *"coverage is not derived from
`complete`"* was tripped by a **comment** describing the separation, so it now strips comments before
scanning — the claim is about code. *"Nothing is re-queried"* now asserts the stronger property it
always meant: the re-read carries the **same filters** and changes only `limit`, with the completion
bounded by a stated ceiling.

The check's first draft hard-coded 80 rows and broke when the information ceiling moved the window
four days; it was rewritten to assert the **property**, not the corpus.

**502/502 test files · typecheck clean · lint unchanged at 11 pre-existing findings in tracked files,
none here.** Commit **`1b83384`**. The committed UI work (89385c8) was not touched.
