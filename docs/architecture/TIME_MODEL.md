# Time Model

Status: **settled.** Enforced by tests, not convention.

This is the authoritative statement of how time works in Fourth Meridian. It supersedes inference from code comments.

> **New here? The one idea.** Time in Fourth Meridian is a single persistent
> **anchor** (`asOf`) plus a **window length** (`preset`) measured *backwards from the
> anchor* — not from the present. `asOf` decides *what is true* (which snapshot,
> price, FX rate); the preset decides only *how much history is shown*. There is one
> canonical time authority (`shellTimeReducer` / `usePerspectiveShellState`); the
> `TimelineLens` UI cannot read a clock or name a preset — it only *emits intents* —
> so it is structurally incapable of becoming a second authority. **Every financial
> Perspective participates in this one model** (§5); no workspace owns its own time.

---

## 1. The invariant

> **`asOf` is a persistent temporal anchor.**
>
> It is the vantage point from which all financial truth is read, and it moves **only** by explicit user action — never as a side effect of choosing a window.
>
> **Relative presets are window lengths measured backwards from the anchor**, not from the present.

Concretely:

```
asOf = 2026-03-31 · preset = Month to date   →   2026-03-01 → 2026-03-31
                                                  NOT this month
```

This is intentional. `lib/perspectives/time-range.ts:26-27` states it as the resolver's own rule: *"Compare To = start of the period that CONTAINS As Of; As Of stays the endpoint."*

## 2. Why — the two axes are separate

`lib/wealth/wealth-time-machine.ts:13-16`:

> *The shared range only windows the historical chart; **it never redefines the point-in-time cards**.*

- **`asOf` determines what is true.** Which snapshot, which `PositionObservation`, which price, which FX rate.
- **The preset determines how much history is shown.** Nothing more.

A preset change is a range operation. It has no business moving the anchor. Cash Flow made this explicit when it replaced an implicit `new Date()` with `asOf` (`CashFlowWorkspace.tsx:132-135`) — resetting the anchor on preset selection would partially undo that fix.

## 3. Derived rules

| Concept | Rule |
|---|---|
| `compareTo` | Always derived from `preset` + `asOf`, except under `CUSTOM`. Invariant: `preset ≠ CUSTOM ⟺ compareTo === compareToForPreset(preset, asOf, coverage)` |
| `CUSTOM` | Not a choice — an **inference**. The state when a manual pair matches no preset. |
| `ALL` | All history **up to the anchor**, opening at `coverageFrom` when known, else `null`. **Never fabricated.** |
| Future dates | `clampAsOf` caps `asOf` at today. `compareTo` is *not* constrained to precede `asOf` — forward comparison is legitimate and Wealth depends on it. The strictly-earlier rule is a **derivation** (`historicalCompareTo`), not an invariant. |

## 4. Two obligations that follow

Because the anchor is persistent:

**4.1 — Every surface displaying a period must name the anchor, never imply the present.**

A label may not assert "this" of a window that does not contain today. To-date presets are therefore **"Month to date"**, not "This month". The lens names the vantage point in its eyebrow — *"As of Mar 31, 2026"* — including at the present (*"As of today"*), because `asOf`'s present-day value is not "unset", it is "anchored to now".

**4.2 — There must be exactly ONE explicit action returning to the present.**

An anchor you can enter but not leave is a trap, not a lens. That action is `returnToPresent` → `setAsOf(today)`.

**Exactly one** is load-bearing. An emptied As-of field is therefore **rejected with a message**, not silently coerced to today — even though the legacy control did coerce. Two paths to the present, one deliberate and one accidental, make the deliberate one noise: a user who cleared the field and landed on today would reasonably conclude that *is* the way back.

## 5. Where authority lives

```
TimelineLens          presentation + intent. Cannot read a clock, do calendar
                      arithmetic, or name a preset. Structurally incapable of
                      becoming a second authority.
      │ TimelineIntent
      ▼
PerspectiveTimeAdapter  ONE adapter, all five Perspectives. Intent → an
                        EXISTING ShellTimeAction. Owns no state.
      │ ShellTimeAction
      ▼
shellTimeReducer      THE authority. Pure. One owner
usePerspectiveShellState  (usePerspectiveShellState), one URL model.
```

No workspace owns canonical time. No per-Perspective time adapter exists or should — the differences between lenses live *downstream* of selection, never in how time is chosen.

## 6. Enforcement

This doctrine is enforced, not documented-and-hoped:

| Property | Test | Note |
|---|---|---|
| The anchor survives every preset | `time-range.test.ts` | Historical fixtures. **Mutation-verified: flipping the reducer to reset produces 27 failures** (previously 0 — the old fixtures were degenerate) |
| No label asserts the present | `perspective-time-adapter.test.ts` | `!/^This\b/` over every option |
| One sanctioned return to the present | `perspective-time-adapter.test.ts` | Empty As-of rejected; no other intent jumps to today |
| `ALL` never fabricates a start | `timeline-lens-coverage.test.ts` | Including delayed coverage hydration |
| The lens cannot become an authority | `TimelineLens.test.ts` | Import / date-API / vocabulary / token guards |
| No workspace owns time | `workspace-definition.test.ts` | Doctrine scan, mutation-verified |
| One selector on screen | `timeline-lens-exclusivity.test.ts` | Renders the shell rather than scanning it |

## 7. Changing this doctrine

If a future change makes the anchor reset on preset selection, it must also answer:

1. **Reducer/hydrate divergence.** `hydrateShellTimeState` re-derives `compareTo` from the URL's `asOf`. Under a reset model the same `{preset, asOf}` resolves differently by link than by click — or every historical deep link breaks, along with the round-trip identity test.
2. **Wealth's only historical-window workflow.** *"What did my net worth look like on D, and what was the trailing-quarter shape into D?"* has exactly one expression: anchor at D, pick 3M. The balance lenses have no `explicitPeriodRange` escape hatch the way Cash Flow does.

Both were weighed in the TIME-1 audit and neither has a cheap answer. That is why the doctrine is what it is.
