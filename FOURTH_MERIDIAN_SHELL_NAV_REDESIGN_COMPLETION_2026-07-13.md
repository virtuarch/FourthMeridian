# Fourth Meridian — Shell Navigation Redesign: Completion Summary

**Date:** 2026-07-13
**Branch:** `feature/shell-nav-redesign` (worktree off `HEAD` = `68a4fb2`) — **NOT merged to primary; held for review as instructed.**
**Plan:** `FOURTH_MERIDIAN_SHELL_NAV_REDESIGN_IMPLEMENTATION_PLAN_2026-07-13.md`
**Investigation:** `FOURTH_MERIDIAN_SHELL_NAV_REDESIGN_INVESTIGATION_2026-07-13.md`

---

## 1. What shipped

Both the **Space rail tabs** and the **Perspective lens tabs** are now **centered floating glass pills** that **shrink modestly on scroll-down and return to full size on scroll-up / near the top** (a scale-down, never a hide). The **Perspective tabs gained icons**, and the **Perspective tab track moved above** the time/trust + period-preset block. The four other `SegmentedControl` consumers are **untouched and byte-identical**.

Delivered as six independently-committed, independently-gated slices:

| Slice | Commit | What |
|---|---|---|
| S1 | `aa9803c` | Perspective tab icon plumbing + shared resolver |
| S2 | `f43163d` | Reorder `PerspectiveShell` (lens tabs above time/trust) |
| S3 | `1b00e7e` | Additive `icon?` slot on `SegmentedControl` + wire tab icons |
| S4 | `34c0047` | `FloatingNavWrapper` (centered floating pill, no motion) |
| S5 | `32562f4` | `useScrollShrink` hook + wire the shrink into the wrapper |
| S6 | *(this)* | Tests (+5), STATUS.md, completion summary |

---

## 2. Slice detail

**S1 — Perspective tab icons (data plumbing).** The `PerspectiveDef.icon` → Lucide component mapping already existed as a module-private `ICON_MAP` in `PerspectivesWidget.tsx`. Per plan §2.1 ("reuse that resolver rather than writing a third one"), it was extracted into a shared `lib/perspective-icons.ts` (`PERSPECTIVE_ICON_MAP` + `PERSPECTIVE_ICON_FALLBACK`), and `PerspectivesWidget` now consumes it (pure, behavior-identical refactor — same Sparkles fallback, member-access lookup to keep the `react-hooks/static-components` rule satisfied). `PerspectiveTabItem` gained optional `icon?: string`, threaded from `PerspectiveDef.icon` at the `SpaceDashboard` call site. Icons render once the S3 slot exists.

**S2 — Reorder `PerspectiveShell`.** Pure JSX swap: the `PerspectiveTabs` track (Container 2) renders above the time/trust + period-preset block (Container 1). Container numbering kept its original semantics; only render order and the doc comment changed. No prop/state/host changes.

**S3 — `SegmentedControl` icon slot (the shared-primitive change).** `SegmentedControlOption<T>` gained an **additive optional** `icon?: ReactNode` (a pre-resolved node, so the primitive stays icon-library-agnostic). It renders before the label inside an inner flex span **only when present**; when absent, the segment renders its bare `opt.label` exactly as before. `PerspectiveTabs` resolves the icon name via the shared map through a static `TabIcon` component (mirrors `TimelineWidget`'s `EventIcon` precedent), size 14, `aria-hidden` — the visible label remains the accessible name. Icon-only rendering was **deliberately deferred** as an open product decision (investigation §5/§7) to avoid dropping accessible names.

**S4 — `FloatingNavWrapper` (positioning only).** New `components/atlas/FloatingNavWrapper.tsx`: centers a `SegmentedControl` and pins it (`position: sticky`, `z-30`, below the `h-14`/`z-40` app header) as a floating glass pill. It adds **no background of its own** — the wrapped control supplies the glass — so `SegmentedControl` stays a plain, reusable control (stop condition #5). Mounted at exactly the two intended call sites (the rail in `SpaceDashboard`, and Container 2 in `PerspectiveShell`, replacing the old bordered selector frame). Shipped with the shrink inert (`scale = 1`) — the deliberate "does the centered pill look right?" checkpoint.

**S5 — `useScrollShrink` + wiring.** New `components/atlas/useScrollShrink.ts`. The **scroll container was verified = window** before any code: `DashboardChrome` is `flex min-h-screen` with no nested overflow scroller in the main content column (the only `overflow-y-auto` is the Sidebar's own nav, a separate column), and its headers pin via `sticky top-0`, which only works against document scroll — so both surfaces share the window. The hook returns a scale (0.9 while scrolling down past a 24px threshold; 1 on scroll-up or near the top), rAF-throttled passive listener, no animation loop. The shrink **decision** is a pure exported `computeShrink()`, unit-tested against a scripted scroll sequence. `FloatingNavWrapper` consumes the hook and applies the scale via its CSS `transition: transform var(--dur-base)`, so the global `prefers-reduced-motion` rule (`transition-duration: 0.01ms !important`, verified in `globals.css`) makes the size change instant with **no bespoke JS reduced-motion branch**.

**S6 — Tests + polish.** +5 test files (suite 194 → **199/199**), STATUS.md bullet, this summary.

---

## 3. Stop conditions — all five clear

1. **No untouched consumer changed.** The four other consumer files (`CashFlowPeriodSelector`, `TimelineWidget`, `WealthCompositionCard`, `WealthTrendChart`) are **absent from the branch diff**, and a source-scan guard test (`shell-nav.test.ts`) locks that none of them import `FloatingNavWrapper`/`useScrollShrink` or pass an `icon`. The additive `icon?` field's label-only branch is DOM-identical. ✅
2. **Scroll container verified before wiring** (window; §2.4/§5) — not assumed. ✅
3. **Shrink is a modest scale, not a hide** (0.9, returns to full) — matches the literal "shrinks as you scroll" ask. ✅
4. **Accessible name preserved** — the visible label stays; the glyph is `aria-hidden`; icon-only deferred. ✅
5. **`SegmentedControl` stays plain** — no positioning/scroll logic added to the primitive (asserted by test); the floating/scroll behavior lives entirely in `FloatingNavWrapper` + the hook. ✅

---

## 4. Validation gate (run after every slice)

| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `eslint .` | **0 errors** (6 pre-existing warnings, none in new files) |
| `npm test` | **199/199** (194 baseline + 5 new) |
| `git diff --name-only` | matches §3 (+ the one documented deviation below) |

New tests: `lib/perspective-icons.test.ts` (map completeness vs every `PerspectiveDef.icon`; fallback), `components/atlas/useScrollShrink.test.ts` (`computeShrink` scripted sequence), `components/atlas/SegmentedControl.test.ts` (additive slot, byte-identical label-only path, no positioning), `components/atlas/FloatingNavWrapper.test.ts` (centered/sticky, no own background, hook consumption, stacking offsets), `components/space/shell/shell-nav.test.ts` (reorder, icon wiring, **untouched-consumer guard**).

---

## 5. Deviations from the plan (explicit)

- **`PerspectivesWidget.tsx` in the diff** (§3 listed 4 modify + 3 add). This is the plan-§2.1-authorized DRY refactor: reusing the existing resolver required exporting it, so `PerspectivesWidget` now consumes the shared `lib/perspective-icons.ts`. It is **behavior-identical** and is **not** a `SegmentedControl` consumer, so it triggers no stop condition.
- **Hook location:** colocated at `components/atlas/useScrollShrink.ts` rather than `lib/hooks/` — the house convention is colocated hooks (`lib/hooks/` does not exist; cf. `components/atlas/useBodyScrollLock.ts`), and plan §3 explicitly allowed "co-located with the wrapper."

Full branch diff (8 source files + 5 tests): `FloatingNavWrapper.tsx` (A), `useScrollShrink.ts` (A), `lib/perspective-icons.ts` (A), `SegmentedControl.tsx` (M), `SpaceDashboard.tsx` (M), `PerspectiveShell.tsx` (M), `PerspectiveTabs.tsx` (M), `PerspectivesWidget.tsx` (M).

---

## 6. Review points / follow-ups (flagged, not silently taken)

- **Perspective pill sticky range.** The rail pill has a tall parent (the `max-w-5xl` content column) so it pins over all content. The Perspective pill was mounted per plan §2.4 **inside `PerspectiveShell` Container 2**, whose containing block is short (the two-container shell div), so its sticky range is bounded — it pins briefly below the rail, then scrolls with the content. This is a reasonable UX (global rail persists; the lens picker is top-of-view). Making it pin over the whole workspace is a small follow-up: hoist its `FloatingNavWrapper` one level, to be a direct child of the tall `space-y-4` container that also holds the workspace. Left as a review decision rather than diverging from the plan's mount point.
- **Stacking offsets** (`RAIL_PILL_TOP = 56`, `PERSPECTIVE_PILL_TOP = 108`) are pixel math worth eyeballing when both pills coexist on the Perspectives tab.
- **Icon-only tabs** (dropping the visible label to save more space) remain an open product decision — would require a per-option `aria-label` (stop condition #4).

---

## 7. Manual verification (delegated — needs the authenticated dev env)

The automated gate was run after every slice. The **live pixel pass** could not be run here: the running dev server on :3000 serves the primary branch, and viewing the pills requires an authenticated session against a populated Space (the user's env). On `feature/shell-nav-redesign`, run `npm run dev` and confirm:

- [ ] Perspective tabs show **icons** (Wealth Gem, Cash Flow Waves, Liquidity Droplets, Investments TrendingUp, Debt CreditCard, …) alongside labels.
- [ ] The Perspective **tab track renders above** the As-of / Compare-to + period-preset block.
- [ ] The **rail tabs** and **Perspective tabs** each render as a **centered floating pill**, pinned below the header, content scrolling under them.
- [ ] Both **shrink** modestly on scroll-down and **return to full size** on scroll-up / near the top (not a hide).
- [ ] **Pixel-identical to before** (the five untouched consumers): the Daily Brief range strip, Wealth composition/trend chart controls, and the Cash Flow period selector.
- [ ] With **Reduce Motion** enabled (OS setting), the shrink is instant (no animated tween), and the pill still resizes.
