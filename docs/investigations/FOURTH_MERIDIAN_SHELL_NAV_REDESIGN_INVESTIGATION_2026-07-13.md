# Fourth Meridian — Shell Navigation Redesign (Instagram-style floating pill): Investigation

**Date:** 2026-07-13
**Scope:** Ground a product vision — both the Space-level rail tabs and the Perspective tabs become centered floating pills that shrink/collapse on scroll (Instagram's current bottom-nav treatment); the Perspective tabs additionally switch to icons to save space; the Perspective tab track moves above the time/trust + period-preset block ("the time machine toggle") instead of below it.
**Prompted by:** a direct product reference to Instagram's 2026 bottom-nav redesign (centered floating "Liquid Glass" pill, narrower than the old full-width bar, collapses on scroll) — see prior chat turn for the verified description of that reference.

---

## 1. Executive assessment

**Two of the four asks are cheap, and one of them is almost free because the data already exists.** Every `PerspectiveDef` in `lib/perspectives.ts` already carries a `icon: string` field (Lucide icon name) — Wealth → `Gem`, Cash Flow → `Waves`, Liquidity → `Droplets`, Investments → `TrendingUp`, Debt → `CreditCard`, Retirement → `PiggyBank`, Goals → `Target`, Tax → `FileText`, Property → `Home`, Business Health → `Briefcase`. `PerspectiveTabs.tsx` never reads this field today — it only renders `label` through `SegmentedControl`. Wiring icons in is surfacing existing data, not designing an icon set. The reorder (Perspective tab track above the time/trust block) is a two-block JSX swap inside `PerspectiveShell.tsx`, which is already exactly two stacked containers.

**The floating-pill-plus-shrink-on-scroll treatment is real, new work, and it's shared infrastructure risk, not UI polish.** Both surfaces the user wants this on — the Perspective tabs (`PerspectiveTabs.tsx`) and the Space-level rail tabs (`railOptions` in `SpaceDashboard.tsx`, sourced from `railVisibleTabs()` in `lib/space-nav.ts`) — are built on the **same shared primitive**, `components/atlas/SegmentedControl.tsx`, which today has **six consumers app-wide** (`SpaceDashboard.tsx`, `PerspectiveTabs.tsx`, `CashFlowPeriodSelector.tsx`, `TimelineWidget.tsx`, `WealthCompositionCard.tsx`, `WealthTrendChart.tsx`), a narrow `{id, label}` option type, and no icon slot. Any change to this primitive is felt everywhere at once — the same "widely-shared component, extend carefully" risk already named for `SegmentedControl` in the Transactions plan.

**There is no existing scroll-direction/hide-on-scroll mechanism anywhere in this codebase** (grep-verified across `onScroll`/`useScroll`/`scrollY`/`IntersectionObserver` — the handful of hits are unrelated: body-scroll-locking, an unrelated CSS renderer, a modal). This is genuinely new interaction code, not an extension of something that already exists.

---

## 2. Current state (verified)

- **`lib/perspectives.ts`** — `PerspectiveDef` (`:47–60`+) already has `id, label, description, icon (Lucide name string), status, group`. The icon-name convention is shared with `lib/widget-registry.ts` and `lib/timeline-types.ts` per this file's own doc comment.
- **Icon resolution precedent already exists** — `components/space/widgets/TimelineWidget.tsx` (`:40`) defines a local `const ICON_MAP: Record<string, React.ElementType> = {...}` mapping icon-name strings to imported Lucide components, with a safe fallback (`(name && ICON_MAP[name]) || Activity`) and a tiny resolver rendering `<Icon size={14} />`. This is the established, precedented pattern for turning a `PerspectiveDef.icon` string into a real component — reuse the shape, don't invent a new resolution mechanism.
- **`PerspectiveTabs.tsx`** (full file read) — renders the six lenses as one `SegmentedControl` track; maps `items` to `{id, label}` only; `icon` is never read. Comment: "the shell has a single active-state grammar (the Meridian-glass sliding highlight) across presets and tabs."
- **`PerspectiveShell.tsx`** (full file read) — exactly two stacked containers today, Container 1 first: Row A `ShellContextRow` (As of / swap / Compare to / Completeness / Evidence chips) + Row B `CashFlowPeriodSelector` (the period-preset segmented control — this is "the time machine toggle" the user means), then Container 2: `PerspectiveTabs`. Doc comment: *"time and trust remain fixed; the lens changes."* Reordering these two containers is a same-file JSX change — no other file depends on their relative order (both are presentation-only, receiving all state via props from the host).
- **`components/atlas/SegmentedControl.tsx`** (full file read) — the shared "Apple-style segmented control," one glass capsule with a sliding Meridian-tint highlight. `SegmentedControlOption<T>` is `{id, label}` — no icon field. Already has: a centered/self-contained capsule shape (`rounded-[var(--radius-full)]`, translucent glass background, `backdrop-filter: blur(30px)`), horizontal-scroll overflow for narrow widths (`.no-scrollbar`), and a `useLayoutEffect`-driven sliding highlight that re-measures on value/resize — **no scroll-position awareness at all**. Six real consumers confirmed via grep: `SpaceDashboard.tsx`, `PerspectiveTabs.tsx`, `CashFlowPeriodSelector.tsx`, `TimelineWidget.tsx`, `WealthCompositionCard.tsx`, `WealthTrendChart.tsx`.
- **The Space-level rail tabs** — `lib/space-nav.ts` owns `SPACE_TAB_LABELS` (id → label) and `railVisibleTabs(host)`; `SpaceDashboard.tsx:2411` builds `railOptions: {id, label}[]` from it (Settings filtered out, order fixed by `SPACE_TAB_ORDER`). No icon field exists on this path today (a separate, coarser-grained concept than Perspectives — `OVERVIEW/GOALS/ACCOUNTS/DEBT/INVESTMENTS/RETIREMENT/ACTIVITY` etc., not the same list as the Perspective lenses). **The user's request scopes icons to the Perspective tabs only, not this rail** — confirmed against the literal ask ("on the perspectives tab i want to use icons"), so this rail keeps text labels; it only needs the floating-pill/shrink-on-scroll visual treatment, not an icon system.
- **No existing sticky/scroll-aware wrapper around the rail tabs specifically** — `DashboardChrome.tsx` has its own `sticky top-0 z-40` app-wide header (logo/user menu), a separate surface from `railOptions`, which renders inline further down the page body. Confirmed no `sticky` class near the rail-tab render site — today it scrolls away with the page like ordinary content. Making it float and react to scroll is new positioning behavior, not extending an existing sticky treatment.

---

## 3. Bucket 1 — real and cheap

| Item | Real source | Note |
|---|---|---|
| Perspective tab icons | `PerspectiveDef.icon` (already populated for every lens) + the `ICON_MAP` resolution pattern already precedented in `TimelineWidget.tsx` | Surfacing existing data through an already-established resolution shape — the smallest piece of this whole request. |
| Reorder: Perspective tabs above the time/trust block | `PerspectiveShell.tsx`'s two containers, presentation-only | A JSX block swap in one file. |

## 4. Bucket 2 — real, but this is where the actual engineering is

- **Icon slot on `SegmentedControl`.** Must be additive (`icon?: React.ReactNode` on `SegmentedControlOption`) so the five other consumers — none of which pass icons today — are unaffected. Verify each of the six consumers renders correctly with the field simply absent before considering this done.
- **Centered floating pill treatment for both surfaces.** `SegmentedControl` is already a self-contained rounded capsule with glass/blur styling — the "pill" shape substantially already exists. What's new is making it float independent of normal document flow (fixed/sticky positioning, centered rather than stretching to a content column's width) for both the rail tabs and the Perspective tabs specifically, without disturbing the other four consumers who should almost certainly NOT float (Daily Brief's range strip, Wealth's chart controls, Cash Flow's period selector, Timeline's filter) — this strongly implies the floating/shrinking behavior should be a wrapper applied at the two call sites that want it, not a change to `SegmentedControl` itself, which should stay a plain, non-positioned control that anyone can drop anywhere (including inside a floating wrapper).
- **Scroll-driven shrink/hide.** New: a hook (e.g. `useScrollDirection` or `useHideOnScroll`) tracking scroll position/direction on the relevant scroll container, driving a shrink/hide CSS transform. Needs to identify the correct scroll container for each surface (the rail tabs' container vs. the Perspective shell's container may not be the same scrolling element) — this is a real design question, not a default.

## 5. Bucket 3 — should not build yet / needs a decision, not code

- **Exact shrink behavior** (does the pill shrink in place, slide up and hide entirely, or shrink to an icon-only strip?) and **exact scroll thresholds** are product/motion decisions the plan should surface as an explicit open question rather than silently pick one, matching the same discipline used for the Transactions calendar's zero-vs-unavailable cell distinction.
- **Whether the Space-level rail tabs get icons too**, even though not explicitly asked for — flagged as a genuine follow-on question, not assumed in scope, since the two surfaces (Perspectives vs. rail tabs) are conceptually different lists (lenses vs. sections) and Fourth Meridian's icon convention already exists for one but not the other.

---

## 6. Recommended sequencing

1. **Phase 1 — cheap, real, no shared-primitive risk.** Perspective tab icons (via the existing `PerspectiveDef.icon` + a local `ICON_MAP` resolver, same shape as `TimelineWidget.tsx`) + the Container reorder in `PerspectiveShell.tsx`. Ships independently of everything else, immediately visible, zero risk to `SegmentedControl`'s other five consumers.
2. **Phase 2 — the shared-primitive extension + floating wrapper.** Add the optional icon slot to `SegmentedControl` (verified non-breaking for all six consumers), then build a floating-pill wrapper component consumed only by the rail tabs and the Perspective tabs — not a change to `SegmentedControl`'s own positioning.
3. **Phase 3 — scroll physics.** The new scroll-direction hook, wired into the Phase 2 wrapper, applied to both surfaces once the wrapper itself is confirmed correct and non-disruptive.

Each phase independently shippable and revertible — this mirrors the same "small slices, stop and verify" discipline used for every other feature this week, and is more important here than usual because Phase 2 touches a primitive six other features depend on.

---

## 7. Open questions before an implementation plan is written

1. Shrink behavior on scroll: shrink-in-place, slide-and-hide, or collapse-to-icons-only? Pick one deliberately (§5).
2. Should the Space-level rail tabs get icons too, or stay text-only per the literal scope of the request?
3. Scroll container identity for each surface — confirm before Phase 3 is scoped in detail, since a wrong assumption here (e.g. assuming `window` scroll when the actual scroll container is a nested div) would make the whole feature silently not work.
