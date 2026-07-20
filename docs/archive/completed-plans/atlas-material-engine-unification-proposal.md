# Atlas Material Engine — Liquid Unification Proposal (Phase 1B design review)

**Type:** Investigation / architecture proposal only. No code, no edits, nothing implemented.
**Date:** 2026-07-03  ·  **Branch:** `feature/v2.5-spaces-completion`
**Trigger:** the Daily Brief Liquid prototype is approved *visually*. This document designs the transition from the experiment into a permanent Atlas material — one material engine, not a parallel design system.
**Governing predecessors (not re-litigated):** `ATLAS_GLASS_MATERIAL_DOCTRINE.md`, `ATLAS_GLASS_MODAL_DOCTRINE.md`, `MATERIAL_ENGINE_PHASE_1A_CHECKLIST.md`, `ATLAS_GLASS_REAL_REFRACTION_GAP_ANALYSIS.md`, `ATLAS_ENDGAME_INVESTIGATION.md`.

---

## 1. Current architecture assessment

### 1.1 Atlas today is already a single material engine — expressed as tokens + one base primitive

- **`GlassPanel`** is the canonical surface. It owns geometry (`radius`), the depth ladder (`ultrathin → thin → regular → thick → floating`), elevation (`e1–e4`), the Fresnel edge, directional bloom, the inset refraction bevel, accent `glow`, and the `interactive` affordance. Material is driven entirely by CSS tokens: `--glass-{depth}` fills (per-theme) and `--glass-filter-{depth}` = `blur() saturate() brightness()`.
- **`DataCard`**, **`OverlaySurface`** (+ `Dialog`/`FormModal`/`ConfirmDialog`), and effectively every migrated surface **compose GlassPanel**. `DataCard` deliberately *locks out* material embellishment (no glow, no liquid props, motion inert) — data stays quiet.
- **`GlassButton`** is the one near-peer that hand-rolls its own `backdrop-filter: blur(20px) saturate(160%)` instead of routing through the depth tokens — a small, pre-existing inconsistency (it predates the Phase 1A ladder).
- Interaction is already tokenized and shared: `--dur-*`, `--ease-*`, `--z-modal*`, `motion-safe`, `prefers-reduced-motion`, `prefers-reduced-transparency`.

**So the glass side is coherent: one engine, one depth system, one interaction model, tokens as the source of truth.**

### 1.2 Liquid today is a parallel, un-integrated second system

The approved prototype uses **`@ogtirth/liquid-glass-oss`** — a **WebGL-canvas** material that refracts a *supplied `backgroundImage`* and composites crisp DOM children above it. This is a genuinely different, higher-fidelity material than the CSS simulation (it actually displaces backdrop pixels). But as built it is a parallel system, not an Atlas material:

- **It shares none of the material engine.** `refraction` / `chromaticAberration` / `variant` are library props; it consumes **zero** `--glass-*` depth tokens. It only borrows the *interaction* tokens (`--dur-base`, `--ease-standard`, `--meridian-400` ring) and a hand-placed contrast scrim (`rgba(6,9,17,0.32)`).
- **Duplicated implementations.** `BriefLiquidCta` and `BriefLiquidCard` re-implement the click/link/keyboard/focus wrapper, geometry, and scrim that GlassPanel/DataCard already provide — in parallel, per component, with scoped `<style>` tag geometry hacks (`.lg-card`, `.lg-card__content`).
- **The registration gap.** The library refracts a **static image** (`/oval-world.png`), not the live, masked/blurred/animated Atlas field (`fourth-meridian-dark.png` in `globals.css`). Every Liquid component's own header flags this: "won't register perfectly with what's actually painted behind." Liquid therefore only looks *correct* where the fed image ≈ the real backdrop — i.e., over the Earth hero.

### 1.3 There are actually TWO liquid libraries, and one is already dead

| Package | Technique | Verdict | Files |
|---|---|---|---|
| `liquid-glass-web-react` | SVG `feDisplacementMap` **content** lens (warps the element's own children / the Earth image) | **Rejected** (STATUS §8) — inert | `BriefHeroRefractionSpike` (inert passthrough), `SpaceHeroRefractionSpike`, `BriefButtonRefraction`, `LiquidButton`, `app/material-lab/*` |
| `@ogtirth/liquid-glass-oss` | WebGL canvas, refracts a **supplied backdrop image**, crisp DOM children | **Approved (visual)** | `BriefLiquidCta`, `BriefLiquidCard` (production shape); `BriefOgtirthCard`, `BriefOgtirthButton` (comparison spikes) |

### 1.4 Flags & mount points (the experiment surface to collapse)

- `NEXT_PUBLIC_LIQUID_CTA` (`1|strong`) → `BriefHero` dynamically loads `BriefLiquidCta` for the two real hero CTAs.
- `NEXT_PUBLIC_LIQUID_CARD` (`1|strong`) → `BriefInsight`, `BriefSinceLastVisit`, `BriefAttention` conditionally back their card with `BriefLiquidCard`; also `BriefOgtirthCard`.
- `NEXT_PUBLIC_LIQUID_BUTTON` (`strong`) → `BriefOgtirthButton` (comparison only).
- Inert wrappers still mounted: `BriefHeroRefractionSpike` (BriefHero), `SpaceHeroRefractionSpike` (SpaceDashboard).

### 1.5 The strategic finding from the gap analysis

`ATLAS_GLASS_REAL_REFRACTION_GAP_ANALYSIS.md` concludes the delta between Atlas glass and "real" liquid is **exactly one stage: displacing backdrop pixels**, and that the *smallest native* way to get it is an **opt-in SVG `feDisplacementMap`** applied to the `floating`/modal tier of GlassPanel — **no WebGL, no new dependency**, capability-gated with today's simulation as fallback.

**This matters enormously for the architecture:** the *material* (how the backdrop is displaced) should be a swappable implementation detail behind the primitive, because there are two viable engines for it (WebGL-ogtirth now, SVG-native later) and we do not want to marry the primitive API to either one.

---

## 2. Proposed Atlas Material architecture

**Yes — Atlas should officially become one engine, not "Atlas Glass + Liquid experiments."** The unification principle:

> **Material is an axis, not a component family.** A surface's *structure* (geometry, depth, elevation, edge, interaction, accessibility, content layer) is universal and owned by one primitive. *Material* — how the pane's backdrop is rendered — is a single property with a small set of values, resolved by one internal renderer.

Concretely, four things become singular and shared across every material:

1. **One material engine** — a single `resolveMaterial(depth, material)` boundary. `solid` = opaque fill; `glass` = today's `--glass-filter-{depth}` frost + edge + bloom + bevel; `liquid` = displacement backdrop (ogtirth now; SVG-native later). Depth semantics (thickness) are shared: a `thick` liquid and a `thick` glass are the *same tier*, rendered by different engines.
2. **One lighting model** — the doctrine's single light source becomes a real token (`--atlas-light-angle`, currently deferred to "Phase 1B" in the material doctrine). Glass edges/bloom/bevel and Liquid's highlight must both read from it, so a Liquid pane and a glass pane on the same screen are lit from the same direction. **This is a prerequisite for Liquid to look native.**
3. **One depth system** — the existing `ultrathin…floating` ladder governs both. Liquid is only sanctioned at the top of the ladder (`floating`/hero), which keeps it rare by construction (Material Doctrine Law 4: restraint).
4. **One interaction model** — the existing `--dur-*` / `--ease-*` / `motion-safe` / focus-ring / `--z-*` tokens already apply to Liquid wrappers today; formalize that Liquid **must** use them (never library-native motion).

Liquid stops being a design system and becomes **the richest tier of the one material engine** — used exactly where the engine says the deepest, most-directional glass belongs (Material Doctrine §2: `floating`/hero is "the only tier where richer optics are sanctioned").

---

## 3. Primitive hierarchy (single source of truth)

The user's sketch is directionally right; here is the recommended shape, tuned to **preserve existing architecture and add the least new surface area**.

```
AtlasSurface                     ← the ONE base primitive (today: GlassPanel, evolved)
  owns: geometry · depth · elevation · edge · bloom · interaction · a11y · content layer
  prop: material = "solid" | "glass" | "liquid"     (default "glass")
        └─ delegates ONLY the backdrop render to → MaterialRenderer (one internal module)
             ├─ solid   → opaque fill
             ├─ glass   → --glass-filter-{depth} + fresnel + bloom + bevel   (today's path)
             └─ liquid  → <AtlasLiquid> displacement backdrop (vendored ogtirth; SVG later)

Presets (thin wrappers over AtlasSurface — no new material logic):
  AtlasCard     (= DataCard)      material locked to glass|solid; liquid forbidden by construction
  AtlasButton   (= GlassButton)   routed through the depth tokens (fixes the 1.1 inconsistency)
  AtlasPanel    (= generic GlassPanel usage)
  AtlasDialog   (= OverlaySurface / Dialog / FormModal / ConfirmDialog) material locked to glass
```

Pragmatic path (recommended): **do not do a big-bang rename.** `GlassPanel` already *is* `AtlasSurface`. The minimal, behavior-preserving move is:

- Add a `material?: "solid" | "glass" | "liquid"` prop to `GlassPanel`, **defaulting to `"glass"`** so every existing surface is byte-identical.
- Extract the current backdrop styling into the `glass` branch of one `MaterialRenderer`; add the `liquid` branch that renders a single vendored `AtlasLiquid` backdrop and keeps the existing content layer / scrim / edge / interaction untouched.
- Keep `GlassPanel`/`DataCard`/`OverlaySurface` names; optionally add `AtlasSurface`/`AtlasCard`/etc. as **aliases** if the team wants the vocabulary. Naming is cosmetic; the single source of truth is the primitive + the one `MaterialRenderer`.

**Result:** `material="liquid"` is the *entire* public API for Liquid. `BriefLiquidCta`/`BriefLiquidCard` cease to exist as separate components — they become `<DataCard interactive material="liquid">` / `<AtlasButton material="liquid">` usages.

---

## 4. Material doctrine (permanent)

Based on the approved visual direction and the registration-gap constraint:

**Where Liquid SHOULD be used**
- **Hero / brand chrome over the Atlas Earth field only.** The Daily Brief hero CTAs and hero-region cards (the approved surfaces); the Space detail hero. These are singular, large, `floating`-tier surfaces sitting over a *known* backdrop image that the engine can be fed — so refraction registers and reads as intentional brand identity.
- Restricted to the **`floating` depth tier**, so it is automatically rare (Law 4).

**Where Liquid must NEVER be used**
- **Data-dense surfaces** — dashboard `DataCard`s, tables, lists, chart cards. Displacement fights legibility and multiplies WebGL cost. `DataCard` forbids it by construction.
- **Modals / overlays over arbitrary app content** — there is no meaningful single backdrop to refract, the two-live-blur-layer budget (Material Doctrine §3) is already spent by scrim + panel, and OverlaySurface stays glass.
- **Anywhere the fed image ≠ the real backdrop** (the registration gap). If a surface doesn't sit over the Earth field, Liquid will mis-register — use glass.
- **Under `prefers-reduced-transparency` / `prefers-reduced-motion`, or where WebGL is unavailable** — fall back to glass.

**Which surfaces remain traditional Atlas glass:** everything that is not a hero over the field — all data cards, all chrome (sidebar, toolbars, nav), all modals/dialogs, inputs, tooltips, dropdowns.

**Should data-heavy cards remain simpler?** **Yes, permanently.** This is Design Language Law 7 (scarce accent) + the DataCard locks, extended to material: *material richness is inversely proportional to data density.* Data reads on glass or solid; only chrome/hero earns Liquid.

**Chrome carries the material; data stays readable.** Adopt this as doctrine: the pane (chrome) may be as rich as `floating` Liquid, but the **content layer is always crisp, accessible DOM above the material with a guaranteed contrast floor** (the scrim becomes a primitive-owned, tokenized concern, not a per-component literal).

One-line doctrine: **Liquid is the `floating` tier of Atlas glass, used only on hero chrome over the Earth field; data never rides Liquid.**

---

## 5. Vendoring strategy (remove the experiment without changing behavior)

"Vendor" here means two things — bring the material *in-house* behind one boundary, and *de-experiment* the call sites. Do both, additively, behavior-first.

1. **Single import boundary (`AtlasLiquid`).** Create one internal module that is the *only* file allowed to import `@ogtirth/liquid-glass-oss` — mirroring the codebase's existing "single LLM import site / single decrypt module" discipline. It encapsulates: the library call, the fed `backgroundImage`, the scrim, the geometry normalization, capability detection, and the glass fallback. Every other Liquid import site is deleted.
2. **Collapse duplicates into the material prop.** Re-point the approved surfaces (`BriefHero` CTAs; `BriefInsight`/`BriefSinceLastVisit`/`BriefAttention` cards) at `material="liquid"` on the existing primitives. Then delete `BriefLiquidCta` and `BriefLiquidCard` — their wrapper/geometry/scrim logic is now the primitive's.
3. **Remove feature flags by promoting the approved config to defaults.** The approved settings (the non-`strong` values: `refraction 0.5`, `chromaticAberration 0.12`, tier-appropriate radius) become the `liquid` material defaults. `NEXT_PUBLIC_LIQUID_CTA/CARD/BUTTON` are deleted; `strong` was a tuning aid and does not ship. Behavior is identical to "flag on, conservative" — which is the approved state.
4. **Delete the rejected library and all dead spikes.** Remove `liquid-glass-web-react` from `package.json` and delete `BriefHeroRefractionSpike`, `SpaceHeroRefractionSpike`, `BriefButtonRefraction`, `LiquidButton`, `app/material-lab/*`, `BriefOgtirthCard`, `BriefOgtirthButton` (comparison spikes). This also closes the KD-13 residue.
5. **Keep SSR behavior identical.** `AtlasLiquid` stays `dynamic(..., { ssr:false })` behind the primitive, so flag-off's "no WebGL on the server" property is preserved and there's no new hydration/CLS risk.

Net: two `package.json` deps → one; ~9 experimental components → zero; three env flags → zero; two duplicate card/button implementations → one prop. **No rendered surface changes** because the approved config becomes the default and the glass fallback is the old default.

---

## 6. Phase 1B proposal

The material doctrine originally scoped Phase 1B as "Fresnel edge + floating tier." Phase 1A/2/3 already delivered the edge, floating fill, and bevel. **Re-aim Phase 1B at the material axis + Liquid promotion**, since that is the live, approved need — with unified lighting folded in as its true prerequisite.

**Phase 1B — "Material Axis & Liquid Promotion."** Ordered, each step independently shippable and revert-safe:

1. **Unified lighting token** (`--atlas-light-angle` + `--atlas-light-x/y`). Re-point glass edge/bloom/bevel at it (behavior-identical at the current default angle). *Prerequisite:* Liquid's highlight must agree with glass's light source.
2. **Material axis, default glass.** Add `material` to the base primitive + extract `MaterialRenderer`; glass path unchanged, every surface byte-identical.
3. **`AtlasLiquid` single boundary.** Vendor the ogtirth call behind one module with capability detection + glass fallback + tokenized scrim.
4. **Promote approved surfaces** to `material="liquid"`; delete `BriefLiquidCta`/`BriefLiquidCard`.
5. **Retire flags** (approved config → defaults).
6. **Delete rejected library + all spikes** (closes KD-13 residue).
7. **Material API freeze.** Lock the `material` prop contract, the Liquid usage rules (§4), and the fallback guarantees; document that the Liquid *implementation* (ogtirth vs future SVG-native) is swappable behind `AtlasLiquid` without touching call sites.

**Why this ordering beats the user's list:** it front-loads *unified lighting* (without it, Liquid looks lit from a different sun than the glass beside it), and it sequences *delete* strictly after *promote + freeze* so nothing is removed while a call site still depends on it. It also explicitly preserves the **SVG-native refraction** path from the gap analysis as a drop-in future material, so adopting WebGL now does not lock us into an unmaintained dependency forever.

---

## 7. Spaces Dashboard recommendation

**Question: is the Spaces Overview page (the grid listing every Space) the right next Liquid pilot?**

**Recommendation: No — not the card grid.** Three reasons rooted in the doctrine:

1. **Data density.** Space cards carry data (name, members, balances/metrics). §4 says data never rides Liquid. A grid of Liquid data cards violates "chrome carries material, data stays readable."
2. **Performance.** Liquid is a WebGL canvas *per instance*. A list page renders N Spaces → N canvases → real GPU/battery cost, especially on mobile. Hero surfaces are singular; grids are not.
3. **Registration gap.** Grid cards do not each sit over a clean, known Earth backdrop; the fed image would mis-register per card.

**Better pilot: the singular hero surfaces.** The approved Daily Brief hero is pilot #1 (already visually approved). The correct *next* pilot is the **Space *detail* hero** — one large `floating` surface over the Space's Earth field — which `SpaceHeroRefractionSpike` was already probing. That extends Liquid along the grain of the doctrine (one hero per page, over the field) and validates the primitive's `material="liquid"` path on a second surface **before** any broad rollout.

If a Spaces *Overview* moment is desired, apply Liquid to a **single** feature element on that page (e.g., a hero/banner or the primary "Create Space" CTA), never to the repeating card grid.

---

## 8. Risks

- **WebGL cost & battery** — per-instance canvases; mitigated by restricting Liquid to singular hero surfaces (§4/§7) and lazy `ssr:false` loading.
- **Dependency risk** — `@ogtirth/liquid-glass-oss` is a small OSS lib; API churn or abandonment. Mitigated by the single `AtlasLiquid` boundary and the SVG-native fallback path as an exit.
- **Registration gap** — fed static image ≠ live animated field; visible mis-alignment if Liquid escapes hero-over-field usage. Mitigated by doctrine + the primitive refusing Liquid outside sanctioned tiers.
- **Accessibility** — must honor `prefers-reduced-transparency`/`-motion`, guarantee a contrast floor over the refraction, preserve focus/keyboard (today's wrappers do; the primitive must keep it). Fallback to glass in all reduced modes.
- **Two-sources-of-truth drift** — if `material` is added but lighting/depth/scrim aren't truly unified, Liquid and glass diverge again. Mitigated by making Phase 1B step 1 (unified lighting) a hard prerequisite and routing the scrim through a token.
- **SSR/hydration/CLS** — `ssr:false` means a client-only paint; keep the glass fallback rendering immediately so there's no layout shift.
- **Theme parity** — light theme is defined but unwired; Liquid must ship both-theme values at introduction (Material Doctrine Law 7), not retrofit.
- **Perf regressions on low-end/Firefox/Safari** — capability-detect; fall back to glass silently.

## 9. Rollback strategy

- **Default is glass.** `material` defaults to `"glass"`; the entire change is inert until a surface opts in. Reverting any surface = drop the `material="liquid"` prop.
- **Capability-gated with glass fallback** — no-WebGL / reduced-transparency / reduced-motion already render exactly today's glass, so the safe path is always live.
- **Single boundary** — removing Liquid entirely is one file (`AtlasLiquid`) + one dep line; the primitive keeps working.
- **Step-wise revert** — each Phase 1B step is independently shippable and revertible (the project's established migration discipline). Lighting-token, material-axis, promotion, flag-removal, and deletion are separate commits.
- **Deferred deletion** — keep the approved flag config recoverable for one release before deleting the standalone components, so a fast revert doesn't require reconstructing them.

## 10. Final recommendation

Adopt the **single material engine**. Make Liquid the `floating`-tier material of the existing Atlas primitive via one `material` prop (default `glass`), with the ogtirth call vendored behind a single `AtlasLiquid` boundary and a guaranteed glass fallback. Restrict Liquid by doctrine to **hero/brand chrome over the Earth field**; keep **all data on glass/solid**; chrome carries material, data stays readable. Execute as **Phase 1B "Material Axis & Liquid Promotion"** in the order in §6 (unified lighting first, deletion last, API freeze at the end). **Do not pilot on the Spaces Overview card grid** — pilot the Space *detail hero* next. Delete the rejected `liquid-glass-web-react` and all spikes, remove the three flags by promoting the approved config to defaults, and collapse the duplicate card/CTA components into the material prop. Preserve the **SVG-native `feDisplacementMap`** option as a swappable future implementation behind `AtlasLiquid`, so choosing WebGL today never becomes a permanent dependency.

This eliminates the experimental phase and the parallel system, leaves exactly one primitive + one material renderer as the source of truth, and changes no rendered surface in the process.

*End of proposal. No code written, no files edited beyond this new document.*
