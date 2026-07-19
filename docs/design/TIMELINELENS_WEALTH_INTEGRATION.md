# TimelineLens — Wealth Integration (Slice 3)

Status: **Wealth live behind the rollout flag. Parity validated. STOP for review.**
Date: 2026-07-19
Companion docs: `TIMELINELENS_V4_MIGRATION_MATRIX.md` (inventory) · `TIMELINELENS_V4_PROMOTION_REPORT.md` (Slices 1–2)

---

## 1. What replaced what

**Old (still present, still the default for every other Perspective):**

```
PerspectiveShell
  ├─ ShellContextRow          As of · ⇄ swap · Compare to · ✕ clear   (capability-gated)
  └─ CashFlowPeriodSelector   WTD·MTD·QTD·YTD | 1W·1M·3M·6M·1Y·ALL     (universal)
```

**New, for Wealth only:**

```
PerspectiveShell
  └─ TimelineLens + ShellTrustRow    one control, trust chips beside it
```

Two stacked control rows became one instrument. The trust chips (Completeness / Evidence / FX) were never temporally gated and are unchanged — they moved out of `ShellContextRow` in Slice 0 and now sit beside the lens.

**Nothing else changed.** No loader, snapshot, calculation, projection, route, or URL-model edit. Verified by diff scope: `PerspectiveShell.tsx`, `SpaceDashboard.tsx` (two props), plus new files.

---

## 2. Adapter path

```
TimelineIntent
   → shellActionForIntent()            (adapter, 117 parity checks)
   → existing ShellTimeAction
   → the SAME PerspectiveShell callbacks the old controls used
   → SpaceDashboard handlers (unchanged)
   → shellTimeReducer                  (unchanged)
   → canonical {preset, asOf, compareTo}
```

The key integration decision: the adapter's `ShellTimeAction` is routed back through `onSelectPreset` / `onAsOfChange` / `onCompareToChange` / `onSwap` — **the existing props**. So `handleSelectSlice` still runs (including its Cash-Flow-override clearing), `handleCompareToChange` still re-infers. The host cannot tell which UI produced the intent. That is what makes this a presentation swap rather than a new path.

**No new reducer action. No new state.** `PerspectiveShell` holds exactly one new piece of local state — `boundaryError` — which is presentation feedback and never reaches canonical time.

---

## 3. Feature flag

`components/space/shell/timeline-lens-rollout.ts`

```ts
export const TIMELINE_LENS_PERSPECTIVES: ReadonlySet<string> = new Set(["wealth"]);
```

- **In the set** → TimelineLens.
- **Not in the set** → the existing controls, byte-identical.

Rollback is deleting `"wealth"`. The old components are **not removed** (Slice 5), so the path back stays clean while the canary runs — pinned by a guard assertion.

---

## 4. Parity results

All exercised in the browser against the live app with real data.

### Presets — every one canonical-correct

| Selected | URL `preset \| asof \| compareto` | Readout |
|---|---|---|
| This month | `MTD \| 2026-07-19 \| 2026-07-01` | This month · Jul 1 → Jul 19, 2026 |
| Last 30 days | `PAST_MONTH \| 2026-07-19 \| 2026-06-19` | Last 30 days · Jun 19 → Jul 19, 2026 |
| Last 90 days | `PAST_QUARTER \| 2026-07-19 \| 2026-04-19` | Last 90 days · Apr 19 → Jul 19, 2026 |
| This year | `YTD \| 2026-07-19 \| 2026-01-01` | This year · Jan 1 → Jul 19, 2026 |
| Last 12 months | `PAST_YEAR \| 2026-07-19 \| 2025-07-19` | Last 12 months · Jul 19, 2025 → Jul 19, 2026 |
| All history | `ALL \| 2026-07-19 \| 2025-07-20` | All history · Jul 20, 2025 → Jul 19, 2026 |

`ALL` resolved `compareTo` from the Space's **coverage date**, not a fabricated one. Chart caption tracked `compareTo` throughout (`"2026 vs Jul 20, 2025"`), and the hero delta recomputed per window — data loading is unchanged.

### Custom boundaries

| Case | Result |
|---|---|
| Normal historical range | `custom \| 2026-02-10 \| 2025-11-02` ✓ |
| **Forward comparison** | `compareTo 2026-05-20 > asOf 2026-02-10` — **accepted and expressible** ✓ |
| Future date | URL **unchanged**, message shown, no coercion ✓ |
| Empty as-of | URL **unchanged**, "Enter an as-of date." ✓ |
| Empty compare-to | `compareto` dropped — same as the old ✕ button ✓ |

No silent coercion, no fabricated dates: a rejected intent produces **no action at all**, so canonical time cannot move to a date the user did not choose.

### Navigation

| Test | Result |
|---|---|
| Select → refresh | State restored from URL ✓ |
| Browser **back** | `ALL` → `PAST_YEAR`; readout and chart followed ✓ |
| Browser **forward** | `ALL` restored, chart caption restored ✓ |
| **Deep link** (`?asof=2026-03-15&compareto=2025-11-02&preset=custom`) | Readout "Custom range · Nov 2, 2025 → Mar 15, 2026", chart "Mar 15, 2026 vs Nov 2, 2025" ✓ |

**No stale selection anywhere.** The lens stores nothing; it derives its whole display from canonical state each render, so changes it never observed — back-navigation, deep links, async coverage — are reflected automatically. Under a custom range the panel correctly shows **0 checked** options while remaining keyboard-reachable (**1 tabbable**, the fallback working in production).

### Mobile (500px)

Bottom sheet full-width and bottom-anchored, height-capped, grab handle, pinned safe-area footer, content scrolls, 10 options, **no horizontal overflow anywhere on the page**, workspace layout and bottom navigation unaffected.

---

## 5. Two defects found by browser verification

Both were invisible to unit tests and are now fixed and pinned by guard assertions.

**a) Boundary errors rendered under the wrong field.** `boundaryError` was an opaque `string`, and the panel wired it only to the Compare-to `Field` — so rejecting the **As-of** input showed "Date cannot be in the future." under **Compare to**. Fixed by making the error carry its boundary:

```ts
interface TimelineBoundaryError { boundary: "asOf" | "compareTo"; message: string }
```

Re-verified: an as-of rejection now renders under *As of*, a compare-to rejection under *Compare to*.

**b) Icon-only affordances were 31×27px.** `!px-2` on a `size="sm"` GlassButton squashed swap and clear below the touch floor. Fixed to a 44×44 minimum; re-verified on the mobile sheet.

---

## 6. Guard rewritten — doctrine, not filenames

`lib/perspectives/workspace-definition.test.ts` previously asserted `PerspectiveShell` source contains `<CashFlowPeriodSelector` — a **file name**. It now enforces the property that actually matters:

1. The shell renders *a* canonical time selector (legacy slicer **or** TimelineLens).
2. That selector is **never** capability-gated (`vis.period` stays absent).
3. **No workspace owns canonical time** — scans `components/space/workspaces/` and the five financial workspace directories for time-selector components, time-authority imports (`usePerspectiveShellState`, `shellTimeReducer`, `perspective-time-adapter`), direct shell-action dispatch, and raw `type="date"` inputs.
4. The rollout allowlist is a migration device: both paths present, mutually exclusive, rollback intact.

Data-entry date fields are **not** view-time controls — a goal's target date is a value being stored, not a lens. `AddGoalModal.tsx` is exempt **by explicit name**, so adding another is a conscious act rather than silent drift.

**Mutation-tested.** Injecting `<TimelineLens` into a workspace, injecting `usePerspectiveShellState` into a workspace, and deleting the legacy rollback path each produced the expected failure.

---

## 7. Remaining consumers

| Consumer | Status |
|---|---|
| **Wealth** | ✅ migrated, parity validated |
| Investments · Cash Flow · Debt · Liquidity | Unchanged — legacy controls, awaiting review |
| Transactions | Deferred. Needs TX-2/TX-3 first; its filter is only free today because all rows sit in memory |
| Activity | Blocked. 60-row *recency* cap makes a date filter misleading; needs a route change |
| Calendar | Leave coupled. `AllTimeYearNav` stays a peer control — it guards the `ALL` sentinel |

---

## 8. Known, deliberately not fixed

1. **The one behavior deviation** (carried from Slice 2): today an emptied As-of silently becomes *today*; the lens rejects it with a message instead. Per the "no silent fabricated dates" instruction. Reversible in one line if strict parity is preferred — **needs a decision**.
2. **"Done" button is 42px**, from GlassButton's shared `size="md"`. Two below the 44px floor. Changing it moves every button in the app, so it belongs in an Atlas slice, not here.
3. **PanelHeader's close button is 32×32** — same reasoning, pre-existing, Atlas-wide.
4. **7 buttons on `/dashboard/spaces` contain `<div>` children** — same invalid-markup class fixed in GlassPanel, different components. Unrelated to this work.

---

## 9. Migration plan from here

```
Slice 3  Wealth                      ← DONE, awaiting review
Slice 4  Investments → Cash Flow → Debt/Liquidity   one at a time, each parity-gated
Slice 5  Delete ShellContextRow's time half + CashFlowPeriodSelector; retire the flag
```

Per-Perspective notes for Slice 4:

- **Investments** — verify `historicalCompareTo` strict clamp still applied downstream; A10 valuation coverage unchanged.
- **Cash Flow** — `capabilityForLens` already hides the boundary fields; verify the `CUSTOM` hold (`lastRelativePeriod`) and that explicit Month/Quarter/Year drills stay CF-local.
- **Debt / Liquidity** — `partial` capability still renders the controls; verify the honesty copy.

Do not proceed until Wealth is reviewed.

---

## 10. Test status

`302/303`. The single failure is the pre-existing `MarketingNav`/`Reveal` marketing-boundary check, untouched by this work.

- TimelineLens ownership guard — **298 checks**
- Adapter parity — **117 checks**
- GlassPanel primitive — **41 checks**
- Workspace doctrine — **661 checks** (rewritten, mutation-tested)
