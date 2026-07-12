# Fourth Meridian — Shell Nav Phase 2: Completion Summary

**Date:** 2026-07-13
**Branch:** `feature/v2.5-spaces-completion` (directly on primary — no worktree, per the request)
**Builds on:** Shell Nav Phase 1, merged at `e0a4f92`
**Plan:** `FOURTH_MERIDIAN_SHELL_NAV_PHASE2_IMPLEMENTATION_PLAN_2026-07-13.md`
**Investigation:** `FOURTH_MERIDIAN_SHELL_NAV_PHASE2_INVESTIGATION_2026-07-13.md`

---

## 1. What shipped — two independent changes

**(1) Icon-only tabs, label revealed only on the active tab** — for both the Space rail and the Perspective track. Inactive tabs show only their icon; the active tab shows icon + label. The four other `SegmentedControl` consumers are untouched (default `labelVisibility="always"`).

**(2) Scroll-follow swap on the Perspectives tab** — the rail stops floating there (renders fully static/in-flow) so the Perspective track becomes the surface that floats and shrinks. Every other tab keeps the floating/shrinking rail.

Five committed, gated slices:

| Slice | Commit | What |
|---|---|---|
| S1 | `8b18926` | `SegmentedControl` `labelVisibility` prop + sr-only collapse + aria-label |
| S2 | `42b5e1a` | `lib/space-nav-icons.ts` + rail icon wiring |
| S3 | `a0246ba` | `labelVisibility="activeOnly"` at both call sites + a11y fix |
| S4 | `08c3b7a` | scroll-follow conditional + `PERSPECTIVE_PILL_TOP` 108→56 |
| S5 | *(this)* | tests (+1, suite 200/200), STATUS.md, completion summary |

---

## 2. The one non-negotiable bar: accessible names (stop condition #1), resolved empirically

The prompt was explicit that hiding the label without an explicit `aria-label` would break assistive tech, and asked to **verify empirically** whether `aria-label` should be unconditional or only under `activeOnly` — *"test it, don't assume."*

I did, against Chrome's live accessibility tree:

- Initial implementation added `aria-label` **only to collapsed (inactive)** tabs, expecting the active tab's visible text to name it.
- Reading the AX tree (`read_page`) showed the **active** tabs (`Perspectives`, `Cash Flow`) as **nameless**, while the icon-only inactive tabs were correctly named.
- Inspecting the DOM: the active tab's label text sits nested inside a child `<span>` (alongside the `aria-hidden` icon). Chrome does **not** surface a name-from-contents through that nesting; the "Manage" button (text a direct child) *was* named, confirming the nesting is the difference. `getComputedAccessibleName` is not exposed to page JS, so the AX tree is the ground truth — and it is the same tree screen readers consume.
- **Resolution:** apply `aria-label={opt.label}` to **every** segment on an `activeOnly` surface (active + inactive), and to **none** on `"always"` surfaces. Re-read the AX tree: all 12 rail + Perspective tabs now expose a name. `aria-label` equals the visible text, so per the ARIA name-computation spec it supersedes the contents and is announced once (no double-announce).

So the empirical answer to the plan's open question: `aria-label` is applied **conditionally on `labelVisibility === "activeOnly"`** (not unconditionally across all consumers — that would alter the four untouched ones — and not only on collapsed tabs, which leaves the active tab nameless in Chrome's tree).

---

## 3. Stop conditions (plan §9) — all five clear

1. **No inactive (or active) tab loses its accessible name.** Every `activeOnly` segment carries an explicit `aria-label`; verified live in Chrome's AX tree (all 12 tabs named). ✅
2. **No rail tab ships iconless.** `lib/space-nav-icons.ts` maps every `SpaceTabId`; a `satisfies Record<SpaceTabId, ElementType>` clause makes an omission a **compile error**, plus a runtime completeness test. ✅
3. **Scroll-follow is a true opt-out, not `shrinkOnScroll={false}`.** On the Perspectives tab the rail renders bare (no `FloatingNavWrapper` at all); asserted by a comment-stripped source-scan test. ✅
4. **The mobile rail-width fix's status was checked first.** `git log` confirmed HEAD was still Phase 1's merge (`e0a4f92`) with no other-session commit landed, so this work proceeded on today's structure as written. ✅
5. **The four untouched `SegmentedControl` consumers are byte-identical.** They default to `labelVisibility="always"` (no `aria-label`, no collapse) and are absent from the diff; verified in-app (period selector, Timeline filter, Wealth composition/trend all unchanged). ✅

---

## 4. Validation gate (run after every slice)

| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** (incl. the `satisfies` completeness guard) |
| `eslint .` | **0 errors** (6 pre-existing warnings) |
| `npm test` | **200/200** (199 + new `space-nav-icons.test.ts`) |
| `git diff --name-only` | matches plan §3 |

New/changed tests: `lib/space-nav-icons.test.ts` (completeness + fallback); `SegmentedControl.test.ts` (+labelVisibility/activeOnly/aria-label cases); `shell-nav.test.ts` (rail unwrapped iff `activeTab === "PERSPECTIVES"`, no `shrinkOnScroll={false}`); `FloatingNavWrapper.test.ts` (new pin offsets).

Files (plan §3): **Modify** `SegmentedControl.tsx`, `PerspectiveTabs.tsx`, `SpaceDashboard.tsx`, `FloatingNavWrapper.tsx` (the one stacking constant). **Add** `lib/space-nav-icons.ts` + its test. `PerspectiveShell.tsx` was **not** touched (the offset changed lives in `FloatingNavWrapper.tsx`, which it only imports). The four untouched consumers are untouched.

---

## 5. In-app verification (authenticated dev session)

- ✅ Rail + Perspective tabs are **icon-only for inactive**, **icon + label for the active** one (rail: Compass · **Layers "Perspectives"** · Activity · Landmark · ArrowLeftRight · Users; lenses: **Gem "Wealth"** · Waves · Droplets · TrendingUp · CreditCard · Target).
- ✅ Activating a lens collapses the old label to its icon and reveals the new one; the highlight re-measure slides + resizes as **one coordinated motion**.
- ✅ On the **Perspectives** tab the rail is **static** (scrolls away) and the **Perspective pill floats and pins at ~56px** (the header line) with no dead gap.
- ✅ On **Overview** (and other tabs) the rail still **floats/shrinks** as in Phase 1.
- ✅ The four untouched consumers (Cash Flow period selector, Timeline filter, Wealth composition/trend, the range strip) render with full labels, unchanged.
- ✅ Accessibility tree: every rail + Perspective tab exposes a name.

---

## 6. Notes for review

- **Rail icon choices.** The plan §2.2 suggested `GOALS/DEBT/INVESTMENTS/RETIREMENT` glyphs, but those are Perspective lenses, not rail tabs — the actual `SPACE_TAB_LABELS` ids are `OVERVIEW/PERSPECTIVES/ACTIVITY/FINANCES/ACCOUNTS/TRANSACTIONS/MEMBERS/DOCUMENTS/SETTINGS`, which is what's mapped (reusing the plan's OVERVIEW→Compass, ACCOUNTS→Landmark, ACTIVITY→Activity; the rest chosen per section: PERSPECTIVES→Layers, FINANCES→Wallet, TRANSACTIONS→ArrowLeftRight, MEMBERS→Users, DOCUMENTS→FileText, SETTINGS→Settings). Any of these glyphs is a cheap swap if a different one reads better.
- **Perspective pill sticky range** remains bounded by `PerspectiveShell`'s container (the Phase 1 note): the pill pins near the top of the shell then scrolls with the workspace. The scroll-follow swap correctly makes the rail static and hands the floating role to the Perspective track within that range; hoisting the pill one level for full-range pinning is still the small optional follow-up flagged in Phase 1.
