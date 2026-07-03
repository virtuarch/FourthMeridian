# Atlas Overlay Audit

**Status:** Investigation only. No implementation, no code changes.
**Branch:** `feature/v2.5-spaces-completion`
**Scope:** Every overlay, drawer, modal, sheet, full-screen experience, tooltip, popover and dialog in the application, audited against twelve behavioural criteria and grouped into the smallest possible remediation families.

---

## 0. How to read this

The app has **one canonical overlay primitive** — `components/atlas/OverlaySurface.tsx`, with thin presets `Dialog`, `FormModal`, and `ConfirmDialog`. Since the *Atlas Glass Modal Doctrine* was written, a meaningful chunk of the modal family has already migrated onto it (this is well past the doctrine's "wired to nothing" snapshot). The primitive gets all twelve criteria right by construction, so anything sitting on it is compliant and only inherits regressions through hand-rolled escape hatches.

Everything **not** on the primitive re-implements the twelve concerns by hand and each gets a different subset wrong. Those are the audit's real subject.

**The twelve criteria, defined:**

1. **Primitive** — what the surface is built from.
2. **Scroll correctness** — height cap on the panel element + a single `flex-1 min-h-0 overflow-y-auto` body (not a cap on an inner wrapper; not "no cap at all").
3. **Body lock** — background/body scroll frozen while open.
4. **Focus trap** — focus moves in on open, is trapped, returns to the trigger on close.
5. **Portal** — rendered into `document.body` (escapes the `transform`/`backdrop-filter` containing-block trap).
6. **Z-index** — from the named token scale (`--z-modal…`) vs. an ad-hoc literal.
7. **Keyboard** — Tab cycling within the surface, Enter-to-submit where relevant.
8. **Escape** — Esc closes (guarded while busy).
9. **Backdrop** — scrim present + click-to-close behaviour.
10. **Page scroll preservation** — `window.scrollY` preserved/restored across open/close (no jump-to-top).
11. **Mobile presentation** — bottom sheet / full-screen / centered.
12. **Desktop presentation** — centered floating surface + width ladder.

Legend: ✅ correct · ⚠️ partial / non-standard · ❌ missing · — not applicable · *inherit* = provided by the primitive.

---

## 1. Compliant — on the Atlas primitive

These render through `OverlaySurface` (directly or via `FormModal` / `Dialog` / `ConfirmDialog`) and inherit every criterion. Listed for completeness; they are the target state, not the problem.

| Surface | Primitive | Scroll | Body lock | Focus trap | Portal | Z-index | Keyboard | Escape | Backdrop | Scroll preserve | Mobile | Desktop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `AddWalletModal` | FormModal → OverlaySurface | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ | ✅ | ✅ | full-screen | centered md |
| `AddManualAssetModal` | FormModal | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ | ✅ | ✅ | full-screen | centered md |
| `CreateSpaceModal` (multi-step) | FormModal | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ guarded | ✅ | ✅ | full-screen | centered md |
| `ManageSpaceModal` | FormModal | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ | ✅ | ✅ | full-screen | centered |
| `TotpSection` (setup) | FormModal | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ⚠️ blocked (enforced 2FA) | ⚠️ blocked | ✅ | full-screen | centered md |
| `TotpSection` (verify / disable) | Dialog | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ | ✅ | ✅ | bottom sheet | centered sm |
| `RemoveAccountModal` | Dialog | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ | ✅ | ✅ | bottom sheet | centered sm |
| `AccountModal` | OverlaySurface (workspace) | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ | ⚠️ off (workspace) | ✅ | full-screen | centered xl |
| `SpaceDashboard` delete-goal confirm | ConfirmDialog → Dialog | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ guarded | ✅ | ✅ | bottom sheet | centered sm |
| `AdminExpandHistoryFlow` | Dialog | ✅ | ✅ | ✅ | ✅ | ✅ token | ✅ | ✅ guarded | ✅ | ✅ | bottom sheet | centered sm |

**One embedded exception inside a compliant host:** `AccountModal` still contains a hand-rolled **nested TradingView chart overlay** (`fixed inset-0 z-[110]`, raw `var(--glass-thick)` div). It has no Esc, no focus trap, no portal (it deliberately resolves against the modal panel), and is dismissed only by its own close button. See family **F5**.

---

## 2. Non-compliant — hand-rolled overlays

Every surface below re-implements overlay behaviour by hand. This is the audit's core.

### 2.1 Shared shell — `GlassModal` and its inline twin

| Surface | Primitive | Scroll | Body lock | Focus trap | Portal | Z-index | Keyboard | Escape | Backdrop | Scroll preserve | Mobile | Desktop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `widgets/GlassModal` (shell) | GlassPanel + tokens | ✅ panel cap + `min-h-0` body | ✅ `useBodyScrollLock` | ❌ | ❌ | ⚠️ `z-[100]` literal | ❌ no Tab trap | ❌ **no Esc key handler** | ✅ click-close | ✅ (via hook) | bottom sheet `h-94dvh` | centered md/lg/xl/full |
| `widgets/TimelineModal` | via GlassModal (`size=full`) | ✅ inherit | ✅ inherit | ❌ inherit | ❌ inherit | ⚠️ inherit | ❌ inherit | ❌ inherit | ✅ inherit | ✅ inherit | full sheet | centered full |
| KPI-detail / Perspective-detail modals | via GlassModal | ✅ | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ✅ | ✅ | bottom sheet | centered |
| `charts/NetWorthChartModal` | GlassPanel + tokens (own inline copy of GlassModal recipe) | ✅ panel cap | ❌ **no body lock** | ❌ | ❌ | ⚠️ `z-[100]` | ❌ | ❌ | ✅ click-close | ❌ | bottom sheet `h-94dvh` | centered `max-w-3xl` |

### 2.2 Inline token-styled modals (correct material, missing behaviour)

| Surface | Primitive | Scroll | Body lock | Focus trap | Portal | Z-index | Keyboard | Escape | Backdrop | Scroll preserve | Mobile | Desktop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `DebtClient` transaction modal | inline `--modal-surface` div | ✅ panel cap `max-h-88dvh` | ❌ | ❌ | ❌ | ⚠️ `z-[100]` | ❌ | ❌ | ✅ click-close | ❌ | centered `p-4` | centered `max-w-2xl` |
| `InvestmentsClient` activity modal | inline `--modal-surface` div | ✅ panel cap `max-h-88dvh` | ❌ | ❌ | ❌ | ⚠️ `z-[100]` | ❌ | ❌ | ❌ **scrim not clickable** | ❌ | centered | centered `max-w-lg` |
| `SpacesClient` space-preview modal | GlassPanel + tokens | ✅ panel cap | ❌ | ❌ | ❌ | ⚠️ **`z-[200]`** (outlier) | ❌ | ❌ | ✅ click-close | ❌ | centered | centered `max-w-md` |
| `AssetDrawer` (misnamed — renders centered) | inline `--modal-surface` div | ✅ panel cap `max-h-88dvh` | ❌ | ❌ | ❌ | ⚠️ `z-[100]` | ❌ | ✅ `window` keydown | ✅ click-close | ❌ | centered + mobile handle-bar | centered `max-w-2xl` |
| `SpaceDashboard` TrashDrawer | inline `--modal-surface` div | ✅ `max-h-70dvh` | ❌ | ❌ | ❌ | ⚠️ `z-50` | ❌ | ❌ | ✅ click-close | ❌ | bottom sheet `rounded-t` | centered `max-w-md` |
| `SpaceDashboard` Add-Goal modal | inline `--modal-surface` div | ✅ `max-h-88dvh` | ❌ | ❌ | ❌ | ⚠️ `z-50` | ⚠️ form submit only | ❌ | ❌ **no backdrop close** | ❌ | centered | centered `max-w-md` |

### 2.3 Full-screen bespoke surfaces

| Surface | Primitive | Scroll | Body lock | Focus trap | Portal | Z-index | Keyboard | Escape | Backdrop | Scroll preserve | Mobile | Desktop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `AdviceBanner` AnalysisModal | bespoke, `bg-black/95` hardcoded | ✅ body scrolls, full-height | ❌ | ❌ | ❌ | ⚠️ `z-[100]` | ❌ | ❌ | ⚠️ opaque takeover, `target` click-close | ❌ | full-screen | full-screen (`sm:max-w-none`) |
| `space/sections/DebtPayoffSection` (fullscreen) | inline `--modal-surface` div | ✅ panel cap `max-h-88dvh` | ✅ `useBodyScrollLock` | ❌ | ❌ | ⚠️ `z-50` | ❌ | ✅ keydown | ❌ **no backdrop close** | ✅ (via hook) | centered, dual mobile/desktop layout | centered `max-w-3xl` |

### 2.4 Non-tokenized (hardcoded gray) surfaces — will not theme

| Surface | Primitive | Scroll | Body lock | Focus trap | Portal | Z-index | Keyboard | Escape | Backdrop | Scroll preserve | Mobile | Desktop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `charts/HoldingsDonutChart` popup | bespoke, `bg-gray-900/800/700` | ✅ body scrolls | ❌ | ❌ | ❌ | ⚠️ `z-[100]` | ❌ | ❌ | ✅ click-close | ❌ | top-inset bottom sheet `mt-16 rounded-t-3xl` | same (not adapted) |
| `admin/ProviderDiagnosticsDrawer` (true edge drawer) | bespoke, `bg-gray-950` | ✅ body scrolls, full-height | ❌ | ❌ | ❌ | ⚠️ `z-[100]` | ⚠️ | ✅ keydown | ✅ click-close | ❌ | full-width | right edge drawer `max-w-xl` |
| `admin/security` Reset-2FA modal | bespoke, `bg-gray-900` | ❌ **no cap / no scroll region** | ❌ | ❌ | ❌ | ⚠️ `z-50` | ❌ | ❌ | ⚠️ scrim, **no click-close** | ❌ | centered `max-w-md` | centered `max-w-md` |
| `admin/security` Recovery-Codes modal | bespoke, `bg-gray-900` | ❌ **no cap / no scroll region** | ❌ | ❌ | ❌ | ⚠️ `z-50` | ❌ | ❌ | ⚠️ no click-close | ❌ | centered `max-w-md` | centered `max-w-md` |
| `admin/security` Sessions modal | bespoke, `bg-gray-900` | ⚠️ `max-h-80vh` (vh not dvh) | ❌ | ❌ | ❌ | ⚠️ `z-50` | ❌ | ❌ | ⚠️ no click-close | ❌ | centered `max-w-lg` | centered `max-w-lg` |

### 2.5 Reference-correct portal modal (the "good outlier")

| Surface | Primitive | Scroll | Body lock | Focus trap | Portal | Z-index | Keyboard | Escape | Backdrop | Scroll preserve | Mobile | Desktop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `brief/BriefModal` | GlassPanel + createPortal | ⚠️ `max-h-85vh` (vh not dvh) | ✅ `useBodyScrollLock` | ❌ no Tab trap | ✅ | ⚠️ **`z-[9999]`** (outlier) | ❌ | ✅ keydown | ✅ click-close | ✅ (via hook) | inset panel, dual header render | centered `max-w-2xl/3xl` |
| `brief/AttentionModal` | via BriefModal | inherit | ✅ | ❌ | ✅ | ⚠️ inherit | ❌ | ✅ | ✅ | ✅ | inherit | inherit |
| `brief/SinceLastVisitModal` | via BriefModal | inherit | ✅ | ❌ | ✅ | ⚠️ inherit | ❌ | ✅ | ✅ | ✅ | inherit | inherit |

`BriefModal` has the correct **structure** (portal + a11y role + body-lock + scroll-preserve) that the primitive was designed around, but still lacks a Tab focus-trap and uses `vh` + a `z-[9999]` outlier.

### 2.6 Anchored popovers / menus — governed separately, listed for completeness

These are **not** modals (anchored to a trigger, not centered; no scrim, no body-lock by design). They belong to a lighter popover doctrine and should **not** be forced onto the modal primitive — but they are audited here because the brief asks for popovers and menus.

| Surface | Primitive | Portal | Z-index | Keyboard | Escape | Outside-click | Role | Mobile | Desktop |
|---|---|---|---|---|---|---|---|---|---|
| `widgets/MoreMenu` | absolute-wrapped GlassPanel | ❌ | ⚠️ literal (wrapper) | ⚠️ | ✅ Esc | ✅ | `role="menu"` | anchored | anchored |
| `widgets/PerspectiveSwitcher` | absolute GlassPanel | ❌ | ⚠️ `z-50` | ⚠️ | ✅ Esc | ✅ | `menu` / `menuitemradio` | anchored | anchored |
| `atlas/InlineFilter` (mobile dropdown) | GlassPanel popover | ❌ | ⚠️ | ⚠️ arrow nav absent | ✅ Esc | ✅ | `tablist`/`tab` (desktop), radio rows (mobile) | dropdown | inline text row |
| `SpaceDashboard` goal kebab menu | absolute div, `--modal-surface` | ❌ | ⚠️ `z-30` | ❌ | ❌ | ⚠️ parent `stopPropagation` | none | anchored | anchored |
| `DashboardClient` manage menu | invisible full-screen dismiss layer | ❌ | ⚠️ `z-30` | ❌ | ❌ | ✅ backdrop layer | none | anchored | anchored |

**Tooltips:** there is **no custom tooltip component.** The only tooltips in the app are native browser `title=""` attributes (e.g. `SpaceTrendHero`, `TimelineModal`, `AssetDrawer` allocation bars). No audit action — they are outside the overlay system entirely.

---

## 3. Cross-cutting inconsistencies (the summary the table proves)

- **Focus trap** is absent from *every* surface except those on the primitive — including the otherwise-correct `GlassModal` and `BriefModal`. This is the single most widespread gap.
- **Escape** is present on only ~5 hand-rolled surfaces (`AssetDrawer`, `DebtPayoffSection`, `ProviderDiagnosticsDrawer`, `BriefModal`, and the primitive family) and absent from the rest — notably every `admin/security` modal and both shared shells (`GlassModal`, `NetWorthChartModal`).
- **Body lock + page-scroll preservation** travel together (both come from `useBodyScrollLock`). Present on `GlassModal`, `BriefModal`, `DebtPayoffSection`, and the primitive; **missing everywhere else**, so those surfaces jump the page on open/close.
- **Portal** exists in exactly two places: the primitive and `BriefModal`. Every other overlay is vulnerable to the glass containing-block trap that `OverlaySurface` was built to fix.
- **Z-index** has no discipline off-primitive: `z-30`, `z-50`, `z-[100]`, `z-[110]`, `z-[200]`, `z-[9999]` all coexist. Only the primitive uses the `--z-modal` token.
- **Scroll cap** is mostly correct now (panel-level caps), with two hard failures — both `admin/security` credential modals have **no cap and no scroll region at all** (the same class of defect the doctrine flagged on old TotpSection).
- **Non-tokenized surfaces** (`HoldingsDonutChart`, `ProviderDiagnosticsDrawer`, all three `admin/security` modals) hardcode `bg-gray-*` and will not theme or match Atlas Glass.
- **Backdrop behaviour** is arbitrary: some click-to-close, some not (`InvestmentsClient`, `SpaceDashboard` Add-Goal, `DebtPayoffSection`, all `admin/security` modals), one opaque full-bleed takeover (`AdviceBanner`).

---

## 4. Implementation families (smallest possible grouping)

Every inconsistent surface collapses into **six** remediation families. The grouping is by *what the fix is*, so each family is one coherent piece of work — no per-file bespoke effort.

### F1 — Migrate inline token modals onto `FormModal` / `Dialog`
The largest family. Surfaces that already use the correct glass material and panel-level height cap, and only lack the behavioural layer (portal, body-lock, focus-trap, Esc, scroll-preserve, token z-index). Migration is "wrap in the existing preset, delete the hand-rolled scaffold."

- `DebtClient` transaction modal
- `InvestmentsClient` activity modal *(also gains a clickable backdrop)*
- `SpacesClient` space-preview modal *(also normalises the `z-[200]` outlier)*
- `AssetDrawer` *(also resolves the misnomer — it is a centered dialog, not a drawer)*
- `SpaceDashboard` TrashDrawer
- `SpaceDashboard` Add-Goal modal *(also gains backdrop close)*

### F2 — Fold the shared shells into the primitive
Two shells implement ~80% of the primitive but predate its adoption. Retiring them (or re-basing them on `OverlaySurface`) fixes their whole downstream consumer set in one move.

- `widgets/GlassModal` → and with it `TimelineModal` + all KPI/Perspective detail modals *(gains portal, focus-trap, Esc, token z-index)*
- `charts/NetWorthChartModal` (inline twin of the same recipe) *(also gains body-lock + scroll-preserve)*

### F3 — Re-tokenize and migrate the hardcoded-gray surfaces
Surfaces that will not theme because they use `bg-gray-*` instead of glass tokens. Fix is token replacement **plus** primitive migration in the same pass.

- `charts/HoldingsDonutChart` popup → `FormModal`/workspace intent
- `admin/security` Reset-2FA modal → `FormModal` *(also gains scroll cap — currently none)*
- `admin/security` Recovery-Codes modal → `FormModal` *(also gains scroll cap)*
- `admin/security` Sessions modal → `FormModal` *(also `vh`→`dvh`)*

### F4 — Land the Edge Drawer variant, then migrate the one true drawer
`ProviderDiagnosticsDrawer` is the only genuine edge-anchored drawer. It needs the primitive's not-yet-built `anchor="edge"` variant (doctrine Phase 6). Distinct from F1/F3 because it requires a small primitive extension first, not just migration.

- Primitive: add edge-anchor variant to `OverlaySurface`
- `admin/ProviderDiagnosticsDrawer` → migrate + re-tokenize onto it

### F5 — Collapse nested/full-screen bespoke overlays
Overlays that open *over* another surface or take the full viewport with their own layout. They should become nested `OverlaySurface` instances (with the `zIndex` nested-layer prop) or a workspace-intent overlay, rather than raw `fixed inset-0` children.

- `AccountModal` nested TradingView chart overlay (`z-[110]`)
- `AdviceBanner` AnalysisModal *(also re-tokenize off `bg-black/95`)*
- `DebtPayoffSection` fullscreen *(already has Esc + body-lock; needs portal, focus-trap, backdrop, token z-index)*

### F6 — Finish `BriefModal` and normalize outliers
`BriefModal` is structurally reference-correct; it only needs the two missing pieces to reach parity, at which point its deliberate glass tuning can stay as a documented one-off.

- Add Tab focus-trap
- `max-h-85vh` → `dvh`; normalise `z-[9999]` onto the token scale
- Applies transitively to `AttentionModal` + `SinceLastVisitModal`

### (Out of scope) Popover doctrine — not a modal family
`MoreMenu`, `PerspectiveSwitcher`, `InlineFilter`, and the `SpaceDashboard` / `DashboardClient` menus are anchored popovers. They should be unified under a **separate lightweight popover primitive** (shared outside-click + Esc + `role`/z-index token), never the modal primitive. Tracked separately; the two menus currently lacking Esc/outside-click (`SpaceDashboard` kebab, `DashboardClient` manage) are the only functional gaps there.

---

## 5. Family → z-index normalization map (reference)

For whoever picks up F1–F6: the target token scale (from the doctrine) is `--z-modal: 100`, `--z-modal-nested: 110`, `--z-toast: 200`, `--z-critical: 300`. Current literals to retire: `z-50` (admin, TrashDrawer, Add-Goal, DebtPayoff, PerspectiveSwitcher), `z-[100]` (all §2.1–2.4), `z-[110]` (AccountModal nested → `--z-modal-nested`), `z-[200]` (SpacesClient → **wrong layer**, should be `--z-modal`), `z-[9999]` (BriefModal), `z-30` (kebab/manage popovers → popover token).

---

*End of audit. No code was modified.*
