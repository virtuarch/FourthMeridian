# Atlas Glass — Material Doctrine

**Thread:** Atlas Glass 1B — Glass Material Engine
**Status:** Doctrine / decision record. Investigation-only phase — **nothing here is implemented yet.** This document defines the rules a future, approval-gated implementation must follow.
**Scope:** Visual material only. Does not govern OverlaySurface/Dialog/FormModal behaviour, scroll locking, focus, routing, sizing, or z-index — see `ATLAS_GLASS_MODAL_DOCTRINE.md` for those.
**Companion:** `docs/investigations/ATLAS_GLASS_MATERIAL_ENGINE_INVESTIGATION.md` (findings). This file is the rules.

> **Prime directive.** Every Atlas Glass surface should feel like a real physical pane sitting above the application — responding to a single light source, with depth you can read and a world visible behind it. The goal is *not* more blur. Premium comes from **coherence and restraint**, not intensity.

---

## 1. Optical principles (the laws)

These are the non-negotiable rules. Everything downstream (hierarchy, lighting, motion) is an application of these.

1. **One light source.** The whole app is lit from a single notional direction (default: top / top-left). Every edge highlight, bloom, and shadow must agree with it. A future `--atlas-light-angle` (and/or `--atlas-light-x/y`) is the single source of truth; no surface invents its own light.
2. **Depth is physical, not alpha.** Thickness is expressed through **blur radius + saturation + brightness together**, not opacity alone. Thicker glass blurs more, saturates less, and darkens the background more. (Today's primitive violates this — see Roadmap Phase 1.)
3. **Edges are brighter than centers.** Real glass catches light at its lip. Every surface has a lit perimeter (Fresnel), brightest toward the light, falling off toward the shadowed edges. The center is the quietest part of the pane.
4. **Restraint is the brand.** Refraction, bloom, and accent glow are *rare by default*. Premium reads as premium because most surfaces are calm and only a few are lit. This extends Design Language Law 7 (scarce brass/AI accent) to the whole optical system.
5. **Material is orthogonal to motion and to color.** A surface never moves because it became premium glass, and never changes hue to signal state (state = the existing tone/accent tokens). Material carries *depth and light*, nothing else.
6. **Cheap effects first.** Perceived quality is bought with gradients, masks, shadows, and opacity before it is bought with blur radius or displacement. Expensive optics are reserved for the few surfaces that justify them.
7. **Every optical variable ships in both themes.** No new material variable exists in dark only. Light-theme parity is defined at introduction, never retrofitted.

---

## 2. Material hierarchy

Each surface class maps to a **depth**, an **elevation**, an **edge intensity**, a **bloom policy**, and a **motion profile**. The ladder below is the target model; it reconciles with — and extends — today's primitives. Values are *relative intent*, to be realised as tokens in implementation, not literal numbers to hardcode here.

| Surface | Depth (thickness) | Elevation | Edge light | Bloom | Motion | Notes vs today |
|---|---|---|---|---|---|---|
| **Buttons** | ultrathin | e1 | soft, full | none | hover lift + press scale (exists) | Keep `GlassButton`'s lighter 20px feel; formalise as `ultrathin`. |
| **Inputs** | ultrathin | e1 (inset-leaning) | soft, top-biased | none | focus = edge brighten (not just ring) | No Atlas input primitive exists yet; define one later. |
| **Tooltip** | thin | e2 | soft, full | none | fade only | Should feel the *lightest floating* surface. |
| **Dropdown / menu** | thin→regular | e3 | medium | none | fade + ≤4px rise | Sits above cards; must read as a distinct layer, not another card. |
| **DataCard** | thin | e2 | soft, full | **none** (locked) | inert by default (exists) | Motion stays opt-in; no glow — unchanged law. |
| **GlassPanel (generic)** | thin (default) | e2 | soft→medium | opt-in glow (exists) | opt-in interactive lift | The base recipe; other surfaces are presets of it. |
| **Toolbar / chrome** | ultrathin→thin | e1 | soft, top-biased | none | none | Quiet, structural; never competes with content. |
| **Sidebar** | regular | e2 | medium, one long edge | none | none (active-row presence pulse exists) | Reads as a standing wall of glass, lit along its inner edge. |
| **Drawer (edge-anchored)** | regular | e3 | medium, leading edge brightest | subtle | slide (behaviour thread owns) | Material only; anchoring/behaviour is the modal thread. |
| **Dialog / FormModal** | thick | e4 | strong, full | subtle | calm fade+rise (behaviour thread owns) | Material via `OverlaySurface`→`GlassPanel`; do not alter behaviour. |
| **Workspace overlay** | thick→floating | e4 | strong | subtle | calm (behaviour thread owns) | Largest, most-separated glass. |
| **Hero panels** | **floating** (new) | e4+ | strong, most directional | allowed (brand accent) | may host pointer-light | The only tier where richer optics (near-refraction) are sanctioned. |

**Rules for the ladder:**

- **Thickness increases with importance and separation from the page.** Chips/toolbars are thinnest; hero/modal are thickest.
- **`floating` is new** and is the brightest, most-separated, most-directional tier — reserved for hero and critical/modal surfaces. It is *not* a license for more blur everywhere; it is a small, rare tier.
- **A surface never sits on the same depth as the thing it floats above.** Dropdown over card, modal over page: the upper surface is at least one depth tier brighter/thicker so the stack reads.
- **DataCard's locks are permanent:** no glow, no displacement/aberration/curvature props, motion inert by default. The material engine must not reopen these.

---

## 3. Layering rules (stacked glass)

1. **Two-layer budget.** No more than **two live `backdrop-filter` layers** in a single visual stack (e.g. scrim + modal is the ceiling; the page behind is sampled, not counted as a third live blur *over* the modal). Adding a blurred dropdown *inside* a blurred modal over a blurred page is forbidden — collapse one layer to a solid-ish fill.
2. **Stack-aware contrast.** When glass sits over glass, the lower surface darkens slightly and the upper surface's leading edge brightens, so the layering is legible. Never stack two identical recipes.
3. **Containing-block discipline.** Because any ancestor with `transform`/`filter`/`backdrop-filter` becomes the positioning root (documented in `OverlaySurface`), new material effects must not introduce `filter`/`transform` on layout ancestors of portalled surfaces. Effects belong on the surface itself, not its wrappers.
4. **Content always on top.** Bloom and edge layers are `aria-hidden`, `pointer-events-none`, and sit **below** the content layer (the existing `z-0`/`z-[1]`/`z-10` ordering in `GlassPanel` is the pattern to preserve).

---

## 4. Lighting rules

1. **Single angle variable.** `--atlas-light-angle` (default top / top-left) drives the edge gradient *and* the interior bloom *and* agrees with elevation shadow direction. Optional `--atlas-light-x/y` for pointer-tracked surfaces resolves to the same model.
2. **Fresnel perimeter.** Replace the single top-edge specular with a full-perimeter lit ring: brightest edge toward the light, dimmest opposite. Implemented as an inset gradient ring (masked border-box gradient or a 1px gradient pad), not four separate borders.
3. **Edge intensity scales with depth.** Thicker glass = brighter, tighter, more defined edge (polished slab); thinner glass = softer, more diffuse edge. `--atlas-edge-intensity` per depth tier.
4. **Interior bloom is optional and quiet.** Max ~6–8% opacity, large radius, positioned by the light angle, below content. It is a *pooling of light inside the pane*, never a colored glow (colored glow remains the separate, scarce `glow` accent prop).
5. **Accent glow stays scarce and separate.** The existing `glow` recipes (meridian/brass/coral/violet/ai) are *semantic accent*, not material lighting. Keep them distinct: material lighting is neutral/white; accent glow is brand color and rare (AI/hero/premium only).
6. **Light theme inverts carefully.** On light glass, a white specular nearly disappears — use the brighter light-theme `--specular-edge` (already `.7`) and add a faint *dark* inner edge for definition. Blooms are lower-opacity on white. Every lighting variable carries a light value at introduction.

---

## 5. Motion rules

1. **Motion is orthogonal to material** (Optical Law 5). Becoming premium glass never adds movement. Movement is an *affordance* (interactive/hover/press/focus), opted into per surface.
2. **Permitted material-motion, all additive, all reduced-motion-gated:**
   - **Hover:** edge brighten + ≤1px lift (lift already exists on interactive panels/buttons — keep).
   - **Press:** small depth compression (surface reads as pushed *into* the light) on interactive surfaces; buttons already scale `.97` — generalise as depth, not just scale.
   - **Focus:** edge brighten in addition to the accessibility ring (never *instead of* — see §7). A material response, not a color change.
   - **Pointer light (opt-in, hero/large surfaces only):** specular/bloom follows the cursor via `--atlas-light-x/y`, updated on `pointermove`, **throttled through `requestAnimationFrame`**, disabled on touch and under reduced motion.
   - **Microparallax (opt-in):** the `AtlasField` background shifts a few pixels relative to pointer so glass appears to float above depth. Very small, very slow, reduced-motion-gated.
3. **Ambient loops stay rare and slow.** `ai-shimmer` (6s) and `atlas-globe-drift` (70s) are the ceiling for ambient motion. No new perpetual animations on data surfaces.
4. **Reduced motion is absolute.** `prefers-reduced-motion: reduce` disables all pointer light, parallax, press depth, and ambient loops (the global rule in `globals.css` plus the JS `usePrefersReducedMotion` check already establish the pattern). Under reduced motion, surfaces are still fully premium — just static.

---

## 6. Performance limits (hard budget)

1. **Blur radius is the scarce resource.** It is the single most expensive property. Higher tiers (`thick`/`floating`) get more blur; the common tiers (`ultrathin`/`thin`) stay cheap. Do not raise `thin` blur to chase prettiness — buy quality with gradients/shadows instead.
2. **≤ 2 live `backdrop-filter` layers per stack** (see §3.1). This is a ceiling, not a target.
3. **No `backdrop-filter` on large scrolling lists of items.** Rows/list items use flat or `--surface-*` tints, not per-row glass. Glass is for *surfaces*, not repeated content.
4. **Displacement/refraction (`feDisplacementMap`) is hero-only and opt-in.** Never on `DataCard`, never on list items, never on mobile by default. It is Safari-fragile and GPU-heavy.
5. **Pointer-driven effects must be rAF-throttled** and must write only CSS custom properties (compositor-friendly), never trigger layout.
6. **Low-power / accessibility fallback.** Honor `prefers-reduced-transparency` (and a low-power path): swap `backdrop-filter` for a near-opaque `--glass-*` fill so the UI stays legible and cheap. The fill tokens already exist; the fallback just drops the filter.
7. **Cross-browser floor:** effects must degrade gracefully where `backdrop-filter` is weak/absent (older Safari, constrained mobile) to the solid-fill fallback — never to an unreadable transparent surface.

---

## 7. Accessibility

1. **Focus rings are never replaced by material.** Edge-brighten on focus is *additive*; the visible `focus-visible` ring (e.g. `ring-[var(--meridian-400)]`, already used on the modal close button) always remains and must meet contrast requirements.
2. **Contrast is measured on the fallback, not the blur.** Text/'non-text contrast must pass against the near-opaque `--glass-*` fallback fill, so the UI is compliant even when `backdrop-filter` is unavailable or disabled.
3. **Reduced motion and reduced transparency are first-class**, not afterthoughts (§5.4, §6.6). A user with both enabled gets a fully static, near-opaque, fully legible Atlas Glass.
4. **Decorative layers are inert.** All edge/bloom/field layers are `aria-hidden` + `pointer-events-none` (existing pattern). They must never trap pointer or screen-reader focus.
5. **No information encoded in material alone.** Depth/bloom never carry meaning a screen-reader user would miss; state stays in the tone/accent tokens and in text.

---

## 8. Implementation roadmap (additive, approval-gated)

Ordered by payoff-to-risk. **Each phase is a separate branch/commit, ships behind a new opt-in class or prop, leaves existing surfaces byte-identical until they adopt it, and is independently revertible.** No phase begins without explicit approval. No phase edits `globals.css` or a primitive until that specific phase is approved.

### Phase 1 — Depth reconciliation + Fresnel edge *(variables + utilities only; highest payoff, lowest risk)*
- Add per-depth blur/saturation/brightness custom properties so `depth` becomes physical thickness, aligning the primitive with the design language's own `.m-*` spec.
- Add a `floating` depth tier.
- Add a full-perimeter edge-light utility class (opt-in) to replace the single top edge.
- **No primitive edits.** New surfaces opt in via class; existing surfaces unchanged. A later, separately-approved step points `GlassPanel` at the new depth vars.
- *Payoff: ~70% of the perceived premium jump. Risk: minimal — pure additive CSS.*

### Phase 2 — Light-angle model + interior bloom *(variables + utilities)*
- Introduce `--atlas-light-angle` (+ light-theme value) and refactor edge + bloom to share it.
- Add an opt-in interior-bloom utility (≤8% opacity, neutral).
- *Payoff: coherent single-light feel. Risk: low.*

### Phase 3 — Additive material primitive *(approval-gated; only if utilities prove insufficient)*
- If class-composition gets unwieldy, introduce **one** new additive primitive (e.g. `GlassSurface`, or a `material="…"` preset path) that packages Phases 1–2. It **wraps/uses** `GlassPanel` semantics without modifying `GlassPanel`.
- *Risk: moderate — new surface area; gated on real need.*

### Phase 4 — Motion *(approval-gated; reduced-motion path built first)*
- Pointer-tracked light (`--atlas-light-x/y`, rAF-throttled, hero-only), press depth on interactive surfaces, optional microparallax.
- *Risk: moderate — perf-sensitive; built behind reduced-motion from commit one.*

### Phase 5 — Field enhancement + light-theme verification
- Optional star/atmosphere layer and microparallax for `AtlasField`.
- Exercise the (already tokenised) light theme end-to-end; fix parity gaps surfaced by the new optical variables.
- *Risk: low-moderate; decorative + verification.*

### Adoption (separate, per-surface, after phases land)
- Existing surfaces migrate onto the new material one class at a time, each its own reviewable diff, following the same impact-map / rollback / validation discipline the modal doctrine uses. `DataCard` locks (§2) are respected throughout.

**Validation for every phase that touches code (when approved):**
`npx prisma generate` is N/A (no schema) → run: build, `npx tsc --noEmit`, `npm run lint`, visual diff of an opt-in sample surface in Chrome + Safari + Firefox + mobile, and a reduced-motion / reduced-transparency pass.

---

## 9. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Perf regression from more/deeper blur & lit layers | Medium | High (mobile jank) | Blur budget (§6.1), ≤2-layer cap (§3.1), no per-row glass (§6.3), low-power fallback (§6.6). Measure on mid-tier mobile before adoption. |
| Safari containing-block breakage from new filters on wrappers | Medium | High (mispositioned overlays) | Effects on the surface only, never layout ancestors (§3.3). Regression-check portalled overlays. |
| Repricing the whole app by editing shared `GlassPanel` | Medium | High | Additive-first: vars + opt-in utilities; primitive re-point is a separate approved step. |
| Optical sprawl / "everything shimmers" cheapening the brand | Medium | Medium | Restraint law (§1.4), scarce accent (§4.5), DataCard locks (§2). |
| Light theme diverges (untested) | High (if ignored) | Medium | Every variable ships a light value (§1.7); Phase 5 verification. |
| Accessibility regressions (contrast on transparent glass, focus lost) | Low–Medium | High | Contrast measured on fallback fill (§7.2), focus ring never replaced (§7.1), reduced-transparency path (§6.6). |
| Scope bleed into the modal-behaviour thread | Low | High | Material-only rule; this doctrine explicitly defers all behaviour to `ATLAS_GLASS_MODAL_DOCTRINE.md`. |

---

## 10. Rollback strategy

- **Per-phase isolation.** Each phase is its own branch/commit introducing only new variables/utilities (and, later, opt-in props). Reverting a phase = deleting its variables/utilities; because existing surfaces don't reference them until a separate adoption step, **revert is inert** — no surface changes appearance on rollback.
- **Adoption reverts independently of the engine.** A migrated surface can be reverted to its previous recipe without removing the material engine, and vice versa, since adoption is per-surface and per-commit.
- **Primitive re-point is the only "hot" change** and is quarantined to its own approved commit; rolling it back restores the current uniform recipe exactly (the `--glass-*` fills and `blur(30px)` values are unchanged by earlier phases).
- **Kill switch.** The low-power/reduced-transparency fallback (§6.6) doubles as a global escape hatch: if any effect misbehaves in production, forcing the fallback path renders every surface as a legible near-opaque fill with no filters.
- **No data/behaviour surface touched**, so there is no migration to unwind — rollback is purely presentational.

---

## 11. Findings & next step (recap)

Atlas Glass is a coherent frosted system whose depth is currently opacity-only and whose lighting is a single top edge. The premium gap is closed additively: make depth physical (blur/saturation scale with thickness), light the full perimeter from one shared angle, add a quiet interior bloom, and — later, gated — pointer light and microparallax, all under a strict blur budget and reduced-motion/transparency discipline, with full light-theme parity.

**Do not implement.** This thread ends at investigation. Recommended first move when work is approved: **Phase 1 only** (per-depth blur/saturation vars + a Fresnel edge utility), delivered as variables and one opt-in utility class, no primitive or `globals.css` edits beyond additive tokens, reviewed as a single diff. Stop after approved scope.
