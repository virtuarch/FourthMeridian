# Fourth Meridian — Shell Navigation Redesign: Implementation Plan

**Date:** 2026-07-13
**Branch of record:** `feature/v2.5-spaces-completion`
**Scope:** Per `FOURTH_MERIDIAN_SHELL_NAV_REDESIGN_INVESTIGATION_2026-07-13.md` §6 — three phases: (1) Perspective tab icons + reordering the Perspective tab track above the time/trust block; (2) an optional icon slot on the shared `SegmentedControl` primitive + a new floating-pill wrapper, applied only to the rail tabs and Perspective tabs; (3) scroll-driven shrink behavior for both surfaces. **No change to `SegmentedControl`'s own positioning or its other four consumers' behavior.** Space-level rail tabs stay text-only (icons there are explicitly out of scope per the investigation's confirmed reading of the request) unless a later decision changes that.

---

## 1. Repository findings (see the investigation doc for full citations)

- `lib/perspectives.ts`'s `PerspectiveDef` already has `icon: string` (Lucide name) populated for every lens — Wealth `Gem`, Cash Flow `Waves`, Liquidity `Droplets`, Investments `TrendingUp`, Debt `CreditCard`, Retirement `PiggyBank`, Goals `Target`, Tax `FileText`, Property `Home`, Business Health `Briefcase`.
- `TimelineWidget.tsx:40` already has the precedented icon-resolution shape: `const ICON_MAP: Record<string, React.ElementType> = {...}`, `(name && ICON_MAP[name]) || Activity` fallback, `<Icon size={14} />`.
- `PerspectiveTabs.tsx` renders lenses via `SegmentedControl`, `{id, label}` only, no icon read.
- `PerspectiveShell.tsx` is exactly two stacked containers (time/trust + presets, then the tab track), presentation-only, no cross-file ordering dependency.
- `components/atlas/SegmentedControl.tsx` — six real consumers (`SpaceDashboard.tsx`, `PerspectiveTabs.tsx`, `CashFlowPeriodSelector.tsx`, `TimelineWidget.tsx`, `WealthCompositionCard.tsx`, `WealthTrendChart.tsx`), `SegmentedControlOption<T> = {id, label}`, already a rounded/glass capsule shape, no scroll-awareness.
- Rail tabs: `railOptions` (`SpaceDashboard.tsx:2411`) sourced from `railVisibleTabs()` (`lib/space-nav.ts`), `{id, label}` only, renders inline (not sticky) today.
- No scroll-direction/hide-on-scroll mechanism exists anywhere in the codebase — new work.

---

## 2. Exact implementation design

### 2.1 Phase 1a — Perspective tab icons

- Add a local `ICON_MAP: Record<string, React.ElementType>` to `PerspectiveTabs.tsx` (or a small shared `lib/perspective-icons.ts` if reused by more than one component — check `PerspectiveCardItem` rendering elsewhere first, since the Perspectives full-tab-grid view may already resolve these icons for its cards; reuse that resolver rather than writing a third one if it exists).
- `PerspectiveTabItem` gains `icon?: string` (the Lucide name, passed straight from `PerspectiveDef.icon` at the call site) — additive, optional.
- `SegmentedControl` (once its Phase 2 icon slot exists — see §2.2) receives a resolved `icon: <Icon size={..} />` node per option; until then, Phase 1a can land with icon+label both showing (icons don't have to arrive alone — "free up space" is fully realized once labels can be dropped in Phase 2, but showing icon+label first is a safe, incremental, independently-shippable step).

### 2.2 Phase 1b — reorder `PerspectiveShell.tsx`

Swap which `<div>` renders first: Container 2 (`PerspectiveTabs`) moves above Container 1 (`ShellContextRow` + `CashFlowPeriodSelector`). Presentation-only — no prop/state changes, no host (`SpaceDashboard.tsx`) changes required since `PerspectiveShell` receives everything via props already.

### 2.3 Phase 2 — `SegmentedControl` icon slot (shared primitive, extend carefully)

- `SegmentedControlOption<T>` gains `icon?: React.ReactNode` — a pre-resolved node, not a string, so `SegmentedControl` itself stays icon-*library*-agnostic (it shouldn't need to know about Lucide or any resolution map — callers resolve their own icon-name-to-component and pass the element).
- Render: `icon` before `label` inside the button, `gap-1.5` or similar; when `icon` is present and the caller wants icon-only (space-saving), that's a **caller decision** — recommend adding a second optional flag like `iconOnly?: boolean` per-option or a control-level prop, resolved during implementation once the visual space savings are actually measured, not guessed at up front.
- **Verify all six consumers are visually and functionally unaffected** — none of the other five pass `icon` today, so the additive field must default to rendering exactly as before when absent. This is the single most important correctness bar for this phase.

### 2.4 Phase 2 — the floating-pill wrapper

- New component, e.g. `components/atlas/FloatingNavWrapper.tsx` (or co-located per surface if a shared wrapper proves awkward — decide once both call sites are attempted) — wraps a `SegmentedControl` instance, centers it, and gives it the floating/glass-pill positioning (likely `fixed` or `sticky` with `left-1/2 -translate-x-1/2`, appropriate `z-index`, safe-area padding for mobile).
- Applied at exactly two call sites: the rail-tab render in `SpaceDashboard.tsx` and `PerspectiveTabs.tsx`'s render (inside `PerspectiveShell.tsx`'s Container 2, post-reorder). Not applied to Daily Brief, Wealth's controls, Cash Flow's period selector, or Timeline's filter — those keep their current in-flow rendering.
- **Confirm the scroll container for each surface before wiring the shrink behavior** (§2.5) — do not assume `window` scroll; verify empirically (e.g. temporarily log `scrollY`/container scroll events) which element actually scrolls under the rail tabs vs. under the Perspective shell, since these may differ.

### 2.5 Phase 3 — scroll-driven shrink

- New hook, e.g. `useScrollShrink(containerRef?, { threshold })` — tracks scroll delta/direction on the correct container (per §2.4's verification) and returns a shrink/visibility state consumed by `FloatingNavWrapper`.
- **Recommended default behavior** (confirm with the user before or during implementation, per the investigation's §5/§7 open questions): the pill scales down modestly (does not fully disappear) past a small scroll-down threshold, and returns to full size on scroll-up or when scrolling stops near the top — matching the literal "shrinks as you scroll" description rather than a full hide/reveal pattern. If a full-hide behavior is actually wanted instead, that's a copy/CSS-endpoint change to the same hook's consumer, not a different hook.
- Respect `prefers-reduced-motion` — this codebase's global CSS already forces near-zero transition duration under that media query (`globals.css`); make sure the shrink transform uses the same transition mechanism (CSS `transition`, not a JS-driven animation loop) so it automatically inherits that accessibility behavior for free, rather than needing its own reduced-motion branch.

---

## 3. Files

**Modify:**
- `components/space/shell/PerspectiveTabs.tsx` — icons (§2.1).
- `components/space/shell/PerspectiveShell.tsx` — reorder (§2.2); mount the floating wrapper around `PerspectiveTabs` (§2.4, once built).
- `components/atlas/SegmentedControl.tsx` — additive `icon?: React.ReactNode` option field (§2.3). No positioning/layout changes to this file itself.
- `components/dashboard/SpaceDashboard.tsx` — mount the floating wrapper around the rail-tab `SegmentedControl` instance (§2.4).

**Add:**
- `components/atlas/FloatingNavWrapper.tsx` (or the alternative co-located shape decided during §2.4).
- `lib/hooks/useScrollShrink.ts` (or co-located with the wrapper) — §2.5.
- Colocated fixture/source-scan tests for each new piece, per house convention (see §7).

**Explicitly untouched:** `CashFlowPeriodSelector.tsx`, `TimelineWidget.tsx`, `WealthCompositionCard.tsx`, `WealthTrendChart.tsx` — all consume `SegmentedControl` but receive no icon, no floating wrapper, and no scroll behavior; their rendering must be byte-identical before and after this work. `lib/space-nav.ts` and `lib/perspectives.ts` (both consumed for existing data, not modified).

---

## 4. Slice plan

- **S1 — Perspective tab icons.** `ICON_MAP` (or shared resolver, verified against existing card-grid usage first), `icon?: string` on `PerspectiveTabItem`, wired through. Ships with icon+label initially.
- **S2 — Reorder `PerspectiveShell.tsx`.** Pure JSX swap, independently shippable, no dependency on S1.
- **S3 — `SegmentedControl` icon slot.** Additive field + render change. Validation: all six consumers manually checked (or fixture-tested) unaffected when `icon` is absent.
- **S4 — Floating wrapper, mounted at both call sites, no scroll behavior yet.** Confirms the centered-pill visual independent of scroll physics — a good, deliberate checkpoint before adding motion.
- **S5 — Scroll container verification + `useScrollShrink` + wiring.** The riskiest slice — verify scroll container identity empirically first (§2.4), then build and wire the hook.
- **S6 — Tests + polish + STATUS.md**, including an explicit manual pass confirming the five untouched `SegmentedControl` consumers still look and behave exactly as before.

---

## 5. Risks

- **Breaking one of `SegmentedControl`'s five other consumers.** The single biggest risk in this whole plan — an additive field is safe in principle, but only if actually verified against every consumer, not assumed safe from the type signature alone.
- **Wrong scroll-container assumption.** Building `useScrollShrink` against `window` when the real scroll container is a nested div would make Phase 3 silently do nothing (or worse, read the wrong scroll position) — verify before coding, not after debugging.
- **Fully hiding the pill instead of shrinking it**, or vice versa, without confirming which behavior is wanted — the investigation flags this as an open product decision, not a default to guess at.
- **Icon-only mode removing accessible labels without an aria-label fallback** — if Phase 2/3 moves toward icon-only rendering for space, each option needs an accessible name (title/aria-label) even when the visible label is dropped.
- **Motion not respecting `prefers-reduced-motion`** — must ride the existing global CSS transition-duration override, not a bespoke JS animation loop that ignores it.

## 6. Overengineering check

Confirmed feasible as: one data-surfacing slice (icons), one JSX reorder, one additive primitive field, one new wrapper component, one new scroll hook — five small, real pieces, not a `SegmentedControl` rewrite. Rejected: rebuilding `SegmentedControl` itself to be scroll-aware (keeps it a plain, reusable control); applying the floating/shrink treatment to all six consumers (only two actually want it); inventing a new icon resolution mechanism when `TimelineWidget.tsx`'s pattern already exists.

## 7. Testing expectations

Source-scan/fixture tests (house convention) for: `ICON_MAP` completeness against every `PerspectiveDef.icon` value in use; `SegmentedControl` renders identically with `icon` absent (a fixture test snapshotting/asserting no visual/DOM difference for the icon-less path); the floating wrapper renders in a centered position at each breakpoint tested; `useScrollShrink` returns the correct shrink state for a scripted sequence of scroll events against a fixture container. Manual pass: all five untouched `SegmentedControl` consumers (Daily Brief, Wealth composition/trend, Cash Flow period selector) visually and functionally unchanged.

## 8. Validation gate

```bash
npx tsc --noEmit
npx eslint
npm test
git diff --name-only   # must match §3 exactly
npm run dev             # manual pass: Perspective tabs show icons; Perspective tab track
                         # renders above the time/trust block; rail tabs and Perspective
                         # tabs both float as a centered pill; both shrink on scroll down
                         # and return to full size on scroll up; the five untouched
                         # SegmentedControl consumers are pixel-identical to before;
                         # reduced-motion setting suppresses the shrink animation
```

## 9. Stop conditions

1. Any of the five untouched `SegmentedControl` consumers changes appearance or behavior — stop and fix before continuing.
2. `useScrollShrink` is wired against an unverified scroll-container assumption — verify first, per §2.4/§5.
3. The shrink behavior fully hides the pill (or vice versa) without confirming that's the wanted behavior rather than the "shrinks" default described in §2.5.
4. Icon-only rendering ships without an accessible name per option.
5. `SegmentedControl` itself gains positioning/scroll logic (instead of the separate wrapper) — keep it a plain, reusable control; the floating/scroll behavior belongs to the wrapper, not the primitive.
