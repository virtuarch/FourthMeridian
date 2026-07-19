# TimelineLens v4 — Promotion Report (Slices 1–2)

Status: **contract hardening complete. Not rendered in production.**
Date: 2026-07-19
Companion: `docs/audits/TIMELINELENS_V4_MIGRATION_MATRIX.md` (authoritative inventory)

Slice 3 (PerspectiveShell wiring behind a per-Perspective flag) has **not** started. Nothing about what a user sees has changed.

---

## 1. What landed

| Slice | Artifact | Lines |
|---|---|---|
| 1 | `components/atlas/TimelineLens/{types,TimelineLens,TimelineLensPanel,index}.ts(x)` | 431 |
| 1 | `components/atlas/TimelineLens/TimelineLens.test.ts` — co-located ownership guard | 295 checks |
| 1 | `components/atlas/GlassPanel.tsx` — `contentClassName` (Atlas primitive fix) | +14 |
| 2 | `components/space/shell/perspective-time-adapter.ts` | 186 |
| 2 | `components/space/shell/perspective-time-adapter.test.ts` — parity proof | 117 checks |
| — | `app/prototype/timeline-component-v4/page.tsx` — re-pointed at the real component + adapter | — |

The prototype's private copy of the component was **deleted**. The harness now imports `@/components/atlas/TimelineLens` and the real adapter, so it cannot drift from what ships.

---

## 2. Component contract

```ts
type TimelineIntent =
  | { type: "period";         optionId: string; intent: string }
  | { type: "customBoundary"; boundary: "asOf" | "compareTo"; value: string }
  | { type: "swap" }
  | { type: "clearComparison" };

interface TimelineLensProps {
  activeOptionId: string | null;                    // derived each render
  boundaries: { asOf: string; compareTo: string };  // derived each render
  summary: TimelineLensSummary;                     // derived each render
  periodOptions: readonly TimelinePeriodOption[];
  maxDate: string;
  onIntent: (intent: TimelineIntent) => void;       // the ONLY mutation boundary
  capability?: TimelineLensCapability;
  boundaryError?: string | null;
  disabled?: boolean; ariaLabel?: string; className?: string;
}
```

**It holds no draft.** The only state is `open`. Everything displayed is derived by the parent from canonical state on every render — so canonical changes the component never saw (URL back-navigation, async coverage arrival, a deep link) are reflected without it knowing they happened. A stored selection would go stale with no way to find out.

---

## 3. Import boundary

Enforced by `components/atlas/TimelineLens/TimelineLens.test.ts`, **co-located deliberately**: the sibling Atlas guard (`panels.test.ts`) is `__dirname`-scoped, so a new folder under `components/atlas/` inherits *zero* import checking. Without this file the component would be unguarded.

**Allowed:** `react`, `react-dom`, `lucide-react`, `node:*`, `@/components/atlas/*`, relative.
**Forbidden:** `@/lib/{time,perspectives,snapshots,wealth,transactions,investments,liquidity,data}`, `@/components/{space,dashboard}`.

Three further guard layers make "not a time authority" structural rather than aspirational:

| Layer | Forbids | Why |
|---|---|---|
| Date-API guard | `new Date`, `Date.now`, `Intl.DateTimeFormat`, `toISOString`, `addDays`, `subMonths`, `startOfWeek`, … | Cannot read a clock or do calendar math |
| Vocabulary guard | the literals `WTD`/`MTD`/…/`CUSTOM`, `TimePreset`, `PerspectiveTimeState`, `ShellTimeAction`, `shellTimeReducer` | Cannot assemble `{preset, asOf, compareTo}` — it cannot *name* a preset |
| Token guard | any `var(--token)` absent from `app/globals.css` | Undefined custom properties don't throw; the declaration is silently dropped |

The guard is **mutation-tested**. Injecting a fake token, a domain import, and a `new Date()` each produced the expected failure; reverting restored green. A guard that cannot fail is theatre.

> The token guard exists because v1–v3 shipped `--font-serif`, `--surface-raised`, and `--neutral-950` — none of which are real tokens. Every one rendered as a silent fallback. Atlas has **no serif token at all** (`--font-ui` and `--font-data` only), so the "editorial serif" in all three prior iterations never rendered as designed. v4 gets its editorial weight from scale, leading, and tracking instead.

---

## 4. Adapter contract

`components/space/shell/perspective-time-adapter.ts` — pure, no React, no clock. Dependency direction is **shell → atlas**; Atlas never imports the shell.

```
TimelineIntent → shellActionForIntent() → existing ShellTimeAction → shellTimeReducer → canonical
```

| Intent | Action | Note |
|---|---|---|
| `period` | `selectPreset` | `intent` is the preset id |
| `customBoundary` (asOf) | `setAsOf` | validated first |
| `customBoundary` (compareTo) | `setCompareTo` | `""` → `null` |
| `swap` | `swap` | |
| `clearComparison` | `setCompareTo(null)` | **not** `clearCompareTo` — see §6 |

**No new reducer action. No new canonical state.** The option table is *derived* from `TO_DATE_PERIODS` / `ROLLING_PERIODS`, not restated, so it cannot become a second preset vocabulary; `EDITORIAL` is keyed by `RelativeCashFlowPeriod`, so adding a preset upstream without a label is a **type error**.

Capability gating reuses `temporalControlVisibility()` rather than re-deriving it, so the lens is gated by exactly the rule that gates the current controls.

---

## 5. Tests added

**Ownership guard — 295 checks.** Imports, date APIs, vocabulary, CSS modules, custom overlays, token existence, Atlas primitive composition, plus three regression pins:

- `max` on **both** boundary inputs (production parity)
- **no** cross-field clamp — the v2 bug that made forward comparison inexpressible
- roving-tabindex fallback — the v3 bug that left every option keyboard-unreachable under a custom range
- one `radiogroup`, not two competing ones
- `LeftPanel` (context/control), not `RightPanel`

**Adapter parity — 117 checks.** The core claim is asserted directly: both routes through the *real* reducer, compared.

```
BEFORE:  existing control → shell action → reducer → canonical
AFTER:   TimelineIntent  → adapter      → reducer → canonical
```

- **50 preset-parity assertions** — all 10 presets × 5 starting states (preset, CUSTOM w/ and w/o comparison, ALL), each byte-identical
- Round trip: `deriveActiveOptionId(apply(intent)) === intent.optionId` for all 10; an unmatched pair reads as no-active-option and canonical says `CUSTOM`
- Forward comparison: `compareTo > asOf` accepted, identical to `setCompareTo`, adapter does not reject
- Custom boundaries: valid values match the existing actions exactly; future dates rejected on **both** fields; `""`, `not-a-date`, `2026-02-30`, `2026-13-01`, `26-01-01` all rejected with a message and **no action to dispatch**
- Swap parity incl. the no-comparison no-op
- Capability gating incl. `partial` (Debt/Liquidity) still rendering

**Browser-verified** on the live harness: 10 options, one radiogroup, one tabbable, both inputs `max=2026-07-19`; selecting a period dispatched exactly `{"type":"selectPreset","preset":"QTD"}`; emptying as-of dispatched **zero** actions and surfaced "Enter an as-of date." with the trigger unchanged; a forward comparison landed as `{preset:"CUSTOM", asOf:"2026-01-05", compareTo:"2026-07-18"}`.

---

## 6. Two corrections to the brief

**a) `clearComparison` maps to `setCompareTo(null)`, not `clearCompareTo`.**

Nothing in the app calls `clearCompareTo` — it is reachable only through an unused hook binding. Today's ✕ button calls `onCompareToChange(null)` → `setCompareTo(null)`.

I initially documented these as *divergent*. The test proved me wrong: `inferPerspectiveTimePreset` returns `CUSTOM` as soon as `compareTo` is null (`time-range.ts:167`) and neither action touches `asOf`, so they are **equivalent everywhere**. The adapter still mirrors the existing dispatch — parity by construction rather than by an equivalence argument a future reducer change could quietly invalidate. The test pins the equivalence across 8 state × coverage combinations, so if it stops holding, the decision is re-examined rather than silently broken.

**b) Invalid boundary input is rejected, not coerced. This is the one intentional behavior deviation.**

Today, emptying the As-of field silently becomes *today* (`e.target.value || today`, `ShellContextRow.tsx:134`) — a date the user did not choose. Per the brief's "no silent fabricated dates", the adapter returns `{ok:false, error}` instead, and the message travels to the component's `Field` error slot. Because the field value is *derived*, it visually reverts rather than jumping.

**This is a deliberate, reviewable difference and the only one in Slices 1–2.** Flagging for the Slice 3 gate: accept it, or restore coercion for strict parity.

---

## 7. Atlas primitive fixed, not worked around

`GlassPanel` renders children inside `<div className="relative z-10">`, so layout classes on the panel never reach the content — a grid on `className` silently does nothing. `Panel.tsx` documents hitting the same wrapper for its height chain, so this is a recurring trap, not a one-off.

Added `contentClassName`, applied to the inner wrapper. Purely additive; all 31 existing call sites unaffected.

**Known, not fixed:** `GlassPanel as="button"` renders `<div>` inside `<button>`, which is invalid HTML (button accepts phrasing content only). Two existing call sites already do this. The fix — making the wrapper a `<span class="block">` — touches every `GlassPanel` consumer and deserves its own review rather than being smuggled in here.

---

## 8. Deferred (unchanged from the matrix)

| Consumer | Status |
|---|---|
| Wealth · Investments · Cash Flow · Debt · Liquidity | Candidates. One shared control, so Slice 3 is one wiring change behind a per-Perspective flag. |
| **Transactions** | **Do not migrate.** Needs TX-2/TX-3 first — and TX-2 is landing *now* in a concurrent session (bounded reads + truncation sentinel), which changes the adapter's contract from "free client-side predicate" to "bounded query". Building against today's all-rows model would target a contract already changing. |
| **Activity** | **Do not migrate.** 60-row *recency* cap (`activity/route.ts:505`) makes "no events in window" indistinguishable from "truncated". Needs a route change, not an adapter. |
| Calendar | Already correctly coupled to canonical time. Leave `AllTimeYearNav` as a peer control — it is the guard preventing the `ALL` sentinel reaching `monthsInRange`. |

---

## 9. Slice 3 preconditions

1. **Decide on §6b** — reject-with-error, or restore empty→today coercion.
2. **Rewrite** `lib/perspectives/workspace-definition.test.ts:234-239`, which asserts on source text that `PerspectiveShell` contains `<CashFlowPeriodSelector`. It must be rewritten, not deleted — the property it protects (the slicer is universal and never capability-gated) stays true and valuable.
3. **Trust row** — `ShellTrustRow` (Slice 0) moves out of `ShellContextRow` to sit beside the lens.
4. **Flag** — `TIMELINE_LENS_PERSPECTIVES` allowlist, growing wealth → investments → cashFlow → debt/liquidity.
5. **Confirm** the Slice 3 diff touches no loader, route, snapshot, or calculation.

---

## 10. Test status at time of writing

`298/300`. Both failures are **outside this work**:

- `lib/marketing-boundary.test.ts` — pre-existing (`MarketingNav.tsx`, `Reveal.tsx` are `"use client"`); failing before Slice 0.
- `lib/data/transactions.population.test.ts` — **a concurrent session's in-progress TX-2 edit** to `lib/data/transactions.ts`. Verified not mine: that file was clean at session start, is dirty now, and none of my changes touch it. Committed with explicit pathspecs so no concurrent work was swept in.

Every test in this slice passes: 295 guard checks, 117 parity checks, `tsc` clean, `eslint` clean.
