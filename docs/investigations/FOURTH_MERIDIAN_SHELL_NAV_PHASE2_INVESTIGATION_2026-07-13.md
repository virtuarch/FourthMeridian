# Fourth Meridian — Shell Nav Phase 2 (icon-only + scroll-follow swap): Investigation

**Date:** 2026-07-13
**Scope:** Two refinements to the just-merged Shell Nav redesign (`e0a4f92`), based on direct feedback after seeing it live: (1) both the Space rail tabs and the Perspective tabs go icon-only, revealing the text label only for the currently active tab; (2) on the Perspectives tab specifically, the floating/shrink-on-scroll behavior swaps from the rail tabs to the Perspective tabs — the rail goes static while a Perspective view is open, the Perspective track becomes the one that floats and shrinks.
**Explicitly out of scope:** the mobile rail-width overflow bug — a separate Claude Code session is already diagnosing that live; this plan assumes it lands separately and doesn't touch the same rendering it's likely to change.
**Confirmed already-correct, no change needed:** default selections. `TAB_ORDER`/`railVisibleTabs` resolve the rail's default to Overview; `defaultPerspectiveId`'s own comment in `SpaceDashboard.tsx:2451` confirms "Default = the first workspace-backed Perspective (Wealth)."

---

## 1. Executive assessment

**Both asks are real, bounded, and build directly on code from the just-shipped work — nothing here requires touching `SegmentedControl`'s core measurement/highlight logic.**

**Icon-only-with-reveal-on-active is the one piece of accessibility work the prior slice deliberately deferred, now becoming a real requirement.** Verified: today, `SegmentedControl`'s only accessible name for each `role="tab"` button is its visible text content — no `aria-label` exists anywhere in the component. If the label is hidden visually for inactive tabs, an explicit `aria-label` per option becomes mandatory, not optional, or every inactive tab loses its name for assistive tech. This is a small, well-defined addition, not a redesign.

**The scroll-follow swap is a single conditional in one file.** Verified: `SpaceDashboard.tsx:3135` wraps the rail unconditionally in `<FloatingNavWrapper top={RAIL_PILL_TOP}>`; `activeTab` is already in scope at that exact call site (used the very next line as `value={activeTab}`). Making the wrapper conditional on `activeTab !== "PERSPECTIVES"` is the entire mechanism — no new component, no new state.

---

## 2. Current state (verified)

- **`SegmentedControl.tsx`** (full file re-read) — `SegmentedControlOption<T>` has `icon?: ReactNode` (Phase 1). Render (`:167–178`): icon (if present) + `opt.label`, both inside the button; the button's only accessible name today is that visible content — confirmed no `aria-label` attribute exists on the `<button role="tab">` anywhere in the file.
- **`PerspectiveTabs.tsx`** (full file re-read) — resolves `PerspectiveDef.icon` via `TabIcon` (a static component wrapping `PERSPECTIVE_ICON_MAP`/`PERSPECTIVE_ICON_FALLBACK` from `lib/perspective-icons.ts`), passes `icon` + full `label` (with the "· soon" suffix logic) to every option unconditionally — no active-only label logic exists yet.
- **Rail tabs** — `SpaceDashboard.tsx:2412` builds `railOptions: {id, label}[]` (no icon at all today — Phase 1 scoped icons to Perspectives only, per the original request's literal wording). `:3135–3142` wraps them in `FloatingNavWrapper` unconditionally.
- **`FloatingNavWrapper.tsx`** (full file re-read) — `shrinkOnScroll` prop already exists, default `true`, documented as the way to "opt out of S5" per-surface. No `activeTab`-conditional logic exists — it's a static prop today, not derived from app state.
- **Perspective tab mount** — `PerspectiveShell.tsx:58` wraps `PerspectiveTabs` in `<FloatingNavWrapper top={PERSPECTIVE_PILL_TOP}>` unconditionally (this file only renders when the Perspectives tab is active in the first place, so no swap logic is needed on this side — it already only exists in the one context that matters).
- **Stacking math** — `RAIL_PILL_TOP = APP_HEADER_H` (56px), `PERSPECTIVE_PILL_TOP = APP_HEADER_H + PILL_H + 6` (108px), designed for both pills coexisting today. If the rail goes static on the Perspectives tab, the Perspective pill no longer needs to pin below a floating rail — it could reasonably pin higher (closer to `RAIL_PILL_TOP`) once the rail isn't floating above it. This is a real follow-on question, not a defaulted assumption (§4).

---

## 3. Icon-only + reveal-on-active — exact mechanism

- `SegmentedControlOption<T>` gains an `aria-label`-equivalent: since `label` already exists and is the natural accessible name, the cleanest shape is: always render `aria-label={opt.label}` on the button (harmless/redundant when the label is visible, load-bearing when it's hidden), and visually hide the label text for inactive options via a new option — either a control-level prop (`labelVisibility: "always" | "activeOnly"`) or a per-option `hideLabelWhenInactive?: boolean`. Recommend the control-level prop: this is a per-surface presentation choice (rail + Perspective tabs want it; the four untouched consumers don't), not a per-option one within a single track.
- When hidden, the label should collapse via CSS (`sr-only`-equivalent: visually hidden but still in the DOM and read by `aria-label`/accessible-name computation) rather than being conditionally unrendered — simpler, avoids the button's hit-target/width jumping oddly per-option, and the sliding highlight's `measure()` (`getBoundingClientRect`) will naturally reflect each button's real (icon-only, narrower) width once the label is visually collapsed, which is also exactly the "free up space" goal.
- **This changes tab width per active state** — when a tab becomes active and its label reveals, its button width grows, which shifts every tab to its right. The sliding highlight already re-measures on `value` change (`useLayoutEffect` in `SegmentedControl`) so the highlight itself will track correctly, but confirm the transition looks intentional (a coordinated width + highlight animation) rather than jarring — this is a real motion-design point worth a deliberate pass, not an assumption.
- **Rail tabs need icons for the first time** — Phase 1 scoped icons to Perspectives only. This ask now wants icons on the rail too. `SPACE_TAB_LABELS`/`railVisibleTabs()` (`lib/space-nav.ts`) currently carry no icon field — a new, additive icon map keyed by rail tab id (`OVERVIEW`, `GOALS`, `ACCOUNTS`, `DEBT`, `INVESTMENTS`, `RETIREMENT`, `ACTIVITY`, etc.) needs to be authored, following the exact same resolution shape as `lib/perspective-icons.ts` (a sibling module, e.g. `lib/space-nav-icons.ts`, not a modification to `lib/perspectives.ts` which is a conceptually different list).

---

## 4. Scroll-follow swap — exact mechanism and one open question

- `SpaceDashboard.tsx`'s rail render becomes conditional: when `activeTab === "PERSPECTIVES"`, render the rail's `SegmentedControl` in-flow (no `FloatingNavWrapper` at all — matching exactly how the four untouched consumers render, i.e. a real "opt out," not `shrinkOnScroll={false}` with the wrapper still floating/positioning it). When `activeTab` is anything else, keep today's behavior (floating + shrinking) unchanged.
- `PerspectiveShell.tsx`'s own `FloatingNavWrapper` around `PerspectiveTabs` needs no conditional — it already only renders while inside the Perspectives tab.
- **Open question, not to be defaulted:** once the rail is static on the Perspectives tab, should `PERSPECTIVE_PILL_TOP` shrink back toward `RAIL_PILL_TOP` (since there's no longer a floating rail above it to clear), or stay where it is (leaving a visually consistent gap matching the rail's own in-flow height)? Recommend confirming this visually during implementation rather than guessing the right pixel value up front.

---

## 5. Sequencing

1. **Slice A — icon-only + reveal-on-active.** `SegmentedControl`'s new label-visibility prop + `aria-label`, the new rail icon map, wiring both surfaces. Independently valuable and testable without touching scroll behavior at all.
2. **Slice B — scroll-follow swap.** The `activeTab`-conditional rail wrapper. Independent of Slice A — could ship in either order or the same PR, but keep them as separate commits so a regression in one is easy to isolate.
3. **Do not touch** the rail-width mobile-overflow rendering path until the other session's fix has landed — re-diff against primary before starting to make sure this work composes with whatever that fix changes.

---

## 6. Open questions for the plan

1. Label-visibility as a control-level prop vs. a route/context-driven default — confirmed control-level is simplest (§3).
2. `PERSPECTIVE_PILL_TOP`'s exact value once the rail is static on that tab (§4) — a visual call, not a default.
3. Rail icon choices for `OVERVIEW/GOALS/ACCOUNTS/DEBT/INVESTMENTS/RETIREMENT/ACTIVITY` (and any other rail tabs per Space category) — needs a specific icon-per-id list, same as `PerspectiveDef.icon` did, authored fresh since no such mapping exists today.
