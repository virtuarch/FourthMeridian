# Atlas Material Doctrine — Glass & Liquid (Platform)

**Status:** Governing doctrine. No implementation. Defines where the two Atlas materials — **Glass** (default) and **Liquid** (rare premium accent) — are allowed to exist across Fourth Meridian, now and through v2.6+.
**Companions:** `ATLAS_GLASS_MATERIAL_DOCTRINE.md` (Glass internals), `ATLAS_LIQUID_MATERIAL_STANDARDIZATION_PLAN.md`, `SPACES_LIQUID_DESIGN_INVESTIGATION.md`.

> **Prime rule.** Atlas Glass is the platform standard. Atlas Liquid is a rare premium *accent*, not a second design system. Liquid is premium **because it is scarce** — if many surfaces use it, none feel special.

---

## 1. Material philosophy

Fourth Meridian has **one design system** with **two materials**:

- **Atlas Glass** — the ubiquitous, quiet, cheap, cross-browser default (`backdrop-filter` frost + edge + tokens). It carries structure, data, and chrome everywhere. It is the material you never notice because it's always there.
- **Atlas Liquid** — a WebGL refraction *material skin* (`AtlasLiquidCta` / `AtlasLiquidCard`, capability-gated by `useAtlasLiquid`). It exists to make a **handful of singular moments** feel premium. It has no component library, no token system, no layout responsibilities — it is a finish applied to a few approved surfaces.

Three hard constraints (learned during the pilots) shape every rule below:

1. **Cost is per-surface and real.** Each Liquid surface is a live WebGL canvas. It must never be applied to repeated, gridded, or data-dense UI (N canvases = a perf/battery failure).
2. **Liquid refracts a *supplied* texture, not the live backdrop.** It is a *content* lens, not a *backdrop* lens. It looks right where the "background" is a known static asset (the Earth) or where a self-contained/specular read is fine — and it visibly clashes on surfaces floating over a *live shared backdrop* (the Spaces globe, dashboards).
3. **Liquid is always an enhancement, never a dependency.** Every Liquid surface has a Glass fallback (no WebGL / `prefers-reduced-transparency` / `?atlasLiquid=0`). If Liquid were removed tomorrow, every screen must still be complete in Glass.

---

## 2. Atlas Glass responsibilities (the platform standard)

Glass is the **default for essentially everything**, and specifically owns:

- **All chrome & navigation** — sidebar, top bar, tab bars, toolbars, breadcrumbs.
- **All modals & overlays** — `OverlaySurface`, dialogs, drawers, popovers, tooltips, dropdowns, menus, command palettes. (Modals rely on `backdrop-filter`; Liquid is the wrong tool.)
- **All data surfaces** — `DataCard`, charts, metric rows, tables, lists, dashboards.
- **All repeated/gridded content** — card grids, list rows, the Spaces `SpaceCard` tiles and their shared canvas, public-Spaces tiles.
- **All forms & inputs** — Create Space modal body, settings forms, editors.
- **All functional/utility areas** — Admin, Platform Ops, Settings.
- **Every Liquid surface's fallback.**

Glass is the safe, universal, calm baseline. When in doubt, it is Glass.

---

## 3. Atlas Liquid responsibilities (rare premium accent)

Liquid is reserved for **singular, high-intent, emotional moments**, one per view at most:

- **Primary hero CTAs** at a decision point (Daily Brief hero CTAs; Create Space CTA).
- **Narrative / storytelling surfaces** (the Daily Brief cards — a deliberately cinematic, once-a-day surface).
- **Featured / discovery hero cards** — a single "recommended" item that should feel special (a featured template, a featured framework, a marketplace hero).
- **Onboarding / empty-state hero moments** — the welcome beat, the "get started" primary action.
- **Public marketing heroes** — sign-up hero, primary conversion CTA.

A surface qualifies for Liquid only if it is **all** of: singular (not repeated), high-intent or emotionally weighted, non-data-dense, backed by a known/static texture (or a self-contained read), and acceptable to degrade to Glass.

---

## 4. What makes a good Liquid candidate

| Signal | Why it fits |
|---|---|
| **Rarity** | One-of on the view; scarcity is the premium. |
| **High intent** | A primary action/decision (Create Space, Continue, Upgrade, Sign up). |
| **Premium action** | Upgrade, unlock, featured, paid — moments worth elevating. |
| **Discovery** | The single hero item that should draw the eye (featured template/framework). |
| **Hero moment** | The one focal surface of a screen. |
| **Storytelling / emotion** | Narrative or celebratory surfaces (Daily Brief, milestones). |
| **Static/known backdrop** | The refracted texture can be a real asset (Earth) so it reads honest. |

**Anti-signals (disqualify):** repeated, gridded, data-dense, interactive-utility, over a live shared backdrop, must-work-everywhere-without-enhancement.

---

## 5. Is Liquid a "premium accent material" or a second design system?

**A premium accent material — explicitly not a second design system.** Governance that keeps it that way:

- **No parallel component library.** Only two primitives (`AtlasLiquidCta`, `AtlasLiquidCard`); no Liquid tables, inputs, menus, modals, etc.
- **One-per-view rule of thumb.** More than one Liquid surface on a screen is a smell.
- **Allowlist, not ad-hoc.** New Liquid usage requires doctrine sign-off against this matrix, never opportunistic adoption.
- **Glass fallback is authoritative.** Liquid never owns layout, spacing, or behavior — Glass does; Liquid only reskins.
- **Budgeted.** If WebGL-context count or mobile FPS is threatened, Liquid usage is cut first.

---

## 6. Decision matrix

### Always Glass
Platform chrome (sidebar, top bar, tab bars, toolbars, breadcrumbs) · all modals/overlays/dialogs/drawers/popovers/tooltips/dropdowns/menus/command-palettes · `DataCard` and all data/metric/chart surfaces · tables, lists, rows · card **grids** (incl. the Spaces `SpaceCard` tiles + shared canvas, public-Spaces tiles) · forms & inputs (incl. Create Space modal body) · Admin · Platform Ops · Settings · dashboards (data) · every Liquid surface's fallback.

### Sometimes Liquid (singular, gated)
Daily Brief hero CTAs *(shipped)* · Daily Brief narrative cards *(shipped)* · Create Space CTA *(shipped)* · a **single** featured Template card · a **single** featured Framework/Marketplace card · a discovery/gallery **hero** (one, not the grid) · empty-state / onboarding **hero** · public marketing **hero** + primary conversion CTA · a premium/upgrade CTA · a rare celebration/milestone hero. *(Each: one-per-view, high-intent, non-repeated, static/known backdrop, Glass fallback.)*

### Never Liquid (regardless of future features)
Any **repeated/gridded** surface (grids, lists, rows, tiles) · any **data-dense** surface (charts, metrics, tables, dashboards) · **modal chrome / overlays** · **forms & inputs** · **Admin / Platform Ops / Settings** functional surfaces · **navigation/chrome** (sidebar, toolbars, tab bars) · **tooltips / menus / popovers** · any surface over a **live shared backdrop** where the supplied-texture mismatch shows (**Space detail hero**, dashboard heroes over the globe) · anything that must be **reliable cross-browser without enhancement**.

---

## 7. Roadmap for future Liquid expansion (v2.6+)

Liquid should **reappear only at natural hero/discovery/premium beats**, always singular:

- **Templates:** one **featured/recommended** template card (Liquid); the picker/gallery grid stays Glass. If a template gallery lands, at most one **gallery hero**.
- **Frameworks / Marketplace:** one **featured framework** or **marketplace hero banner**; a **premium/paid** unlock CTA. The listing **grid stays Glass**.
- **Discovery / onboarding:** the **welcome / empty-state hero** and the **primary "get started" CTA**.
- **Public marketing:** **hero sections** and the primary **sign-up / conversion CTA** — strong candidates (static backdrops, high intent, emotion).
- **AI:** the Daily Brief AI surface already uses it; a future **"premium insight" hero** could — but AI **chat/results/data** surfaces stay Glass.
- **Dashboards:** data stays Glass forever; the *only* possible opening is a rare **milestone/celebration hero** (e.g., a net-worth milestone) — cautiously, never the data cards, and only if the backdrop mismatch is solved (refract the actual Atlas asset).
- **Admin / Ops / Settings:** **never** — functional, dense, no premium/emotional intent.

**Expansion gate (every candidate must pass):** singular on its view · high-intent/emotional · non-repeated & non-data-dense · known/static backdrop (or self-contained read) · Glass fallback verified · fits the one-per-view budget · signed off against §6.

---

## 8. Governing summary

- **Glass is the platform.** Liquid is a garnish on a few hero moments.
- **Scarcity is the strategy** — the value of Liquid is inversely proportional to how often it appears.
- **Never** on grids, data, modals, forms, chrome, admin/ops/settings, or over a live shared backdrop.
- **Always** with a Glass fallback and against the allowlist.
- New Liquid = a doctrine decision (this matrix), not an implementation impulse.

*Doctrine only. No code, no UI changes. Any future Liquid surface starts as a §6 "Sometimes" candidate and must clear the §7 expansion gate before implementation.*
