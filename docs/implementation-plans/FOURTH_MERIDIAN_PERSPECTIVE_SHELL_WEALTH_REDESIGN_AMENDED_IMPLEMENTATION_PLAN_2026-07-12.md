# Fourth Meridian — Perspective Shell + Wealth Redesign: Amended Investigation & Final Implementation Plan

**Date:** 2026-07-12
**Type:** Architecture & UX planning deliverable only. No code written, no files modified, no components created, no migrations, nothing committed.
**Amends and supersedes where stated:** `FOURTH_MERIDIAN_PERSPECTIVE_SHELL_WEALTH_REDESIGN_INVESTIGATION_2026-07-12.md` (the "governing investigation"). Everything in the governing investigation not explicitly amended here still stands — in particular its shell/Wealth critiques (§1–2), concept analysis (§3), honesty hierarchy (§11), and future-compatibility analysis (§12).
**Visual reference:** the attached concept screenshot — directional, not pixel-perfect.
**Scope boundary:** unchanged. The Space rail (Overview / Perspectives / Activity / Accounts / Transactions / Members) is untouched; this plan begins after the user enters **Space → Perspectives**. Two design systems inside that boundary: (1) the Perspective Shell, (2) the Wealth Perspective workspace, one consumer of the shell.

**Summary of amendments applied:**

| # | Amendment | Effect on the governing investigation |
|---|---|---|
| 1 | One canonical time model | **Rejects** governing §4.3's dual-model + optional `presetLink` toggle. Preset, As Of, and Compare To are always synchronized; the standalone `period` disappears as user-facing state |
| 2 | Preset placement | Confirms §6 layout; presets move *inside* the framed shell beneath the context row; groups stay far-left (to-date) / far-right (rolling); rolling set becomes **1W · 1M · 3M · 6M · 1Y · ALL** |
| 3 | Shell visual target | Confirms and sharpens §4/§6: two framed containers, sticky behavior investigated |
| 4 | Wealth visual target | Confirms the five-surface IA; surface ⑤ renamed **Explanation** |
| 5–7 | Hero / dominant chart / change ledger | Confirm §5/§8/§9 with a taller chart mandate and stricter ledger honesty rules |
| 8 | Composition taxonomy | Confirms current `WEALTH_CATEGORY_LABELS` direction; "Other" is a slot, not a fabrication (§4.4 below) |
| 9 | Composition depth | Confirms §5-④ restored modes; specifies the disclosure pattern |
| 10 | Explanation | Renames "Story"; deterministic until A12 |
| 11 | Completeness/Evidence | Confirms §11 three-level hierarchy; no percentages pre-A9 |
| 12 | URL state | Confirms §4.4; adds preset/Custom + metric to the serialized state |
| 13 | Mobile | Confirms §7 with the `<select>` ban made explicit |
| Roadmap | Consolidation | The prior 15-slice roadmap collapses to **9 slices across 4 phases** (§9) |

---

## 1. Updated governing principles

**P1 — One object, many lenses (the leading doctrine).** Perspectives are not separate dashboards; they are lenses over one financial reality. Switching Wealth / Liquidity / Debt / Cash Flow / Investments / Goals must feel like rotating the same object. Concretely enforced as invariants, not vibes:

- The shell (As Of, Compare To, active preset, Completeness, Evidence, Space context) **never unmounts, resets, or flashes** on a lens switch.
- Shell state is written only by shell controls (plus the one sanctioned exception: the chart's `onSelectAsOf` dot-click). Perspectives *read* context and *supply* an envelope; they never own time.
- A lens switch changes exactly one thing: the workspace panel below the tabs.

**P2 — One canonical time model.** The shell owns a single source of truth: `{preset, asOf, compareTo}`, always mutually consistent (§3). No perspective, widget, or chart may carry parallel time state.

**P3 — Did the data earn this?** Unchanged from the Time Machine doctrine. Every rendered number is honestly produced by the engine at ship time: no fabricated attribution, no interpolated continuity, no invented source counts, no completeness percentages before A9 provides a denominator. Estimated/incomplete values never sum into figures presented as observed.

**P4 — Answers, not widgets.** Every major Wealth surface answers a named question; every number appears as a headline exactly once; every caveat is stated exactly once, at the surface it governs.

**P5 — Evolve Atlas/Liquid, don't invent.** Glass panels, hairline borders, `--surface-inset`, tabular numerals, Meridian accents, `SegmentedControl` grammar. No new visual language.

**P6 — Ship the slot, not the promise.** Where the concept shows post-A9/A10 capabilities (true attribution, quantified completeness, source counts), the design ships the *container* shaped for them and fills it with what is earned today.

**P7 — Strict lane discipline (parallel-work caution).** A7/A8 may be in flight elsewhere. This implementation never touches: `prisma/` (schema or migrations), the import pipeline, investment reconstruction, price or valuation infrastructure, or snapshot regeneration. Allowed lanes only: shell presentation/state, Wealth UI components, a bounded pure addition to `lib/wealth/wealth-time-machine.ts` for the compare overlay, envelope/evidence presentation, and a bounded additive change to the shared period vocabulary (§3.4).

---

## 2. Final Perspective Shell target

### 2.1 Structure — two framed containers, then the workspace

```
FRAMED CONTAINER 1 — "time and trust" (one GlassPanel, hairline-strong border)
  Row A (context):  As of [date] · ⇄ · Compare to [date|None] · ······ · Completeness ▸ · Evidence ▸
  Row B (presets):  [WTD MTD QTD YTD]              (breathing room)              [1W 1M 3M 6M 1Y ALL]
FRAMED CONTAINER 2 — "the lens" (sibling frame, visually lighter)
  ● Wealth   Liquidity   Debt   Cash Flow   Investments   Goals
WORKSPACE — the active perspective (unframed page surface below)
```

The shell must read as: *"time and trust remain fixed; the lens changes."* Container 1 is the heaviest chrome on the page (it is the permanent instrument panel); Container 2 is lighter (it is a selector); the workspace is lightest (it is content).

### 2.2 Visual treatment decisions

- **Framing:** Container 1 uses the existing glass-panel recipe with `--border-hairline-strong` and a slightly elevated background vs the page; Container 2 uses `--border-hairline`. Both `rounded-2xl`, consistent internal padding. No third frame anywhere in the shell.
- **Border hierarchy:** strong hairline (container 1) → hairline (container 2) → hairline on workspace cards. Exactly three levels; matches the concept's read where the top band is the most "instrument-like" element.
- **Background contrast:** Row A fields keep `--surface-inset`; the preset `SegmentedControl`s sit directly on the container glass (they carry their own capsule material) — no nested inset-on-inset.
- **Active-state grammar — one grammar everywhere:** the Meridian-glass sliding highlight of `SegmentedControl` becomes the *only* "active" treatment in the shell: preset groups (already using it) and the perspective tabs (migrated to it, replacing the flat `--accent-info` filled pill). One material answers "what is selected?" across the whole shell.
- **Tab treatment:** Container 2 renders the six lenses as one `SegmentedControl`-grammar row (icons optional, labels required), row-major order Wealth · Liquidity · Debt · Cash Flow · Investments · Goals. "Soon" suffix behavior for workspace-less lenses is preserved. Never a sidebar; never a `<select>`.
- **Preset placement (Amendment 2):** Row B sits beneath Row A *inside* Container 1. To-date group flush left, rolling group flush right, `justify-between` with genuine center whitespace — the current layout's exact semantic split, now visibly owned by the same frame as As Of / Compare To, which is what makes the preset ↔ date-pair relationship legible (§3): the dates a preset writes are two centimeters above it.
- **Sticky behavior:** on desktop, Container 1 (Row A only, condensed to one line on scroll) remains sticky below the app header while the workspace scrolls; Container 2 scrolls away with the page. Rationale: time + trust are the always-relevant frame; the lens choice is already reflected in the visible content. On mobile, the condensed Row A is sticky; presets and tabs scroll (§6). If sticky proves visually heavy in implementation, degrade to non-sticky — it is chrome, not contract, and is validated in the browser checklist.
- **Swap affordance:** a ⇄ button between the two date fields (concept's affordance), keyboard-accessible.

### 2.3 What the shell renders per state

- Compare To shows the derived date under any preset; under `ALL` it shows the earliest defensible date when honestly available, else "Earliest available" ghost text with `compareTo = null` (§3.3).
- A manually diverged pair shows **no highlighted preset** (Custom state) — the segmented controls' empty-value behavior, already supported.
- Completeness/Evidence chips: label + tone from the active perspective's envelope (§4.6 of the governing investigation, unchanged), now interactive — Completeness opens a reason popover; Evidence opens the evidence drawer when real detail exists; "—" placeholder stays inert. No fake counts.

---

## 3. Final canonical time-state contract (Amendment 1)

### 3.1 The model

```ts
// lib/space-shell/shell-time.ts (new, pure, fully unit-tested)

type ShellPreset =
  | "WTD" | "MTD" | "QTD" | "YTD"                                  // to-date family
  | "P1W" | "P1M" | "P3M" | "P6M" | "P1Y" | "ALL"                  // rolling family
  | "CUSTOM";                                                       // derived, never user-picked directly

interface ShellTimeState {
  preset:    ShellPreset;
  asOf:      string;         // YYYY-MM-DD, ≤ today
  compareTo: string | null;  // YYYY-MM-DD; null only under ALL-with-no-coverage or explicit clear
}
```

**Invariant (the whole amendment in one sentence):** `preset === "CUSTOM"` ⟺ the `(asOf, compareTo)` pair does not equal `deriveCompareTo(preset, asOf)` for any non-CUSTOM preset — i.e., the highlighted preset always tells the truth about the date pair, and the date pair always reflects the highlighted preset. There is no third piece of time state; the previous standalone `period` is **derived**, not stored (§3.5).

### 3.2 Derivation semantics (calendar-aware, date-only, UTC — matching `formatWealthDate`/`shellToday` doctrine)

| Preset | `compareTo = deriveCompareTo(preset, asOf)` |
|---|---|
| **WTD** | start of the week containing As Of (existing week-start convention in `lib/transactions/cash-flow.ts` — reuse it, do not re-decide it) |
| **MTD** | first day of As Of's month |
| **QTD** | first day of As Of's quarter |
| **YTD** | January 1 of As Of's year |
| **P1W** | As Of − 1 calendar week |
| **P1M** | As Of − 1 calendar month (calendar-aware: Mar 31 − 1M = Feb 28/29, end-of-month clamping) |
| **P3M** | As Of − 3 calendar months |
| **P6M** | As Of − 6 calendar months |
| **P1Y** | As Of − 1 calendar year (Feb 29 clamps to Feb 28) |
| **ALL** | earliest defensible date when honestly available (§3.3); else `null` |

**Default shell state:** `{ preset: "MTD", asOf: today, compareTo: firstDayOfMonth(today) }` — aligned with the existing `DEFAULT_CASH_FLOW_PERIOD = "MTD"`.

### 3.3 Transition rules (bidirectional, no silent disagreement)

| User action | Result |
|---|---|
| Select preset *p* | `compareTo = deriveCompareTo(p, asOf)`; `preset = p`. As Of never moves. |
| Change As Of while `preset ≠ CUSTOM` | `compareTo` recomputed from the active preset against the new As Of. |
| Change As Of while `preset = CUSTOM` | `compareTo` untouched; preset re-inferred (may snap out of Custom if the new pair exactly matches a preset). |
| Manually change Compare To | `preset = inferPreset(asOf, compareTo)`: exact match ⇒ that preset highlights; no match ⇒ `CUSTOM` (no highlight). Ambiguity resolution when a date satisfies several presets (e.g., As Of = Mar 31, Compare To = Mar 1 matches both MTD and QTD): prefer the **currently active** preset if it still matches; otherwise the first match in display order (WTD → MTD → QTD → YTD → P1W → …). Deterministic, tested. |
| Clear Compare To (×) | `compareTo = null`, `preset = CUSTOM`. Perspectives render their honest no-comparison states (all existing `NO_COMPARE` paths remain reachable). |
| Swap (⇄) | Exchange `asOf` ↔ `compareTo` (guard: a swapped-in As Of clamps to ≤ today; a null Compare To disables swap); then re-infer preset (almost always ⇒ `CUSTOM`). Deltas remain mathematically defined as *as-of − compare* regardless of order. |
| Select **ALL** | `compareTo = earliestDefensibleDate ?? null`. The hook receives `earliestDefensibleDate` from the host (today: the earliest non-`fxMiss` `SpaceSnapshot` date the host already holds — Space-level and lens-independent, so the pair stays fixed across lens switches per P1). When `null`, perspectives consume full-history behavior; **no start date is fabricated**. |
| Chart dot click (`onSelectAsOf`) | Same as "change As Of" — flows through the identical reducer path. |

**Forbidden by construction:** the governing investigation's `presetLink: "window" | "window+compare"` toggle (rejected); any state where a highlighted preset and the date pair disagree; any perspective mutating time.

### 3.4 The preset vocabulary change (rolling group: 1W · 1M · 3M · 6M · 1Y · ALL)

Current code ships `1W · 1M · 1Q · 1Y · All`. Required deltas, all inside the existing period module (additive; no schema, no behavior change for existing consumers):

- Relabel `PAST_QUARTER`: `"1Q"` → `"3M"` (identical semantics — a rolling three-calendar-month window; label-only change).
- Add `PAST_6_MONTHS` (`"6M"`) to `RelativeCashFlowPeriod`, `ROLLING_PERIODS`, and `periodRange` (As Of − 6 calendar months, same clamping as `PAST_MONTH`).
- `"All"` label normalizes to `"ALL"` to match the to-date group's uppercase grammar.
- Cash Flow inherits 3M/6M for free (its widgets already consume any `CashFlowPeriod`).

### 3.5 Derived values (what consumers actually read)

```
ShellTimeState {preset, asOf, compareTo}
  ├── chartWindow    = [compareTo ?? coverageFrom, asOf]     // Wealth trend range; replaces the old `period` windowing
  ├── cashFlowPeriod = mapPresetToCashFlowPeriod(preset)     // WTD→"WTD" … P3M→"PAST_QUARTER", P6M→"PAST_6_MONTHS", ALL→"ALL"
  │                    CUSTOM ⇒ hold the last preset-derived period (documented limitation until
  │                    Cash Flow consumes explicit shell ranges; Cash Flow's own explicit
  │                    Month/Quarter/Year pickers inside its History widget are untouched)
  └── URL serialization (§ Amendment 12): asOf, compareTo, preset (or "custom"), metric (wealth only)
```

`computeWealthTimeMachine` keeps its `period` input signature this slice (it is pure and tested); the host passes the derived window. Migrating its signature to an explicit `{start,end}` window is a cleanup slice the plan leaves optional (§9, S5 notes).

---

## 4. Final Wealth information architecture (Amendments 4–10)

Five surfaces, narrative order fixed on all form factors: **state → change → cause → structure → explanation.**

### 4.1 ① Hero — "How wealthy am I?" (Amendment 5)

One headline: Net Worth at As Of (the number appears as a headline **nowhere else on the page**). Beside/beneath it: absolute change vs Compare To, percentage where valid (`pct !== null`), and the confidence treatment inline (Observed / Reconstructed chip, tone per tier). Secondary row: Total Assets · Total Liabilities · Liquid Net Worth as compact label·value·delta rows — **not cards, no sparklines** (all four KPI sparklines are removed; the trend chart is the page's only trend). Liquid Net Worth row carries the "→ Liquidity" lens hand-off affordance (P1: hand-offs are lens switches under the same shell context).

### 4.2 ② Trend — "How has my net worth changed?" (Amendment 6)

The visual center of the page — decisively dominant. Height budget ~360–420px on desktop (the amendment authorizes 40–50% taller than the concept's proportion if it strengthens hierarchy; given the hero no longer competes, it does). Required elements, all specified in the governing investigation §9 and confirmed:

primary net-worth series · compare-period overlay where honestly supported (dashed, `--text-faint`, equal-length window ending at Compare To) · low-alpha Meridian area fill under the primary series only · minimal y-axis (3–4 ticks) and period-appropriate x labels, hairline gridlines · hover/touch tooltip (date · value · "Reconstructed" when applicable) · As Of marker (solid guide) · Compare To marker (dashed guide) · **visible gaps preserved** · hollow/dashed reconstructed markers preserved · dot click/tap sets shared As Of via the existing `onSelectAsOf` contract · metric switcher (Net Worth / Assets / Liabilities / Liquid Net Worth) as an inline `SegmentedControl`-grammar control; the chart's `WealthChartPoint` already carries all four series.

Hard rules: no smoothing through missing data; no interpolation; no invented continuity; the upgraded chart keeps the hand-rolled honest-SVG approach (gaps and hollow markers are first-class there; chart libraries fight them).

### 4.3 ③ Change ledger — "Where did the change come from?" (Amendment 7)

The concept's signed-ledger shape, filled only with earned categories. Today's rows = real composition deltas from `WealthResult.deltas.composition`: **Investments · Crypto · Cash · Real World Assets · Liabilities** (epsilon-filtered, sorted by |Δ|, colored by the existing `driverGood` semantics — liabilities down is good). A hairline-separated **Net Change** total row anchors the card (sum of asset-class deltas minus liability delta = net-worth delta; reconciliation is a test). Exactly **one** attribution limitation note, forward-phrased: *"Attribution by market growth vs. contributions arrives with historical valuation."* Never label these rows Market Growth / Contributions / Income / Spending / Fees before A9 proves those causal categories.

**The A9 slot contract:** the card renders `LedgerRow[] = {id, label, delta, drillTarget?}` + a net row + one optional note. When A9 lands, the read model swaps the row source from composition deltas to true attribution and deletes the note — zero card redesign (P6).

### 4.4 ④ Composition — "What is my wealth composed of?" (Amendments 8–9)

**Taxonomy.** User-facing categories: **Investments · Crypto · Cash · Real World Assets · Other** — where supported. Current reality check against `lib/wealth/wealth-time-machine.ts`: `WEALTH_CATEGORY_LABELS` already renders Cash / Investments / Crypto / **Real World Assets** (the rename is already done in the read model — the remaining work is an audit that no other user-facing Wealth surface still says "Real Assets"/"Real Estate" for physical assets); Crypto is already first-class (never folded into Other); zero-value categories are already epsilon-filtered (`WEALTH_EPSILON = 0.5` — no slice, no legend row, no reserved color, no empty percentage). **"Other" today:** the snapshot's `real` component is a residual (`totalAssets − cash − investments − crypto`), so a separate defensible "Other" bucket does not exist in the data — rendering one would split a residual into two invented parts. Per P3/P6: "Other" is a *reserved slot in the presentation mapping*, populated only when a future snapshot/regeneration change distinguishes genuine real-world assets from the remainder. All of this stays a presentation mapping; **no backend enums or persisted columns are renamed.** Liabilities remain outside the asset doughnut, in their separate row treatment (current behavior, kept deliberately).

**Depth (Amendment 9).** The A6 cutover losses return as modes behind one disclosure affordance on the composition card:

- **By asset class** — default; genuinely historical (snapshot-backed at the As Of date); keeps the Reconstructed badge behavior.
- **By institution / By account / Concentration** — reuse the existing registered widget renderers (`institution_allocation`, `wealth_by_account`, `wealth_concentration`); these read *live accounts*, so each is permanently labeled **"Current classification"** while historical classification is unearned, and the label sits at section level per the honesty hierarchy — current account distribution is never presented as belonging to a historical As Of date.
- **Pattern:** inline mode tabs (small segmented control in the card header) on desktop — lowest-friction, keeps the user in the narrative; a **bottom sheet** on mobile (existing `OverlaySurface` overlay patterns). A drawer/popover adds a navigation layer the four modes don't need.
- Compare-mode enrichment: when `compareTo` is set, per-class delta chips beside legend rows (from `deltas.composition`, already computed).

### 4.5 ⑤ Explanation (Amendment 10)

Renamed from "What's the story behind the change?" to **"Explanation"** — the permanent product label (all code identifiers follow: `WealthExplanationCard`, `result.explanation`; rename-in-sentences-first applies to UI copy immediately, identifiers in the same slice since the component is being rewritten anyway). Deterministic and template-based until A12: only supported facts — *"Net worth increased by $X since ⟨date⟩. Assets increased by $Y and liabilities decreased by $Z."* — plus the dominant supported driver when one exceeds ~half the net change (*"driven mostly by Investments (+$18,420)"*). It must not call an LLM, speculate, advise, or invent causal attribution. Footer affordance: **"View explanation and evidence"** → opens the evidence drawer today; becomes the A12 conversation entry later (same slot, P6).

### 4.6 Honesty & evidence (Amendment 11 — unchanged from governing §11, restated as binding)

Three levels: shell summary → section-level exceptions only → value-level visual treatment. Fixed user-facing vocabulary: **Observed · Reconstructed · Estimated · Incomplete · No history before … · Held at current value · Held at current classification.** No "97% complete" percentages until A9 provides a real denominator. Completeness popover and Evidence drawer render only real detail (snapshot list today); absent envelope ⇒ inert "—"; no fake source counts, ever.

---

## 5. Desktop wireframe (text)

```
╔════════════════════════════════════════════════════════════════════════════╗
║ CONTAINER 1 — time & trust (glass, strong hairline; Row A sticky-condensed  ║
║ on scroll)                                                                  ║
║  As of [Jul 11, 2026 ▾]  ⇄  Compare to [Jan 1, 2026 ▾ ×]      ····         ║
║                                  [🛡 Completeness: Observed ▸] [🗎 Evidence: 31 snapshots ▸] ║
║  ────────────────────────────────────────────────────────────────────────  ║
║  [WTD | MTD● | QTD | YTD]        (breathing room)   [1W | 1M | 3M | 6M | 1Y | ALL] ║
╚════════════════════════════════════════════════════════════════════════════╝
╔════════════════════════════════════════════════════════════════════════════╗
║ CONTAINER 2 — lens (glass, hairline)                                        ║
║  [ ● Wealth | Liquidity | Debt | Cash Flow | Investments | Goals ]          ║
╚════════════════════════════════════════════════════════════════════════════╝
┌──────────────────┐ ┌────────────────────────────────────────────────────────┐
│ ① HERO (4 cols)  │ │ ② TREND (8 cols, ~360–420px)                          │
│ How wealthy am I?│ │ How has my net worth changed?    [NW|Assets|Liab|Liq] │
│ $186,560         │ │   ┊compare guide      area-filled series    ●as-of    │
│ ↑ $24,130 · 14.9%│ │   ╌╌dashed compare overlay╌╌   ○reconstructed  gaps   │
│ vs Jan 1, 2026   │ │   y-ticks · hairline grid · hover tooltip             │
│ ● Observed       │ │   x: Jan '26 … Jul '26                                │
│ ──────────────── │ │                                                        │
│ Assets    $…  ↑Δ │ │                                                        │
│ Liabil.   $…  ↓Δ │ │                                                        │
│ Liquid NW $…  ↑Δ →│ │                                                       │
└──────────────────┘ └────────────────────────────────────────────────────────┘
┌───────────────────────────────┐ ┌────────────────────────────────────────────┐
│ ③ CHANGE (6 cols)             │ │ ④ COMPOSITION (6 cols)                     │
│ Where did the change come     │ │ What is my wealth composed of?             │
│ from?                         │ │ As of Jul 11, 2026    [Class|Inst|Acct|Conc]│
│  Investments      +$18,420    │ │      ◔ doughnut     Investments 61%  $…  Δ │
│  Cash              +$4,820    │ │                     Cash        18%  $…  Δ │
│  Crypto            +$2,740    │ │                     Crypto      14%  $…  Δ │
│  Real World Assets   +$710    │ │                     R.W. Assets  7%  $…  Δ │
│  Liabilities       −$2,560 ✓  │ │  Liabilities (shown separately)   −$…      │
│  ─────────────────────────    │ │                                            │
│  Net Change       +$24,130    │ │                                            │
│  ⓘ attribution note (once)    │ │                                            │
└───────────────────────────────┘ └────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────────┐
│ ⑤ EXPLANATION (12 cols)                                                    │
│ Net worth increased by $24,130 since Jan 1, 2026, driven mostly by         │
│ Investments (+$18,420). Assets increased by $26,690 and liabilities        │
│ decreased by $2,560.               [ View explanation and evidence → ]     │
└────────────────────────────────────────────────────────────────────────────┘
```

## 6. Mobile wireframe (text)

```
┌─────────────────────────────────────┐
│ STICKY: As of Jul 11 ⇄ vs Jan 1 · ●│  ← one condensed line; dates open native
│                                     │    pickers; ● opens completeness sheet
│ [WTD MTD● QTD YTD · 1W 1M 3M 6M 1Y ALL] ← one horizontally scrollable
│  └─ to-date first ─┘ └─ rolling ─┘  │    SegmentedControl track; groups keep
│                                     │    order + a visual divider; scrolls,
│                                     │    never wraps, never merges semantics
│ [ Wealth ● Liquidity Debt Cash… ]   │  ← scrollable tab rail (NO <select>)
├─────────────────────────────────────┤
│ ① HERO  $186,560  ↑$24,130 · 14.9% │
│   ● Observed                        │
│   Assets $… · Liab $… · Liquid $…  │
│ ② TREND (~260px, touch-drag        │
│    tooltip, tap dot = set As Of)    │
│    [NW|Assets|Liab|Liq] switcher    │
│ ③ CHANGE ledger (full width)       │
│ ④ COMPOSITION (modes → bottom      │
│    sheet)                           │
│ ⑤ EXPLANATION + evidence link      │
└─────────────────────────────────────┘
No horizontal page overflow anywhere; only the preset track and tab rail
scroll horizontally within their own bounds.
```

---

## 7. Component hierarchy (final target)

```
SpaceDashboard (host — shrinks; single integration point per phase)
└── [tab === "PERSPECTIVES"]
    ├── usePerspectiveShellState(spaceId, { today, earliestDefensibleDate })   ★ new
    │     — owns ShellTimeState via the §3 reducer; URL sync; exposes derived
    │       {chartWindow, cashFlowPeriod}
    ├── PerspectiveShell                                                        ★ new  components/space/shell/
    │   ├── ShellContextRow                       ← evolves SharedHistoricalContext.tsx
    │   │   ├── AsOfControl · SwapButton · CompareToControl
    │   │   ├── CompletenessChip → CompletenessPopover                          ★ interactive
    │   │   └── EvidenceChip → EvidenceDrawer                                   ★ interactive
    │   ├── ShellPresetRow                        ← evolves CashFlowPeriodSelector
    │   │     (to-date left · rolling right · 1W 1M 3M 6M 1Y ALL · Custom = no highlight)
    │   └── PerspectiveTabs                       ← extracted from SpaceDashboard;
    │         SegmentedControl grammar; scrollable rail on mobile
    └── PerspectiveWorkspace (tabpanel)
        ├── [wealth] WealthPerspective            — recomposed, five surfaces
        │   ├── WealthHero                        ★ (absorbs WealthKpiStrip + WealthChangeCard)
        │   ├── WealthTrendChart                  ← upgraded WealthNetWorthChart
        │   ├── WealthChangeLedger                ★ (absorbs WealthDriversCard)
        │   ├── WealthCompositionCard             ← gains mode switcher + bottom sheet
        │   └── WealthExplanationCard             ← renamed WealthStoryCard + evidence link
        ├── [cashFlow/liquidity/debt/goals] SectionCard virtual-section stacks — unchanged
        └── [investments] unchanged until A10
Shared kit: wealth-ui.tsx (WealthCard, DeltaBadge, WealthUnavailable; Sparkline stays
in the kit for other perspectives, unused on Wealth)
Read model: lib/wealth/wealth-time-machine.ts — one bounded pure addition (compare
overlay series), everything else unchanged
Envelopes: lib/perspectives/envelope.ts                                          ★ new
Time model: lib/space-shell/shell-time.ts                                        ★ new
```

## 8. State / data-flow diagram

```
                     URL (?perspective&asOf&compareTo&preset&metric)
                        ▲ serialize          │ hydrate on mount
                        │                    ▼
   SpaceDashboard ──► usePerspectiveShellState ──────────────┐
   (supplies today,     {preset, asOf, compareTo}            │ reducer-guarded
    earliestDefensible-  + derived {chartWindow,             │ transitions (§3.3)
    Date from snapshots) cashFlowPeriod}                      │
        │                     │                               │
        │                     ▼                               │
        │              PerspectiveShell ◄── PerspectiveEnvelope registry
        │              (renders state;       (active lens supplies
        │               writes ONLY via      completeness + evidence;
        │               shell controls)      Wealth ← wealthResult,
        │                     │              Liquidity/Debt ← lens provenance,
        │                     │              others ← honest static)
        ▼                     ▼
   computeWealthTimeMachine(snapshots, asOf, compareTo, chartWindow, today, currency)
        │  pure, tested — the ONLY compute node
        ▼
   WealthResult ──► WealthPerspective ──► Hero / TrendChart / ChangeLedger /
                                          Composition / Explanation
                          │
                          └── onSelectAsOf(date) ──► shell reducer ("change As Of" path)
                              [the single sanctioned upward write]
Other lenses read {asOf, compareTo, cashFlowPeriod} identically; none write.
```

---

## 9. Consolidated implementation roadmap

Nine slices, four phases. Consolidation applied per the planning preference: the prior 15 slices merge where they shared files (S1+S3+S4-old → new S1; S2-old+S7-old+mobile-shell → new S2; S8+S11-old → new S6; S12+S13-old partially → new S8). Each slice = one commit = one revertable unit. `SpaceDashboard.tsx` is edited in exactly **two** slices (S2, S8); `WealthPerspective.tsx` in exactly **one** (S8); the trend chart file in exactly **one** (S7).

| Slice | Name | Lane | Depends on | Parallel with |
|---|---|---|---|---|
| **S1** | Canonical time model + state hook + URL sync | Shell-only | — | S5 |
| **S2** | Shell extraction: frames, tabs, presets, swap, sticky, mobile shell | Shell-only | S1 | S5 |
| **S3** | Envelope contract + registry | Shell-only | S2 | S4, S5, S6 |
| **S4** | Interactive Completeness popover + Evidence drawer | Shell-only | S2 | S3, S5, S6 |
| **S5** | Read model: compare overlay series (+ optional window signature cleanup) | Wealth read model only | — | S1–S4, S6 |
| **S6** | WealthHero + WealthChangeLedger (new leaf components) | Wealth-only | S1 (types) | S3, S4, S5 |
| **S7** | WealthTrendChart upgrade (dominant chart) | Wealth-only | S5 | S3, S4 |
| **S8** | Wealth integration: composition modes, Explanation, recompose, host wiring | Wealth + host | S2, S6, S7 | — |
| **S9** | Responsive & polish validation pass | Both | S8 | — |

**Sequential chains:** S1 → S2 → {S3, S4} and S5 → S7; S8 requires S2+S6+S7; S9 last.
**Safe parallel sets:** {S1, S5} · then {S3, S4, S6, S7(after S5)} · S8 alone · S9 alone. Never two agents in the same file (§11).

**Commit boundaries:** one commit per slice, message `feat(shell): S1 — canonical time model…` etc.; no slice ships partial (each ends green: `tsc`, lint, `npm test`, and its validation checklist). No drive-by edits outside the slice's owned files.

**Merge order:** S1 → S5 → S2 → S3 → S4 → S6 → S7 → S8 → S9. (S5 merges early because it is pure + tested and unblocks S7; S3/S4/S6 may merge in any order among themselves after their dependencies — the stated order minimizes rebase churn on `components/space/shell/`.)

**Rollback strategy:** every slice is a single revertable commit with no cross-slice file overlap except the two designated integration files; reverting S8 restores the previous `WealthPerspective` composition (old components are deleted only *in* S8, so its revert is total); reverting S2 restores the current three-strip shell (S1's hook API is designed to serve both). Kill-switch notes per slice in §13 prompts. No data/schema rollback exists because no slice touches persistence (P7).

**Stop conditions (global — any one halts the line):** a slice needs a Prisma/schema/migration change; a slice needs to modify import/price/valuation/snapshot-regeneration code; the time-model invariant (§3.1) cannot be enforced without perspective-side writes; `computeWealthTimeMachine` changes would alter any existing tested output; visual work requires breaking the Space rail. Stop, report, re-plan.

---

## 10. File ownership matrix (exact, per slice)

| Slice | Owns (create ★ / edit) | Forbidden (beyond the global P7 list: `prisma/**`, `lib/plaid/**`, `lib/snapshots/**`, `jobs/**`, import/price/valuation code) |
|---|---|---|
| **S1** | ★ `lib/space-shell/shell-time.ts` · ★ `lib/space-shell/shell-time.test.ts` · ★ `components/space/shell/usePerspectiveShellState.ts` · edit `lib/transactions/cash-flow.ts` (additive: `PAST_6_MONTHS`, labels `3M`/`ALL`) · edit `SpaceDashboard.tsx` **only** the 4 lines swapping `useState`s for the hook | All `components/space/widgets/**`, `SharedHistoricalContext.tsx`, `wealth-time-machine.ts` |
| **S2** | ★ `components/space/shell/PerspectiveShell.tsx` · ★ `shell/ShellContextRow.tsx` (absorbs+deletes `SharedHistoricalContext.tsx`) · ★ `shell/ShellPresetRow.tsx` (shell replacement for the Row-2 use of `CashFlowPeriodSelector`; the widget file itself is untouched and remains for any in-widget use) · ★ `shell/PerspectiveTabs.tsx` · edit `SpaceDashboard.tsx` (replace Rows 1–3 + delete inline `PerspectiveTabSelector`) | `wealth/**`, `wealth-time-machine.ts`, `lib/transactions/cash-flow.ts` |
| **S3** | ★ `lib/perspectives/envelope.ts` (+ test) · edit `shell/PerspectiveShell.tsx` (consume registry) | `SpaceDashboard.tsx` (envelope sourcing goes through the registry, not new host ternaries), `wealth/**` |
| **S4** | ★ `shell/CompletenessPopover.tsx` · ★ `shell/EvidenceDrawer.tsx` · edit `shell/ShellContextRow.tsx` | `SpaceDashboard.tsx`, `wealth/**`, `envelope.ts` (S3's; consume only) |
| **S5** | edit `lib/wealth/wealth-time-machine.ts` + `wealth-time-machine.test.ts` **only** | Everything else — this slice is two files |
| **S6** | ★ `wealth/WealthHero.tsx` · ★ `wealth/WealthChangeLedger.tsx` (+ colocated tests if logic warrants) | `WealthPerspective.tsx` (integration is S8), `WealthNetWorthChart.tsx`, shell files |
| **S7** | edit/rename `wealth/WealthNetWorthChart.tsx` → `wealth/WealthTrendChart.tsx` | `WealthPerspective.tsx`, all other wealth files, shell files |
| **S8** | edit `wealth/WealthPerspective.tsx` · edit `wealth/WealthCompositionCard.tsx` (modes) · rename `WealthStoryCard` → ★ `wealth/WealthExplanationCard.tsx` · delete `WealthKpiStrip.tsx`, `WealthChangeCards.tsx` · edit `SpaceDashboard.tsx` (final wiring) · edit `wealth-ui.tsx` (only if a shared primitive needs a prop) | `shell-time.ts`, `wealth-time-machine.ts` (frozen after S5), `lib/transactions/cash-flow.ts` |
| **S9** | Responsive class edits confined to `shell/**` and `wealth/**` files; no structural changes | Everything else; no new components |

## 11. Merge-conflict analysis

- **`SpaceDashboard.tsx`** is the only genuinely contended file. Mitigation: touched in S1 (4-line hook swap), S2 (row replacement), S8 (final wiring) — all on the sequential spine, never in a parallel set. S3–S7 are barred from it by the matrix.
- **`components/space/shell/**`** is created by S2; S3 and S4 both edit inside it afterward but own *different* files (S3: `PerspectiveShell.tsx`; S4: `ShellContextRow.tsx` + new files) — parallel-safe. The one seam: S3's registry consumption renders the chips S4 makes interactive; the `PerspectiveEnvelope` type (defined in S3's `envelope.ts`) is the contract both compile against, so S4 can proceed against the type even before S3 merges.
- **`wealth/**`**: S6 creates new files; S7 edits one existing file; S8 owns the composition file and deletions. Zero overlap until S8, which is sequential.
- **Read model**: S5 is the sole owner of `wealth-time-machine.ts`, frozen after merge; S7/S8 consume its published types only.
- **`lib/transactions/cash-flow.ts`**: touched once (S1, additive). Cash Flow widgets recompile without changes; the only visible effect elsewhere is the `3M`/`ALL` relabel — called out in S1's validation.
- **Cross-lane guarantee for A7/A8 concurrent work:** every file this plan owns is under `components/space/shell/`, `components/space/widgets/wealth/`, `lib/space-shell/`, `lib/perspectives/`, `lib/wealth/wealth-time-machine.*`, plus bounded named edits to `SpaceDashboard.tsx` and `lib/transactions/cash-flow.ts`. None of these are plausible A7/A8 surfaces (import pipeline, pricing, valuation, schema). Conflict risk with the parallel initiatives: effectively zero by construction.

## 12. Validation strategy

**Per-slice gates (every slice):** `npx tsc --noEmit` clean · lint clean · `npm test` green (including the slice's new tests) · the slice's browser spot-check below · no diff outside owned files (verify with `git status`/`git diff --stat` before commit).

**Unit-test requirements:**
- S1: exhaustive `shell-time` table tests — every preset × derivation (§3.2), every transition (§3.3), calendar edges (month-end clamping: Mar 31 −1M; leap day: Feb 29 −1Y; year boundary: Jan 2 WTD; quarter boundaries), `inferPreset` ambiguity determinism, ALL-with/without `earliestDefensibleDate`, invariant property check (`preset ≠ CUSTOM ⇒ compareTo === deriveCompareTo(preset, asOf)`), URL round-trip (serialize → hydrate ⇒ identical state; invalid/future dates fall back to defaults).
- S3: envelope mapping per perspective; absent envelope ⇒ placeholder, never fabricated.
- S5: compare-overlay series — equal-length window derivation, gaps preserved, `isEstimated` carried, empty when `compareTo` null or window precedes coverage; **byte-identical outputs for all existing test inputs** (regression lock).
- S6: ledger reconciliation (Σ asset deltas − liability delta = net-worth delta), epsilon filtering, `driverGood` coloring, single-note rule.

**Browser-validation checklist (S2 partial, full at S8/S9; desktop Chrome + one WebKit pass):**
1. Default entry: preset MTD highlighted, As Of = today, Compare To = first of month — all three visibly consistent.
2. Tap each of the 10 presets → Compare To updates per §3.2; highlighted preset always matches the pair.
3. Change As Of with YTD active → Compare To recomputes to Jan 1 of the new year.
4. Hand-set Compare To to an exact preset boundary → that preset highlights; to an arbitrary date → no preset highlights (Custom).
5. ⇄ swap exchanges dates, clamps to today, drops to Custom; × clear works; deltas everywhere flip/vanish accordingly.
6. Switch through all six lenses: shell does not remount/flash; dates, preset, chips unchanged (P1 invariant — the release-blocking check).
7. Completeness chip opens the reason popover; Evidence opens the drawer with real snapshot rows; placeholder chips are inert.
8. Reload and share the URL: full state (perspective, asOf, compareTo, preset/custom, metric) round-trips.
9. Wealth: net worth appears as a headline exactly once; chart dominates; dot-click moves As Of and every surface follows; tooltip, gaps, hollow markers, compare overlay all render; metric switcher swaps series without losing markers.
10. Ledger rows + Net Change reconcile with the hero delta; exactly one attribution note on the page.
11. Composition modes switch; institution/account/concentration show "Current classification"; zero-value classes absent everywhere; liabilities outside the doughnut.
12. Explanation shows the deterministic sentence; "View explanation and evidence" opens the drawer.
13. Honest-state sweep: As Of before coverage → Incomplete states, no zeros-as-facts; estimated snapshot at As Of → Reconstructed badge at shell + composition; no comparison → all `NO_COMPARE` paths render.

**Responsive-validation checklist (S9; 375px, 768px, 1280px):**
1. No horizontal page overflow at any width (the two sanctioned in-bounds scrollers only).
2. Preset track: to-date group first, rolling second, order intact, divider visible, scrollable.
3. Tab rail scrolls; active lens always reachable; **no `<select>` anywhere in the shell**.
4. Sticky condensed context line behaves (sticks, condenses, doesn't jitter); acceptable degrade = non-sticky, never overlap.
5. Mobile narrative order ① → ⑤ exactly; hero legible without zoom; chart tooltip works by touch-drag; dot-tap targets ≥ 44px effective.
6. Composition bottom sheet opens/dismisses; focus is trapped and restored.
7. Tablet (768px): grid degrades to the intended intermediate (hero above chart, ③/④ stacked) with no orphaned half-width cards.
8. Keyboard/AT pass: tabs are `role=tablist` with arrow nav (existing behavior preserved), date fields labeled, popover/drawer dismissible via Escape.

---

## 13. Copy-paste Claude Code prompts (one per slice)

> Shared preamble for every prompt below — include it verbatim at the top of each:
>
> **Context:** Fourth Meridian, branch `feature/v2.5-spaces-completion`. Governing docs: `FOURTH_MERIDIAN_PERSPECTIVE_SHELL_WEALTH_REDESIGN_AMENDED_IMPLEMENTATION_PLAN_2026-07-12.md` (this plan — binding) and `FOURTH_MERIDIAN_PERSPECTIVE_SHELL_WEALTH_REDESIGN_INVESTIGATION_2026-07-12.md` (background). **Hard rules:** do not touch `prisma/**`, `lib/plaid/**`, `lib/snapshots/**`, `jobs/**`, or any import/price/valuation/regeneration code (A7/A8 run in parallel elsewhere). Edit only the files this slice owns; the plan's §10 matrix is binding — if you believe another file must change, STOP and report instead. Finish green: `npx tsc --noEmit`, lint, `npm test`. One commit for the whole slice. Respect the existing Atlas/Liquid design language and the product-language guide (`fourth-meridian-product-language.md`).

### S1 — Canonical shell time model + state hook + URL sync

```
Implement Slice S1 of the amended plan (§3, §9–10).

Goal: one canonical, shell-owned time model {preset, asOf, compareTo} — always
synchronized — replacing the three independent useStates in SpaceDashboard, plus
URL persistence. No visual changes in this slice.

1. Create lib/space-shell/shell-time.ts (pure, no React, no I/O, date-only UTC
   arithmetic consistent with the existing shellToday/formatWealthDate doctrine):
   - ShellPreset = "WTD"|"MTD"|"QTD"|"YTD"|"P1W"|"P1M"|"P3M"|"P6M"|"P1Y"|"ALL"|"CUSTOM"
   - ShellTimeState { preset, asOf, compareTo }
   - deriveCompareTo(preset, asOf, earliestDefensibleDate?) per the plan's §3.2
     table (calendar-aware: end-of-month clamping, leap-day clamp; reuse the
     week-start convention already used by WTD in lib/transactions/cash-flow.ts).
     ALL returns earliestDefensibleDate ?? null.
   - inferPreset(asOf, compareTo): exact match ⇒ preset (ambiguity: prefer a
     provided currentPreset if it still matches, else first in display order
     WTD,MTD,QTD,YTD,P1W,P1M,P3M,P6M,P1Y,ALL); else "CUSTOM".
   - shellTimeReducer(state, action) implementing EXACTLY the §3.3 transition
     table: selectPreset, setAsOf, setCompareTo, clearCompareTo, swap. Enforce
     the invariant: preset !== "CUSTOM" ⟺ compareTo === deriveCompareTo(preset,
     asOf). asOf must be ≤ today (clamp).
   - mapPresetToCashFlowPeriod(preset, lastPeriod): WTD..YTD map to themselves;
     P1W→PAST_WEEK, P1M→PAST_MONTH, P3M→PAST_QUARTER, P6M→PAST_6_MONTHS,
     P1Y→PAST_YEAR, ALL→ALL; CUSTOM ⇒ lastPeriod (documented limitation).
   - serialize/hydrate helpers for URL params (asOf, compareTo, preset|"custom");
     invalid or future dates ⇒ default state {MTD, today, firstOfMonth(today)}.
2. Edit lib/transactions/cash-flow.ts — ADDITIVE ONLY:
   - add "PAST_6_MONTHS" to RelativeCashFlowPeriod, ROLLING_PERIODS (label "6M",
     between 3M and 1Y), and periodRange (asOf-relative minus 6 calendar months,
     same clamping as PAST_MONTH);
   - relabel PAST_QUARTER "1Q"→"3M" and ALL "All"→"ALL" (labels only, ids and
     semantics unchanged). Run the existing cash-flow tests; fix label-only
     assertions if any, nothing else.
3. Create components/space/shell/usePerspectiveShellState.ts: a hook wrapping
   the reducer; inputs { spaceId, today, earliestDefensibleDate }; returns
   { state, actions, derived: { chartWindow: [compareTo ?? null, asOf],
   cashFlowPeriod } }; syncs asOf/compareTo/preset into the existing query-param
   mechanism SpaceDashboard already uses for tab/perspective, and hydrates on
   mount.
4. Edit components/dashboard/SpaceDashboard.tsx MINIMALLY: replace the asOf/
   compareTo/cashFlowPeriod useStates (lines ~2598–2625) with the hook; compute
   earliestDefensibleDate = earliest non-fxMiss snapshot date from the snapshots
   it already holds; keep every downstream prop identical (wealthResult still
   receives period = derived.cashFlowPeriod). No JSX/visual changes. Default
   state means the initial render now has compareTo = first of month (previously
   null) — this is intended (Amendment 1 default) and is the ONLY visible
   behavior change; note it in the commit message.
5. Tests: lib/space-shell/shell-time.test.ts — full derivation table, every
   transition, calendar edges (Mar 31 −1M, Feb 29 −1Y, Jan 2 WTD, quarter
   boundaries), inferPreset determinism + ambiguity preference, ALL with and
   without earliestDefensibleDate, invariant property test, URL round-trip,
   invalid-date fallback.
Validation: tsc/lint/tests green; app boots; Perspectives tab behaves as before
except the default Compare To. Rollback: revert the single commit (hook API is
self-contained).
Forbidden: everything in §10 S1's forbidden column.
```

### S2 — Shell extraction: frames, tabs, presets, swap, sticky, mobile shell

```
Implement Slice S2 of the amended plan (§2, §5–6, §9–10). Depends on merged S1.

Goal: the shell becomes one visual object — two framed containers — with the
canonical time model surfaced honestly. Shell-only; do not touch wealth/**.

1. Create components/space/shell/PerspectiveShell.tsx: Container 1 ("time &
   trust", glass panel, --border-hairline-strong, rounded-2xl) holding
   ShellContextRow above ShellPresetRow; Container 2 (sibling glass panel,
   --border-hairline) holding PerspectiveTabs. Exactly two frames.
2. Create shell/ShellContextRow.tsx by absorbing SharedHistoricalContext.tsx
   (then delete the old file and update imports):
   - As Of date field · a ⇄ swap button (disabled when compareTo is null;
     dispatches the reducer's swap action) · Compare To field with the existing
     clear (×) affordance;
   - Compare To under ALL with no earliest date: show "Earliest available" ghost
     text, value null;
   - Completeness/Evidence chips: keep current read-only rendering this slice
     (S4 makes them interactive); keep the honest "—" placeholder behavior.
3. Create shell/ShellPresetRow.tsx: two Atlas SegmentedControls, to-date group
   [WTD MTD QTD YTD] flush LEFT, rolling group [1W 1M 3M 6M 1Y ALL] flush RIGHT,
   justify-between (layout doctrine: do NOT merge or move the groups). Value
   comes from shell state; preset "CUSTOM" ⇒ both groups render with no active
   segment (empty-value behavior already supported). Selecting a segment
   dispatches selectPreset.
4. Create shell/PerspectiveTabs.tsx by extracting PerspectiveTabSelector from
   SpaceDashboard.tsx (~line 1918): migrate the active-state treatment from the
   flat accent-info fill to the SegmentedControl Meridian-glass grammar (one
   active-state language across the shell); keep role=tablist, roving tabindex,
   arrow/Home/End nav, and the "soon" suffix. Mobile: replace the <select> with
   a horizontally scrollable rail of the same control (no dropdown — banned).
5. Edit SpaceDashboard.tsx: replace the three strips (SharedHistoricalContext,
   CashFlowPeriodSelector row, inline PerspectiveTabSelector) with
   <PerspectiveShell …/>; delete the now-dead inline component. The
   CashFlowPeriodSelector FILE is untouched (it may remain for in-widget use).
6. Sticky: Container 1's Row A condenses to one line and sticks below the app
   header on scroll (desktop + mobile); presets/tabs scroll away. Keep it CSS-
   simple (position: sticky); if it fights the existing layout, ship non-sticky
   and note it — chrome, not contract.
7. Mobile: context row condenses ("As of Jul 11 ⇄ vs Jan 1 · ●tone"); preset
   groups render as one horizontally scrollable track preserving order (to-date
   first, divider, rolling) — never wrapped, never merged.
Validation: browser checklist items 1–6 (plan §12); lens switching never
remounts the shell (P1 — assert by state persistence + no flash); tsc/lint/
tests green. Rollback: revert commit restores the three-strip layout (S1 hook
serves both).
Forbidden: wealth/**, wealth-time-machine.ts, lib/transactions/cash-flow.ts.
```

### S3 — Per-perspective envelope contract + registry

```
Implement Slice S3 (§4.6 governing investigation §4.2; plan §9–10). Depends on
merged S2. May run parallel with S4/S5/S6 (different files).

1. Create lib/perspectives/envelope.ts:
   - PerspectiveEnvelope { completeness?: { tier: "observed"|"derived"|
     "estimated"|"incomplete"; label: string; tone: "neutral"|"positive"|
     "warning"; detail?: string }, evidence?: { label: string; count?: number } }
   - A resolver keyed by perspective id: wealth ← maps wealthResult.completeness/
     .evidence (unchanged data, new shape); liquidity/debt ← map their existing
     perspective-engine LensResult provenance (dataAsOf, estimated,
     assumptions[].source) to a tier + short label; cashFlow ← static honest
     envelope ("Complete within transaction depth", tier observed, detail names
     the boundary); investments ← tier incomplete, label "Current holdings
     only"; goals ← undefined (placeholder chips).
   - No fabricated counts: evidence.count only where a real record count exists
     (Wealth snapshot count today).
2. Edit shell/PerspectiveShell.tsx to consume the resolver for the ACTIVE
   perspective — this deletes the wealthWorkspaceActive ternary sourcing in the
   host (the host now passes raw inputs; the resolver shapes them).
3. Tests: lib/perspectives/envelope.test.ts — per-perspective mapping, absent ⇒
   undefined (never invented), tier mapping determinism.
Validation: chips show correct envelopes on all six lenses; placeholders honest;
tsc/lint/tests green.
Forbidden: SpaceDashboard.tsx beyond removing the ternary's prop plumbing if it
lives there; wealth/** components; ShellContextRow internals (S4's file).
```

### S4 — Interactive Completeness popover + Evidence drawer

```
Implement Slice S4 (plan §2.3, §4.6; governing §11). Depends on merged S2;
compile against the PerspectiveEnvelope type from S3 (coordinate if unmerged).

1. Create shell/CompletenessPopover.tsx: opens from the Completeness chip;
   shows the tier label + the envelope's detail reason (e.g. "Reconstructed —
   some values held at recent prices", "No history before Mar 3, 2026"). Fixed
   vocabulary only: Observed / Reconstructed / Estimated / Incomplete / No
   history before … / Held at current value / Held at current classification.
   NO percentages. Reuse existing popover/overlay primitives (OverlaySurface /
   Dialog patterns); Escape closes; focus restored.
2. Create shell/EvidenceDrawer.tsx: opens from the Evidence chip when the
   envelope has real detail; for Wealth today, list the snapshot records behind
   the result (date · net worth · Observed/Reconstructed marker) — reuse the
   drawer interaction pattern of TransactionSliceDrawer, not its transaction
   internals. Design the row model generically ({date, label, tier}) so A7/A8
   observations/imports/prices can populate it later without rework.
3. Edit shell/ShellContextRow.tsx: chips become buttons when their envelope
   exists (hover/focus affordance per Atlas), stay inert "—" otherwise.
4. Mobile: both render as bottom sheets via the same overlay primitives.
Validation: browser checklist item 7; keyboard/AT (Escape, focus trap/restore);
no fake counts anywhere; tsc/lint/tests green.
Forbidden: SpaceDashboard.tsx, wealth/**, envelope.ts (consume only),
PerspectiveShell.tsx (S3's edit surface).
```

### S5 — Read model: compare overlay series

```
Implement Slice S5 (plan §4.2, §9–10). No dependencies; may run first in
parallel with S1. TWO FILES ONLY: lib/wealth/wealth-time-machine.ts and its
test file.

1. Add to WealthResult.chart a compareSeries: WealthChartPoint[] — the snapshot
   series windowed to the equal-length window ENDING at compareTo (length =
   asOf − compareTo, i.e. [compareTo − (asOf − compareTo), compareTo]); empty
   when compareTo is null, when the window has no points, or when it precedes
   coverage. Points carry isEstimated exactly like the primary series; fxMiss
   rows are already dropped upstream. No interpolation, no padding, no
   synthesized endpoints.
2. Rename the result field story → explanation (Amendment 10) and update the
   template only if needed to keep current tests' semantics (sentence content
   unchanged this slice). Keep a deprecated story getter ONLY if other callers
   exist — check first; WealthStoryCard is the sole consumer, which S8 rewrites,
   so prefer a clean rename and a one-line fix in WealthStoryCard's field access
   (allowed as a mechanical rename touch).
3. REGRESSION LOCK: all existing test inputs must produce byte-identical outputs
   for every pre-existing field. Add tests: window derivation math, gap
   preservation, isEstimated carry-through, null/empty/pre-coverage cases,
   determinism.
4. OPTIONAL (only if zero-risk): accept an explicit {start,end} chartWindow
   alongside period, preferring it when provided — enables S7/S8 to pass the
   shell-derived window directly. If it complicates the regression lock, skip;
   note the decision.
Validation: tsc/lint/tests green; existing wealth tests untouched and passing.
Forbidden: every other file in the repository.
```

### S6 — WealthHero + WealthChangeLedger (leaf components)

```
Implement Slice S6 (plan §4.1, §4.3). Depends on S1's types (merged); parallel-
safe with S3/S4/S5/S7. NEW FILES ONLY — do not edit WealthPerspective.tsx (S8
integrates; until then these components are unreferenced and must compile +
test standalone).

1. Create components/space/widgets/wealth/WealthHero.tsx:
   - Net worth headline (single instance doctrine), DeltaBadge (abs + pct where
     valid) vs Compare To, inline confidence chip (Observed/Reconstructed tone
     from result.completeness);
   - secondary rows (NOT cards, NO sparklines): Total Assets · Total
     Liabilities · Liquid Net Worth — label · value · DeltaBadge each, with
     goodDirection "down" for liabilities;
   - Liquid Net Worth row: "→ Liquidity" affordance calling an injected
     onSwitchLens("liquidity") (shell context stays fixed — P1);
   - honest states: asOfState.found === false ⇒ WealthUnavailable ("No history
     for this date"), no zeros-as-facts; deltas null ⇒ values without badges.
   - Build from WealthResult + wealth-ui primitives (WealthCard, DeltaBadge,
     WealthUnavailable).
2. Create wealth/WealthChangeLedger.tsx — "Where did the change come from?":
   - rows from result.deltas.composition via the existing driver derivation
     (epsilon-filtered, |Δ|-sorted, driverGood coloring: liabilities down =
     good); labels from WEALTH_CATEGORY_LABELS (Investments/Crypto/Cash/Real
     World Assets/Liabilities);
   - hairline-separated "Net Change" total row = deltas.netWorth.abs; add a test
     asserting reconciliation (Σ asset component deltas − liabilities delta ≈
     net change within epsilon);
   - EXACTLY ONE attribution note, forward-phrased: "Attribution by market
     growth vs. contributions arrives with historical valuation." NEVER label
     rows as Market Growth/Contributions/Income/Spending/Fees (A9 slot contract:
     rows are generic {id,label,delta} so A9 swaps the source without redesign);
   - honest states: no compareTo ⇒ the existing NO_COMPARE message; flat ⇒
     "essentially flat" message (reuse current copy).
3. Colocated tests for the ledger math + single-note rule.
Validation: tsc/lint/tests green (components may be temporarily unreferenced —
that is expected this slice).
Forbidden: WealthPerspective.tsx, WealthNetWorthChart/TrendChart, KpiStrip/
ChangeCards (deleted in S8, untouched here), shell files, read model.
```

### S7 — WealthTrendChart upgrade (the dominant chart)

```
Implement Slice S7 (plan §4.2). Depends on merged S5. ONE FILE: rename/upgrade
components/space/widgets/wealth/WealthNetWorthChart.tsx →
wealth/WealthTrendChart.tsx (update its own imports/exports; WealthPerspective
still imports the old name until S8 — keep a re-export shim from the old path
so nothing breaks, removed in S8).

Preserve (regression-critical): points only at real snapshots; visible gaps;
hollow dashed isEstimated markers; As Of solid guide + Compare To dashed guide;
click/tap dot ⇒ onSelectAsOf; the honest legend + "Gaps between points are
real" note; vectorEffect non-scaling strokes.

Add:
1. Height: ~360–420px desktop (grid-driven), ~260px mobile — the page's
   unmistakable center (Amendment 6 authorizes exceeding the concept's
   proportion).
2. Low-alpha Meridian area fill under the PRIMARY series only (no fill under
   overlays; fill must not bridge gaps — segment the path at gaps).
3. Minimal axes: 3–4 y-ticks (--text-faint, tabular-nums, compact currency) +
   hairline gridlines; x-axis month labels appropriate to window length.
4. Hover/touch tooltip: date · value · "Reconstructed" when isEstimated;
   pointer-follow on desktop, touch-drag scrub on mobile; replaces title-attr
   tooltips (keep aria-labels).
5. Compare overlay: render result.chart.compareSeries (S5) as a dashed
   --text-faint series time-aligned by OFFSET (its window maps onto the primary
   window's x-range so shapes superimpose — the concept's two-line read);
   legend row "Compare period" appears only when the series is non-empty.
6. Metric switcher [Net Worth | Assets | Liabilities | Liquid NW]: small
   segmented control in the card header driving which WealthChartPoint field
   renders (both series); goodDirection semantics for liabilities (down=good)
   affect only tooltip/label coloring, not geometry; switcher choice is
   surfaced via an injected callback so S8 can URL-sync it (metric param).
Hard rules: no smoothing, no interpolation across gaps, no invented continuity;
empty compareSeries ⇒ no overlay and no legend row.
Validation: browser checks — gaps/hollow markers/dot-click all still work;
tooltip on touch; overlay only when honest; tsc/lint/tests green.
Forbidden: every other wealth file, shell files, read model, SpaceDashboard.
```

### S8 — Wealth integration: composition modes, Explanation, recompose, host wiring

```
Implement Slice S8 (plan §4.4–4.5, §5–7). Depends on merged S2, S6, S7. This is
the integration slice — the only slice allowed to edit WealthPerspective.tsx
and the last to touch SpaceDashboard.tsx.

1. Edit wealth/WealthCompositionCard.tsx — modes (Amendments 8–9):
   - header mode switcher: By class (default) · By institution · By account ·
     Concentration; desktop = small segmented control in the card header;
     mobile = trigger opening a bottom sheet (existing overlay primitives);
   - By class: current historical doughnut behavior UNCHANGED (BreakdownWidget,
     epsilon-filtered wealthCompositionItems, Reconstructed badge, liabilities
     kept separate below);
   - institution/account/concentration: reuse the existing registered renderers
     behind these widgets; each carries a permanent section-level label
     "Current classification" (these read live accounts — never present them as
     belonging to a historical As Of date);
   - when compareTo is set, per-class delta chips beside legend rows from
     deltas.composition;
   - taxonomy audit: confirm no user-facing string in wealth/** says "Real
     Assets"/"Real Estate" for the physical-asset class — it must render "Real
     World Assets" via WEALTH_CATEGORY_LABELS. Do NOT add an "Other" category
     (reserved slot; the snapshot residual cannot honestly split — plan §4.4).
     Do NOT rename any backend enum/column.
2. Create wealth/WealthExplanationCard.tsx replacing WealthStoryCard:
   - title "Explanation" (Amendment 10); body = result.explanation (deterministic
     template — no LLM, no speculation, no advice, no causal attribution);
   - extend the template ONLY within supported facts: when one driver's |Δ|
     exceeds half the net change, append "driven mostly by ⟨label⟩ (⟨signed
     amount⟩)" — pure, tested in the read model? NO — keep the read model
     frozen; compute the dominant-driver clause presentationally from
     result.drivers (already |Δ|-sorted) in this component, template-only;
   - footer link "View explanation and evidence" opening the S4 EvidenceDrawer
     (injected callback);
   - remove the duplicated attribution note (the ledger owns the single note).
3. Recompose wealth/WealthPerspective.tsx to the five surfaces (plan §5):
   ① WealthHero (4 cols) + ② WealthTrendChart (8 cols) / ③ WealthChangeLedger
   (6) + ④ WealthCompositionCard (6) / ⑤ WealthExplanationCard (12). Mobile
   stacks ①→⑤. Remove the S7 re-export shim; import WealthTrendChart directly.
4. Delete wealth/WealthKpiStrip.tsx and wealth/WealthChangeCards.tsx (their
   content now lives in Hero/Ledger). Sparkline remains in wealth-ui.tsx
   (unused on this page — do not delete from the kit).
5. Edit SpaceDashboard.tsx (final wiring): pass onSwitchLens (sets the active
   perspective — shell state untouched), the evidence-drawer opener, and URL-
   sync the chart metric param (wealth only) through the S1 hook's mechanism.
6. Page-level assertions to verify manually: net worth is a headline exactly
   once; exactly one attribution note; every number renders once as a headline.
Validation: FULL browser checklist (§12 items 1–13); tsc/lint/tests green;
deleted components have zero remaining imports (grep).
Rollback: reverting this commit restores the previous composition wholesale.
Forbidden: shell-time.ts, wealth-time-machine.ts (frozen), cash-flow.ts,
prisma/anything per the global rules.
```

### S9 — Responsive & polish validation pass

```
Implement Slice S9 (plan §6, §12). Depends on merged S8. Scope: responsive
class/spacing adjustments confined to components/space/shell/** and
components/space/widgets/wealth/** — NO structural changes, NO new components,
NO logic edits.

Work through the responsive-validation checklist (plan §12) at 375 / 768 /
1280px and fix only what it surfaces:
1. No horizontal page overflow anywhere (only the preset track and tab rail
   scroll, within their own bounds).
2. Preset track: to-date group first, divider, rolling group second, order
   intact, scrollable, active segment visible on load.
3. Tab rail scrolls; no <select> in the shell; active lens reachable.
4. Sticky condensed context line: sticks without jitter/overlap; if it cannot
   be made calm, remove stickiness (allowed degrade) and note it.
5. Mobile narrative order ①→⑤; hero legible; touch tooltip scrubs; dot targets
   ≥44px; composition bottom sheet opens/dismisses with focus restore.
6. Tablet: intended intermediate grid (hero above chart; ③/④ stacked), no
   orphaned half-width cards.
7. Keyboard/AT sweep: tablist arrow nav, labeled date fields, Escape closes
   popover/drawer/sheet, focus restored.
Then run the FULL browser checklist once more end-to-end and record results in
the PR description (checklist as checkboxes).
Validation: tsc/lint/tests green; screenshots at all three widths attached.
Forbidden: everything outside shell/** and wealth/** styling.
```

---

## 14. Deferred upgrades (explicit, with landing sites)

| Arrives with | Deferred capability | Pre-built landing site in this design |
|---|---|---|
| **A8** (historical prices/valuation) | Pre-snapshot reconstructed chart segments; finer completeness reasons ("prices reconstructed for 3 holdings") | TrendChart's hollow-marker vocabulary; CompletenessPopover detail string |
| **A9** (wealth regeneration) | True attribution rows (Market Growth / Contributions / Income / Spending / Fees) replacing composition deltas; deletion of the single attribution note; historical composition band mode; quantified completeness ("Observed 97%") and a real "Other"/Real-World-Assets split | ChangeLedger's generic `LedgerRow[]` slot; Composition mode slot; CompletenessChip label (tier → percentage swap); §4.4 reserved "Other" category |
| **A10** (Investments Time Machine) | Investments lens joins the shell historically; Wealth's Investments ledger row drills into the Investments lens; per-holding evidence rows | Envelope registry entry swap; `drillTarget` on ledger rows; EvidenceDrawer generic row model |
| **A11** (Timeline & Simulation) | Derived-event milestone markers on the trend axis; playback (animated As Of); simulation as a labeled alternate shell context | TrendChart marker-layer slot (renders nothing today); the shell reducer is already a scrubber target; envelope tone variant for "simulated" |
| **A12** (Conversation layer) | "Explain this" conversational entry; deep-links driving shell state; LLM narration *of* deterministic numbers | The "View explanation and evidence" slot; the URL contract (perspective/asOf/compareTo/preset/metric); Explanation stays the deterministic ground truth A12 cites |

None of these require redesigning the shell, the five Wealth surfaces, or the time model — that absorption capacity is the design's acceptance test for P6.

## 15. Definition of done

The redesign is **done** when all of the following hold on `feature/v2.5-spaces-completion`:

1. **One object:** switching any of the six lenses changes only the workspace; As Of, Compare To, active preset, Completeness, Evidence, and Space context visibly persist; the shell never remounts or flashes (browser check 6 passes on video or reviewer attestation).
2. **One time model:** `{preset, asOf, compareTo}` is the only time state; every §3.2 derivation and §3.3 transition passes unit tests; the highlighted preset never disagrees with the date pair (invariant test green); default entry state is MTD / today / first-of-month; the rolling group reads 1W · 1M · 3M · 6M · 1Y · ALL with the to-date group far left and rolling far right, unmerged, on all form factors.
3. **The shell reads as two framed containers** matching §2, sticky (or documented degrade), with one active-state grammar throughout, and interactive Completeness/Evidence backed only by real detail — fixed vocabulary, no percentages, no fake counts.
4. **Wealth is five surfaces** in the fixed narrative order on desktop and mobile; net worth is a headline exactly once; zero sparklines on the page; the trend chart is the unmistakable visual center with overlay/tooltip/axes/markers/gaps/hollow-markers/dot-click/metric-switcher all functioning; the ledger reconciles to the hero delta with exactly one attribution note; composition renders the earned taxonomy (no zero-value slices, liabilities separate, "Current classification" labels on live-data modes); "Explanation" is the label and its content is deterministic.
5. **URL round-trip:** a copied Perspectives URL restores Space, tab, perspective, As Of, Compare To, preset/Custom, and metric.
6. **Honesty holds under adversarial states:** pre-coverage As Of, estimated snapshots, cleared comparison, and empty windows all render shaped honest states — no zeros-as-facts, no interpolation, no fabricated categories (browser check 13).
7. **Hygiene:** `tsc`, lint, and the full test suite green; both validation checklists recorded in the final PR; every slice landed as its own revertable commit in the §9 merge order; `git log` shows no slice touched a forbidden file; no Prisma/schema/migration/import/price/valuation/regeneration change exists anywhere in the diff.

---

*End of amended plan. Planning deliverable only — no code was written, no files modified, no components created, no migrations added, nothing committed.*
