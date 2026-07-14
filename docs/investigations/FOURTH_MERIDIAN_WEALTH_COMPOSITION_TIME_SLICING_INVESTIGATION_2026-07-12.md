# Fourth Meridian — Wealth Composition Time-Slicing Investigation

**Date:** 2026-07-12
**Question:** Why doesn't "What is my wealth composed of?" (`WealthCompositionCard`) time-slice the same way as the other Wealth Perspective surfaces (Hero, Trend, Change Ledger)?
**Method:** Direct code inspection — `WealthPerspective.tsx`, `WealthCompositionCard.tsx`, `lib/wealth/wealth-time-machine.ts`, `types/index.ts`. No assumptions carried in from outside the code.

---

## 1. Executive answer

**It's both a bug-that-isn't-a-bug and a real UX problem.** The default view of Composition ("By class") is fully time-sliced — verified byte-for-byte consistent with Hero, Trend, and the Change Ledger, because all four literally read the same shared object. But the card has three OTHER modes — "By institution," "By account," and "Concentration" — that are **deliberately, permanently current-state-only**, by explicit design (the code cites "Amendments 8–9"). Switching to any of those three modes silently drops the selected As Of date and shows today's live account data instead, while every sibling widget on the page stays locked to whatever date is selected. That's almost certainly what you're seeing: the card *looks* like every other Wealth widget, has the same As Of context above it, but three of its four internal tabs quietly stop obeying it.

This isn't sloppiness — it's a real data-availability constraint (§3) — but the way it surfaces to the user is easy to miss and worth a product decision (§4).

---

## 2. How the other surfaces stay in sync (verified)

`WealthPerspective.tsx:68–90` mounts all five surfaces off **one shared object**:

```
<WealthHero result={result} .../>
<WealthTrendChart result={result} .../>
<WealthChangeLedger result={result} .../>
<WealthCompositionCard result={result} .../>
<WealthExplanationCard result={result} .../>
```

`result` is a single `WealthResult` produced once per render by `computeWealthTimeMachine()` (`lib/wealth/wealth-time-machine.ts:225`). Inside it, `asOfState = resolveState(series, asOf)` (`:239`) — the nearest snapshot on or before the selected As Of date (`resolveState`, `:201–208`, "nearest snapshot ≤ date" semantics). Every surface that wants "the truth on the selected date" reads `result.asOfState`. There is exactly one resolution of "what date is it" in this component tree — no surface has its own copy.

**Composition's default mode reads exactly this.** `WealthCompositionCard.tsx:65,110`: `const { asOfState, drivers } = result; const c = asOfState.composition;`. This is the identical `asOfState` Hero and Trend read. By construction, "By class" cannot drift from the rest of the page — it's the same reference, not a re-fetch or a re-derivation.

---

## 3. Where it actually diverges (verified, and why)

`WealthCompositionCard.tsx:39–46,78–91` defines four modes via a `SegmentedControl`:

| Mode | Source | Time-sliced? |
|---|---|---|
| **By class** (default) | `result.asOfState.composition` — the resolved snapshot | **Yes** |
| By institution | `renderInstitutionAllocation(accounts, ctx)` — live `accounts` prop | **No — current only** |
| By account | `renderWealthByAccount(accounts, ctx)` | **No — current only** |
| Concentration | `renderWealthConcentration(accounts, ctx)` | **No — current only** |

The component is explicit about this, both in its header comment (`:16–19`: *"these read LIVE accounts, so they carry a permanent 'Current classification' label and are NEVER presented as belonging to the historical As Of date"*) and in the rendered UI (`:80–83`): a subtitle literally reading **"Current classification"** and a caption **"Current classification — reflects today's connected accounts, not the selected As Of date."**

**Why this isn't an oversight — it's a data ceiling.** Checked `types/index.ts:82–101`, the `Snapshot` type (the only historical record this app persists day-to-day): it stores `netWorth`, `totalAssets`, `totalDebt`, `totalCash`, `totalSavings`, `totalInvestments`, `totalCrypto` — **aggregate class-level totals only.** There is no per-account or per-institution breakdown anywhere in the persisted historical model. `renderInstitutionAllocation` / `renderWealthByAccount` / `renderWealthConcentration` need per-account rows (name, institution, balance) — data that has never existed for any date except today. The "By class" mode can be historical because a snapshot literally stores five class totals per day; the other three modes can't be, because nothing stores per-account or per-institution totals per day. Building that would mean a new per-account historical balance archive — the same category of gap A10 closed specifically for investments (`PositionObservation`), but with no equivalent for cash/savings/other account types today.

This is the same honesty posture as everywhere else in this codebase (Liquidity's deferred history, Debt's deferred per-account deltas): rather than fake an institution/account breakdown for a historical date using today's account list, the app labels it as current and stops there.

---

## 4. The actual problem worth fixing

Not the data boundary — that's correct and consistent with the rest of the product's honesty doctrine. The problem is **discoverability**: the only signal that a mode switch also silently changed the time axis is one small caption line inside the card. A user who sets a historical As Of date, glances at Hero/Trend/Ledger (all correctly historical), then clicks "By institution" inside Composition gets today's numbers with no visual break from the rest of the page — same card chrome, same position, no color change, no icon. That's a real, fixable UX gap, distinct from the (correct) data constraint underneath it.

Options, not a recommendation to build yet:

1. **Leave as-is.** It's technically honest and documented in code; the caption exists. Cheapest, but the caption is easy to miss in a dense card.
2. **Stronger in-card signal when comparing.** When a non-"today" As Of (or any `compareTo`) is active, give the three live modes a visibly different treatment — a persistent badge/border on the switcher itself, not just a caption under the content — so the state change is obvious before the user reads any numbers.
3. **Disable the three live modes when As Of ≠ today**, forcing the segmented control back to "By class" with a disabled-state tooltip explaining why. Most defensive, but removes a capability (seeing today's institution/account breakdown) while the user is looking at a historical date, which may itself be unwanted.
4. **Build the missing per-account historical archive** so all four modes can eventually be real time machines. Correctly out of scope for a UI fix — this is new persisted capability, same class of work as A9/A10, not a Wealth Perspective slice.

**Recommended default if you want a fix now: option 2.** It preserves every existing capability, requires no new data model, and directly targets the actual complaint (indistinguishable temporal state) without removing anything a user could do before.
