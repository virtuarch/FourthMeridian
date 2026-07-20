# V25-CLOSE-4 — Template Truthfulness

**Status:** investigation complete — no code changed
**Date:** 2026-07-20
**Scope:** the Space template system — picker, presets, per-category lenses/heroes, empty states.
**Question:** do templates promise capabilities that don't exist? Make them truthful before v2.5 closure without expanding functionality.

---

## 0. Thesis

**Two truths, one small and one structural.**

1. *The small one:* every template already carries a written description (`CATEGORY_DESCRIPTIONS` → `tpl.description`) all the way to the picker's data — and the picker throws it away, rendering icon + name only. The `space-presets.ts` comment literally says "shown in the template picker"; it isn't. This is a one-line render fix with real value.

2. *The structural one:* after SD-9, **opening a Space of almost any category auto-engages the same `WealthWorkspace` on Overview.** The seeded `SpaceDashboardSection` rows a template writes are *mostly inert at runtime* — they render only for Trip and the Goals/Retirement routed modals. So a template's promise is delivered (or not) almost entirely by two things that *do* vary per category: the **hero** and the **lens list**. Where a template's promise lives only in a seeded section widget (Property value, Vehicle value, Equipment value), that promise is currently **unmet** — the widget exists and is real, but never renders.

The truthful v2.5 move is **copy + configuration only**: show the descriptions, stop leading two templates with a dead "Soon" card, and reconcile a couple of descriptions/visibility with what actually renders. Everything that would require the seeded widgets to render, or a real Business/Property/Tax lens, is v2.6.

---

## 1. How the system actually renders (the fact that governs everything)

Two parallel systems exist; only one drives the primary canvas.

| | System A — Sections | System B — Perspectives |
|---|---|---|
| Source | `PRESET_MAP` (`space-presets.ts`) → seeded `SpaceDashboardSection` rows | `PERSPECTIVES_BY_CATEGORY` + `SPACE_HERO_DEFS` |
| Drives | tab derivation; a config store; **Trip Overview + Goals/Retirement routed modals only** | the Overview canvas, lens chips, hero, doorway |
| Runtime reality | **mostly inert** — see below | **governs what you see** |

The load-bearing line is `use-space-navigation.ts:162-163`: on Overview with no lens selected, `activePerspectiveId` defaults to `"wealth"` whenever the category's list includes it. **14 of 15 categories include `wealth`** — only `TRIP` does not. So every category except Trip lands on Overview and renders `WORKSPACE_RENDERERS.wealth` (`WealthWorkspace`), and the seeded-section path (`OverviewWorkspace` → `SpaceSectionStack`) is skipped.

**Seeded sections that never render at runtime** (structurally orphaned): `net_worth`, `net_worth_chart`, `allocation`, `property_value`, `vehicle_value`, `equipment_value`, `debt_breakdown_chart`, `debt_payoff_calculator` (all suppressed by the auto-engaged WealthWorkspace on Overview); `debt_summary`/`mortgage_tracker`/`auto_loan_tracker` (tab DEBT — not in `TAB_ORDER`); `investment_summary`/`investment_allocation` (tab INVESTMENTS — not in `TAB_ORDER`); `business_accounts`/`accounts_overview` (ACCOUNTS renders `AccountsWorkspace`, ignores sections); `recent_activity` (ACTIVITY renders `ActivityWorkspace`). Seeded sections that **do** surface: `trip_budget`/`trip_savings` (Trip Overview), `goals_progress` (Goals modal), `retirement_progress`/`retirement_accounts` (Retirement modal), and `emergency_fund_progress.config` (read as a hidden config store for the hero's months-covered, though its card never shows).

**Every one of the 22 preset section keys has a real `SectionRegistry` renderer** — none fall through to the "coming soon" `ContextualCard`. The prior template redesign already removed the rendererless keys. So there is **no section-level coming-soon problem left**. Four keys are *honest-looking aliases*, however: `mortgage_tracker`/`auto_loan_tracker` → generic `renderDebtSummary`; `investment_allocation`/`retirement_accounts` → generic `renderInvestmentSummary` (the allocation one renders a *list*, not an allocation chart — `// TODO: replace with BreakdownWidget`). These only matter if those sections are ever made to render (v2.6).

---

## 2. Coming-soon / missing lens audit

Exactly three `comingSoon` lenses exist: **`tax`, `property`, `businessHealth`** (`perspectives.ts:412,416,420`). None has a workspace renderer.

**How a comingSoon lens renders:** never as a clickable primary chip. The primary lens selector is built from a hardcoded allowlist (`NET_WORTH_LENS_ID` + `CORE_LENS_IDS = [cashFlow, liquidity, investments, debt]`, `use-space-navigation.ts:103-104`), intersected with the category's list — so `property`/`businessHealth`/`tax` are silently dropped from it. They surface only in the **Perspectives doorway card row**, which uses the raw category order, as a **non-clickable "Soon" placeholder** (`PerspectivesWidget.tsx:102-150` — a `<div>`, `cursor-default`, "clicking does nothing but show its copy").

| Lens | Where it appears | Leads with it? | Verdict | Action |
|---|---|---|---|---|
| `property` | 2nd id in `PROPERTY` list → **first card** in the Property doorway | Yes — visually leads with an inert "Soon" card | Property Space's doorway opens on a dead card | **Remove `property` from `PERSPECTIVES_BY_CATEGORY.PROPERTY`** (one line). The equity hero already carries Property's story. |
| `businessHealth` | 2nd id in `BUSINESS` list → **first card** in the Business doorway | Yes — same inert lead | Business Space's doorway opens on a dead card | **Remove `businessHealth` from `…BUSINESS`** (one line). The cash-position hero + cashFlow/liquidity lenses carry it. |
| `tax` | **nowhere** — in no category list; fully orphaned | No | Defined but completely unreachable | **Leave as-is** (harmless dead definition) or delete the def for hygiene. No user-facing impact either way. |

The doorway's "See all" already skips past comingSoon to the first real workspace (`SpaceDashboard.tsx:656-659`), and the primary chips already exclude these lenses. So the *only* live symptom is the inert lead card in the Property/Business doorway — removing the two ids from the category lists fixes it with no new code. **Do not build** the lenses.

---

## 3. Template differentiation

Differentiation is real for the categories with a distinct hero + lens set, and collapses for the rest. Heroes (`SPACE_HERO_DEFS`) are the primary differentiator now that Overview is always `WealthWorkspace`.

**Genuinely differentiated** (distinct hero and/or leading real lens):
- **Household / Family** — net-worth hero, shared scope, `wealth/cashFlow/liquidity/debt` lenses. *Note: Household and Family are byte-identical to each other* (same hero def, same lens list) — differentiated from Personal (shared scope) but not from one another. That's defensible (same tools, different mental model); the honest fix is descriptions, not forced divergence.
- **Debt Payoff** — remaining-debt *down-good* hero + real Debt lens. Strong.
- **Emergency Fund** — emergency-fund hero + liquidity lens + config-driven months-covered. Strong.
- **Investment** — portfolio-value hero + real Investments lens. Strong.
- **Retirement** — retirement-portfolio hero + Retirement routed modal (the retirement lens is *not* a primary chip — it's not in `CORE_LENS_IDS`). Adequate.
- **Business** — cash-position hero + cashFlow/liquidity lenses (minus the inert Business Health card, §2). Adequate.
- **Property** — equity `stepAfter` hero (honest for manual valuations). But its seeded `property_value`/`mortgage_tracker` widgets never render, and its description promises "rental income," which has no feature.
- **Trip** — the *one* manual template that works: no `wealth` perspective, so its `trip_budget`/`trip_savings` ProgressWidgets actually render on Overview. Uniquely delivers its promise via System A.

**Collapse to "Personal with a different label"** (no hero def → default net-worth WealthWorkspace; near-identical lens set):
- **Vehicle** and **Equipment** — *and misleading*: their promise ("monitor vehicle value and auto loan" / "equipment value, loans, maintenance") lives entirely in seeded `vehicle_value`/`equipment_value`/`auto_loan_tracker` widgets that **never render**. A user creating a Vehicle Space gets a generic net-worth workspace. This is the sharpest truthfulness gap.
- **Custom** — blank preset by design; honestly generic (still shows net worth). Fine.
- **Other** — general-purpose by design. Fine.

**Smallest truthful change:** descriptions for all; for Vehicle/Equipment, either (a) **hide from the picker** until their value widget renders on Overview (v2.6), or (b) **reword the description** to match the net-worth-workspace reality rather than promising value/loan tracking that doesn't surface. Recommendation: **(b) reword** — the templates still seed the right accounts scaffolding and a future v2.6 can light up the widget; hiding removes a legitimate organizing intent. Do not force artificial composition differences.

---

## 4. Empty states

| Surface | Zero-data behavior today | Honest? | Action |
|---|---|---|---|
| Debt (`renderDebtSummary`, and the real Debt workspace) | "No debt accounts shared / Share debt accounts from the Spaces page" | Yes — and correct for a debt-free user | none |
| Debt breakdown (`renderDebtBreakdownChart`) | "Share your debt accounts from Manage → Add Accounts…" | Yes — points to the action | none |
| Liquidity (SourcesLedger / ladder) | "connect an asset account to see where your money sits" | Yes | none |
| Manual asset (`AssetValueWidget`: Property/Vehicle/Equipment) | "Property value hasn't been configured yet." + capability subline | Honest, but **describes capability, not the action** ("This widget *can* display…"), and — more importantly — **this widget doesn't render for those Spaces at all** (§1), so the empty state is moot for them today | copy-only: if/when the widget renders (v2.6), point the subline at "Add a manual asset from Manage → Add Accounts." For v2.5 it's moot. |

**Finding:** the debt/liquidity zero-data states are already honest and correctly guide the user — no change needed. The manual-asset empty state is honest but currently unreachable for the templates that would use it; fixing its copy only matters once the widget renders, which is v2.6. No onboarding flow is required.

---

## 5. Picker experience (`CreateSpaceModal`)

- **Descriptions already exist and are already carried to the picker** as `tpl.description` (registry populates it from `CATEGORY_DESCRIPTIONS`), but the render shows **only `tpl.icon` + `tpl.name`** (`CreateSpaceModal.tsx:355-376`). `tpl.description` is never referenced. This is the single highest-value, lowest-risk fix.
- **Categories are understandable:** featured chips (Household, Family, Debt Payoff, Emergency Fund, Retirement, Investment) with a "Show more types" toggle revealing Business, Property, Vehicle, Trip, Equipment, Custom, Other. `personal`/`goal` are hidden. Grouping is fine.
- **Icons/names are sufficient** for recognition but not for *choosing* — with no description and no section/lens preview, two similar names (Household vs Family, Custom vs Other) are indistinguishable at the point of choice. Descriptions resolve this.
- **No CMS/database needed** — the data is already in code.

**Recommendation:** render `tpl.description` beneath the name in each chip (or as a selected-state detail line). Pure JSX, no data work.

---

## 6. Template matrix — Promise → Reality → Action

| Template | Promise (current description) | Reality at runtime | Action |
|---|---|---|---|
| **Household** | "Manage shared finances with a partner or housemates." | Net-worth hero, shared scope, wealth/cashFlow/liquidity/debt lenses | **Keep** · show description |
| **Family** | "Coordinate budgets and savings across your family." | Identical to Household (same hero + lenses) | **Keep** · show description (accept shared composition) |
| **Debt Payoff** | "Strategize and track debt elimination across accounts." | Remaining-debt down-good hero + real Debt lens | **Keep** · show description |
| **Emergency Fund** | "Build and protect your emergency savings buffer." | Emergency-fund hero + liquidity lens + months-covered | **Keep** · show description |
| **Retirement** | "Monitor retirement accounts and progress toward FIRE." | Retirement-portfolio hero + Retirement routed modal (not a primary chip) | **Keep** · show description |
| **Investment** | "Focus on portfolio performance and asset allocation." | Portfolio hero + real Investments lens | **Keep** · show description |
| **Business** | "Oversee cash flow and accounts for a business or LLC." | Cash-position hero + cashFlow/liquidity lenses; **inert Business Health card leads doorway** | **Keep** · show description · **remove `businessHealth` from category list** |
| **Property** | "Track property value, mortgage, and rental income." | Equity stepAfter hero (honest); **property/mortgage widgets never render**; **inert Property card leads doorway**; **"rental income" has no feature** | **Keep** · **remove `property` from category list** · **reword description** (drop "rental income"; lead with equity) |
| **Trip** | "Budget and save for a specific trip or vacation." | Uniquely renders trip_budget/trip_savings ProgressWidgets | **Keep** · show description |
| **Vehicle** | "Monitor vehicle value and auto loan progress." | **No hero → generic net-worth workspace; value/loan widgets never render** | **Keep but reword** description to the net-worth reality (or hide until v2.6) |
| **Equipment** | "Track equipment value, loans, and maintenance costs." | Same as Vehicle; value widget never renders; "maintenance costs" has no feature | **Keep but reword** (or hide until v2.6) |
| **Custom** | "Start from a blank slate and add sections yourself." | Empty preset; net-worth workspace | **Keep** · show description |
| **Other** | "General-purpose financial space." | Net-worth workspace | **Keep** · show description |
| Personal *(hidden)* | registration default | PersonalHero + wealth | keep hidden |
| Goal *(hidden)* | legacy fallback | Goals-on-Overview | keep hidden |

No template needs to be *removed* from the picker. Two need a coming-soon lens removed from their category list; two (Property, Vehicle/Equipment) need a description reworded to stop promising a widget/feature that doesn't render.

---

## 7. Exact implementation scope

**v2.5 — truthfulness (copy + config only, no new functionality):**

| # | Change | File(s) | Risk |
|---|---|---|---|
| 1 | Render `tpl.description` in the picker chip | `CreateSpaceModal.tsx:355-376` | low (JSX) |
| 2 | Remove `property` from `PERSPECTIVES_BY_CATEGORY.PROPERTY` | `perspectives.ts:440` | low (one line) — stops the inert doorway lead |
| 3 | Remove `businessHealth` from `PERSPECTIVES_BY_CATEGORY.BUSINESS` | `perspectives.ts:442` | low (one line) |
| 4 | Reword `PROPERTY` description — drop "rental income," lead with equity | `space-presets.ts:461` | low (copy) |
| 5 | Reword `VEHICLE`/`EQUIPMENT` descriptions to the net-worth reality (don't promise value/loan tracking that doesn't render) | `space-presets.ts:462,465` | low (copy) |
| 6 | *(optional hygiene)* delete the orphaned `tax` lens def, or leave it | `perspectives.ts:412-414` | trivial |
| 7 | *(optional)* update the stale `space-presets.ts:453` comment ("shown in the template picker") once #1 lands | `space-presets.ts` | trivial |

A guard test asserting picker chips render their description, and that no category's perspective list contains a `comingSoon` lens, would lock #1–#3.

**v2.6 — functional (deferred, "do not build" now):**
- Make Property/Vehicle/Equipment seeded value widgets render on Overview (requires composing the section stack with, or beside, the wealth workspace, or a category-specific overview) — this is the real fix for the Vehicle/Equipment collapse.
- Real Business Health / Property / Tax lens workspaces.
- De-alias `investment_allocation` (→ real BreakdownWidget), `retirement_accounts`, `mortgage_tracker`, `auto_loan_tracker` to purpose-specific widgets.
- Manual-asset empty-state copy pointing at the add-account action (only once the widget renders).

---

## 8. v2.5 vs v2.6 boundary

**v2.5 (this closeout):** make the picker and templates *say true things* — show the descriptions that exist, stop two templates leading with a dead lens, and reword two descriptions that promise unrendered widgets/absent features. No workspace, data model, or widget work. Items #1–#5 above; ~2 files of copy + 2 one-line list edits + 1 JSX change.

**v2.6 (intelligence / functional):** make the manual-asset templates (Property/Vehicle/Equipment) actually *render* their signature widget, and build the Business/Property/Tax lenses. That is where the Vehicle/Equipment "collapse" is genuinely resolved rather than papered over with honest copy.

The dividing principle: v2.5 removes every *false* promise; v2.6 adds the *missing* capability. Nothing here expands template functionality.

---

## 9. Investigation completeness

- **All 15 templates inspected:** every `SpaceCategory` traced through `PRESET_MAP` (`space-presets.ts:281-385`), `PERSPECTIVES_BY_CATEGORY` (`perspectives.ts:435-450`), `SPACE_HERO_DEFS` (`space-hero.ts:42-109`), and the registry (`space-templates/registry.ts:56-75`), incl. the two hidden ones (Personal, Goal).
- **All comingSoon references checked:** exactly three (`tax`, `property`, `businessHealth`, `perspectives.ts:412/416/420`); each traced through the nav render path (primary selector allowlist, doorway card, composition switcher). `tax` confirmed orphaned across all category arrays.
- **All 22 preset section keys checked** against `SectionRegistry` — all have renderers; four are generic aliases; none are coming-soon placeholders.
- **Both render systems traced** end to end (creation seeding → `useSpaceData` → tab derivation → `WORKSPACE_RENDERERS` default-to-wealth → section suppression).
- **No implementation performed** — read-only investigation and two read-only sub-agents; zero files modified. `git status` shows only this new audit doc.
