# Fourth Meridian — Shell Nav Phase 2: Implementation Plan

**Date:** 2026-07-13
**Branch of record:** `feature/v2.5-spaces-completion` (Shell Nav Phase 1 already merged, `e0a4f92`)
**Scope:** Per `FOURTH_MERIDIAN_SHELL_NAV_PHASE2_INVESTIGATION_2026-07-13.md` — (A) icon-only tabs with the label revealed only on the active tab, for both the rail and the Perspective track; (B) the floating/shrink-on-scroll behavior swaps from the rail to the Perspective track specifically while the Perspectives tab is open. **Not in scope: the mobile rail-width overflow bug** — verify against primary for a landed fix before starting, don't fix it here.

---

## 1. Repository findings (see the investigation doc for full citations)

- `SegmentedControl.tsx` has no `aria-label` anywhere — the visible label is every tab's only accessible name today. Hiding it visually without an explicit `aria-label` would break assistive tech.
- `PerspectiveTabs.tsx` already resolves icons via `TabIcon`/`lib/perspective-icons.ts`; rail tabs (`SpaceDashboard.tsx:2412`, `lib/space-nav.ts`) have no icon field or mapping today — new work, not a resurfacing.
- `SpaceDashboard.tsx:3135` wraps the rail in `FloatingNavWrapper` unconditionally; `activeTab` is already in scope at that call site.
- `PerspectiveShell.tsx:58` already only renders while Perspectives is open — no conditional needed on that side.
- `RAIL_PILL_TOP` / `PERSPECTIVE_PILL_TOP` stacking constants (`FloatingNavWrapper.tsx`) were designed for both pills coexisting — revisit `PERSPECTIVE_PILL_TOP`'s value once the rail goes static on that tab (open question, §2.3).

---

## 2. Exact implementation design

### 2.1 `SegmentedControl.tsx` — label visibility + accessible name

- New prop: `labelVisibility?: "always" | "activeOnly"` (default `"always"` — every existing consumer's behavior is unchanged without touching call sites).
- Always render `aria-label={opt.label}` on the `<button role="tab">`, regardless of `labelVisibility` — harmless when the label is visible, load-bearing when it's collapsed. Verify this doesn't create a redundant-announcement issue when the label IS visible (some screen readers double-announce visible text + aria-label on the same element) — if so, make `aria-label` conditional on `labelVisibility === "activeOnly"` instead of unconditional; decide by testing, not by assumption.
- When `labelVisibility === "activeOnly"` and the option is NOT active: visually collapse the label (a `sr-only`-equivalent utility — width/overflow clipped, not `display: none`, so it stays in the accessibility tree and the button's `aria-label` isn't the only thing carrying the name if a chosen approach keeps text-content-based naming instead). When active: render normally (icon + full label, exactly today's rendering).
- The sliding highlight's existing `measure()` (`useLayoutEffect`, keyed on `value`) will naturally re-measure the now-different button widths on activation/deactivation — no change needed there, but confirm visually that the width change reads as one coordinated motion, not two disjoint jumps (investigation §3).

### 2.2 Rail icons — new mapping, new module

- New `lib/space-nav-icons.ts` (sibling to `lib/perspective-icons.ts`, not a modification to it — rail tabs and Perspectives are different concepts per `lib/perspectives.ts`'s own doc comment). Recommended starting mapping, reusing the **same icon already assigned to the equivalent Perspective concept** where one exists (consistency across the two nav surfaces for the same underlying idea):
  - `OVERVIEW` → `Compass` (matches `lib/perspectives.ts`'s own `"overview"` → `Compass`)
  - `GOALS` → `Target` (matches Perspective `goals`)
  - `DEBT` → `CreditCard` (matches Perspective `debt`)
  - `INVESTMENTS` → `TrendingUp` (matches Perspective `investments`)
  - `RETIREMENT` → `PiggyBank` (matches Perspective `retirement`)
  - `ACCOUNTS` → `Landmark` (no Perspective equivalent; a common "institution/accounts" glyph, already used elsewhere in this codebase per `TimelineWidget.tsx`'s own `ICON_MAP`)
  - `ACTIVITY` → `Activity` (no Perspective equivalent; matches `TimelineWidget.tsx`'s own `ICON_MAP` entry for the same concept)
  - Any other rail tab id present in `SPACE_TAB_LABELS` not listed here needs its own choice during implementation — don't leave any rail tab silently iconless once this ships (that would look like a bug, not a deliberate omission).
- Follow the exact `ICON_MAP` + safe-fallback shape already used twice in this codebase (`TimelineWidget.tsx`, `lib/perspective-icons.ts`) — a third, differently-shaped resolver would be an inconsistency, not a fresh design.

### 2.3 Scroll-follow swap

- `SpaceDashboard.tsx`'s rail render: wrap the existing `<SegmentedControl aria-label="Space section" options={railOptions} value={activeTab} onChange={setActiveTab} />` in `FloatingNavWrapper` only when `activeTab !== "PERSPECTIVES"`; render it bare (in-flow, no wrapper at all) when `activeTab === "PERSPECTIVES"` — matching exactly how the four untouched `SegmentedControl` consumers render, not `shrinkOnScroll={false}` (which would still float/position it, just without the shrink animation — not what's being asked).
- Re-examine `PERSPECTIVE_PILL_TOP` once the rail is static on that tab — with no floating rail above it to clear, decide during implementation (visually) whether it should move closer to `RAIL_PILL_TOP`'s value or stay as-is for a consistent gap against the rail's own in-flow height. Don't guess a number without looking at it rendered.

---

## 3. Files

**Modify:**
- `components/atlas/SegmentedControl.tsx` — `labelVisibility` prop, `aria-label`, collapsed-label rendering (§2.1).
- `components/space/shell/PerspectiveTabs.tsx` — pass `labelVisibility="activeOnly"`.
- `components/dashboard/SpaceDashboard.tsx` — rail icons wired in, `labelVisibility="activeOnly"` passed, the `activeTab !== "PERSPECTIVES"` conditional wrapper (§2.3).
- `components/space/shell/PerspectiveShell.tsx` — only if `PERSPECTIVE_PILL_TOP`'s value changes (§2.3); otherwise untouched.
- `components/atlas/FloatingNavWrapper.tsx` — only if the stacking constants need adjusting; the wrapper's own logic shouldn't otherwise need to change (the conditional lives at the call site, not inside the wrapper).

**Add:**
- `lib/space-nav-icons.ts` (§2.2) + a colocated completeness test (every rail tab id in `SPACE_TAB_LABELS` has an icon — same shape as the existing `lib/perspective-icons.test.ts`).
- Extend `SegmentedControl.test.ts` with `labelVisibility="activeOnly"` cases: inactive options render a collapsed label + `aria-label`; the active option renders the full label; `labelVisibility="always"` (the default) is unchanged from today.
- Extend `shell-nav.test.ts` (or add a new colocated test) asserting the rail is NOT wrapped in `FloatingNavWrapper` when `activeTab === "PERSPECTIVES"`, and IS wrapped otherwise.

**Explicitly untouched:** `CashFlowPeriodSelector.tsx`, `TimelineWidget.tsx`, `WealthCompositionCard.tsx`, `WealthTrendChart.tsx` (still don't pass `labelVisibility`, defaulting to `"always"` — byte-identical), `lib/perspectives.ts`, `lib/perspective-icons.ts` (consumed for the icon-reuse pattern, not modified), the mobile rail-width fix (out of scope, verify it's landed before starting).

---

## 4. Slice plan

- **S1 — `SegmentedControl` label-visibility + `aria-label`.** Default-unchanged for existing consumers; new prop tested in isolation with fixture options.
- **S2 — Rail icon map + wiring.** `lib/space-nav-icons.ts`, completeness test, wired into `SpaceDashboard.tsx`'s `railOptions`.
- **S3 — `labelVisibility="activeOnly"` wired at both call sites** (rail + `PerspectiveTabs`). Visual checkpoint: confirm the width-change-on-activation motion looks coordinated.
- **S4 — Scroll-follow conditional.** The `activeTab !== "PERSPECTIVES"` wrapper swap in `SpaceDashboard.tsx`; revisit `PERSPECTIVE_PILL_TOP` if needed.
- **S5 — Tests + polish + STATUS.md.**

---

## 5. Risks

- **Accessible-name regression** if `labelVisibility="activeOnly"` ships without `aria-label`, or with a `display: none` collapse that removes the option from the accessibility tree entirely instead of visually hiding it.
- **Redundant screen-reader announcement** if `aria-label` is applied unconditionally alongside a still-visible label — verify, don't assume, per §2.1.
- **Disjointed width-change animation** on tab activation (label reveal shifts every tab to its right) — a real motion-design risk, not just a functional one.
- **Silently iconless rail tab** — every id in `SPACE_TAB_LABELS` must get an icon; the completeness test (§3) is what catches an omission before it ships as a visible gap.
- **Racing the mobile-width fix** — re-diff against primary before starting S1; if the other session has already changed the rail's render structure, adjust this plan's file-level instructions to match rather than reverting its fix.

## 6. Overengineering check

Confirmed feasible as: one new prop + accessible-name handling on an already-existing shared control, one new icon map (same shape as two existing precedents), one conditional at one call site. Rejected: a new `SegmentedControl` variant/fork; changing `PerspectiveShell`'s mount structure beyond the one constant it might need to adjust; touching the four untouched consumers.

## 7. Testing expectations

`SegmentedControl.test.ts`: `labelVisibility="always"` (default) unchanged; `"activeOnly"` collapses inactive labels and reveals the active one; `aria-label` present per option; accessible name computable for an inactive, visually-label-less option. `lib/space-nav-icons.test.ts`: every `SPACE_TAB_LABELS` id has an icon, safe fallback exists. Rail wrapper conditional: a fixture/source-scan test asserting the rail is unwrapped exactly when `activeTab === "PERSPECTIVES"`.

## 8. Validation gate

```bash
npx tsc --noEmit
npx eslint
npm test
git diff --name-only   # must match §3
npm run dev             # manual pass: both navbars show icon-only for inactive tabs,
                         # full icon+label for the active one; the width/highlight
                         # transition on activation looks coordinated; on the
                         # Perspectives tab the rail is static (no float/shrink)
                         # and the Perspective track floats/shrinks instead; every
                         # other tab keeps the rail floating/shrinking as before;
                         # screen-reader spot check confirms inactive tabs still
                         # announce a name
```

## 9. Stop conditions

1. Any inactive tab loses its accessible name (no visible label AND no `aria-label`).
2. A rail tab id ships with no icon (silently falls to a generic fallback that reads as a bug, not a choice).
3. The scroll-follow conditional is implemented as `shrinkOnScroll={false}` instead of removing the wrapper entirely on the Perspectives tab — those are different behaviors; the ask is for the rail to go fully static there, not just stop shrinking.
4. This work begins before confirming the mobile rail-width fix's status — check first.
5. Any of the four untouched `SegmentedControl` consumers changes appearance (they should default to `labelVisibility="always"` and never see this work at all).
