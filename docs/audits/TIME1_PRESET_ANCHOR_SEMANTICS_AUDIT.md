# TIME-1 — Preset Anchor Semantics Audit

Status: **investigation complete. No code changed.**
Date: 2026-07-19
Question: *is `asOf` a persistent lens anchor, or only meaningful when the user explicitly chooses a historical view?*

---

## 0. Verdict

**`asOf` is a persistent lens anchor. The observed behavior is correct, documented, and must remain.**

But the report that prompted this audit is not wrong about the *experience*. It identified a real defect and misattributed it. The actual problems are three, none of which is canonical:

| # | Defect | Layer | Origin |
|---|---|---|---|
| 1 | **No way back to the present.** Anchored to a past date, presets don't free you and nothing else offers to. | Affordance | Pre-existing, worsened by TimelineLens |
| 2 | **Preset labels assert present tense** — "This month" at a March anchor is categorically false. | Presentation | **Introduced by me**, Slice 2 |
| 3 | **The anchor is no longer named** — the readout shows a bare range, not which end is the vantage point. | Presentation | **Introduced by me**, Slice 2 |

Changing `selectPreset` to reset `asOf` would be solving a navigation problem with a semantics change. It would destroy the one workflow that has no alternative, and split reducer/hydrate agreement. §6 details why.

---

## 1. Current behavior

`lib/perspectives/time-range.ts:248-251`:

```ts
case "selectPreset": {
  const asOf = clampAsOf(state.asOf, today);
  return { preset: action.preset, asOf, compareTo: compareToForPreset(action.preset, asOf, coverageFrom) };
}
```

`asOf` is read from state, not from `today`. `clampAsOf` is a future-date guard, not a reset.

Reproduced live at `asOf = 2026-03-31`:

| Picked | Canonical | Readout |
|---|---|---|
| This week | `WTD \| 2026-03-31 \| 2026-03-29` | This week · Mar 29 → Mar 31, 2026 |
| This month | `MTD \| 2026-03-31 \| 2026-03-01` | This month · Mar 1 → Mar 31, 2026 |
| This year | `YTD \| 2026-03-31 \| 2026-01-01` | This year · Jan 1 → Mar 31, 2026 |
| Last 12 months | `PAST_YEAR \| 2026-03-31 \| 2025-03-31` | Last 12 months · Mar 31, 2025 → Mar 31, 2026 |
| All history | `ALL \| 2026-03-31 \| 2025-07-20` | All history · Jul 20, 2025 → Mar 31, 2026 |

Every window is arithmetically correct under the documented rule. The *dates* are honest; the *labels* are not.

---

## 2. Historical rationale — what the evidence supports

### Intent: strong, converging, multi-source

`time-range.ts:26-27` — the module states the rule outright:

> *To-date presets — Compare To = start of the week/month/quarter/year that **CONTAINS As Of**; **As Of stays the endpoint**.*

`time-range.ts:135-137`:
> *As Of is the endpoint and never moves here; Compare To is recomputed from the preset.*

`wealth-time-machine.ts:13-16` — the doctrine that makes it coherent, an explicit separation of two axes:
> *The shared range only windows the historical chart; **it never redefines the point-in-time cards**.*

So: **`asOf` determines what is true; the preset determines only how much history is shown.** A preset change is a range operation and has no business moving the anchor.

`CashFlowWorkspace.tsx:132-135` — the strongest single piece, because it records a *direction of travel*:
> *Replacing the former implicit `new Date()` (today) makes the whole Cash Flow window travel with asOf.*

Resetting `asOf` on preset selection would partially reintroduce exactly what that fix removed.

Corroborating: `TIMELINE_CONTROL_REDESIGN.md:111` ("re-derives the opening date from **the selected `asOf`**… the reducer **truth rule**"); `TX3_TRANSACTION_EXPLORER_AUDIT.md:125` and `TX3_QUERY_CONTRACT_IMPLEMENTATION.md:34`, both of which use **"asOf-anchored"** as the defining property distinguishing canonical Perspective time from a plain range filter.

And indirectly but powerfully: **an entire honesty subsystem exists because the product expects users to sit at a past `asOf`** — `DebtHero.tsx:124-125`, `LiquidityHero.tsx:142-143`, the `partial` capability declarations. You do not build that for a transient filter.

### Two things the evidence does **not** support

**The behavior was never explicitly decided.** `git log -S "selectPreset"` returns exactly one commit (`06b72cc`), which describes the reducer structurally and names only `clampAsOf (≤ today)` as an `asOf` rule. The predecessor `8b7fe83` says *"Selecting a slice derives Compare To"* — Compare To only; the asymmetry is stated, never justified. The cited "§3.3 transition table" **is not in the repository**. So the rule follows necessarily from a coherent, repeatedly-restated model, but was never enumerated as an option and defended.

**The behavior is completely unguarded.** Every existing assertion is degenerate. `time-range.test.ts:149-150` reads:

```ts
check("selectPreset YTD → Compare To Jan 1, As Of unchanged", … && ytd.asOf === TODAY && …);
```

but its fixture is `defaultPerspectiveTimeState(TODAY)`, so `start.asOf === TODAY`. Proven by execution:

```
fixture start.asOf = 2026-07-19   today = 2026-07-19   → identical: true
=> assertion ytd.asOf===TODAY passes under BOTH models: true

with a HISTORICAL fixture the models DIVERGE:
  preserve → {"preset":"YTD","asOf":"2026-03-31","compareTo":"2026-01-01"}
  reset    → {preset:YTD, asOf:2026-07-19, compareTo:2026-01-01}
```

The same defect affects `timeline-lens-coverage.test.ts:99` and `perspective-time-adapter.test.ts:83-95`. **Reversing the behavior today would break zero tests.** For a load-bearing temporal invariant, that is the most actionable finding in this audit.

---

## 3. Time semantics taxonomy

| Concept | Definition | Anchor relationship |
|---|---|---|
| **`asOf`** | The vantage point. *What is true* at this moment in time. | The anchor itself. Persistent; moves only by explicit user action. |
| **Relative preset** (WTD/MTD/QTD/YTD, PAST_*) | A window **length**, measured backwards **from the anchor**. Not from now. | Derived from `asOf`. Never moves it. |
| **`compareTo`** | The window's opening boundary — and, separately, the comparison baseline. | Derived from `preset` + `asOf`, except under CUSTOM. |
| **CUSTOM** | Not a choice — an *inference*. The state when a manual pair matches no preset. | Preserves both boundaries verbatim. |
| **ALL** | All history **up to the anchor**, opening at `coverageFrom` when known, else null. Never fabricated. | Derived from `asOf` + coverage. |

**Answers to the brief's three questions:**

- *Relative presets: rolling from now, or from the current anchor?* — **From the current anchor.** `time-range.ts:26-29`.
- *Custom ranges: preserve historical anchors?* — **Yes.** Both boundaries are the user's explicit intent.
- *On preset switch, should comparison derive from new preset + new anchor, or previous comparison state?* — **New preset + existing anchor.** The invariant `preset ≠ CUSTOM ⟺ compareTo === compareToForPreset(preset, asOf, coverage)` forces it; preserving a stale `compareTo` would violate the invariant the reducer exists to hold.

One naming problem worth recording: `compareTo` carries **two meanings** — window start *and* comparison baseline. `time-range.ts:5-7` calls it "the comparison/range-start Compare To". This conflation is out of scope here but is the root of several presentation ambiguities.

---

## 4. Consumer impact — if the anchor were reset on preset selection

| Perspective | Capability | What `asOf` drives | Cost of a reset |
|---|---|---|---|
| **Wealth** | full | Hero figure, composition card, chart right edge, compare overlay length, trust tier (`wealth-time-machine.ts:249,280,288,297`) | **Highest.** Every preset click yanks the entire lens to the present. |
| **Cash Flow** | full | Window *end* via `asOfClock → periodRange` (`CashFlowWorkspace.tsx:135`) | Moderate — but see below; it has an alternative. |
| **Investments** | full | Fetch key; selects `PositionObservation` + per-date prices; **also the FX rate date** (`InvestmentsWorkspace.tsx:84-85`); `historicalMode` collapses | High. |
| **Debt** | partial | Lens fetch gated on `asOf < today`; trend, verdict, trust, chart window | Moderate; headline is present-day by design. |
| **Liquidity** | partial | Ladder *reconstructed* at `asOf`; tier deltas; history clip | Moderate–high. |

**The Cash Flow justification for preserve-anchor is weak.** `periodRange` ignores `now` entirely for explicit periods (`cash-flow.ts:136-137`), and `CashFlowHistoryWidget` already offers Month/Quarter/Year drills populated only with periods that have data. For "show me March 2026" the explicit drill **strictly dominates**: one click, exact calendar month, immune to `asOf`, and scoped to Cash Flow alone. The preserve path requires setting As-of inside March then clicking MTD — and if you pick Mar 15 you get a *partial* month labeled "This month", while dragging all four other lenses back with you.

**The Wealth justification is strong, and it is the only one with no alternative.** *"What did my net worth look like on date D, and what was the trailing-quarter shape leading into D?"* has exactly one expression: anchor at D, click 3M. The balance lenses have no `explicitPeriodRange` escape hatch the way Cash Flow does.

Bounded, though: a user could set As-of = D and Compare-to = D−90d manually, landing on the identical `{asOf, compareTo}` pair via `CUSTOM`. The loss under a reset model would be *one-click preset arithmetic around a historical anchor*, not the capability itself.

**No caching risk in either direction.** All hooks use `cache: "no-store"` with `asOf` in the dep array; Debt and Liquidity *skip* the fetch when `asOf >= today`. A reset would cause **fewer** fetches, not more. This is not a constraint on the decision.

---

## 5. Where preserving the anchor genuinely misleads

1. **Labels assert present tense.** `perspective-time-adapter.ts` maps WTD→"This week", MTD→"This month", YTD→"This year". At a 2025 anchor, YTD yields 2025's year-to-date **labeled "This year."** The legacy labels — `WTD`, `MTD`, `1M`, `1Y` — asserted nothing. **This is a regression I introduced in Slice 2.**
2. **The anchor is no longer named.** Legacy always showed the literal label **"As of"** beside its date. The lens shows `Mar 1, 2026 → Mar 31, 2026` — a bare range. `summarize()` says "As of …" *only* when `compareTo` is null, i.e. exactly when there is no range to misread. **Also mine, Slice 2.**
3. **Silent partial periods.** MTD anchored mid-month yields a truncated month with no signal.
4. **Cross-lens spillover.** One preset click moves all five Perspectives; the strip is never capability-gated.
5. **Stickiness with no exit.** §7.

---

## 6. Why "reset on preset" is the wrong fix

**It breaks reducer/hydrate agreement.** `hydrateShellTimeState` (`time-range.ts:296-314`) takes `asOf` from the URL and re-derives `compareTo` from *that* `asOf` — the same shape as the reducer. `?preset=MTD&asof=2026-03-15` deep-links to March. Under a reset model the two diverge: the same `{preset, asOf}` would produce **different results depending on whether they arrived by link or by click**. Either you accept that split, or you make hydrate reset too — which breaks every historical deep link and the round-trip identity test at `time-range.test.ts:200`. Neither is free. This is the highest-risk part of any change.

**It overloads a semantic operation to solve a navigation problem.** The preset strip has become the de facto escape from a historical anchor *because nothing else is*. Making it the official escape destroys the Wealth workflow and splits URL semantics, to solve something a dedicated affordance solves locally with no reducer change.

---

## 7. The real defect — no way back to the present

There is **no** today/now/live reset control anywhere. `ShellContextRow` renders a bare `<input type="date" max={today}>` with no reset. `TimelineLensPanel` contains no occurrence of "today". `PERIOD_OPTIONS` has no "Today" entry.

**A user anchored to a past date must manually retype today's date to escape.**

And I made this worse. The legacy control did `onAsOfChange(e.target.value || today)` (`ShellContextRow.tsx:71`) — clearing the field silently snapped back to today. That was an *accidental* escape hatch, but a real one. My Slice 2 adapter deliberately removed it (`perspective-time-adapter.ts:128-130`, returning `{ok: false, error: "Enter an as-of date."}`) under the "no silent fabricated dates" principle.

That principle is still right — silently substituting a date the user didn't choose is bad. But **it closed the only other exit without replacing it.** The still-open as-of-coercion decision from Slice 4 is therefore not merely a parity question: it removed an escape hatch, and the replacement was never built.

---

## 8. Recommended doctrine

> **`asOf` is a persistent lens anchor.**
>
> It is the vantage point from which all financial truth is read, and it moves **only** by explicit user action — never as a side effect of choosing a window.
>
> **Relative presets are window lengths measured backwards from the anchor**, not from the present. `compareTo` is always derived from `preset` + `asOf`; the invariant `preset ≠ CUSTOM ⟺ compareTo === compareToForPreset(preset, asOf, coverage)` holds without exception.
>
> **Because the anchor is persistent, two obligations follow:**
> 1. Every surface that displays a period must **name the anchor**, never imply the present. A label may not assert "this" of a window that does not contain today.
> 2. The user must always have **one explicit action that returns them to the present**. An anchor you can enter but not leave is a trap, not a lens.

`asOf` is meaningful **at all times**, not only when historical. Its present-day value is not "unset" — it is "anchored to now," which is why `clampAsOf` guards the future and why `defaultPerspectiveTimeState` is `MTD @ today`.

---

## 9. Required code slices (none implemented)

Ordered by value. None changes the reducer.

**TIME-1A — Return to the present** *(affordance; highest value)*
Add one explicit control mapping to the **existing** `setAsOf(today)` action — a "Today" entry in `PERIOD_OPTIONS`, or a reset affordance beside the As-of field. No new semantics, no reducer change, no deep-link impact. Resolves §7 and removes the pressure that motivated this audit.
*Interacts with the open Slice 4 decision* — settle both together.

**TIME-1B — Anchor-truthful labels** *(presentation; fixes my regression)*
Either make the to-date labels anchor-neutral ("Month to date" rather than "This month"), or make them anchor-aware ("March 2026" when `asOf` is historical). Also restore naming the anchor in the readout — `summarize()` should say which end is the vantage point, not just print a range. Adapter-local; TimelineLens is unchanged.

**TIME-1C — Pin the invariant** *(durability; cheapest)*
One test with `asOf !== today`:
```ts
const hist = { preset: "CUSTOM", asOf: "2026-03-31", compareTo: "2025-11-02" };
const ytd = shellTimeReducer(hist, { type: "selectPreset", preset: "YTD" }, ctx);
check("selectPreset preserves a HISTORICAL As Of (the anchor never moves)",
  ytd.asOf === "2026-03-31" && ytd.compareTo === "2026-01-01");
```
This converts strong-but-inferential intent into a pinned contract. **Do this regardless of any other decision** — the doctrine in §8 is currently unenforced.

**Not recommended:** changing `selectPreset` to reset the anchor. §6.

---

## 10. Migration risk

| Path | Risk |
|---|---|
| **Keep semantics + TIME-1A/B/C** | **Low.** No reducer change, no URL change, no consumer change. 1A and 1B are additive UI; 1C is a test. |
| **Reset semantics** | **High.** Reducer/hydrate divergence (§6) forces a choice between two bad options; Wealth's only historical-window workflow is lost; extra Back-stack entries with discontinuous `asOf`; and the change is currently **unguarded**, so nothing would catch a partial implementation. |

---

## 11. Answer to the key question

> *Is `asOf` a persistent lens anchor, or is it only meaningful when the user explicitly chooses a historical view?*

**A persistent lens anchor** — established by the reducer's own documentation, the Wealth time-machine doctrine's explicit separation of the two axes, the Cash Flow migration *away* from an implicit `today`, and the existence of a whole honesty subsystem predicated on users sitting at a past date.

The reported behavior is the doctrine working correctly. What is broken is that we let users enter the anchor without giving them a way out, and then labeled their historical windows as though they were the present.

**Settle TIME-1A and TIME-1B before deleting the legacy controls** — 1A because the legacy control's `|| today` fallback is the current de facto escape hatch and deleting it removes the last one; 1B because the labels are mine and they are wrong today.
