# Fourth Meridian — Perspective Shell + Wealth Experience Redesign Investigation

**Date:** 2026-07-12
**Type:** Architecture & UX investigation only. No code written, no files modified, no components created, nothing committed.
**Scope begins:** the moment the user clicks **Perspectives** inside a Space. The Space rail (Overview / Perspectives / Activity / Accounts / Transactions / Members) is out of scope and correct as-is.
**Reference:** the attached concept screenshot is treated as directional inspiration, not a pixel spec.
**Governing principle carried forward from the Time Machine work:** *"Did the data earn this?"* — nothing in this design may present a number the engine cannot honestly produce at the time it ships.

---

## 0. Grounding — what actually exists today

Verified against the working tree:

| Piece | File | Reality |
|---|---|---|
| Shell Row 1 (As Of / Compare To / Completeness / Evidence) | `components/space/SharedHistoricalContext.tsx` (171 lines) | Presentation-only flex row: two native `<input type="date">` fields + two read-only `ShellChip`s |
| Shell Row 2 (time presets) | `components/space/widgets/CashFlowPeriodSelector.tsx` | Two Atlas `SegmentedControl`s: left `WTD·MTD·QTD·YTD`, right `1W·1M·1Q·1Y·All` (ids/labels from `lib/transactions/cash-flow.ts`) |
| Shell Row 3 (Perspective tabs) | `PerspectiveTabSelector` inside `components/dashboard/SpaceDashboard.tsx:1918` | 2×3 pill grid (md+), plain `<select>` on narrow screens |
| Shell state | `SpaceDashboard.tsx:2598–2625` | `asOf`, `compareTo`, `cashFlowPeriod` are three `useState`s inside the 3,519-line host; only `tab` + `perspective` sync to the URL |
| Wealth read model | `lib/wealth/wealth-time-machine.ts` (289 lines, pure, tested) | `computeWealthTimeMachine` → `WealthResult` (asOfState, compareState, deltas, drivers, chart, completeness, evidence, story) |
| Wealth workspace | `components/space/widgets/wealth/` | `WealthPerspective` composes: `WealthKpiStrip` (4 cards) → editorial grid (`WealthChangeCard`, `WealthNetWorthChart`, `WealthCompositionCard`, `WealthDriversCard`) → full-width `WealthStoryCard` |
| Perspective library | `lib/perspectives.ts` | `PERSPECTIVE_LIBRARY` + per-category ordering; Wealth/CashFlow/Liquidity/Debt/Goals/Investments have workspaces |
| Trust vocabulary | `WealthResult.completeness` | `observed / derived / incomplete` tiers with shell-ready labels ("Observed", "Reconstructed", "No history before …") |

Two vocabulary notes used throughout this document:

- **"Shell"** = Rows 1–3 above plus the state they carry (`asOf`, `compareTo`, `period`).
- **"Envelope"** = the per-perspective `{completeness, evidence}` summary the shell displays.

---

## 1. UX critique of the current Perspective shell

The architecture underneath the shell is right — one shared `FinancialContext`, perspectives as pure consumers — but the *presentation* undersells it, and three structural seams leak through.

**1.1 The shell doesn't read as one object.** Rows 1, 2, and 3 are three unrelated-looking strips stacked with `space-y-4`: a bare flex row of date inputs and chips, then two floating segmented controls, then a borderless pill grid. Nothing visually communicates "this is the permanent frame; everything below is the lens." The concept screenshot gets this exactly right: the time/trust row sits inside one bordered container, and the tabs sit in a second container directly beneath it. Today a user cannot tell that As Of governs every tab — it looks like page furniture that happens to be above the tabs.

**1.2 The shared time control still wears Cash Flow's name.** Row 2 *is* the shell's time preset row, but it is `CashFlowPeriodSelector`, typed as `CashFlowPeriod` from `lib/transactions/cash-flow.ts`, defaulting to `DEFAULT_CASH_FLOW_PERIOD`. The comment in `SpaceDashboard.tsx:3168` already admits these "belong to the shell, not to any one Perspective." The naming is not cosmetic: any perspective that wants the shared window must import from `lib/transactions/`, which is the wrong dependency direction and will get worse as A8–A10 land.

**1.3 Two time models coexist without a stated relationship.** The shell carries *both* a point-in-time pair (`asOf`, `compareTo`) and a rolling window (`period`), and they never touch: presets window the Wealth chart but never move As Of or Compare To; picking a Compare To date doesn't highlight or clear a preset. A user who taps `YTD` and then wonders why "vs Jan 1" doesn't appear in the KPI deltas has discovered the seam. The read model even documents it ("the shared range only windows the historical chart; it never redefines the point-in-time cards") — correct engineering honesty, but unresolved UX.

**1.4 Completeness and Evidence are dead ends.** The `ShellChip`s are read-only text with a `title` tooltip. Evidence says "31 snapshots" with nothing to click; Completeness says "Observed" with no way to ask *what was observed and what wasn't*. The concept shows the right ambition: a confidence framing ("Observed 97% · High Confidence") and a **View details** affordance. The repo already owns the drill-down primitive (`TransactionSliceDrawer` as the shared evidence drawer pattern, per the Cross-Perspective TM investigation §10) — the chip just never opens anything.

**1.5 The envelope is hardwired to Wealth.** `SpaceDashboard.tsx:3160–3165` populates Completeness/Evidence only when `wealthWorkspaceActive`; every other tab shows "—". Cash Flow *could* state "Complete within transaction depth"; Liquidity and Debt have lens provenance today. The shell needs a per-perspective envelope contract, not a ternary naming one perspective.

**1.6 Shell state is trapped in the host and not shareable.** `asOf`/`compareTo`/`period` are `useState`s in `SpaceDashboard`; the URL-sync effect (line ~2566) persists only `tab` and `perspective`. Reloading, sharing a link, or navigating away loses the time context — fatal for a product whose core promise is "look at this date." There is also no dedicated shell component owning the contract; the 3,519-line host is the shell.

**1.7 Small frictions.** No swap affordance between As Of and Compare To (the concept has one). Native date inputs offer no "quality of target" hint (you can pick a date with no coverage and only find out per-card). Tab pills use a flat `--accent-info` fill while Row 2 uses the Meridian-glass SegmentedControl — two different "active" grammars within one shell. On mobile the tabs collapse to a `<select>`, which is honest but breaks the "rotating one object" feel entirely.

---

## 2. UX critique of the current Wealth page

The A6 Wealth workspace is already question-first — the five card titles literally are the questions — and its honesty discipline is exemplary. The problems are redundancy, chart weakness, and lost composition depth.

**2.1 Net worth appears four times.** The KPI strip's first card, `WealthChangeCard`'s 3xl headline, the chart's right-slot value, and the story sentence all restate the same number. The delta appears three times (KPI badge, ChangeCard badge, story text). This is the classic symptom the prompt names: cards, not analysis.

**2.2 `WealthChangeCard` and `WealthDriversCard` are 80% the same card.** ChangeCard shows net worth + delta + top-3 drivers; DriversCard shows all drivers + the same attribution note. Two surfaces answer "what changed?" with overlapping content, and the `ATTRIBUTION_NOTE` ("Detailed attribution … isn't available yet") is stamped on up to three cards at once — honesty degrading into wallpaper.

**2.3 The chart is honest but not primary.** `WealthNetWorthChart` is a hand-rolled polyline: no axis labels, no gridlines, no hover tooltip (only `title` attributes on dots), no area fill, fixed 220px height, and — most importantly vs the concept — **no comparison series**. The concept's chart carries two lines (current range vs compare range) and is unmistakably the page's center of gravity. Ours occupies the center cell but has less visual information than the KPI sparklines around it.

**2.4 Sparkline redundancy.** Each of the four KPI cards renders a sparkline of the *same shared range* the main chart draws. Four miniature charts orbiting one large chart of the same data is density without information.

**2.5 Composition lost depth in the A6 cutover.** The pre-A6 Wealth workspace (`lib/perspectives.ts:103`) rendered `asset_allocation`, `wealth_by_account`, `institution_allocation`, and `wealth_concentration`. `WealthPerspective` replaced that stack with a single as-of asset-class donut. Historically honest — the snapshot only carries class totals — but institution allocation, account-level breakdown, and concentration analysis vanished from the Wealth lens rather than becoming drill-downs. (They still exist as registered widgets; they're simply unreachable from Wealth.)

**2.6 The story is a caption, not a narrative.** `WealthStoryCard` renders one or two deterministic sentences that restate the deltas already shown twice above it, plus the attribution disclaimer again. It occupies a full-width row for content that today earns two lines. The concept's equivalent ("What's the story behind the change?") works because it *adds* framing ("primarily due to… partially offset by…") and links onward to evidence — ours repeats.

**2.7 What is genuinely good and must be kept.** Question-led card titles; the click-a-dot-to-set-As-Of interaction (chart → shell feedback loop — this is the "rotating the object" feel, already built); real-gaps-stay-visible plotting; hollow markers for reconstructed snapshots; shaped unavailable states everywhere; liabilities shown separately from the assets donut; the pure read model that makes all of this testable. None of this should be regressed by the redesign.

---

## 3. Analysis of the attached concept

What the concept gets right, what it gets wrong for this codebase, and what it silently assumes.

**3.1 Right — and adoptable now.**

- **One framed shell above one framed tab row.** The single strongest idea: As Of / Compare To / Completeness / Evidence live in a visually distinct permanent container. Costless to adopt.
- **Compare-to swap affordance** (the ⇄ icon). Trivial, high-utility.
- **Question-led sections.** Already our doctrine; the concept validates the A6 direction.
- **Chart as the dominant center with the hero number to its left.** Matches our grid, executed with more conviction (two series, filled area, axis labels).
- **"Where did this change come from?" as a signed ledger** (Market Growth +18,420 / Contributions +7,300 / Spending −4,560 / Net Change). This is the right *shape* for our drivers card — a small attribution table with a net line.
- **Evidence with a count and "View details."** Confirms the drawer direction.

**3.2 Wrong for us — explicitly rejected.**

- **The left sidebar** (Overview / Perspectives-with-children / Timeline / Simulation / Reports / Documents / Settings). The prompt keeps the Space rail and the tab model; the sidebar is rejected wholesale. Timeline and Simulation (A11) will arrive as capabilities, not nav destinations copied from this mock.
- **"Family Office" framing and any renaming.** Vocabulary stays per `fourth-meridian-product-language.md` (Space, Perspective, Snapshot).

**3.3 Not yet earned — designed for, but honestly degraded until the architecture arrives.**

- **Market Growth vs Contributions vs Income vs Spending vs Fees attribution.** The concept's most seductive element. Today's snapshots cannot decompose this (the read model says so; the Cross-Perspective investigation §4C rates decomposition "High — defer"). It becomes real only after A8 historical prices + A9 wealth regeneration (positions × prices ⇒ market effect; flows ⇒ contributions). The design must ship the *slot* — a driver ledger fed by composition deltas now, upgraded to true attribution later — never fabricate the numbers.
- **"Completeness 97% · High Confidence."** A quantified completeness score requires a defined denominator (what fraction of accounts/dates/values are observed vs derived). Our tier model (`observed/derived/incomplete`) is the honest current form. A percentage is adoptable post-A9 when regeneration knows coverage per day; until then the label + tone is what the data earned.
- **"128 sources."** Today Evidence = snapshot count. Post-A7/A8, evidence becomes observations + imports + price points — a real count with a real drawer. Design the chip to accept any `{label, count?, detail}`.
- **Two-line comparison chart.** *Partially* earned now: we can overlay the compare point and shade the delta; a full second series ("the same range, one year earlier") is cheap to compute from snapshots and is earned — this one should come early.
- **"12.1% return across all investments."** Pure A10 territory. Not before the Investments Time Machine.

**3.4 Silent assumptions to reject.** The concept assumes history is continuous (its line has no gaps) and everything is always known (no reconstructed/estimated markers anywhere). Our chart's honest gaps and hollow markers are a *feature* the concept lacks — keep them.

---

## 4. Proposed Perspective Shell architecture

### 4.1 The shell becomes a real component with a real contract

Extract from `SpaceDashboard` into a dedicated `components/space/shell/` family:

```
PerspectiveShell                        — the permanent frame (one glass container)
├── ShellContextRow                     — As Of · ⇄ · Compare To · Completeness · Evidence
│   ├── AsOfControl                     — date field + coverage hint
│   ├── CompareToControl                — date field + swap + clear
│   ├── CompletenessChip                — tier label + tone (opens detail popover)
│   └── EvidenceChip                    — label + count (opens evidence drawer)
├── ShellPresetRow                      — LEFT [WTD MTD QTD YTD] · RIGHT [1W 1M 1Q 1Y All]
│   └── (two SegmentedControls — layout unchanged, presentation refined, §6/§9)
└── PerspectiveTabs                     — Wealth · Liquidity · Debt · Cash Flow · Investments · Goals
```

State moves behind one hook, `usePerspectiveShellState(spaceId)`, owning a single reducer-shaped object:

```ts
interface ShellTimeContext {
  asOf: string;               // YYYY-MM-DD, ≤ today
  compareTo: string | null;
  period: SharedPeriod;       // the preset window (chart/flow range)
  presetLink: "window" | "window+compare";   // §4.3
}
```

`SpaceDashboard` consumes the hook and passes the context down exactly as it threads `wealthResult` today — the host shrinks, the contract firms up, and nothing about data flow changes.

### 4.2 Per-perspective envelope contract (kills the Wealth ternary)

Every workspace-backed perspective supplies an envelope the shell renders:

```ts
interface PerspectiveEnvelope {
  completeness?: { tier: "observed"|"derived"|"estimated"|"incomplete";
                   label: string; tone: "neutral"|"positive"|"warning"; detail?: string };
  evidence?:     { label: string; count?: number; onOpenDetail?: () => void };
}
```

Sourcing today, with zero new computation: Wealth → `wealthResult.completeness/evidence` (already exists); Liquidity/Debt → the `perspective-engine` `LensResult` provenance (`dataAsOf`, `assumptions[].source`, `estimated`) mapped to a tier; Cash Flow → "Complete within transaction depth (since {earliest tx})"; Investments → honest `incomplete` ("Current holdings only — history arrives with the Investments Time Machine"); Goals → neutral. The shell renders whichever envelope the *active* perspective supplies, placeholder otherwise — same honest fallback as today, minus the hardcoding.

This is the same envelope A5's `ComputeOptions.asOf` work anticipated; it is the UI face of the completeness stamp the Cross-Perspective investigation named the single highest-value ontology addition.

### 4.3 Reconciling the two time models — one rule, stated in the UI

Keep both models (they are both correct), but define their relationship instead of leaving it implicit:

- **As Of** = the anchor. The preset window always *ends* at As Of (today: `periodRange(period, today)` — it should take `asOf` as its reference date, which also makes presets meaningful when viewing the past).
- **Presets** = the window (chart range, Cash Flow range). Unchanged placement, unchanged groups.
- **The link (new):** an unobtrusive toggle/inline action on the preset row — "compare to start of period." When enabled (`presetLink: "window+compare"`), tapping `YTD` also sets `compareTo` = Jan 1; tapping `1M` sets `compareTo` = one month before As Of. When the user hand-picks a Compare To date, the link disengages (chip shows the custom date). This turns the seam in §1.3 into a feature: one tap answers "how did YTD go?" across every card, which is precisely the concept screenshot's default state (`As of Jul 11, 2026 · Compare to Jan 1, 2025`).

Explicit non-goal: presets never *move* As Of. As Of moves only via its own control or the chart-dot click.

### 4.4 URL as the shell's memory

Serialize `asOf`, `compareTo` (when set), and `period` into the existing query-param sync alongside `tab`/`perspective`. A Perspectives link becomes a complete, shareable financial question: *"this Space, Wealth lens, as of Jul 11, compared to Jan 1, YTD window."* This is also the seam A11 (Timeline) and A12 (conversation deep-links: "show me March") will drive.

### 4.5 What the shell must never do

No computation (it stays presentation + state); no per-perspective branches beyond rendering the supplied envelope; no future dates; no fabricated envelope values (absent stays "—"). Perspectives may *read* the context and *supply* an envelope — never write shell state, with the single sanctioned exception of the existing `onSelectAsOf` chart-dot callback.

---

## 5. Proposed Wealth information architecture

Five surfaces, one narrative spine, replacing today's ten (4 KPI + 5 cards + story). Every section is an *answer*; reading top-to-bottom is reading the analysis.

```
① HERO — "How wealthy am I?"
   Net worth (one large number, once) · delta badge vs Compare To · confidence
   inline ("Observed" / "Reconstructed") · compact secondary metrics:
   Assets · Liabilities · Liquid NW (numbers + deltas, NO sparklines)

② TREND — "How has my net worth changed?"        ← the dominant surface
   Upgraded chart: area fill, axis labels, hover tooltip, As Of + Compare markers,
   compare-period overlay series, honest gaps + hollow reconstructed markers kept,
   click-dot-sets-As-Of kept

③ CHANGE — "Where did this change come from?"
   ONE card (merges WealthChangeCard + WealthDriversCard): signed driver ledger
   with a Net Change total row (concept's shape). Today fed by composition deltas
   (Investments / Cash / Real World Assets / Liabilities); post-A9 fed by true
   attribution (Market Growth / Contributions / Spending / Fees). ONE attribution
   caveat, stated once, here only.

④ COMPOSITION — "What is my wealth composed of?"
   As-of donut (kept) + mode affordance: By class (now) · By institution ·
   By account · Concentration — the widgets lost in the A6 cutover return as
   modes/drill-downs, clearly labeled "current classification" where they
   cannot yet be historical (§11). Historical composition band arrives post-A9.

⑤ STORY — "What's the story behind the change?"
   Full-width narrative footer: the deterministic template sentence (kept),
   plus "View full explanation and evidence →" opening the evidence drawer.
   This line is the A12 conversation layer's future doorway.
```

Ordering rationale: number → shape of change → cause of change → structure → narrative. The comparison model (§ COMPARISON in the prompt) threads through all five: ① states the delta, ② shows it, ③ decomposes it, ④ can diff structure (compare-mode donut deltas later), ⑤ narrates it — each section answering *what changed / by how much / why / on what evidence* without repeating the others' content.

What gets deleted: the standalone KPI strip (absorbed into ①), `WealthChangeCard` (absorbed into ① + ③), the four KPI sparklines (the trend surface is ②), two of the three `ATTRIBUTION_NOTE` repetitions.

---

## 6. Desktop layout recommendation

Target feel: Bloomberg's density discipline, Linear's calm chrome, Arc/Apple-Finance restraint — achieved with the existing Atlas/Liquid vocabulary (glass panels, hairline borders, tabular numerals, Meridian accent), not a new language.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ SHELL (one GlassPanel, hairline border — the permanent frame)            │
│  As of [Jul 11 2026]  ⇄  Compare to [Jan 1 2025 ×]    Completeness ▸ Evidence ▸ │
│  [WTD MTD QTD YTD]                                  [1W 1M 1Q 1Y All]    │
├──────────────────────────────────────────────────────────────────────────┤
│ TABS (second frame, directly beneath — SegmentedControl grammar)         │
│  ● Wealth   Liquidity   Debt   Cash Flow   Investments   Goals           │
├──────────────────────────────────────────────────────────────────────────┤
│ WORKSPACE (12-col grid)                                                  │
│ ┌─────────────┐ ┌───────────────────────────────────────────────────┐    │
│ │ ① HERO      │ │ ② TREND — dominant chart                         │    │
│ │ (4 cols)    │ │ (8 cols, ~320px, area + compare overlay)          │    │
│ └─────────────┘ └───────────────────────────────────────────────────┘    │
│ ┌───────────────────────────┐ ┌─────────────────────────────────────┐    │
│ │ ③ CHANGE — driver ledger │ │ ④ COMPOSITION — donut + modes       │    │
│ │ (6 cols)                  │ │ (6 cols)                            │    │
│ └───────────────────────────┘ └─────────────────────────────────────┘    │
│ ┌───────────────────────────────────────────────────────────────────┐    │
│ │ ⑤ STORY — narrative + "View full explanation and evidence →"     │    │
│ └───────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

Treatment decisions:

- **Chart-first:** ② gets ~2× today's height (≈320px vs 220px) and two-thirds of the top band's width. It is the only chart on the page above the fold besides the donut — sparklines gone.
- **KPIs smaller, prose richer:** the hero's secondary metrics are single-line rows (label · value · delta), not cards. Reclaimed space goes to the driver ledger and story.
- **Section rhythm:** consistent `rounded-2xl` + `--surface-inset` + `--border-hairline` card shells (already `WealthCard`'s recipe); one spacing unit between bands; question titles at the same weight everywhere (`text-sm font-semibold`).
- **Hover behavior:** chart tooltip (date · value · tier); driver rows highlight and offer drill-down to the evidence drawer scoped to that component; donut segments cross-highlight legend rows.
- **Progressive disclosure:** Completeness/Evidence chips open popover/drawer instead of demanding page space; composition modes hide institution/account/concentration depth behind one affordance; the story links onward instead of inflating.

---

## 7. Mobile layout recommendation

Preserve the analytical *sequence*, compress the chrome:

1. **Shell collapses to two lines, stays sticky-adjacent:** line 1 = `As of Jul 11 ⇄ vs Jan 1 · ● Observed` (dates open native pickers; the trust dot opens the completeness popover; Evidence lives inside it on mobile). Line 2 = the preset row, horizontally scrollable via SegmentedControl's existing overflow handling — left group leading, right group trailing, same split, one swipeable track.
2. **Tabs stay tabs.** Replace the current `<select>` with the same SegmentedControl in scrollable mode (6 segments, Wealth leading). A picker breaks lens-rotation; a swipeable rail keeps it.
3. **Workspace stacks in narrative order** ① → ② → ③ → ④ → ⑤, full-width. The chart keeps ~240px height with the tooltip driven by touch-drag; dot-tap still sets As Of (the touch targets already exist — `p-1 -m-1` hit area).
4. **Composition modes become a bottom-sheet** (existing `OverlaySurface`/modal patterns) rather than inline tabs.
5. Hero shows net worth + delta + confidence; the three secondary metrics render as one compact three-column row beneath it.

Nothing on mobile is a different *information* architecture — only a different density.

---

## 8. Widget consolidation recommendations

| Today (10 surfaces) | Proposed (5) | Disposition |
|---|---|---|
| KPI card: Net Worth | ① Hero headline | Merged |
| KPI card: Total Assets | ① Hero secondary row | Demoted from card to row |
| KPI card: Total Liabilities | ① Hero secondary row | Demoted |
| KPI card: Liquid Net Worth | ① Hero secondary row | Demoted; cross-link "→ Liquidity" (lens hand-off, not duplication) |
| 4× KPI sparklines | — | **Deleted** (redundant with ②) |
| `WealthChangeCard` ("How wealthy am I?") | ① headline + ③ ledger | **Deleted as a card**; its content splits |
| `WealthNetWorthChart` | ② Trend | Upgraded (axis, tooltip, area, compare overlay) |
| `WealthCompositionCard` | ④ Composition | Kept; gains modes |
| `WealthDriversCard` | ③ Change ledger | Merged with ChangeCard remnants; gains Net Change total row |
| `WealthStoryCard` | ⑤ Story | Kept; gains evidence link; loses duplicate attribution note |
| *(unreachable since A6)* `institution_allocation`, `wealth_by_account`, `wealth_concentration` | ④ modes / drill-downs | **Restored** behind progressive disclosure, honestly labeled current-classification until A9 |

Net effect: every number appears exactly once as a headline; the attribution caveat appears exactly once; the read model (`WealthResult`) already carries everything the five surfaces need — **this consolidation requires no read-model changes**, only presentation.

---

## 9. Chart recommendations

**② Trend (primary).**
- Keep the honest skeleton: points only at real snapshots, visible gaps, hollow dashed markers for `isEstimated`, As Of / Compare To vertical guides, click-to-set-As-Of.
- Add: subtle area fill under the line (Meridian-tinted, low alpha); a minimal y-axis (3–4 tick labels, `--text-faint`, hairline gridlines); an x-axis of period-appropriate month labels; a hover/touch tooltip (date · net worth · "Reconstructed" when applicable) replacing `title` attributes.
- Add the **compare overlay**: when `compareTo` is set, render the equivalent-length window ending at Compare To as a dashed secondary series (`--text-faint`), matching the concept's two-line read. Earned today — it is the same snapshot series, re-windowed.
- Metric switcher (Net Worth / Assets / Liabilities / Liquid) as a small inline control — the chart data (`WealthChartPoint`) already carries all four; this replaces the four sparklines with one interaction.
- Implementation posture: the hand-rolled SVG has served honesty well (gaps and hollow markers are hard to force through chart libraries); upgrading it beats replacing it.

**③ Change ledger.** Not a pie, not bars-for-decoration: a signed ledger table (label · signed amount, red/green per `driverGood` semantics — liabilities down is good) with a hairline-separated **Net Change** total row. Optionally a compact horizontal waterfall strip above it post-A9 when categories become flows (Market Growth → Contributions → Spending → Fees → Net). Waterfalls of composition deltas today would over-promise causality — deltas are not flows; hold the waterfall until attribution is real.

**④ Composition.** Keep the `BreakdownWidget` donut for as-of class composition; liabilities stay outside the donut (current treatment is correct and better than the concept, which hides liabilities entirely). Compare-mode: when `compareTo` is set, show per-class delta chips beside legend rows (computed in `deltas.composition` already). Post-A9: a stacked area/band "composition over time" as an alternate view within ④ — designed now as a mode slot, not built.

**① Hero.** No chart. Numbers, deltas, one confidence chip.

**Sparklines** (`wealth-ui.tsx` `Sparkline`) remain in the shared kit for use where no primary chart exists (e.g., other perspectives' cards) — just not on this page.

---

## 10. Storytelling recommendations

The page should read as one narrative told once: **state → change → cause → structure → story.**

- **The story stays deterministic and template-based** (current `story` composer) until A12. No LLM prose in the Wealth surface before the conversation layer, and even then: A12 *explains* the deterministic numbers, it never generates them.
- **Grow the template vocabulary as facts become available**, keeping the "only supported facts" rule: add the largest driver when one exceeds ~half the net change ("driven mostly by Investments, +$18,420"); add coverage framing when the range clips coverage ("since your history begins Mar 3"); post-A9, the sentence upgrades itself to true attribution ("primarily market growth (+$18,420) and contributions (+$7,300), partially offset by spending (−$4,560)") — the concept's sentence, earned.
- **One caveat, once.** The attribution disclaimer lives only in ③, phrased forward-looking ("Attribution by market growth vs. contributions arrives with historical valuation") rather than apologetic, and disappears the day A9 lands.
- **Every claim links to its evidence.** The story's "View full explanation and evidence →" opens the evidence drawer listing the snapshots (later: observations, imports, prices) behind the numbers. This link is deliberately the same UI slot A12's "explain this" conversation entry will occupy — the doorway ships years before the room.
- **Voice:** per the product-language guide — calm, specific, declarative; "reconstructed," "no history before…," never tier jargon.

---

## 11. Honesty / evidence presentation recommendations

The trust system's content is right; its *placement* needs a hierarchy so it informs without wallpapering.

**Three levels, each stated once:**

1. **Shell level (global):** the Completeness chip = worst tier among the active perspective's contributors + short label ("Observed" / "Reconstructed" / "No history before Mar 3"). Clicking opens a popover with the one-line reason per the Cross-Perspective §9 stamp ("Cash reconstructed from transactions; investments held at recent prices; 2 accounts have no history before Apr 3"). The Evidence chip = count + "View details" → drawer.
2. **Section level (exceptions only):** a section carries a badge only when its status *differs* from the shell stamp — the composition card's "Reconstructed" badge when that snapshot is estimated, the chart's hollow markers, "held at current classification" on institution/account modes (which read live accounts, not historical snapshots — this must be labeled or those modes would silently break the time machine promise). If the section matches the shell, it says nothing.
3. **Value level (visual, not textual):** hollow/dashed markers, gap rendering, em-dashes for unavailable values. Never a paragraph.

**Vocabulary (user-facing, fixed):** Observed · Reconstructed · Estimated · No history before … · Held at current value/classification. Internal tier names never render.

**Rules:** estimated/incomplete values are never summed into a figure presented as observed (existing engine rule — now a design rule too); absence of an envelope renders "—", never an invented value; percentages ("97%") only after A9 gives completeness a real denominator; the count in the Evidence chip is only ever a count of real records.

---

## 12. Future compatibility analysis (A7 → A12)

Using the prompt's numbering (repo docs partition the same work as A6-prices/A7-valuation/A8-regeneration/P5):

| Arrival | What changes | Where it lands in this design | Redesign needed? |
|---|---|---|---|
| **A7 Historical Investment Import** | Imported positions/events deepen coverage; evidence gains "imported" records | Evidence chip count + drawer rows; coverage boundary (`coverageFrom`) moves earlier; chart range extends | **No** — envelope + drawer absorb it |
| **A8 Historical Price Foundation & Valuation** | Positions × prices ⇒ per-date investment values; `estimated` degrades like FX misses | Chart gains pre-snapshot reconstructed segments (hollow markers already speak this language); completeness tiers get finer reasons | **No** — the tier vocabulary was built for exactly this |
| **A9 Wealth Regeneration** | History becomes regenerable, denser, correctable | ③ upgrades to true attribution (Market Growth / Contributions / Spending / Fees) in the same ledger slot; ⑤'s sentence upgrades; ④ gains historical composition mode; Completeness can become quantified ("Observed 97%") | **No** — this is the design's headline beneficiary; the slots are pre-cut |
| **A10 Investments Time Machine** | Investments perspective becomes historical | The *shell* already serves it (as-of, compare, presets, envelope); Investments swaps its "current holdings only" envelope for a real one; Wealth's Investments driver row can drill through to the Investments lens | **No** — shell was the point |
| **A11 Timeline & Simulation** | Milestones, playback, scenario branches | Shell is the natural host: derived-event markers render on ②'s time axis; playback = animated As Of (the state contract §4.1 is already a scrubber target); simulation = a *labeled alternate context* the shell displays (visually distinct "simulated" treatment — tone variant, not new layout) | **Shell no; one new chrome affordance** (marker/playback layer on the chart) |
| **A12 Financial Conversation Layer** | Ask "why did net worth drop in March?" | Deep-links into shell state via the URL contract (§4.4: asOf/compareTo/period/perspective are addressable); answers cite the same envelope + evidence drawer; ⑤'s "View full explanation" slot becomes the conversation entry | **No** — the URL and evidence contracts are the API |

The single structural bet making all of this absorb cleanly: **the shell owns time + trust as data (`ShellTimeContext` + `PerspectiveEnvelope`), and every perspective is a pure renderer of computed results.** A7–A10 change what the engines can compute; A11–A12 change how the same state is driven and narrated. Neither touches the frame.

---

## 13. Component hierarchy

Proposed target (new/moved marked; everything else exists):

```
SpaceDashboard (host — shrinks)
└── [tab === "PERSPECTIVES"]
    ├── usePerspectiveShellState(spaceId)          ★ new hook — asOf/compareTo/period/presetLink + URL sync
    ├── PerspectiveShell                            ★ new — components/space/shell/
    │   ├── ShellContextRow                         ← evolves SharedHistoricalContext.tsx
    │   │   ├── AsOfControl / CompareToControl (+ swap)
    │   │   ├── CompletenessChip → CompletenessPopover   ★ interactive
    │   │   └── EvidenceChip → EvidenceDrawer            ★ interactive (TransactionSliceDrawer pattern)
    │   ├── ShellPresetRow                          ← evolves CashFlowPeriodSelector (renamed, relocated;
    │   │                                              layout identical: to-date left · rolling right)
    │   └── PerspectiveTabs                         ← evolves PerspectiveTabSelector (extracted from host;
    │                                                  SegmentedControl grammar; scrollable on mobile)
    └── PerspectiveWorkspace (tabpanel)
        ├── [wealth] WealthPerspective              — recomposed to the 5-surface IA
        │   ├── WealthHero                          ★ merges WealthKpiStrip + WealthChangeCard headline
        │   ├── WealthTrendChart                    ← upgraded WealthNetWorthChart (axis/tooltip/overlay/metric switch)
        │   ├── WealthChangeLedger                  ★ merges WealthDriversCard + ChangeCard drivers (+ net row)
        │   ├── WealthCompositionCard               ← gains mode switcher (class/institution/account/concentration)
        │   └── WealthStoryCard                     ← gains evidence link; loses duplicate caveat
        ├── [cashFlow/liquidity/debt/goals] SectionCard virtual-section stacks (unchanged)
        └── [investments] unchanged until A10
Shared: wealth-ui.tsx (WealthCard, DeltaBadge, Sparkline, WealthUnavailable) — kept as the kit
Read models: lib/wealth/wealth-time-machine.ts — unchanged by this redesign
```

---

## 14. Navigation hierarchy

```
Space rail (UNCHANGED): Overview · Perspectives · Activity · Accounts · Transactions · Members
└── Perspectives
    ├── Shell (permanent, perspective-independent): As Of · Compare To · Completeness ·
    │   Evidence · presets — never remounts on lens switch
    ├── Lens tabs (kept as tabs, never a sidebar): Wealth · Liquidity · Debt ·
    │   Cash Flow · Investments · Goals   (order/membership stays per-category via
    │   PERSPECTIVES_BY_CATEGORY; "soon" lenses keep the honest suffix)
    ├── Within a lens: sections answer questions; drill-downs (evidence drawer,
    │   composition modes, driver → transactions) are overlays, never navigation
    └── Cross-lens hand-offs are lens *switches* within the same shell context
        (Hero "Liquid NW → Liquidity", Wealth driver "Investments → Investments lens"):
        the time context travels, reinforcing rotation-not-navigation
URL: ?tab=perspectives&perspective=wealth&asOf=…&compareTo=…&period=…  — a complete,
shareable, A12-addressable financial question
```

Switching lenses changes *only* the workspace panel. The shell never unmounts, never flashes, never resets — this invariant, more than any visual choice, is what makes it feel like rotating one object.

---

## 15. Implementation roadmap — small, independent Claude Code slices

Ordered for minimal merge conflicts: the shell-extraction spine first (it touches `SpaceDashboard`), then parallel-safe leaf slices that each own disjoint files. Every slice is independently shippable and behavior-preserving unless stated.

**Phase 1 — Shell spine (sequential; each touches `SpaceDashboard.tsx`, so do not parallelize within the phase):**

| Slice | Scope | Files (owned) | Notes |
|---|---|---|---|
| **S1 — Extract shell state hook** | Move `asOf`/`compareTo`/`cashFlowPeriod` `useState`s into `usePerspectiveShellState`; host consumes it. Zero visual change. | ★ `components/space/shell/usePerspectiveShellState.ts`; edit `SpaceDashboard.tsx` | Kill-switch trivial: hook returns the same tuple |
| **S2 — Extract `PerspectiveShell` container** | Wrap Rows 1–3 in one `components/space/shell/PerspectiveShell.tsx` with the single-frame glass treatment; move `SharedHistoricalContext` + preset row + `PerspectiveTabSelector` (extracted from host) inside. Visual: the "one object" frame. | ★ `shell/PerspectiveShell.tsx`, ★ `shell/PerspectiveTabs.tsx`; edits: `SpaceDashboard.tsx`, `SharedHistoricalContext.tsx` (move) | Preset layout untouched (left/right groups) |
| **S3 — URL-sync shell state** | Add `asOf`/`compareTo`/`period` to the existing query-param effect; restore on mount. | edit `usePerspectiveShellState.ts`, `SpaceDashboard.tsx` (param plumbing) | Guard: invalid/future dates fall back to today |

**Phase 2 — Shell contracts (parallel-safe after S2; disjoint files):**

| Slice | Scope | Files (owned) | Notes |
|---|---|---|---|
| **S4 — Shared period seam** | Introduce `lib/time/shared-period.ts` re-exporting/aliasing the period types + `periodRange` (reference date = `asOf`); `ShellPresetRow` (renamed presentation wrapper) consumes it. Cash Flow keeps consuming its own module — one seam, no big-bang rename. | ★ `lib/time/shared-period.ts`, ★ `shell/ShellPresetRow.tsx` | Follows the "rename in sentences first" doctrine |
| **S5 — Per-perspective envelope contract** | `PerspectiveEnvelope` type + registry keyed by perspective id; Wealth adapter maps `wealthResult`; Liquidity/Debt map lens provenance; Cash Flow/Investments/Goals get honest static envelopes. Deletes the `wealthWorkspaceActive` ternary. | ★ `lib/perspectives/envelope.ts`, edits confined to `PerspectiveShell.tsx` + small per-adapter files | |
| **S6 — Interactive trust chips** | CompletenessChip popover (stamp reason) + EvidenceChip drawer (snapshot list now; generic record list later). | ★ `shell/CompletenessPopover.tsx`, ★ `shell/EvidenceDrawer.tsx`; edit `ShellContextRow` | Reuses OverlaySurface/drawer patterns |
| **S7 — Compare ergonomics** | Swap (⇄) between As Of/Compare To; optional "compare to start of period" preset link (`presetLink`). | edits: `ShellContextRow`, `usePerspectiveShellState.ts` | The one slice that changes preset *behavior* — behind the toggle, default off |

**Phase 3 — Wealth recomposition (parallel-safe; each owns one component file; `WealthPerspective.tsx` composition updated last):**

| Slice | Scope | Files (owned) | Notes |
|---|---|---|---|
| **S8 — `WealthHero`** | Merge KPI strip + ChangeCard headline into the hero (headline + delta + confidence + 3 secondary rows; sparklines removed). | ★ `wealth/WealthHero.tsx` | Read model unchanged |
| **S9 — Trend chart upgrade** | Axis labels, gridlines, hover/touch tooltip, area fill, metric switcher; keep gaps/hollow markers/dot-click. | edit `wealth/WealthNetWorthChart.tsx` (→ `WealthTrendChart`) | Largest visual slice; still pure presentation |
| **S10 — Compare overlay series** | Dashed equivalent-window series ending at Compare To. Small read-model addition: a second windowed series in `WealthResult.chart` (pure, tested). | edits: `wealth-time-machine.ts` (+ test), `WealthTrendChart` | Only slice touching the read model |
| **S11 — `WealthChangeLedger`** | Merge Drivers + Change cards: signed ledger + Net Change row + single forward-looking caveat; per-class delta chips for ④ come from the same deltas. | ★ `wealth/WealthChangeLedger.tsx`; delete `WealthChangeCards.tsx` after S13 | |
| **S12 — Composition modes** | Mode switcher on the composition card: class (historical, default) / institution / account / concentration (current-classification, labeled). Reuses the existing registered widgets' renderers. | edit `wealth/WealthCompositionCard.tsx` | Honesty labels per §11 |
| **S13 — Recompose `WealthPerspective`** | Swap the grid to the 5-surface IA; story card gains the evidence link; remove dead components. | edit `wealth/WealthPerspective.tsx`, `WealthStoryCard` | Depends on S8–S12; the only integration slice |

**Phase 4 — Polish + forward seams (parallel-safe):**

| Slice | Scope | Files (owned) |
|---|---|---|
| **S14 — Mobile pass** | Two-line collapsed shell, scrollable tab rail (replaces `<select>`), touch tooltip, bottom-sheet composition modes. | edits: `shell/*`, `wealth/*` responsive classes |
| **S15 — A11/A12 seams (chrome only)** | Derived-event marker layer slot on the trend chart (renders nothing today); confirm URL contract covers deep-link needs. | edit `WealthTrendChart` (slot prop), docs |

Dependency shape: S1→S2→S3 sequential; {S4,S5,S6,S7} parallel after S2; {S8,S9,S10,S11,S12} parallel after S3 (S10 after S9 if same-file churn is a concern); S13 integrates; {S14,S15} parallel after S13. No slice requires schema changes, migrations, or engine changes; only S10 touches a read model, and it is pure + test-covered.

---

*End of investigation. No code was written, no files were modified, no components were created, and nothing was committed.*
