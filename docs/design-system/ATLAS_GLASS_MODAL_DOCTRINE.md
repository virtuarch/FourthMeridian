# Atlas Glass — Modal Doctrine

**Status:** Investigation / proposal. No implementation.
**Scope:** Establishes the permanent modal system for Fourth Meridian across desktop and mobile, ahead of migrating the remaining modal family during Step C (Surface Adoption).
**Baseline read:** `components/dashboard/widgets/GlassModal.tsx`, `components/atlas/GlassPanel.tsx`, `app/globals.css`, and the full modal inventory below were read before any recommendation was written.
**Governing philosophy:** restrained, premium, calm, Apple-like polish, Bloomberg seriousness where appropriate. No trendy animation. A system that still feels modern in ten years.

---

## 0. Executive summary

Fourth Meridian does not have a modal *system*. It has roughly eight overlapping modal *recipes* that were each copied from the one before it and then quietly diverged. The two reported UX defects — Add Wallet pinned to the top on desktop, and the 2FA modal clipping vertically — are not isolated bugs. They are two symptoms of the same root cause: **there is no single overlay primitive that owns positioning, sizing, scroll containment, stacking, and accessibility.** Each modal re-implements those concerns by hand, so each modal gets them slightly wrong in a different way.

The `GlassModal` shell (`components/dashboard/widgets/GlassModal.tsx`) is already 80% of the correct answer, and `BriefModal` already solved the hardest structural problem (portaling out of the glass containing-block trap). Neither has been generalized. This doctrine proposes promoting a single overlay primitive — provisionally `OverlaySurface` — into `components/atlas/`, alongside `GlassPanel` and `DataCard`, with two thin presets (`Dialog`, `FormModal`) layered on top. Everything else migrates onto it.

This document catalogues the current state, defines the target doctrine, and proposes a phased migration. It changes no code.

---

## 1. Inventory

Every overlay surface currently in the application, grouped by intent. "Recipe" identifies which of the eight divergent implementations it is built from (see §1.2).

### 1.1 Modal / overlay inventory

| Component | Intent category | Recipe | Z-index | Portaled? | Positioning | Max-height / scroll | A11y (role/focus/esc) |
|---|---|---|---|---|---|---|---|
| `widgets/GlassModal` | **Shared shell** (KPI detail, Perspective, Timeline) | **R1 – GlassModal** | `z-[100]` | No | `items-end sm:items-center` | `sm:max-h-88/90dvh`, body scrolls internally | esc via caller; no role/trap |
| `widgets/TimelineModal` | Detail overlay | R1 (via GlassModal, `size="full"`) | `z-[100]` | No | inherits | inherits (`full` = fixed 92dvh) | inherits |
| `charts/NetWorthChartModal` | Detail / chart | **R2 – Chart inline** | `z-[100]` | No | `items-end sm:items-center` | `sm:max-h-88dvh`, internal scroll | no role/trap; esc unclear |
| `dashboard/AccountModal` | Management dialog | R2 + nested full-screen chart overlay | `z-[100]` / `z-[110]` | No | `items-end sm:items-center` | `max-h-88dvh` panel, internal scroll | esc yes; no role/trap |
| `dashboard/AddWalletModal` | **Form modal** | **R3 – Form family** | `zIndex 100` (prop-overridable) | No | `items-end sm:items-center` | `max-h` on **inner div**, not panel | **no esc**; no role/trap |
| `dashboard/AddManualAssetModal` | Form modal | R3 | `z-[100]` default | No | `items-end sm:items-center` | `max-h` on inner div | **no esc**; no role/trap |
| `dashboard/CreateSpaceModal` | **Multi-step onboarding** | R3 (hosts nested modals) | `z-[100]` | No | `items-end sm:items-center` | internal | esc yes (guarded mid-submit) |
| `dashboard/ManageSpaceModal` | Management dialog (large, ~1.1k lines) | R3-derived | `z-[100]` | No | `items-end sm:items-center` | internal | partial |
| `dashboard/RemoveAccountModal` | **Confirmation** | **R4 – Confirm (correct sizing)** | `z-[100]` | No | `items-end sm:items-center` | `max-h-88dvh` on **panel** (correct) | no esc; no role/trap |
| `dashboard/AssetDrawer` | Detail dialog (misnamed) | **R5 – Raw scrim** | `z-[100]` | No | `items-center` (centered, not a drawer) | `max-h-88dvh`, internal scroll | esc yes; no role/trap |
| `dashboard/TotpSection` (setup) | **Form modal (2FA)** | **R6 – Bespoke, no primitive** | `z-50` | No | `items-center` | **none — no max-h, no scroll** ⚠ | no esc; no role/trap |
| `dashboard/TotpSection` (verify/disable) | Form modal (2FA) | R6 | `z-50` | No | `items-center` | **none — no max-h, no scroll** ⚠ | no esc; no role/trap |
| `brief/BriefModal` | **Reading / briefing overlay** | **R7 – Portal (correct a11y)** | `z-[9999]` | **Yes** ✅ | `items-center` | `max-h-85vh`, internal scroll | **role="dialog" + aria-modal + esc + body-lock** ✅ |
| `brief/AttentionModal` | Briefing content | Rendered inside R7 | — | via BriefModal | — | — | inherits |
| `brief/SinceLastVisitModal` | Briefing content | Rendered inside R7 | — | via BriefModal | — | — | inherits |
| `admin/ProviderDiagnosticsDrawer` | **True edge drawer** | **R8 – Admin (hardcoded grays)** | `z-[100]` | No | `justify-end` (right drawer) | full-height, internal scroll | esc yes; **`bg-gray-950`, not tokens** ⚠ |
| `admin/AdminExpandHistoryFlow` | Confirmation / flow | R8 | `z-[150]` | No | `items-center` | `max-w-sm` | **`bg-gray-900`, not tokens** ⚠ |
| `space/sections/DebtPayoffSection` | Full-screen instrument | Bespoke + body-lock | — | No | full-screen | body-lock ✅ | partial |

**Non-modal overlays (popovers / menus)** — governed separately by a lighter popover doctrine, listed for completeness: `widgets/MoreMenu`, `widgets/PerspectiveSwitcher`, `atlas/InlineFilter` (dropdowns, `z-30`/`z-40`), plus `TimelineModal`/filter toolbars. These should **not** be forced onto the modal primitive; they are anchored, not centered, and are called out in §7.

### 1.2 The eight recipes (fragmentation map)

The inventory collapses to eight hand-rolled shells, in rough order of correctness:

- **R1 — GlassModal shell.** The newest and best. `GlassPanel` + theme tokens, `items-end sm:items-center`, viewport-capped height, header/toolbar/footer slots with a scrolling body. Explicitly documented as *not* a replacement for the others "to avoid touching working code" — i.e. the generalization was deferred, not rejected.
- **R2 — Chart inline.** `NetWorthChartModal`'s original inline recipe; R1 was extracted from it. Correct sizing, no slots, duplicated per file.
- **R3 — Form family.** `AddWallet` / `AddManualAsset` / `CreateSpace` / `ManageSpace`. The buggy positioning family: `max-height` lives on an **inner div** instead of the `GlassPanel`, and none of them portal. **Source of the Add Wallet top-pinning defect.**
- **R4 — Confirm.** `RemoveAccountModal`. Structurally the *most correct* of the form-ish shells (max-height on the panel), but still a separate copy.
- **R5 — Raw scrim.** `AssetDrawer`. Bypasses `GlassPanel`; inline `backdrop-filter`/`--scrim`. Named "Drawer" but renders centered.
- **R6 — Bespoke 2FA.** `TotpSection`. Uses `--modal-surface` directly, no `GlassPanel`, **no max-height and no scroll container.** **Source of the 2FA clipping defect.**
- **R7 — Portal.** `BriefModal`. The only modal that portals into `document.body` and the only one with full dialog a11y. Its own header comment documents *exactly* the containing-block bug that afflicts R3 — the fix was applied once and never generalized.
- **R8 — Admin.** `ProviderDiagnosticsDrawer` / `AdminExpandHistoryFlow`. Hardcoded `bg-gray-950/900`, ignoring the glass tokens entirely; will not theme and will not match Atlas Glass.

**Takeaway:** the knowledge to build the correct modal already exists in the codebase — it is just distributed across R1 (structure), R4 (sizing), and R7 (portal + a11y). No modal has all three. The doctrine's job is to unify them.

---

## 2. Modal taxonomy

Fourth Meridian should standardize on **one primitive and three presentation intents**, not a sprawl of bespoke shells. Three intents is the minimum that covers every surface in §1 without forcing dissimilar things to share behavior.

### 2.1 The three intents

1. **Dialog** — short, self-contained, decision- or read-oriented. Confirmations, small detail cards, "are you sure", brief informational overlays. Content is bounded and rarely scrolls. Examples today: `RemoveAccountModal`, `AdminExpandHistoryFlow`, small KPI cards.

2. **Form Modal** — data entry, one or many fields, a clear commit/cancel contract. May grow tall enough to scroll. Examples today: `AddWalletModal`, `AddManualAssetModal`, `TotpSection`, `CreateSpaceModal` (multi-step), `ManageSpaceModal`.

3. **Workspace Overlay** — large, immersive, tool-like surfaces that approach full-screen and host their own internal layout (sub-nav, panels, charts, timelines). Examples today: `AccountModal`, `TimelineModal` (`size="full"`), `NetWorthChartModal`, and every future Meridian Analyst / Perspective Builder / Debt Living Instrument surface.

A fourth presentation, **Edge Drawer**, is a *variant of Workspace Overlay* anchored to a screen edge rather than centered (`ProviderDiagnosticsDrawer`). It is not a separate primitive — it is the same surface with an anchor prop — but it is called out because it is the correct home for admin/enterprise inspector panels.

### 2.2 Why intents, not one-size-fits-all

A single generic `<Modal>` forces a confirmation and a Perspective Builder to share max-width, padding rhythm, and mobile behavior, which is exactly how the current fragmentation started (everyone copied one shell, then overrode it locally until they diverged). Three intents encode the *behavioral* differences that actually matter — how tall it's allowed to get, whether it scrolls, how it presents on mobile, how it lays out actions — while sharing one *structural* core (positioning, portal, scrim, stacking, focus, esc, animation). The intents are presets over the primitive, not parallel implementations.

### 2.3 Why not more than three

Onboarding, editors, wallet import, member invitation, provider config, etc. are **content**, not new structural types. Onboarding is a multi-step Form Modal. An editor is a Workspace Overlay. Wallet import is a Form Modal. Adding a taxonomy entry per feature is what produced R1–R8. The taxonomy is deliberately closed at three intents plus the drawer anchor variant.

---

## 3. Desktop doctrine

Investigated against the existing implementations; the recommendations below reconcile them onto one standard. Where an existing modal already does the right thing, it is cited as the reference.

**Positioning.** Centered both axes, always. Reference: R1/R2 (`sm:items-center justify-center`). The correct rule is `items-end` (bottom sheet) only below the mobile breakpoint, `items-center` at `sm` and up. The Add Wallet defect is *not* a positioning-class bug — its class is already `sm:items-center` — it is a containing-block bug (see §8.1). Positioning is only trustworthy once the surface is portaled.

**Maximum width.** Bind width to intent, not to per-file guesses:
- Dialog: `max-w-md` (≈448px).
- Form Modal: `max-w-md` to `max-w-xl` (single vs. dense/multi-column forms).
- Workspace Overlay: `max-w-3xl` / `max-w-5xl`, and `max-w-[96vw]` for the immersive `full` case. Reference: R1's `SIZE_CLASS` map already encodes exactly this ladder — adopt it verbatim as the width scale.

**Maximum height.** `max-h-[88dvh]` for Dialog/Form/standard Workspace; `~92dvh` for immersive `full`. Two hard rules: (1) the cap must live on the **panel element**, never on an inner wrapper (R4 correct; R3 wrong — the immediate cause of one clipping-class bug); (2) use `dvh`, not `vh`, so mobile browser chrome doesn't clip. `BriefModal`'s `85vh` should migrate to `dvh`.

**Scrolling.** The panel is a `flex flex-col` with a fixed header, a `flex-1 min-h-0 overflow-y-auto` body, and a fixed footer. The `min-h-0` is load-bearing — without it the body refuses to shrink and overflows the cap (R1 documents this precisely). The page behind never scrolls (see §6).

**Action placement.** Actions live in a fixed footer, right-aligned on desktop, primary action rightmost, `Cancel`/secondary to its left. Destructive actions use the coral tone and never occupy the primary (rightmost-by-default) slot without a confirmation step. Reference: `AddWalletModal`'s footer (`Cancel` + primary) is the correct pattern; standardize it.

**Focus.** On open, focus moves to the first interactive element (or the panel itself for read-only dialogs) and is **trapped** within the surface until close. On close, focus returns to the invoking trigger. Today **no modal traps focus** and only `BriefModal` sets a dialog role — this is the single largest accessibility gap and the primitive must own it.

**Keyboard behavior.** `Esc` closes (unless a guarded async commit is in flight — `CreateSpaceModal` already models the guard correctly). `Tab`/`Shift+Tab` cycle within the trap. `Enter` submits the primary action from within form fields where unambiguous (`CreateSpaceModal` does this). Escape handling is currently present in only ~10 files and absent from `AddWallet`/`AddManualAsset`/`RemoveAccount`/`Totp` — the primitive makes it universal.

**Escape handling.** Owned centrally by the primitive via a single keydown listener that respects an `isBusy`/`preventClose` flag, so individual modals stop hand-rolling (and forgetting) it.

**Backdrop.** Scrim `rgba(0,0,0,0.55)` + `backdrop-filter: blur(8px)` is the established Atlas value (R1/R2/R3). Standardize on the `--scrim` token rather than the literal so light/dark and future tuning happen in one place. Backdrop click closes for Dialog and Form Modal; for Workspace Overlay, backdrop click closes only when there are no unsaved changes.

**Layering.** Replace the current ad-hoc ladder (`z-50`, `z-[100]`, `z-[110]`, `z-[150]`, `z-[200]`, `z-[9999]`) with a small named token scale, e.g. `--z-modal: 100`, `--z-modal-nested: 110`, `--z-toast: 200`, `--z-critical: 300`. `BriefModal`'s `9999` and Totp's `50` are both outliers that should normalize. Nested modals (a Form Modal launched from a Workspace Overlay, e.g. Add Wallet inside Create Space) get the `nested` layer via the existing `zIndex` prop pattern — but nesting should be minimized (see §9).

**Animation.** Calm and near-invisible. Scrim fades in over `--dur-fast` (180ms, `--ease-enter`); the panel fades and rises ~8px (or scales from 0.98) over `--dur-base` (240ms, `--ease-enter`); reverse on exit with `--ease-exit`. On mobile, the bottom sheet translates up from the bottom edge. No spring overshoot, no bounce, no blur-in of content, nothing that draws attention to itself. The global `prefers-reduced-motion` block already neutralizes durations — the primitive should additionally drop the transform (not just the timing) under reduced motion so there is zero positional movement.

**Glass material.** One material, from `GlassPanel`: `depth="thick"`, `elevation="e4"`, `radius="xl"`, with the specular top-edge highlight. This matches the design language's own elevation ladder ("E4 — Modal: sheets, dialogs, 70px shadow + scrim behind"). `TotpSection`'s `--modal-surface` and the admin `bg-gray-*` surfaces are the deviations to retire. Ambient `glow` stays off by default and is opt-in per surface (AI surfaces `meridian`/`ai`, premium `brass`) — restrained, never competing with content.

---

## 4. Mobile doctrine

**Investigated question:** should forms become full-screen instead of floating dialogs? **Confirmed, with a refinement.**

The current app already renders every modal as a full-height bottom sheet on mobile (`h-[94dvh]` below the `sm` breakpoint — R1). That is close to right but too blunt: a two-line confirmation should not occupy 94% of the screen. The doctrine ties mobile presentation to the **intent**, not a global default:

- **Dialog → bottom sheet, sized to content.** Anchored to the bottom edge, height = content up to a cap (`max-h-[70dvh]`), rounded top corners, with a grabber affordance. Small confirmations stay light. This confirms the "small confirmations may remain sheets" intuition.
- **Form Modal → full-screen.** Data entry becomes a full-screen surface with a fixed top bar (title + close) and a fixed bottom action bar, edge-to-edge, safe-area aware. This confirms the "form-heavy workflows should become full-screen" intuition and directly fixes the class of problem where a floating dialog plus an open keyboard leaves no room (the mobile analogue of the 2FA clipping). Multi-step forms (`CreateSpaceModal`) especially benefit.
- **Workspace Overlay → full-screen, always.** These are already near-full-screen on desktop; on mobile they are simply full-screen with the app-style top bar.

**Bottom sheets vs. floating dialogs vs. full-screen — recommendation:** floating (centered) dialogs are a **desktop-only** presentation. On mobile, the choice is binary and intent-driven: sheet for Dialog, full-screen for Form/Workspace. No floating centered dialogs on phones.

**Grabber / dismiss.** Sheets support swipe-to-dismiss with a visible grabber; full-screen surfaces dismiss via an explicit close control (no accidental swipe-away of a half-filled form).

---

## 5. Responsive rules

A modal changes presentation at exactly one primary breakpoint, with three secondary conditions:

- **Primary breakpoint — `sm` (640px, Tailwind default, already the app's implicit breakpoint).** Below `sm`: sheet (Dialog) or full-screen (Form/Workspace). At/above `sm`: centered floating surface. This single breakpoint is what R1 already uses; formalize it rather than inventing new ones.
- **Tablets (`sm`–`lg`, portrait).** Treated as desktop (centered), but Form Modals may prefer full-screen in portrait when the content is tall. Rule: if intrinsic content height would exceed `~85dvh` at the tablet width, promote to full-screen rather than scroll a floating card.
- **Landscape phones.** Short viewport height is the hazard. Force full-screen for anything but the smallest Dialog, because a centered card in a 380px-tall landscape viewport is the 2FA-clipping scenario again. Never rely on `vh`; `dvh` + full-screen.
- **Keyboard open.** On mobile, an open keyboard shrinks the visual viewport. Full-screen Form Modals must keep the fixed action bar pinned to the *visual* viewport bottom (via `dvh` / `100svh` and `env(safe-area-inset-bottom)`), and scroll the focused field into view. This is the single most important mobile fix and is impossible to get right with the current floating-dialog approach — another argument for full-screen forms.
- **Safe areas.** All edge-anchored presentations (sheets, full-screen bars, drawers) pad with `env(safe-area-inset-*)` so nothing hides behind notches or home indicators. Currently unhandled anywhere.

---

## 6. Scroll doctrine

- **The page never scrolls while a modal is open.** Body scroll is locked on open and restored on close. Today only `BriefModal` and `DebtPayoffSection` lock the body; every other modal lets the page scroll behind it. The primitive owns the lock (and the scroll-position restoration).
- **The modal body scrolls; header and footer stay fixed.** The three-zone `flex` layout (fixed header / `flex-1 min-h-0 overflow-y-auto` body / fixed footer) is the canonical structure — R1 already implements it correctly and it is the reference.
- **The panel scrolls internally, not the viewport.** A modal must never be taller than its `dvh` cap; overflow is resolved inside the body, never by the surface growing past the screen. This is the exact invariant `TotpSection` violates.
- **Long forms** keep their submit/cancel actions in the always-visible footer so the primary action is reachable without scrolling to the bottom. Section headers within a very long form may be sticky within the scroll body, but the modal header/footer are the only truly fixed chrome.
- **Nested scroll** (e.g. a scrollable list inside a scrolling form) is discouraged; if unavoidable, the inner region gets an explicit bounded height so scroll chaining is predictable.
- **The scroll body must bound against a *definite* height, not `h-full` through `GlassPanel`.** `GlassPanel` wraps its children in a plain `relative z-10` block (no `flex`/height), which breaks any `height:100%` chain passing through it (see §8.10). The flex column that contains the scroll body must therefore carry the viewport-relative cap itself (`h-[100dvh]` / `max-h-[88dvh]` / `max-h-[92dvh]`, all `dvh`-based and thus definite), so `flex-1 min-h-0 overflow-y-auto` on the body has a real height to overflow. Putting the cap only on the outer `GlassPanel` is not sufficient.

---

## 7. Shared primitive

**Recommendation: yes — expose one overlay primitive in `components/atlas/`, peer to `GlassPanel` and `DataCard`, with two thin presets.** This is the central recommendation of the doctrine.

### 7.1 Structure

```
components/atlas/
  OverlaySurface.tsx   ← the primitive: portal, scrim, positioning,
                          focus trap, esc, scroll-lock, layering,
                          animation, responsive sheet/full-screen switch,
                          GlassPanel material, header/body/footer slots
  Dialog.tsx           ← preset: OverlaySurface tuned for confirmations
  FormModal.tsx        ← preset: OverlaySurface tuned for data entry
```

`OverlaySurface` is the single place that owns *behavior*. `Dialog` and `FormModal` are ~30-line presets that set intent-specific defaults (width, mobile presentation, action-bar layout). A Workspace Overlay is `OverlaySurface` used directly with `intent="workspace"` (and `anchor="right"` for the drawer variant). This mirrors how `GlassPanel` is the primitive and today's modals are its consumers — the doctrine simply moves the *modal* concerns into their own primitive instead of re-deriving them per file.

### 7.2 Naming

`OverlaySurface` is preferred over `DialogSurface`/`FormSurface` because the primitive is presentation-neutral; the *intent* lives in the preset name (`Dialog`, `FormModal`) and in an `intent`/`anchor` prop for Workspace/Drawer. This keeps the primitive count at one and reads consistently with the existing `*Surface`/`*Panel`/`*Card` vocabulary. (If the team prefers, `ModalSurface` is an acceptable synonym; the important decision is *one* primitive, not the exact noun.)

### 7.3 Why one primitive with presets, not three primitives

Positioning, portaling, focus trapping, scroll-locking, escape, layering, and animation are *identical* across all three intents — those are exactly the concerns currently duplicated (and mis-copied) eight times. Splitting them across three primitives would re-fragment the hard parts. The parts that genuinely differ between intents are small and declarative (max-width, mobile mode, action layout), so they belong in presets, not in separate implementations.

### 7.4 Relationship to existing code

`GlassModal` becomes the *seed* of `OverlaySurface` — it already has the slot API (title/subtitle/icon/toolbar/footer/children), the size ladder, and the correct scroll structure. It is missing: the portal (steal from `BriefModal`), the focus trap + `role="dialog"`/`aria-modal` (steal from `BriefModal`), body-scroll-lock (steal from `BriefModal`/`DebtPayoffSection`), the panel-level height cap (steal from `RemoveAccountModal`), token-based z-index, and the mobile intent switch. Every missing piece already exists elsewhere in the codebase; the primitive assembles them.

---

## 8. Existing problems (catalogue only — not fixed here)

### 8.1 Add Wallet opens pinned to the top on desktop — *root cause identified*

Not a positioning-class error. `AddWalletModal`'s overlay is already `fixed inset-0 flex items-end sm:items-center justify-center`, which centers correctly *when it is positioned relative to the viewport*. The defect is that it is **not** positioned relative to the viewport: no Fourth Meridian modal except `BriefModal` uses `createPortal`, so each modal renders inline in the React tree. CSS specifies that an element with `backdrop-filter`, `filter`, or `transform` becomes the **containing block for `position: fixed` descendants**. `GlassPanel` — used pervasively across the app chrome and, critically, as the wrapper of `CreateSpaceModal` (which renders `AddWalletModal` at line 707) and `UserButton` — sets `backdrop-filter: blur(30px)`. So when Add Wallet is opened from within a glass surface, its `fixed inset-0` resolves against that ancestor's box, not the screen, and it lands wherever that box sits — typically high/offset. `BriefModal`'s own header comment documents this exact trap ("positions relative to the card rather than the viewport… createPortal renders into document.body") — the fix was applied once, to one modal, and never generalized. **Doctrine fix path:** the primitive portals to `document.body`. Also present in R3's structural quirk: the height cap is on the inner div, not the panel, which compounds sizing oddities.

### 8.2 2FA verification clipped vertically on desktop — *root cause identified*

`TotpSection`'s panel is `w-full max-w-md … rounded-2xl shadow-2xl` with **no `max-height` and no `overflow` container** anywhere in the file (verified: zero `max-h`, `overflow-y`, or `dvh` occurrences). The setup flow's content (intro, QR ~200px, secret row, backup codes, verify input, actions) exceeds a short desktop viewport; with the surface centered and unbounded, the overflow is clipped by the top and bottom of the screen with no way to scroll to it. It also bypasses `GlassPanel` entirely, using `--modal-surface`. **Doctrine fix path:** panel-level `max-h-[88dvh]` + internal `flex-1 min-h-0 overflow-y-auto` body, i.e. the standard three-zone structure the primitive provides for free.

### 8.3 Divergent implementations

Eight recipes (§1.2) for what should be one surface. New modals are copied from whichever neighbor was nearest, so fixes (portal in R7, panel-cap in R4, scroll-lock in R7) never propagate.

### 8.4 Inconsistent sizing

Height caps live on the panel in some modals (R4, correct) and on an inner wrapper in others (R3, incorrect). `BriefModal` uses `vh`; everyone else uses `dvh`. Widths are per-file literals rather than a shared scale (R1's `SIZE_CLASS` is the only place a scale exists).

### 8.5 Inconsistent spacing

Header padding varies (`px-5 pt-5 pb-4` vs. `px-6 pt-5 pb-3` vs. `p-5`), footer treatment varies (border-top present/absent), and body padding is per-file. No shared spacing rhythm for modal chrome.

### 8.6 Inconsistent layering

`z-50` (Totp), `z-[100]` (most), `z-[110]` (AccountModal nested chart), `z-[150]` (AdminExpandHistoryFlow), `z-[200]`, `z-[9999]` (BriefModal). No named scale; collisions are possible and nesting order is implicit.

### 8.7 Accessibility gaps (systemic)

Only `BriefModal` sets `role="dialog"` + `aria-modal`. **No modal traps focus.** Escape is handled in only ~10 of the overlay files and is absent from Add Wallet, Add Manual Asset, Remove Account, and both Totp modals. Focus is not returned to the trigger on close. This is the highest-severity category and is invisible until audited.

### 8.8 Off-token surfaces

`TotpSection` (`--modal-surface`) and both admin overlays (`bg-gray-950` / `bg-gray-900`) do not render through `GlassPanel` and will not match Atlas Glass or theme correctly (the admin ones are hardcoded dark and will break in light mode).

### 8.9 Misnamed component

`AssetDrawer` is a centered dialog, not a drawer. `ProviderDiagnosticsDrawer` is the only true edge drawer. Naming should follow the taxonomy after migration.

### 8.10 Post-migration scroll regression — the modal body does not scroll — *root cause identified (shared primitive)*

*Reported after M1–M2 and the form-family migration: `CreateSpaceModal` can no longer scroll — the modal feels frozen/stale and its lower content is unreachable.*

Root cause is in the **primitive**, not `CreateSpaceModal`. `OverlaySurface` builds its three-zone layout as `GlassPanel (flex flex-col, max-h-[88dvh], overflow-hidden)` → *its content* → an inner `div.h-full.min-h-0.flex.flex-col` → the scroll body `div.flex-1.min-h-0.overflow-y-auto`. The flaw is that `GlassPanel` does not render its children directly: it wraps them in `<div className="relative z-10">` (GlassPanel.tsx:130) — a plain block with **no height, no `flex`, and no `min-h-0`**. That wrapper sits between the height-capped panel and the inner column and **breaks the flex-height chain**:

- On desktop the panel is `sm:h-auto sm:max-h-[88dvh]` → its height is *indefinite* (a max, not a fixed height).
- The interrupting `relative z-10` wrapper is the panel's single in-flow flex item but carries `min-height:auto`, so it never shrinks to the cap; it grows to content height.
- The inner div's `h-full` (`height:100%`) resolves against that wrapper, whose height is *auto/content-driven* → `h-full` collapses to `auto`. The inner column is therefore content-height, not viewport-bounded.
- With the inner column unbounded, the body's `flex-1 min-h-0 overflow-y-auto` has nothing to overflow — it just grows. The panel's `max-h-[88dvh]` + `overflow-hidden` then **clips** everything past 88dvh with no scrollbar. Hence "frozen."

Why it surfaced on `CreateSpaceModal` first: `AddWalletModal` and the `TotpSection` modals have content that fits within ~88dvh on a normal desktop, so no scroll is required and the clip never triggers. `CreateSpaceModal`'s multi-step form (account lists, invite UI) exceeds the cap. The same latent defect affects **every** migrated modal once its content passes the cap (`ManageSpaceModal` is the next most likely to hit it). The inline `min-h-0` comment in `OverlaySurface` describes the *intended* behavior, but `min-h-0` on the inner div is moot because its parent — the `GlassPanel` wrapper — is unbounded.

This confirms the pre-existing caution now formalized in §6: the reliable pattern in this codebase (e.g. the pre-migration `RemoveAccountModal`/`AddWalletModal`) put the viewport-relative `max-h` **directly on the inner flex container**, rather than relying on `h-full` propagating through `GlassPanel`'s wrapper. The proposed fix (below, primitive-scoped) restores that.

---

## 9. Future compatibility

The primitive is designed so the following ship *on it* without a modal redesign:

- **Meridian Analyst.** A Workspace Overlay (likely `full`), potentially with an AI `glow`, hosting a conversational/analytical panel. Needs: large surface, internal scroll, streaming content that grows without breaking the cap — all native to the primitive's three-zone scroll model.
- **Perspective Builder.** A Workspace Overlay with an internal multi-pane editor and a persistent action bar; may nest a Form Modal (e.g. "add data source") via the `nested` z-layer. The primitive's fixed footer + internal scroll + nested-layer prop cover this.
- **Debt Living Instrument.** Likely a full-screen Workspace Overlay (its precursor `DebtPayoffSection` already goes full-screen with body-lock) — folds directly into the Workspace intent, gaining portal + focus-trap + safe-area handling it currently lacks.
- **Provider configuration.** A Form Modal (multi-section) for standard config; the **Edge Drawer** variant for inspector-style diagnostics, replacing the hardcoded-gray `ProviderDiagnosticsDrawer` with a token-driven drawer.
- **Admin console & enterprise workflows.** Management dialogs and drawers on the same primitive, finally on tokens (fixing §8.8), with consistent layering for the deeper stacking these flows tend to need (bulk actions, confirmations over tables) — served by the named z-scale and the `nested` layer.

Because behavior is centralized, future needs (e.g. a global confirm-before-close policy, a new reduced-motion rule, a stacking-context fix) are one-file changes rather than an eight-modal migration.

---

## 10. Accessibility (consolidated requirements)

The primitive must guarantee, for every consumer, by construction:

- `role="dialog"` (or `alertdialog` for destructive confirmations) + `aria-modal="true"` + an `aria-label`/`aria-labelledby` bound to the title.
- Focus moves in on open, is trapped for the lifetime of the surface, and returns to the invoking trigger on close.
- Background content is inert to AT (via portal + `aria-hidden`/`inert` on the app root while open).
- `Esc` closes (respecting the busy/preventClose guard); `Tab` cycles within.
- Body scroll locked; scroll position restored on close.
- Reduced-motion: no transform movement, minimal opacity change.
- Touch targets ≥44px (the close buttons already use `touch-manipulation` and 32–44px hit areas — standardize at 44px).

Today none of these are guaranteed; `BriefModal` meets roughly half. This is the strongest single argument for centralizing behavior in one primitive.

---

## 11. Animation philosophy

Calm, physical, and self-effacing — the modal should feel like a pane of glass settling into place, not an effect. Concretely: scrim fade `--dur-fast`/`--ease-enter`; panel opacity + ≤8px rise (or 0.98→1 scale) over `--dur-base`/`--ease-enter`; symmetric exit on `--ease-exit`; mobile sheet translates from the bottom edge over `--dur-base`. No `--ease-spring` on modals (reserve the spring for playful micro-interactions elsewhere), no bounce, no content blur-in, no staggered reveals, no parallax. Under `prefers-reduced-motion`, drop the transform entirely and keep only a near-instant opacity change. This is deliberately the *least* animation that still reads as "a surface arrived" — which is what keeps it feeling current in ten years.

---

## 12. Proposed implementation roadmap

Sequenced so that nothing user-visible breaks and each step is independently shippable and reversible. **No step is executed as part of this investigation.**

**Phase 0 — Ratify doctrine.** Review and approve this document as the modal ADR. Decide primitive name (`OverlaySurface` proposed) and the z-index token scale. *Deliverable: sign-off. No code.*

**Phase 1 — Build the primitive (additive, unused).** Create `components/atlas/OverlaySurface.tsx` by promoting `GlassModal` and folding in the portal + focus-trap + `role`/`aria-modal` + body-lock (from `BriefModal`), the panel-level height cap (from `RemoveAccountModal`), the named z-scale, and the mobile intent switch. Add `Dialog` and `FormModal` presets. Ship it wired to nothing. Add the z-index tokens to `globals.css`. *Nothing migrates yet; zero behavioral risk.*

**Phase 2 — Fix the two reported defects by migration.** Migrate `AddWalletModal` (fixes §8.1 via portal) and `TotpSection` (fixes §8.2 via panel cap + scroll body) onto the primitive. These are the highest-value, most-contained migrations and validate the primitive against the two known bugs. *This is where the reported issues actually get fixed — correctly, once.*

**Phase 3 — Migrate the Form family.** `AddManualAssetModal`, `CreateSpaceModal`, `ManageSpaceModal` → `FormModal`. Retires recipe R3.

**Phase 4 — Migrate Dialogs and Confirmations.** `RemoveAccountModal`, `AdminExpandHistoryFlow`, small KPI/detail cards → `Dialog`. Retires R4/part of R8.

**Phase 5 — Migrate Workspace Overlays.** `AccountModal`, `NetWorthChartModal`, `TimelineModal`, `AssetDrawer` (and rename it) → `OverlaySurface` workspace intent. Retires R2/R5.

**Phase 6 — Migrate Drawers and off-token admin surfaces.** `ProviderDiagnosticsDrawer` → drawer variant, on tokens (fixes §8.8). Retires R8.

**Phase 7 — Reconcile the briefing overlays.** Fold `BriefModal`/`AttentionModal`/`SinceLastVisitModal` onto the primitive *or* formally document them as a sanctioned reading-overlay variant if their `blur(56px)` editorial material is intentionally distinct. Retires R7 or blesses it explicitly.

**Phase 8 — Delete dead recipes and lint against regressions.** Remove the superseded shells; add a lint/convention (or a `DataCard`-style doc) so new overlays must use the primitive. Add the popover doctrine note (§7 excludes menus/`InlineFilter` — they stay anchored, not modal).

### 12.1 Mandatory validation checklist — every migrated modal

`npx tsc --noEmit` and `npm run lint` are necessary but **not sufficient** — the SCROLL-1 regression (§8.10) passed both while being visibly broken, because it is a runtime layout failure. Every modal migration MUST be checked, on a real running build, against **all** of the following. A migration is not "done" until each line is confirmed with content tall enough to exceed the viewport cap (short-content modals hide scroll defects):

- [ ] **Desktop centered positioning** — surface is centered both axes, not pinned/offset (portal verified).
- [ ] **Mobile presentation** — full-screen for Form/Workspace; content-sized bottom sheet for Dialog.
- [ ] **Internal body scroll works** — with content taller than the cap, the body scrolls (this is the SCROLL-1 check; test the *tallest* state of the modal).
- [ ] **Long forms reach the bottom** — the last field/element is reachable by scrolling.
- [ ] **Footer / actions remain reachable** — primary/secondary actions are always visible or scrollable-to; never clipped off-screen.
- [ ] **Keyboard does not trap content off-screen** — on mobile, an open keyboard does not hide the focused field or the action bar (`dvh`/`svh` + safe-area).
- [ ] **Escape / backdrop behavior matches prior behavior** — dismissal (or intentional non-dismissal, e.g. enforced 2FA, busy state) is identical to pre-migration.
- [ ] **Focus trap works without blocking scroll** — Tab cycles within the surface, focus returns to the trigger on close, and the trap does not prevent wheel/touch scrolling of the body.
- [ ] **Body scroll locked, modal body scroll not** — the page behind is frozen, but the modal's own body still scrolls (the two must not be conflated).
- [ ] **Nested modal stacking still works** — a modal launched from within another (e.g. Add Wallet from Create Space) renders above its host and dismisses back to it correctly.

**Validation basics (unchanged):** `npx tsc --noEmit`, `npm run lint`, and confirm no unrelated files changed. Accessibility (roles, `aria-modal`, esc, return-focus) is verified explicitly since it is the category with the most current gaps.

---

## 13. Proposed fix for SCROLL-1 (root cause in §8.10) — smallest safe change

The defect is **shared** (in `OverlaySurface`), so the fix belongs in the primitive — a single change repairs all six migrated modals at once, with no per-modal edits.

**Fix:** stop relying on `h-full` propagating through `GlassPanel`'s `relative z-10` wrapper. Carry the same viewport-relative height cap on the **inner flex container** that holds the scroll body, so it bounds against a *definite* height regardless of the interrupting wrapper. Concretely, in `OverlaySurface`, change the inner container from:

```
<div className="h-full min-h-0 flex flex-col p-5">
```

to carry the panel's height classes and drop `h-full`:

```
<div className={`min-h-0 flex flex-col p-5 ${mobileHeight} ${desktopHeight}`}>
```

(`mobileHeight`/`desktopHeight` are the `dvh`-based caps already computed for the panel — `h-[100dvh] sm:h-auto`, `sm:h-auto sm:max-h-[88dvh]`, etc.) Because those caps are viewport-relative and thus definite, the inner column clamps correctly and the body's `flex-1 min-h-0 overflow-y-auto` gains a real height to overflow. This mirrors the proven pre-migration pattern (`RemoveAccountModal` carried `max-h` on its inner flex container, not just the panel).

**Why this over alternatives:**
- *Not* editing `GlassPanel`'s wrapper (adding `flex`/`min-h-0` to line 130) — that would change every `GlassPanel` consumer (cards, panels app-wide) and is a far larger blast radius for the same result.
- *Not* a per-modal fix in `CreateSpaceModal` — the bug is in the primitive; a local patch would leave `ManageSpaceModal` and future tall modals broken.

**Blast radius:** one file, one line (plus keeping the `min-h-0`). Panel keeps its own classes; short-content modals still size to content and center normally. **Rollback:** restore the original inner `className`.

**Validation before merge:** the full §12.1 checklist against `CreateSpaceModal` (tallest step) and `ManageSpaceModal`, plus a spot-check of `AddWalletModal`/`TotpSection`/`AddManualAssetModal`/`RemoveAccountModal` to confirm no size/centering regression.

*Investigation complete. Root cause identified; fix proposed and scoped. No code changed — stopping here per instruction.*
