# Atlas Polish Investigation

**Status:** Investigation only — no implementation.
**Scope:** Visual-consistency audit of the finished Atlas Glass UI (Spaces,
dashboard, Daily Brief, and the `components/atlas` primitive layer).
**Branch:** `feature/v2.5-spaces-completion`
**Date:** 2026-07-03

This document catalogs *visual polish inconsistencies only* — spacing, padding,
border-radius, animation, glass depth, hover, focus, shadow, surface hierarchy,
and micro-interactions. It proposes **no redesigns**. Every finding is a
deviation from a value the design system already defines. Fixes are grouped into
reviewable implementation families at the end; each family is independently
shippable behind its own checklist.

---

## 0. Method & the canonical baseline

The audit measures consumers against the tokens and primitives the codebase
already treats as canonical:

- **Tokens** — `app/globals.css` (`--radius-*`, `--space-*`, `--dur-*`,
  `--ease-*`, `--shadow-e1..e4`, `--glass-*`, `--specular-edge`).
- **Primitives** — `components/atlas/*`: `GlassPanel` (blur(30px) saturate(160%),
  radius-lg, shadow-e2, specular top edge), `GlassButton` (blur(20px), radius-sm,
  hover −1px, active 0.97), `OverlaySurface` (thick / e4 / radius-xl modal),
  `SegmentedControl`, `InlineFilter`, `DataCard`.

The primitives are correct and internally coherent. **Almost every inconsistency
below is a consumer hand-rolling a value the primitive already owns, or two
consumers picking different literals for the same visual role.** The Atlas Glass
migration (per the Step A/B/C and Modal Doctrine checklists) is partially
complete: the primitives exist, but a large tail of surfaces still predate them.
This investigation is the polish pass over that tail.

### Counting note

Numbers below are from a full sweep of `components/**` and `app/**` (excluding
`node_modules`). They are indicative magnitudes, not line-exact audits — the
point is the *ratio* of ad-hoc literals to token usage, which is the polish
signal.

---

## 1. Border-radius mismatches

**Severity: High — most pervasive inconsistency in the app.**

Token scale (`globals.css`): `--radius-xs 6 / sm 10 / md 14 / lg 20 / xl 28 /
full 999`. Tailwind's `rounded-*` scale does **not** align: `rounded-md 6 / lg 8 /
xl 12 / 2xl 16 / 3xl 24`. So a component written with `rounded-2xl` (16px) is
neither `--radius-md` (14) nor `--radius-lg` (20) — it lands in a gap the design
language never defines.

Sweep result:

| Source | Count |
|---|---|
| Tailwind `rounded-*` literals | ~580 |
| `var(--radius-*)` token uses | ~79 |

Literal breakdown: `rounded-xl` ×247, `rounded-lg` ×138, `rounded-full` ×135,
`rounded-2xl` ×49, `rounded-md` ×5, `rounded-3xl` ×3, `rounded-sm` ×1, plus two
one-off arbitraries `rounded-[2px]` (`InlineFilter.tsx:117`) and `rounded-[14px]`
(`InvestmentsClient.tsx:500` — this one *equals* `--radius-md` but is written as a
magic number).

Concrete drift that reads on screen:

- **Card radius disagreement.** The canonical glass card (`GlassPanel` /
  `DataCard`) is `--radius-lg` (20px). Hand-rolled cards across the dashboard use
  `rounded-2xl` (16px) and `rounded-xl` (12px). Adjacent cards on the same page
  therefore have visibly different corner radii.
- **Modal radius disagreement.** Canonical modal (`OverlaySurface`) is
  `--radius-xl` (28px). Legacy modals disagree even with *each other*:
  `rounded-3xl` (24px) in `InvestmentsClient.tsx:173`, `AssetDrawer.tsx:52`,
  `DebtClient.tsx:1026`; `rounded-2xl` (16px) in `SpaceDashboard.tsx:1612`,
  `DebtPayoffSection.tsx:329`, `app/admin/security/page.tsx` (×3). Peer modals
  sit at 24px, 16px, and (canonical) 28px simultaneously.
- **`rounded-[2px]` in `InlineFilter`** — the active-tab underline wrapper uses a
  raw 2px, off-scale entirely (smallest token is `--radius-xs` 6px; a 2px
  hairline corner is defensible but should be an explicit decision, not a magic
  number).

---

## 2. Spacing & padding inconsistencies

**Severity: Medium.**

The `--space-*` token scale (4px base) is almost entirely bypassed: `var(--space-*)`
appears **4 times** in all of `components/**`, while raw Tailwind spacing is used
everywhere. Tailwind's scale happens to align numerically (`p-4` = 16 =
`--space-4`), so this is not a broken-rhythm problem so much as a
*token-adoption* problem — but it produces two visible symptoms:

- **Card inner-padding drift.** Card padding ranges freely: `p-3` ×31, `p-4` ×24,
  `p-5` ×12, `p-6` ×4, `p-8` ×3 across dashboard/space/brief. The canonical
  `DataCard` default is `var(--space-4)` (16px = `p-4`). Cards of the same visual
  tier use 12 / 16 / 20 / 24px padding with no rule connecting size to tier.
- **Responsive-padding one-offs.** `sm:p-4` ×3, `sm:p-6` ×3, `md:p-5` ×1,
  `md:p-6` ×1 — a handful of components grow their padding at breakpoints while
  their siblings do not, so a row of cards can shift out of alignment on tablet.
- **`OverlaySurface` internal rhythm** is self-consistent (`p-5` shell, `mt-3`
  toolbar, `mt-4` body/footer) but is a *different* rhythm than the legacy modals
  it will replace (which use `p-6`/`p-4` mixes), so during migration the two will
  look subtly different.

This family is low-risk to unify because the numeric values already mostly match;
the work is routing them through `--space-*` and picking one card-padding value
per tier.

---

## 3. Border-radius vs. shadow: shadow inconsistencies

**Severity: Medium–High.**

Token recipes `--shadow-e1..e4` encode the design language's elevation ladder
(each pairs a drop shadow with a 1px inset specular ring). Adoption is minimal:

| Source | Count |
|---|---|
| `var(--shadow-e*)` token uses | 4 (e2 ×1, e3 ×2, e4 ×1) |
| Tailwind `shadow-2xl` | 15 |
| Tailwind `shadow-lg` / `xl` / `sm` | 2 / 1 / 2 |
| Hand-rolled inline `boxShadow: rgba(...)` | 8 files |

- **`shadow-2xl` is the de-facto modal shadow** (15 uses across every legacy
  modal and dropdown: `SpaceDashboard`, `DebtClient`, `InvestmentsClient`,
  `AssetDrawer`, `DebtPayoffSection`, `UserButton`, `AdminUserMenu`,
  `ProviderActionsButton`, `HoldingsDonutChart`, admin security pages). It has no
  inset specular ring, so these surfaces miss the "lit glass edge" that
  `--shadow-e4` gives the canonical modal — a real depth-signature mismatch, not
  just a different blur radius.
- **Hand-rolled `boxShadow`** in `SpacesClient.tsx` (×3), `InvestmentsClient`,
  `UserMenu`, `BriefNewUser`, `BriefModal`, plus the primitives. The primitive
  uses are legitimate (they *define* the recipe); the consumer uses
  (`SpacesClient`, `InvestmentsClient`) invent bespoke rgba shadows instead of
  referencing `--shadow-e*`.
- **Elevation is not tied to hierarchy.** Because most shadows are `shadow-2xl`
  regardless of surface role, a dropdown menu and a full modal can carry the same
  shadow weight — flattening the intended z-hierarchy.

---

## 4. Glass depth / material inconsistencies

**Severity: High.**

Canonical glass material = `backdrop-filter: blur(30px) saturate(160%)` +
`--glass-{depth}` fill + 1px `--specular-edge` top highlight. `GlassButton`
intentionally uses a lighter `blur(20px)`; scrims use `blur(8px)`. Everything else
should match `GlassPanel`. It doesn't:

Blur/saturate values found in hand-rolled surfaces (outside the primitives):

| Value | Where | Verdict |
|---|---|---|
| `blur(30px) saturate(160%)` | `AccountModal:630`, `AssetDrawer:55`, `BottomNav:43`, `Sidebar:384` | matches canonical (good, but hand-copied — drift risk) |
| `blur(8px)` scrim | `BriefModal`, `NetWorthChartModal`, `SpacesClient`, `GlassModal` | matches scrim (good) |
| `blur(56px) saturate(180%)` | `BriefModal.tsx:173–174` | **outlier** — nearly 2× the canonical blur, higher saturate |
| `blur(28px) saturate(140%)` | `UserMenu.tsx:176–177` | **outlier** — off on both axes |
| `blur(20px)` on a *panel* | `NetWorthChartModal.tsx:211` | **outlier** — button-tier blur on a panel-tier surface |

`saturate()` values across the app: `160%` ×13 (canonical), `180%` ×3, `140%` ×2.
Three different saturation levels for surfaces that should read as the same glass.

Additional material-signature gaps:

- **~15 files hand-roll `backdrop-filter` instead of rendering through
  `GlassPanel`** (`Sidebar`, `BottomNav`, `UserMenu`, `RefreshButton`,
  `AdviceBanner`, `AssetDrawer`, `HoldingsDonutChart`, `ProviderDiagnosticsDrawer`,
  `BriefLogo`, admin pages, …). Each is a place the 30px/160%/specular recipe can
  silently drift.
- **Missing specular top-edge.** The 1px `--specular-edge` gradient is the Atlas
  Glass signature. Hand-rolled panels (e.g. `Sidebar`, `BottomNav`,
  `NetWorthChartModal` inner panel) omit it, so they read as plain frosted boxes
  next to the specular-lit primitives.
- **Depth-token usage is sparse in raw CSS** (`--glass-ultrathin` ×10, `thin` ×3,
  `regular` ×1, `thick` ×3), while `GlassPanel depth=` props are healthier
  (`thin` ×29, `thick` ×8, `regular` ×3). The raw-CSS surfaces are the ones most
  likely to have picked the wrong depth for their tier.

---

## 5. Surface hierarchy inconsistencies

**Severity: Medium–High.** Overlaps with §3–4 but is distinct: this is about
*which material a surface picks for its role*, not the material's fidelity.

- **Legacy dropdowns/menus use raw palette, not glass.** `UserButton.tsx:43`,
  `AdminUserMenu.tsx:40`, `ProviderActionsButton.tsx:163` render menus as
  `bg-gray-900 border-gray-700 rounded-2xl shadow-2xl`. The Atlas equivalent
  (`InlineFilter`'s popover) is a `GlassPanel depth="regular"`. So two menus that
  do the same job — one is opaque slate, one is frosted glass.
- **Raw `bg-gray-900 / gray-950 / border-gray-700/800`** persists in
  `HoldingsDonutChart`, `ProviderDiagnosticsDrawer`, `UserButton`,
  `AdminUserMenu`, and the admin pages, bypassing `--glass-*` / `--modal-surface`
  / `--border-hairline` entirely. (Admin is arguably outside the "finished Atlas
  UI" surface; flagged separately in §11.)
- **Modal fill split.** Newer legacy modals correctly use
  `var(--modal-surface)` (`InvestmentsClient`, `DebtClient`, `SpaceDashboard`,
  `DashboardClient`, `DebtPayoffSection`), but `HoldingsDonutChart` and the admin
  modals still use `bg-gray-900/950`. Same surface role, two fills.
- **`bg-white/5` leftover** at `AccountModal.tsx:51` — the last raw white-tint
  surface; the rest of the app migrated to `--surface-muted` / `--surface-hover`.

---

## 6. Animation / duration inconsistencies

**Severity: Medium.**

Motion tokens: `--dur-instant 100 / fast 180 / base 240 / moderate 320 / slow 480`.
Token adoption: `--dur-base` ×19, `--dur-fast` ×7, `--dur-instant` ×1, `--dur-slow`
×2. Against that, hardcoded Tailwind durations: `duration-200` ×7, `duration-300`
×5, `duration-150` ×4. None of `150/200/300` is a token value (`180/240/320` are),
so these are all near-misses to the intended scale.

The visible problem is **the same micro-interaction is timed differently in
different files:**

- **Chevron rotate-on-expand** uses `duration-150` in `MoreMenu.tsx:111`,
  `PerspectiveSwitcher.tsx:118`, `UserMenu.tsx:162`, `InlineFilter.tsx:156`, but
  `duration-200` in `BankingClient.tsx:287`, `DebtClient.tsx:453/512/546`. Same
  affordance, two speeds.
- **Expand/collapse & progress fills** use `duration-200` (`DebtClient`
  height animations) vs `duration-300` (`ProgressWidget.tsx:199`,
  `CreateSpaceModal.tsx:126` step bar, `BriefInsight`/`BriefSinceLastVisit`/
  `BriefAttention` hover overlays). No rule ties duration to interaction type.
- **`transition-all` ×21** vs the primitives' explicit
  `transition-[transform,box-shadow,background-color]`. `transition-all` animates
  unintended properties (and is a minor perf smell); the primitives model the
  correct pattern.

Easing is comparatively healthy — `--ease-standard` / `--ease-spring` /
`--ease-enter` are used where present — the gap is duration + property scoping.

---

## 7. Hover inconsistencies

**Severity: Medium.**

Canonical hover lift = `hover:-translate-y-[1px]` (`GlassPanel` interactive,
`GlassButton`). Found lift values:

| Lift | Count | Where |
|---|---|---|
| `-translate-y-[1px]` (canonical) | 6 | primitives + consumers |
| `-translate-y-0.5` (2px) | 1 | `BriefNewUser.tsx:36` |
| `-translate-y-[2px]` | 1 | `SpacesClient.tsx:464` |
| `-translate-y-[3px]` | 1 | `SpacesClient.tsx:323` |

- **`SpacesClient` Space cards lift 3× the canonical amount** and are the *only*
  surface in the app that also **scales up on hover** (`hover:scale-[1.014]`,
  `SpacesClient.tsx:323`). Every other interactive surface only translates. This
  is the most noticeable hover outlier.
- **Hover elevation coupling varies.** Some hovers bump shadow
  (`SpacesClient` → `shadow-e3`/`e2`), most don't. If lift implies elevation, the
  rule isn't applied consistently.
- **Hover *fill* is well-unified** — `--surface-hover` / `--surface-hover-strong`
  are used consistently and `hover:bg-white/[0.0n]` literals are effectively gone
  (0 remaining). This part of the migration is done; only the transform side
  drifts.

---

## 8. Focus inconsistencies

**Severity: High (also an accessibility gap).**

This is the single largest consistency hole. `focus-visible` styling exists in
**only ~6 files** (`SegmentedControl`, `InlineFilter`, `OverlaySurface`,
`BriefModal`, `UserMenu`, and the Brief* group). Meanwhile:

- **~230+ interactive `<button>`s across 30+ files have zero `focus-visible`
  treatment** and fall back to the browser default outline (or nothing, where an
  outline reset cascades). Highest-count offenders: `SpaceDashboard` (30 buttons,
  0 focus), `ManageSpaceModal` (22/0), `DebtClient` (22/0), `DashboardClient`
  (19/0), `TotpSection` (18/0), `InvestmentsClient` (11/0), `AccountModal` (11/0).
- **The canonical `GlassButton` itself has no focus ring** (`GlassButton.tsx` —
  1 button, 0 focus-visible). Because it's the primitive, this omission
  propagates to every action that adopts it. Fixing focus here is the highest-
  leverage single change in the whole audit.
- **The few files that *do* have rings use two different recipes:**
  - Recipe A (×5): `focus-visible:outline-none ring-2 ring-[var(--meridian-400)]`
    — *no offset* (`SegmentedControl`, `InlineFilter`, `OverlaySurface` close btn).
  - Recipe B (×6): same + `ring-offset-2 ring-offset-transparent` — *with offset*
    (`BriefHero`, `BriefNewUser`, and the Brief group).

  So even the surfaces that got focus right disagree on whether the ring sits on
  the edge or floats 2px off it.

---

## 9. Micro-interaction inconsistencies

**Severity: Low–Medium.**

- **Active-press scale.** Canonical `active:scale-[0.97]` (×7, from `GlassButton`)
  vs `active:scale-[0.98]` (×1, `BriefHero.tsx:118`). Minor, but two press
  depths.
- **Active-press timing.** `BriefHero` pairs its press with
  `active:duration-[var(--dur-instant)]` (correct — a press should snap). Most
  other pressable surfaces don't shorten duration on `:active`, so their press
  eases at the full `--dur-base` (240ms), which feels mushy vs the snappy
  primitive. Inconsistent application of an otherwise-correct pattern.
- **Chevron flip** (see §6) — the rotate is the micro-interaction; its 150/200ms
  split is the visible artifact.
- **Loading idioms are mixed but mostly defensible:** `animate-spin` ×82 (button
  spinners), `animate-pulse` ×10 (skeletons), `animate-bounce` ×3. Worth a
  consistency note: the AI-motion doctrine says AI surfaces should use the ambient
  `meridian-shimmer` / `.ai-shimmer`, never a spinner — spot-check that no AI
  surface reaches for `animate-spin`. Non-AI spinners are fine.
- **`presence-dot`** (breathing status dot) is a single shared keyframe — good,
  no drift found. Called out as the model the other micro-interactions should
  follow (one definition, many consumers).

---

## 10. Summary table

| # | Category | Severity | Primary signal |
|---|---|---|---|
| 1 | Border-radius | High | ~580 `rounded-*` literals vs ~79 tokens; card 12/16/20 & modal 16/24/28 disagreement |
| 2 | Spacing / padding | Medium | `--space-*` used 4×; card padding p-3/4/5/6 with no tier rule |
| 3 | Shadow | Med–High | `shadow-2xl` ×15 vs `--shadow-e*` ×4; inset specular ring lost |
| 4 | Glass depth / material | High | blur 20/28/30/56px, saturate 140/160/180%; specular edge omitted on hand-rolled panels |
| 5 | Surface hierarchy | Med–High | raw `bg-gray-900` menus/modals vs glass; menu = opaque vs frosted |
| 6 | Animation / duration | Medium | 150/200/300ms literals; same chevron 150 vs 200 |
| 7 | Hover | Medium | lift −1/2/3px; `SpacesClient` cards scale-up (only ones) |
| 8 | Focus | High | ~230 buttons no focus-visible; `GlassButton` has none; ring offset vs no-offset |
| 9 | Micro-interaction | Low–Med | active 0.97 vs 0.98; press-duration snap applied unevenly |

---

## 11. Implementation families (reviewable, no redesigns)

Each family is a self-contained, mechanical consistency pass — a search-and-align
against an existing token, not a redesign. Ordered by leverage (impact ÷ risk).
None should be combined into one branch; each needs its own impact map, rollback
plan, and validation checklist per project rules.

### Family P1 — Focus-visible unification *(highest leverage)*
- Add one canonical focus recipe to `GlassButton` (the primitive) — pick offset
  vs no-offset once and codify it.
- Reconcile Recipe A vs Recipe B (§8) into a single `focus-visible` utility.
- Sweep the ~30 files / ~230 buttons that have no focus treatment onto it.
- **Why first:** biggest single visible + a11y win; fixing the primitive covers
  most adopters automatically. Purely additive.

### Family P2 — Radius tokenization
- Map `rounded-2xl → --radius-lg` (cards), `rounded-3xl/2xl modals → --radius-xl`,
  and audit `rounded-xl` card uses.
- Resolve the peer-modal radius disagreement (24 vs 16 vs 28) to `--radius-xl`.
- Replace `rounded-[14px]` / `rounded-[2px]` magic numbers with tokens or an
  explicit documented exception.
- **Note:** highest count, so stage per-surface-family (cards, then modals, then
  chips) rather than one mega-commit.

### Family P3 — Glass material fidelity
- Route hand-rolled `backdrop-filter` surfaces through `GlassPanel` where
  structurally possible; where not, align literals to `blur(30px) saturate(160%)`.
- Fix the three material outliers: `BriefModal` blur(56px)/180%, `UserMenu`
  blur(28px)/140%, `NetWorthChartModal` panel blur(20px).
- Restore the specular top-edge on hand-rolled panels (`Sidebar`, `BottomNav`,
  `NetWorthChartModal` inner).

### Family P4 — Shadow tokenization
- Replace `shadow-2xl` on modals/menus with `--shadow-e4` / `--shadow-e3` by role.
- Convert bespoke inline `boxShadow` (`SpacesClient`, `InvestmentsClient`) to
  `--shadow-e*`.
- Re-tie elevation to hierarchy (menu = e3, modal = e4).

### Family P5 — Surface-hierarchy cleanup
- Convert raw `bg-gray-900/950 + border-gray-700/800` menus/modals to
  `--glass-*` / `--modal-surface` / `--border-hairline` (`UserButton`,
  `AdminUserMenu`, `ProviderActionsButton`, `HoldingsDonutChart`).
- Clear the last `bg-white/5` (`AccountModal:51`) to `--surface-muted`.
- **Scope call needed:** admin surfaces (`app/admin/**`, `AdminUserMenu`,
  `ProviderActionsButton`, `ProviderDiagnosticsDrawer`) are legacy raw-palette and
  may be intentionally outside the "Atlas UI." Recommend confirming scope before
  touching them — the user-facing subset (`UserButton`, `HoldingsDonutChart`,
  `AccountModal`) is clearly in scope.

### Family P6 — Motion tokenization
- Replace `duration-150/200/300` with `--dur-fast` / `--dur-base` / `--dur-moderate`.
- Unify the chevron-rotate micro-interaction to one duration everywhere.
- Convert `transition-all` (×21) to explicit `transition-[props]` per the
  primitive pattern.

### Family P7 — Hover & press consistency
- Normalize hover lift to `−translate-y-[1px]`; decide `SpacesClient` cards'
  −3px + scale-up as an intentional hero exception or bring them in line.
- Standardize `active:scale-[0.97]` and apply `active:duration-[--dur-instant]`
  wherever a press exists (currently only `BriefHero`).

### Family P8 — Spacing/padding token adoption *(lowest risk, cosmetic)*
- Route card padding through `--space-*`; pick one padding value per card tier.
- Reconcile responsive-padding one-offs (`sm:p-4/6`, `md:p-5/6`) against the
  DataCard/OverlaySurface rhythm.

---

## 12. Explicit non-goals

- **No redesigns.** No new visual language, no new tokens, no layout changes —
  only alignment to values already defined.
- **No legacy-table / schema / route work** — this is a UI-surface audit only.
- **No behavioral change.** Modal behavior, focus-trap, scroll-lock, and portal
  logic in `OverlaySurface` are correct and out of scope.
- Admin surfaces are flagged (§5, §11 P5) but **not assumed in scope** pending a
  scope decision.
