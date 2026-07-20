> **INVESTIGATION / DESIGN PROPOSAL ONLY — no code, no assets generated.** Scope: a reusable material system for Atlas Liquid (and, later, Fourth Meridian at large). Grounded in the vendored shader (`components/atlas/vendor/liquid-glass/core/shaders.ts`), the R4-b tint pipeline (`AtlasLiquidCard.tint/tintStrength` → `LiquidGlassSettings.tintColor/tintStrength`), and the Atlas doctrine. Stops at the proposal.

# Atlas Material Library — Investigation & Proposal

## 0. The core insight (why the gradient felt cheap, and what to do instead)

Two facts from the actual shader decide everything below:

1. **Refraction bends *line-work at the edges*, not flat fills.** The displacement is driven by the glass height-gradient and is strongest where `edge` is high (`shaders.ts:93–96`); chromatic aberration splits along the surface normal at the rim (`:113,:126`). A **flat gradient has almost nothing to bend** — which is exactly why removing the globe (dense meridian line-work) drained the "expensive glass" feeling. What reads as premium under refraction is **fine, regular, mid-frequency line-work over a soft tonal base**: the lines visibly curve at the card's edge, the tone gives depth in the middle.
2. **Tint multiplies *over* the sampled texture** (`shaders.ts:141` `mix(color, color*u_tintColor, u_tintStrength)`). So the texture should carry **structure (luminance)**, and colour should come from the **per-Space tint** we already wired in R4-b. One grayscale material, recolored per Space — not N coloured pictures.

**Therefore the strongest direction is not "a different picture per Space." It is a single coherent system of grayscale *precision-instrument engravings* that the existing tint recolors.** Structure = shared identity; hue = Space identity. This is smaller, more maintainable, more on-brand, and mechanically aligned with the shader.

---

## 1. Visual philosophy — "Instruments, not landscapes"

Fourth Meridian is a financial **operating system** built on the vocabulary of **navigation, cartography, and precision measurement**. Its materials should look like the *instruments that locate and measure* — nautical charts, blueprints, radar scopes, contour surveys, orbital plots — **never the terrain they depict**. The through-line is the **meridian**: *lines that tell you where you are.*

Design laws for every material:

- **Engraved, not painted.** Crisp technical line-work (graticules, ticks, isolines, bearings) over a calm tonal field. No blobs, no clouds, no photos, no Earth, no obvious maps.
- **Grayscale by construction.** Materials ship as luminance only. Colour is the tint's job (§0.2). This is what lets one material serve every Space and every brand surface.
- **Mid-frequency + seamless.** Lines dense enough to bend beautifully, coarse enough to survive the 9-tap blur (`sampleBlur`, `:10–21`); tiled seamlessly so scaling/repeat never seams.
- **Calm and quiet.** Low contrast, most of the field in shadow. The card's contrast scrim + `darkTint` (`:142`) keep text legible; the material lives *under* the data, felt more than seen.
- **Recognisably Fourth Meridian.** A person should identify the product from the material alone — the way a brand is known by its guilloché (banknotes) or its grid (Swiss design). Restraint is the brand (Atlas doctrine §1.4): a *small, sharp family*, not a texture zoo.

---

## 2. Proposed Atlas Material Library

A curated family of **six** structures (fewer, sharper than the 10 brainstormed examples — see §7 for why). Each is a tileable grayscale engraving; the per-Space tint colours it.

| # | Material | Concept / motif | Why it refracts well | Feeling |
|---|---|---|---|---|
| M1 | **Meridian** *(signature)* | Longitude/latitude graticule — the brand's own curve-work, refined from today's `atlas-meridians` | Regular curved line-work = the canonical "watch the glass bend straight lines" surface | Atlas, navigation, calm authority |
| M2 | **Blueprint** | Orthographic grid + fine construction ticks, dimension marks, corner registration | Straight ruled grid bends crisply at the rim; ticks add sparkle | Precision, engineering, structure |
| M3 | **Contour** | Nested topographic isolines (elevation rings), smooth and flowing | Concentric curves refract like flowing water; organic-but-technical | Calm, flowing, "the shape of a thing" |
| M4 | **Radar** | Concentric range rings + bearing spokes + one faint sweep gradient (PPI scope) | Rings + radials = strong edge-bend + a directional highlight | Vigilance, readiness, monitoring |
| M5 | **Network** | Faint node-and-edge graph (financial network), sparse and deliberate | Nodes catch specular points; edges bend as thin lines | Systems, connection, operations |
| M6 | **Heading / Flow** | Rhumb-line / streamline field (compass roses + flow lines, like a current chart) | Long sweeping lines with a directional bias read as movement | Progress, motion toward a goal |

All six share the same **line weight system, tonal floor, and seam logic**, so they read as *one family*. (Names are proposals; **Meridian, Blueprint, Contour** are the load-bearing three and should ship first.)

---

## 3. Materials ↔ Space types

The tint (R4-b palette) reinforces the material rather than replacing it. Materials are **reused across categories** — a feature, not a compromise.

| Space type | Material | Tint (existing) | Rationale |
|---|---|---|---|
| Personal | **Meridian** | brass `#C89B3C` | the warm brand signature — the "home" material |
| Household / Family | **Contour** | blue `#4F8DFF` | flowing, shared, organic-but-ordered |
| Business | **Network** | green `#2FBF71` | a system of accounts/flows — a financial network |
| Investment / Retirement | **Blueprint** | violet `#8B6CFF` | constructed, structured, engineered growth |
| Debt payoff | **Contour** (terrain variant) | red `#D94A4A` | terrain/topology — the "climb out"; reuses M3 at a denser setting |
| Emergency fund | **Radar** | teal `#2AA6A6` | readiness / monitoring / vigilance |
| Goal / Trip | **Heading / Flow** | gold `#E3B341` / neutral | movement toward a target; rhumb lines |
| Property / Vehicle / Equipment | **Blueprint** | neutral slate | assets = engineering drawings |
| Custom / Other | **Meridian** | neutral slate | default to the signature |

Six materials cover all fifteen categories. The mapping lives in code as a `spaceMaterial(category)` lookup mirroring the existing `spaceIdentityTint(category)` — trivial to extend.

---

## 4. Which materials become reusable across Fourth Meridian

The point of a *system* is that it outlives the card. Grayscale + tint means the same assets serve the whole product:

- **Meridian (M1) — the brand signature.** Auth/loading screens, empty states, the `AtlasField` ambient background (replacing the literal globe there too), Daily Brief flagship `AtlasLiquidCard`s, marketing/OG imagery. This is the material someone should recognise as Fourth Meridian.
- **Blueprint (M2) — the technical/data register.** Data-dense headers, report covers, export/print surfaces, settings.
- **Contour (M3) — the calm/ambient register.** Modals, onboarding, low-attention backdrops.
- **Radar / Network / Heading (M4–M6)** stay **contextual** (Spaces + the occasional state surface), not global — scarcity keeps them meaningful.

Governance: promote M1–M3 to platform materials in the doctrine; keep M4–M6 as scoped accents. Same restraint ladder Atlas Liquid already uses.

---

## 5. How the materials should be produced — procedural, exported to texture

The Liquid material samples an **image** for `u_bg` (WebGL texture). So the runtime consumer must be a raster/texture; the *authoring* method is the real question.

| Option | Fit | Verdict |
|---|---|---|
| **PNG (hand-authored)** | works as texture; reliable | ✗ as a *system* — static, per-material, hard to tile-tune, not parameterizable |
| **CSS gradients/patterns** | cannot feed the WebGL `u_bg` sampler | ✗ for the Liquid texture (fine for the Glass fallback + non-Liquid brand uses) |
| **SVG line-work** | excellent *authoring* format (precise, vector); needs rasterizing for WebGL | ◐ good source-of-truth, export to texture |
| **Procedural generator (canvas/offscreen)** | one deterministic module draws each engraving; tileable by construction; parameterized (density, weight); grayscale | ✔ **the system** |

**Recommendation:** a single **procedural generator** — a small deterministic module (`lib/atlas/materials/`) that draws each material as a **seamless, grayscale, tileable field** (Canvas 2D or an offscreen WebGL pass), parameterized by line density/weight/tonal floor. Ship it in two stages:

1. **Build-time bake (start here):** run the generator to emit a handful of optimized tileable PNGs (e.g. `atlas-material-meridian.png`). This is a **drop-in replacement** for the current `atlas-card-neutral.png` — zero runtime cost, zero Liquid-system change.
2. **Runtime-procedural (optional, later):** generate to an offscreen canvas → texture at load, enabling live parameterization (density per Space, animated sweep for Radar) without shipping N PNGs.

Grayscale-only throughout; colour stays in the R4-b tint pipeline. SVG is a fine *hand-authoring* source that the generator or a designer exports from — but the runtime artifact is a baked/generated texture, not raw SVG.

---

## 6. Smallest implementation roadmap (no Liquid rewrite)

Every step is additive and reversible; the vendored renderer and `AtlasLiquidCard`'s R4-b API are untouched after Phase 1.

- **Phase 0 — approve** this philosophy, the six-material family, and the Space mapping. *(No code.)*
- **Phase 1 — one material, drop-in.** Build **Meridian** via the generator; bake one tileable PNG; swap it for `atlas-card-neutral.png` as the Space-card `backgroundImage` (a one-constant change in `SpacesClient.tsx`). Validate refraction + tint + legibility + tiling on real hardware (Chrome/Safari/mobile, reduced-transparency fallback). **This proves the whole thesis with the smallest possible change.**
- **Phase 2 — per-Space material.** Add `spaceMaterial(category)` (mirrors `spaceIdentityTint`); `SpaceCard` passes the mapped texture. Still only the `backgroundImage` prop — no `AtlasLiquidCard` change.
- **Phase 3 — expand the family.** Add Blueprint, Contour, Radar, Network, Heading; complete the mapping. Bake + wire; pure additive.
- **Phase 4 — platformize (optional).** Move materials into `lib/atlas/materials/`, reuse M1–M3 in `AtlasField`/loading/brand surfaces, and (if wanted) flip to runtime-procedural generation. Doctrine update promoting M1–M3 to platform materials.

Rollback at any phase = revert the texture constant / map; `atlas-card-neutral.png` remains a valid fallback.

---

## 7. Why this is stronger than the brainstormed list

- **A system beats a set.** Ten unrelated textures (Aurora, Constellation, blobs…) would read as a stock pack, not a brand. Six engravings sharing one line/tonal/seam language read as *one designed material* — recognisable, ownable. Restraint is the brand (doctrine §1.4).
- **Structure × tint is the mechanically correct model.** It matches how the shader composites (tint multiplies structure), so per-Space identity costs *a hue*, not *a new asset* — and the tint genuinely "reinforces the material" as requested.
- **It scales past the card.** Grayscale materials serve `AtlasField`, loading, modals, print, marketing — the path to "recognise Fourth Meridian from the material alone."
- **It rejects the anti-patterns by construction.** Instruments (charts/blueprints/radar), not landscapes/Earth/photos/gradients/blobs. Line-work refracts; calm tone preserves legibility; procedural = seamless tiling.

Two examples from the brainstorm are **folded in** rather than dropped: *Coordinate Grid → Blueprint*, *Topology/Contour → Contour*, *Compass/Flow → Heading*, *Financial Network → Network*, *Radar → Radar*. *Aurora* and *Constellation* are **declined** — auroras are landscape/atmosphere and constellations drift toward decorative star-fields (noise under refraction, weak brand fit).

---

## 8. Requirements check

Works inside Atlas Liquid (texture for `u_bg`) ✓ · looks good under refraction (mid-frequency line-work at edges) ✓ · tiles cleanly (procedural/seamless) ✓ · subtle (low-contrast, shadowed floor) ✓ · preserves legibility (scrim + `darkTint`, material stays under data) ✓ · premium (precision engraving) ✓ · avoids noise (no high-freq/random) ✓.

**Stop point:** this investigation. No code, no assets. Recommended first move on approval: **Phase 1 — bake the Meridian material and drop it in as the Space-card texture** — the smallest change that proves the system.
