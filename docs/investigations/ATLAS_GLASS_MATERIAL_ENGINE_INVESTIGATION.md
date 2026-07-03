# Atlas Glass — Material Engine Investigation

**Thread:** Atlas Glass 1B — Glass Material Engine
**Status:** Investigation only. No implementation. Nothing in this document has been built.
**Scope:** Visual material only. This thread does **not** touch OverlaySurface behaviour, GlassModal/Dialog/FormModal behaviour, scroll locking, focus management, routing, modal sizing, z-index, or any workflow/interaction logic. Those are owned by the modal-infrastructure thread and are assumed to continue independently.
**Companion:** `docs/design-system/ATLAS_GLASS_MATERIAL_DOCTRINE.md` (the rules); this file is the findings.

---

## 0. Executive summary

Atlas Glass today is a *good* frosted-glass system: one canonical surface primitive (`GlassPanel`), semantic depth/elevation tokens, a specular top edge, optional ambient glow, and a masked brand background (`AtlasField`). It is coherent and tokenised. What it is **not** yet is a *material* — a surface that behaves like a physical pane responding to light, depth, and the world behind it.

The single most important finding: **depth is currently an opacity change only.** `GlassPanel` hardcodes `backdrop-filter: blur(30px) saturate(160%)` for every depth, so `thin`, `regular`, and `thick` differ solely by background alpha. The design-language reference (`Fourth-Meridian-Design-Language-v1.html`, the `.m-*` classes) already specifies that blur and saturation should *scale with thickness* (16 → 28 → 40 → 60px; 180% → 165% → 150% → 140%). Reconciling the primitive with its own spec is the highest-leverage, lowest-risk upgrade available and unlocks most of the "premium" perception on its own.

The rest of the premium gap is additive optical detail — Fresnel edge lighting instead of a single top edge, a restrained interior bloom, a light-angle variable that lets edges and glow respond to a shared direction, and micro-motion (pointer-tracked light, press depth). None of it requires touching component behaviour, and all of it can be delivered as CSS variables + utility classes + one optional additive primitive.

**Recommendation:** proceed in additive phases, variables and utilities first, no edits to existing primitives until a specific phase is approved. Estimated visual payoff is front-loaded: Phase 1 (depth reconciliation + Fresnel edge) delivers ~70% of the perceived premium jump for near-zero risk.

---

## 1. Current implementation — what exists today

### 1.1 The token layer (`app/globals.css`)

The material vocabulary lives entirely in `:root` + the two theme blocks:

- **Depth fills** — `--glass-ultrathin` (`rgba(255,255,255,.05)`), `--glass-thin` (`rgba(18,24,38,.55)`), `--glass-regular` (`rgba(14,19,31,.72)`), `--glass-thick` (`rgba(10,14,23,.88)`). These are *fill/alpha only* — they carry no blur or saturation information.
- **Edge / light** — `--specular-edge` (`rgba(255,255,255,.16)` dark, `.7` light), `--border-hairline` / `--border-hairline-strong`.
- **Elevation** — `--shadow-e1..e4`, each an outer drop shadow plus a `0 0 0 1px rgba(255,255,255,.05..10) inset` white ring.
- **Scrim** — `--scrim` for modal backdrops.
- **Surface tints** — `--surface-hover`, `--surface-hover-strong`, `--surface-muted`, `--surface-inset`.
- **Motion** — `--ease-*`, `--dur-*`, plus `--dur-ambient` (2400ms) and `--dur-shimmer` (6000ms).

Both a `dark` (shipping) and a `light` (reserved, not wired to a toggle) theme define the full set, so the material language is already theme-parameterised even though only dark ships.

### 1.2 The primitive layer (`components/atlas/`)

| Primitive | Material recipe today | Notes |
|---|---|---|
| `GlassPanel` | `blur(30px) saturate(160%)`, `--glass-{depth}` fill, `--shadow-{elevation}`, 1px hairline border, **single top-edge specular gradient**, optional radial `glow`, optional `interactive` hover lift (`-1px`) | The canonical surface. Every other surface composes it. |
| `DataCard` | Composes `GlassPanel` at `thin`/`e2`/`lg`, no glow, motion inert by default | Semantic wrapper. Deliberately exposes **no** liquid-glass props. |
| `OverlaySurface` | Composes `GlassPanel` at `thick`/`e4`/`xl`; adds scrim with `blur(8px)` | Behaviour-owning modal primitive — **out of scope for this thread**, referenced for material only. |
| `GlassButton` | `blur(20px) saturate(160%)`, tinted fills per `tone`, top-edge specular, hover `-1px` + active `scale(.97)` | Button-shaped sibling. |
| `AtlasField` | Background: masked brand globe PNG (`blur(2px) brightness(.52) saturate(1.15)`), inline SVG meridian grid, one brass horizon arc, radial base gradient, 70s drift | Decorative page backdrop. |

### 1.3 The "signature" today

The recognisable Atlas Glass tell is the **1px top-edge specular highlight** (`linear-gradient(90deg, transparent, var(--specular-edge), transparent)`) sitting above the fill, present on `GlassPanel` and `GlassButton`. It reads as light catching the top lip of a pane. It is the seed of a real edge-lighting model but is currently only *one* edge.

---

## 2. Findings against the nine investigation areas

### 2.1 Refraction — *absent; simulated only by blur*

There is no refraction today — no distortion of the background, no sense of looking *through* a thick medium. `backdrop-filter: blur()` frosts the background but does not bend it. Depth-through-material is faked purely by fill opacity.

**Opportunity (restrained):** refraction can be *suggested* without a literal displacement map by (a) letting the backdrop-filter carry a slight `brightness()`/`contrast()` shift alongside blur so thicker glass visibly darkens and compresses the background's tonal range, and (b) an inner "thickness" gradient (a very low-opacity vertical light-to-dark wash inside the pane) that reads as the depth of the medium. A literal `feDisplacementMap` (SVG filter) produces true edge-bending refraction but is **GPU-expensive and Safari-inconsistent** — it belongs in an opt-in "hero only" tier, never on `DataCard`. **Explicitly avoid** animated ripple/wobble; the directive calls this out as gimmicky and it reads as cheap.

### 2.2 Edge lighting — *partial; only the top edge is lit*

Only the top edge carries a specular. A real Fresnel response brightens the whole perimeter, brightest where the notional light hits (top / top-left) and falling off toward the shadowed edges, with the edge always brighter than the center.

**Opportunity:** replace the single top gradient with a full-perimeter edge treatment. The cleanest additive mechanism is an `::after` inset ring using a `linear-gradient` border-image or a masked box (a `padding: 1px` gradient ring, or `background: linear-gradient(...) border-box` with `mask` compositing). Directional response comes from a shared `--atlas-light-angle` (or `--atlas-light-x/y`) variable that both the edge gradient and the interior bloom read, so "the light" is a single source across the whole material. Variable edge intensity per depth: thicker glass = brighter, tighter edge (more like a polished slab), thin glass = softer.

### 2.3 Internal reflection — *only the optional radial glow*

`GlassPanel`'s `glow` prop is the closest thing to interior light, but it's a flat radial tint, not a reflection, and `DataCard` deliberately disables it. There is no interior bloom, no sense of light pooling inside the pane, no interaction when glass stacks over glass.

**Opportunity:** a subtle **interior bloom** — a soft, large-radius highlight positioned by the same light-angle variable, at very low opacity (≤ 6–8%), sitting below content and above the fill. For **stacked glass** (modal over page, dropdown over card), a faint darkening of the lower surface and brightening of the upper edge sells the layering; today stacked glass just double-blurs with no relationship between the layers.

### 2.4 Surface depth — *tokens exist but blur is uniform (primary gap)*

`--glass-ultrathin/thin/regular/thick` exist, but `GlassPanel` applies **one** blur/saturation to all of them. So the four "depths" are four opacities of the same 30px frost. The design language's own `.m-*` classes already prescribe blur *and* saturation scaling with thickness — the primitive simply never adopted it. There is also **no "floating" tier** (the directive asks for thin / medium / thick / **floating**), which would be the brightest, most-elevated, most-separated glass for hero and modal surfaces.

**Opportunity:** introduce per-depth blur + saturation (+ optional brightness) so depth is a *physical thickness* axis, not an alpha slider. Map: `ultrathin`→light blur/high saturation (chips, toolbars), `thin`→cards, `regular`→panels/drawers, `thick`→dialogs, new `floating`→hero/critical. This is the single highest-value change and is purely a values-and-tokens exercise.

### 2.5 Background interaction — *static; field does not respond to glass*

`AtlasField` renders a globe, meridian grid, one brass horizon arc, and a base gradient, slowly drifting (70s). Glass surfaces blur whatever is behind them, but the field is otherwise inert relative to the glass — no parallax, no refraction of the meridian lines through panes, no atmosphere response. **There are no stars today** despite the directive listing them; the "atmosphere" is the radial gradient + mask only.

**Opportunity:** (a) optional very-slow **microparallax** of the field relative to pointer so glass appears to float above a world with real depth; (b) let the field's brass arc / meridian geometry read *through* thin glass as faint refracted structure rather than uniform mush (achieved by keeping thin depths at lower blur per 2.4); (c) an optional star/atmosphere layer as an additive field enhancement. All decorative, all reduced-motion-gated, none touching interaction.

### 2.6 Material hierarchy — *flat; most surfaces share one recipe*

Almost everything is `GlassPanel` at `thin`/`e2` or `thick`/`e4` (modals). Buttons differ (20px blur). There is **no differentiated recipe** for tooltip vs dropdown vs sidebar vs toolbar vs hero vs input — several of those aren't even distinct primitives yet (no Atlas input/tooltip/dropdown/sidebar primitive exists; they're hand-rolled where used). Hierarchy is currently carried almost entirely by elevation shadow, not by material behaviour.

**Opportunity:** define a deliberate material ladder where each surface class maps to a depth + elevation + edge-intensity + motion profile (see the Doctrine, §Material Hierarchy). The point is that a tooltip should *feel* thinner and lighter than a dialog, not just smaller.

### 2.7 Motion — *minimal; lift + ambient loops only*

Present: `GlassPanel.interactive` hover lift (`-1px`), `GlassButton` hover lift + `active:scale(.97)`, `presence-pulse`, `ai-shimmer` (6s sweep), `atlas-globe-drift` (70s). Absent: **pointer-tracked light** (specular/bloom following the cursor), **microparallax**, **press-state depth** on panels (only the button presses), and any **focus-state material change** (focus is a ring, not a material response). Reduced-motion is handled well and globally (`prefers-reduced-motion` kills animations; `OverlaySurface` also has a JS `usePrefersReducedMotion`).

**Opportunity:** add a light-follows-pointer highlight driven by `--atlas-light-x/y` (updated on `pointermove`, throttled via rAF), a small press-depth on interactive panels, and optional microparallax — every one of them additive, opt-in, and reduced-motion-gated. Motion must remain *orthogonal to material* (the DataCard doctrine rule): a surface never moves just because it became premium glass.

### 2.8 Performance — *the real constraint on all of the above*

`backdrop-filter: blur(30px)` is already the most expensive thing the UI does per surface. Key realities:

- **Stacking cost is multiplicative.** A modal is `GlassPanel` (backdrop-filter) inside a scrim (backdrop-filter) over a page full of `GlassPanel`s over `AtlasField`. Each `backdrop-filter` forces the compositor to sample and blur everything behind it. More lit edges, blooms, and higher blur radii all add to this.
- **Safari** honours `backdrop-filter` but is sensitive to the *containing-block* trap already documented in `OverlaySurface` (any ancestor with transform/filter/backdrop-filter becomes the positioning root) — adding filters to more surfaces widens that footgun surface area. SVG `feDisplacementMap` refraction is notably janky in Safari.
- **Firefox** now ships `backdrop-filter` by default, but large-radius blur + many layers degrades fastest here.
- **Mobile** is the binding constraint: 60px blur across full-screen overlays on a mid-tier phone drops frames. Blur radius, not the pretty stuff, is the budget.

**Opportunity / guardrail:** treat blur radius as a scarce budget. Cheaper effects (gradients, box-shadow, masks, opacity) should carry as much of the "premium" as possible; expensive effects (high blur, displacement) are reserved for few, small, high-value surfaces. Establish an explicit **stacking limit** (e.g. no more than 2 live `backdrop-filter` layers in the same visual stack) and a `@media (prefers-reduced-transparency)` / low-power fallback that swaps blur for a solid-ish fill.

### 2.9 Light theme — *fully tokenised, never exercised*

`html[data-theme="light"]` defines every material token (white-based glass fills, `--specular-edge: rgba(255,255,255,.7)`, dark-ink borders, brighter scrim). It is not wired to a toggle, so none of it is battle-tested. The material language *should* translate, but a few things need explicit rules: on light glass a white specular nearly vanishes (needs the brighter `.7` value already present, plus possibly a dark inner edge for definition), and radial glows read very differently on white. Any new optical variable (light-angle, edge-intensity, bloom) must ship with a light-theme value from day one, exactly as the existing tokens already do.

---

## 3. Gap summary (current → premium)

| Optical property | Today | Premium target | Cheapest additive path |
|---|---|---|---|
| Depth | opacity only | blur + saturation + brightness scale with thickness; 4 tiers + `floating` | per-depth CSS vars + utility classes |
| Edge lighting | top edge only | full Fresnel perimeter, directional, depth-variable | inset gradient ring + `--atlas-light-angle` |
| Internal reflection | flat radial glow (off on cards) | low-opacity interior bloom, stack-aware | bloom layer reading light-angle var |
| Refraction | blur only | tonal compression + thickness wash (no displacement on common surfaces) | backdrop `brightness/contrast` + inner gradient |
| Background interaction | static drift | optional microparallax, structure reads through thin glass | pointer var + lower thin-depth blur |
| Hierarchy | ~2 recipes | per-surface-class material ladder | doctrine mapping + presets |
| Motion | lift + ambient loops | pointer light, press depth, focus material, microparallax | pointer vars, all reduced-motion-gated |
| Performance | single 30px blur, uncounted stacking | budgeted blur, ≤2 stacked filters, low-power fallback | stacking limit + fallback media queries |
| Light theme | tokenised, untested | verified parity, per-effect light values | ship light value with every new var |

---

## 4. Constraints observed (why this stays additive)

- **No behaviour in this thread.** Everything above is achievable with fills, gradients, masks, shadows, and CSS custom properties. None of it requires changing how any surface *behaves*.
- **The primitives are load-bearing and shared.** `GlassPanel` backs cards, modals, and buttons; a careless change reprices the whole app and risks the documented Safari containing-block trap. Additive variables + utilities let surfaces opt in one at a time.
- **The doctrine already forbids sprawl.** `DataCard` explicitly refuses liquid-glass props (displacement/aberration/curvature) by construction, and motion is defined as orthogonal to material. The material engine must honour those existing laws, not reopen them.
- **Scarcity is a brand law.** Design Language Law 7 keeps brass/AI accents scarce; the same discipline applies to refraction and bloom — premium *because* rare, not because everything shimmers.

---

## 5. What was explicitly NOT done

No files were edited. `globals.css`, all Atlas primitives, components, and migrations are untouched. No tokens added, no classes added, no components created. This is a reading-and-analysis pass only. Recommendations for the smallest additive implementation sequence, phased with risk and rollback, live in the companion Doctrine (§Implementation Roadmap) and in §6 below.

---

## 6. Recommended smallest additive sequence (summary — full detail in Doctrine)

1. **Phase 1 — Depth reconciliation + Fresnel edge (variables + utilities only).** Add per-depth blur/saturation vars and a full-perimeter edge-light utility. No primitive edits; opt-in class on new surfaces first. Highest payoff, lowest risk.
2. **Phase 2 — Light-angle model + interior bloom.** Introduce `--atlas-light-angle` and an additive bloom utility that shares it with the edge.
3. **Phase 3 — Additive primitive (`GlassSurface` or a `material` prop path) — approval-gated.** Only if utilities prove insufficient; wraps the above without altering `GlassPanel`.
4. **Phase 4 — Motion (pointer light, press depth, microparallax) — approval-gated, reduced-motion first.**
5. **Phase 5 — Field enhancement + light-theme verification.** Optional stars/atmosphere/parallax; exercise the light theme.

Each phase ships behind a new opt-in class/prop, leaves existing surfaces byte-identical until they adopt it, and is independently revertible by deleting its variables/utilities.
