# Atlas Glass — Real Refraction Gap Analysis

**Thread:** Atlas Glass — Material Engine
**Status:** Investigation only. No implementation. No files edited except this new document.
**Companions:** `ATLAS_GLASS_MATERIAL_ENGINE_INVESTIGATION.md`, `docs/design-system/ATLAS_GLASS_MATERIAL_DOCTRINE.md`.
**Scope guard:** did not edit `globals.css`, `GlassPanel`, `OverlaySurface`, modal behaviour, or layout; no WebGL/canvas/pointer-motion/parallax proposed.

> **One-line finding.** Atlas Glass is a high-quality *simulation* of glass — frost + edge + bloom + bevel — but it never displaces a single background pixel, so lines behind a pane stay perfectly straight. That is why it reads as "frosted acrylic with nice edges," not a lens. True refraction requires geometric displacement of the backdrop, which only `feDisplacementMap` (SVG) can do within a CSS/SVG-only budget.

---

## 0. What was verified in the code

A full grep of `app/`, `components/`, `lib/` confirms:

- **Every `backdrop-filter` in the app is `blur()` / `saturate()` / `brightness()` only.** The canonical path is `GlassPanel`'s `backdrop-filter: var(--glass-filter-{depth})`, which resolves to `blur(...) saturate(...) brightness(...)`. No exceptions.
- **No SVG filter primitives exist anywhere** — zero `<filter>`, `feDisplacementMap`, `feTurbulence`, `feImage`, `feGaussianBlur`, or `feColorMatrix` in the tree.
- **No `backdrop-filter: url(#…)` or `filter: url(#…)` refraction.** The only `url(#…)` references are Recharts linear-gradient *fills* (`nwGrad`, `insightGrad`, `spaceHeroGrad`, `phc_grad_*`) — chart paint, unrelated to glass.
- The Phase 1–3 material engine is entirely: per-depth `--glass-filter-*` (blur/sat/brightness), the `.atlas-fresnel-edge` gradient ring, `GlassPanel`'s directional bloom gradient, and the inset `box-shadow` refraction bevel/rim-light.

**Conclusion:** the current "refraction" is 100% simulated with paint (gradients, shadows) and frost (blur). Nothing warps the background.

---

## 1. Does Atlas currently do true refraction / displacement?

**No.** It performs no geometric displacement. The background behind a pane is blurred, tinted, and darkened, and the pane is lit with gradient edges/bloom and an inset bevel — but the backdrop pixels are never *moved*. A straight meridian line behind the glass remains straight; a lens would bend it. The eye uses that bending as the primary "this is refractive glass" cue, and it is absent.

---

## 2. If not, what is missing?

Two optical cues, both of which depend on moving backdrop pixels:

1. **Edge-offset refraction (the essential one).** Real glass bends light most where the surface curves — at the rim. Behind a real pane, background lines *shift and curve* near the edges and are near-undistorted in the flat center. Atlas has no positional distortion at all.
2. **Chromatic aberration (secondary, optional).** A thick lens splits the rim into faint R/G/B fringes. Atlas has none.

Both are impossible to fake with blur/gradients/shadows because those operations never change a pixel's *position*. This is a structural ceiling of the current approach, not a tuning problem — no further edge/bloom/bevel adjustment will produce bending.

---

## 3. What did the earlier GitHub reference do differently?

The reference "liquid glass" recreations (the Apple-Liquid-Glass-in-CSS class of demos) add a real displacement stage that Atlas omits:

1. Build a **displacement map** — either an inline SVG gradient/normal-map via `feImage`, or organic noise via `feTurbulence`. Edge-weighted maps push displacement to the rim (physically correct); turbulence gives a wobbly "liquid" look.
2. Feed it to **`feDisplacementMap`**, which offsets each backdrop pixel by the map's R/G channels scaled by a `scale` value → the background literally warps.
3. Apply the whole filter to the element via **`backdrop-filter: blur(…) url(#filterId)`**, so it distorts *what's behind* the pane, not the pane's own content.
4. Often add **per-channel displacement + `feColorMatrix`** for chromatic aberration, and sometimes `feGaussianBlur` inside the filter.

| Stage | Reference technique | Atlas today |
|---|---|---|
| Frost | `feGaussianBlur` or `backdrop-filter: blur()` | ✅ `blur()` via `--glass-filter-*` |
| **Backdrop displacement** | ✅ `feImage`/`feTurbulence` → `feDisplacementMap` | ❌ none |
| Edge concentration | ✅ edge-weighted displacement map | ⚠️ *faked* with gradient edge + inset bevel (paint only) |
| Chromatic aberration | ✅ per-channel displace + `feColorMatrix` | ❌ none |
| Edge light / bloom / bevel | sometimes | ✅ (this is where Atlas is actually strong) |
| Applied via | `backdrop-filter: url(#…)` | `backdrop-filter: blur/sat/bright` |

So the delta is exactly **one stage: `feDisplacementMap` applied to the backdrop.** Everything else Atlas already does, and in some respects (restrained edge/bloom/bevel) does more tastefully than the reference.

---

## 4. Smallest safe implementation of real refraction

An **opt-in, static, edge-weighted SVG displacement filter, gated and fallback-first** — introduced as a new capability, not a change to existing surfaces:

1. Add one inline SVG `<filter id="atlas-refraction">` (rendered once, hidden): `feImage` referencing an inline **edge-weighted radial/normal gradient** (near-zero displacement in the center, rising at the rim) → `feDisplacementMap` with a **low `scale` (~6–14px)**. **No `feTurbulence` animation** (that's the "liquid wobble"; keep it calm and on-brand). Aberration deferred.
2. Expose it through a **new `refraction?: boolean` prop** wired **only to the `floating`/modal tier** (a new opt-in, defaulting off), applied as `backdrop-filter: var(--glass-filter-thick) url(#atlas-refraction)`. *(Note: wiring lives in a future approved phase — not done here.)*
3. **Capability-gate it:** feature-detect `backdrop-filter: url()` support; if absent (Safari — see §6), render exactly today's simulation. Also disable under `prefers-reduced-transparency` and `prefers-reduced-motion`.
4. Keep the Phase 1–3 simulation as the **universal always-on baseline and the fallback**. Real refraction is purely additive on top of a handful of hero/modal surfaces.

This is the smallest change that produces actual bending: one filter def + one opt-in prop on one tier, everything else untouched.

---

## 5. Can it be done with CSS/SVG only?

**Yes.** `feDisplacementMap` + `backdrop-filter: url(#…)` is fully declarative SVG/CSS — no canvas, no WebGL, no JS render loop. Chromatic aberration, if ever added, is also SVG-only (`feColorMatrix` + per-channel displacement). This satisfies the CSS/SVG-only constraint.

**The catch:** "CSS/SVG-only" guarantees the *technique* is in-budget, not that it *renders everywhere*. The one browser that matters most for parity (Safari) is where the CSS/SVG path is weakest (§6). So CSS/SVG-only is necessary but not sufficient for cross-browser parity.

---

## 6. Safari, mobile, GPU, and accessibility risks

- **Safari (the dealbreaker).** WebKit supports `backdrop-filter: blur()` but does **not reliably support `backdrop-filter: url(#svgFilter)`** — across most Safari/iOS versions the SVG-filter-as-backdrop reference silently no-ops or breaks the surface. The reference demos look right in Chrome/Firefox and fall back to plain/broken glass in Safari. A feature-detect + fallback to the current simulation is **mandatory**, and the honest expectation is "visible in Chrome/Firefox, gracefully absent in Safari."
- **GPU / rendering cost.** `feDisplacementMap` re-samples the entire region behind the element on every composite. On a full-screen modal over the busy Earth field that's a large sampled area, and stacked with the existing blur it's two heavy filter passes — pushing against the doctrine's ≤2-live-filter budget.
- **Mobile.** Retina doubles sampled pixels; blur + displacement on large surfaces drops frames and drains battery. This is the binding constraint and the reason for hero/modal-only scope.
- **Containing-block trap.** SVG filters create containing blocks exactly like `backdrop-filter` — applying one to an overlay's layout ancestors risks reintroducing the documented "modal pins to the wrong element" bug. The filter must live on the surface itself, never a wrapper.
- **Responsiveness.** Displacement maps are resolution/size-referenced; the map must track element size or the distortion skews on resize.
- **Accessibility.** Distortion can reduce text/background legibility and can be a motion/vestibular concern if it ever animates (it must not). Gate on `prefers-reduced-transparency` **and** `prefers-reduced-motion`; measure text contrast against the opaque fallback fill, not the distorted state; keep the filter layer `aria-hidden` and pointer-inert.

---

## 7. Should it be opt-in only for hero/modal surfaces?

**Yes — unambiguously.** Three independent reasons converge: (a) GPU/mobile cost forbids it on many or repeated surfaces; (b) Safari fragility means it must be an enhancement with a fallback, never a dependency; (c) brand restraint (Design Language Law 7) makes refraction premium *because* it's rare. It belongs on the `floating`/modal/hero tier behind an explicit opt-in, **never** on `DataCard`, list rows, toolbars, or globally.

---

## 8. How this fits the Material Engine roadmap

It slots in cleanly as a **new, additive, opt-in Phase 4 — Refraction**, after the shipped work, with no rework of it:

- **Phase 1** — per-depth material variables + `floating` tier ✅
- **Phase 1B** — `GlassPanel` consumes the depth tokens ✅
- **Phase 2** — Fresnel edge + bloom adoption, ladder retune ✅
- **Phase 3** — refraction *illusion* (directional bevel, rim-light, stronger edge) ✅ ← current ceiling of the paint-only approach
- **Phase 4 (proposed, opt-in)** — real backdrop **displacement** via SVG `feDisplacementMap`, capability-gated, `floating`/modal only, Phase 1–3 as the fallback. Optional Phase 4b: chromatic aberration.

Phases 1–3 are the correct universal baseline precisely *because* Phase 4 can't render everywhere. Phase 4 is the enhancement tier for capable browsers on rare surfaces. It reuses the existing `--glass-filter-*` tokens (composes `blur … url(#…)`) and the existing opt-in-prop pattern (`edge`/`bloom` → add `refraction`), so it's consistent with how the engine already grows.

---

## 9. Recommendation

Adopt real refraction as an **opt-in Phase 4**, not a change to the current engine. Ship one static, edge-weighted `feDisplacementMap` filter behind a `refraction` prop on the `floating`/modal tier, capability-detected with automatic fallback to today's simulation, disabled under reduced-transparency/motion. Set expectations explicitly: **enhancement in Chrome/Firefox, gracefully absent in Safari.** If hard Safari parity is required, true refraction is not achievable with CSS/SVG alone and would need canvas/WebGL — which is out of the stated scope, so the answer there is "keep the Phase 3 simulation."

---

## 10. Smallest safe implementation path (sequenced, for when approved)

1. **Spike (throwaway):** one hero/modal surface, inline `#atlas-refraction` filter, measure in Chrome + Safari + a mid-tier phone. Confirm the Chrome win and the Safari fallback behaviour before committing.
2. **Capability detection utility:** feature-detect `backdrop-filter: url()`; expose a boolean the surface reads. Fallback = current simulation.
3. **Additive filter def:** render `#atlas-refraction` once (hidden), no consumers yet.
4. **Opt-in prop:** add `refraction` to the `floating`/modal path only, off by default, gated by the capability flag + reduced-transparency/motion.
5. **Adopt on 1–2 hero/modal surfaces**, each its own reviewable diff.
6. **Validate:** `tsc`, `lint`, cross-browser visual, mobile frame-rate, reduced-transparency/motion, contrast on fallback.

Each step is additive and independently revertible; existing surfaces stay byte-identical until a surface explicitly opts in.

---

## 11. Rollback strategy

- **Nothing to roll back today** — this phase is investigation only; no code changed.
- **When Phase 4 lands:** it is entirely additive — a hidden filter def + one opt-in prop on one tier. Rollback = remove the filter def and the `refraction` prop path; every surface falls back to the Phase 1–3 simulation with zero visual change to anything that didn't opt in.
- **Runtime kill-switch:** because the capability gate already routes unsupported/reduced-transparency contexts to the simulation, forcing that gate false globally disables refraction everywhere instantly, without touching per-surface code.
- **No data/behaviour/layout surface is involved**, so rollback is purely presentational.

---

## 12. Open decisions

1. **Safari stance:** accept "graceful absence in Safari," or hold refraction entirely until/unless a WebKit-safe path exists? (If parity is mandatory, the answer is "don't ship real refraction" — CSS/SVG can't guarantee it.)
2. **Map style:** calm edge-weighted gradient (on-brand, static) vs. `feTurbulence` "liquid" wobble (trendier, more motion/perf/vestibular cost). Recommendation: edge-weighted, static.
3. **Chromatic aberration:** in scope for v1 or deferred to 4b? Recommendation: defer.
4. **Displacement scale:** how strong before it hurts legibility over the Earth field? Needs the spike to tune (start ~6–14px).
5. **Surface set:** which exact hero/modal surfaces qualify as `floating`, and do any dashboard heroes want it or only true modals?
6. **Perf ceiling:** acceptable added cost on mobile modals, and the frame-rate threshold that vetoes it.

---

*Investigation complete. No implementation performed. Awaiting a decision on Phase 4 before any code.*
