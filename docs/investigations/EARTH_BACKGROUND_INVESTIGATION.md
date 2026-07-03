# Daily Brief Earth Background — Investigation & Implementation Plan

**Status:** Investigation only. No implementation.
**Scope:** Replace the current Daily Brief Earth background with a higher-quality,
4K-ready Earth visual that works with Atlas Glass / Liquid Glass-style refraction.
**Author:** Investigation pass, 2026-07-03.

---

## TL;DR recommendation

Keep the **hybrid static-image + CSS-atmosphere** architecture that already exists
(`EarthBackground.tsx`). Do **not** move to a WebGL globe, video loop, canvas, or
procedural renderer — every one of those trades away calm, sharpness, battery, and
simplicity for motion the design direction explicitly does not want.

The quality problem is not the *approach* — it is the *source assets and delivery
format*. The current heroes are ~1.5–1.8 K wide PNGs (2–3 MB each) being scaled up
to a wrapper as wide as **180 vw** (≈ 6,900 px on a 4K display). That ~3–4× upscale
is what reads as soft. The smallest path to a premium result is: regenerate the same
crops at true 4K, ship them as **AVIF (+ WebP fallback)**, and add an LQIP blur
placeholder. No component API changes, no new dependency, no motion added.

---

## 1. Current ownership — what renders the background today

| File | Role |
| --- | --- |
| `components/brief/BriefHero.tsx` | Hero container (`clamp(480px, 72vh, 820px)`); resolves region + theme and mounts `EarthBackground`. |
| `components/brief/EarthBackground.tsx` | **Owns the background.** Oversized image wrapper (`object-cover`, 115→180 vw) + 8 stacked atmosphere layers (base fill, blue multiply tint, UTC sun bloom, rim scatter, edge/top vignettes, bottom dissolve). Applies `filter: blur(0.8px) brightness(0.66) saturate(1.05)`. |
| `lib/hero-region.ts` | Maps IANA timezone → one of six regional crops; resolves `{region, theme}` → image path. Holds `DEFAULT_HERO_SRC` and the two `HERO_REGION_SRC` tables. |
| `components/brief/HeroRegionProvider.tsx` | Region state (auto-detect + manual override, unpersisted). |
| `components/theme/ThemeProvider` (via `useTheme`) | Supplies `dark`/`light` (Midnight/Light Glass) → selects the light vs dark crop. |
| `public/hero/*.png` + `public/oval-world.png` | **The actual assets.** 12 regional crops (6 regions × light/dark) + 1 default night-side Earth. |

**Key architectural fact:** the image path is fully data-driven through
`heroSrcForRegion()`. Swapping in better assets is a *file + path* change; the render
pipeline does not need to change. This is why the recommended path is so small.

### Current asset inventory (measured)

| Asset | Dimensions | Size | Notes |
| --- | --- | --- | --- |
| `oval-world.png` (default) | 1572 × 1001 | 2.1 MB | Night-side Earth, city lights on black. Used dark **and** as the only fallback. |
| `earth-*.png` (6 dark) | 1536–1827 × 861–1024 | 2.1–2.3 MB | Regional night crops. |
| `earth-*-light.png` (6 light) | 1536–1779 × 884–1024 | 2.4–2.9 MB | Regional daytime crops. |

**Total:** 13 PNGs, ≈ 30 MB uncompressed-ish. None are 4K. Widest source is 1827 px;
the wrapper renders up to 180 vw. On any display wider than ~1900 px the Earth is
already being upscaled, and on 4K it is upscaled 3–4×. **This is the root cause of the
"not sharp enough" feel.**

---

## 2. The glass-compatibility constraint (this drives everything)

Atlas Glass today (`GlassPanel.tsx`) is **frosted translucency, not true refraction**:

```
background: var(--glass-thin)               /* rgba(18,24,38,.55) — semi-opaque */
backdrop-filter: blur(30px) saturate(160%)  /* heavy frost */
```

There is **no `feDisplacementMap` / `feTurbulence`** anywhere in the codebase — the
"Liquid Glass-style refraction" in the design direction is an aspiration, not yet
implemented. That matters for the Earth choice in two ways:

1. **`blur(30px)` destroys fine detail beneath the panel.** Ultra-fine 4K texture
   *under* a glass card is wasted — it is blurred to mush regardless of source
   resolution. So 4K resolution pays off in the **exposed** hero regions (behind text,
   near edges, the visible curve/terminator) — not under the panels.
2. **What makes glass "pop" is mid-frequency, high-contrast structure** — the
   day/night terminator line, coastlines, city-light clusters, the atmospheric rim.
   These survive a 30 px blur as soft luminance gradients and give refraction/frost
   something to bend. A flat or evenly-lit globe reads as dead glass.

**Design implication for the new asset:** prioritise a strong terminator, a bright
atmospheric rim, and clustered city lights over pixel-level landmass detail. If/when
true refraction (SVG displacement) lands later, that same mid-frequency structure is
exactly what it needs — so this choice is future-proof.

---

## 3. Question-by-question

### Q1 — Static image / canvas / WebGL / video / hybrid?

**Recommendation: hybrid static image + CSS effects (what exists), upgraded.**

| Approach | Premium? | Calm/still? | Perf | Complexity | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Static 4K image + CSS** | ✅ cinematic, art-directable | ✅ perfectly still | ✅ one decode, GPU-composited | ✅ lowest | **Chosen** |
| Generated canvas | ⚠️ hard to reach "cinematic" | ✅ | ⚠️ main-thread paint | ❌ high | No |
| WebGL globe | ❌ reads as "game globe" | ❌ invites rotation/motion | ❌ shader + GL context cost | ❌ highest | No — violates "not a game globe" |
| Video loop | ⚠️ can look premium | ❌ constant motion | ❌ heavy bytes, battery, decode | ⚠️ medium | No — violates "should not animate constantly" |
| **Hybrid image + CSS** | ✅ | ✅ (sun bloom is static-per-load) | ✅ | ✅ | **Chosen** |

The existing component *is* the hybrid approach and it is well-built (documented
layering, responsive cover, theme-aware atmosphere). The work is asset quality, not
re-architecture.

### Q2 — Best premium result with least complexity?

A **static, art-directed 4K crop per region/theme**, delivered as AVIF with a WebP
fallback and an LQIP placeholder, composited under the existing CSS atmosphere layers.
Complexity added: essentially zero code — new files + a `<picture>`/format swap. The
"premium" comes from resolution + a clean terminator + the atmosphere layers already
in place, not from motion.

### Q3 — How to hit each requirement

- **High resolution:** author/regenerate crops at **≥ 3840 px on the long edge**
  (ideally 4096–5120 px so the 160–180 vw wrapper still has headroom on 4K/ultrawide).
- **Performant:** AVIF (typically 60–80 % smaller than the current PNGs) + WebP
  fallback; `next/image` with correct `sizes` (already present) so smaller viewports
  fetch smaller variants; `priority` on the hero only (already set); LQIP/blur
  placeholder so first paint is instant. Target ≤ ~300–500 KB delivered per crop at 4K
  in AVIF.
- **Responsive:** the oversized-wrapper `object-cover` model already guarantees
  cover-fill at every breakpoint. Keep it. 4K source removes upscaling at the top end.
- **Dark enough for text:** three existing levers stay — `filter: brightness(0.66)`,
  the blue multiply tint, and the bottom dissolve into `--bg-base`. Author the source
  darker on the lower third (where hero text sits) so CSS does less work. Verify text
  contrast ≥ 4.5:1 over the busiest crop.
- **Compatible with glass refraction:** favour mid-frequency contrast (terminator,
  rim, city-light clusters) — see §2. Keep the exposed curve/rim crisp; fine detail
  under panels is optional.
- **Not distracting:** no motion; keep the current per-load static sun bloom (it does
  not animate); keep the long bottom dissolve so the eye settles on text.

### Q4 — NASA/public-domain vs custom vs procedural?

- **NASA is the right *source texture*, custom art-direction is the right *finish*.**
  - **NASA Black Marble** (night lights) and **Blue Marble Next Generation / Visible
    Earth** (day) are public domain (NASA imagery carries no copyright), available as
    high-res global mosaics — ideal, authoritative, and legally clean. Black Marble in
    particular gives real, correctly-placed city lights, which is exactly the
    mid-frequency structure glass needs and reads as unmistakably premium.
  - **Pure procedural / WebGL** is rejected (Q1): looks synthetic, invites motion.
  - **Fully custom AI-rendered crops** (the current pipeline) give the cinematic
    framing but are not photographically authoritative and are what currently ship at
    sub-4K.
- **Recommended:** use NASA Blue/Black Marble as the base globe texture, composite the
  six regional day/night crops + atmosphere/terminator to 4K in a render/compositing
  pass, matching the current framing (`POSITION_Y`, Earth:space ratio). Public-domain
  base + curated crop = premium *and* clean licensing. Keep the existing six-region /
  two-theme matrix so no downstream code changes.

### Q5 — Files/components that own the background

Answered in **§1**. Primary owner: `components/brief/EarthBackground.tsx`.
Asset resolution: `lib/hero-region.ts`. Assets: `public/hero/*` + `public/oval-world.png`.

### Q6 — Smallest implementation path

Because paths are data-driven, the minimum viable upgrade is:

1. **Produce 4K assets** for the 13 slots (NASA-sourced base → composited crops),
   matching current framing. Author lower third darker.
2. **Encode** each as AVIF + WebP (keep a PNG fallback only if needed). Generate a tiny
   base64 LQIP for each.
3. **Swap sources** — either drop-in same filenames, or add `.avif/.webp` and point
   `HERO_REGION_SRC*` / `DEFAULT_HERO_SRC` at them. Give the default its own asset so
   `oval-world.png` is no longer doing double duty.
4. **Delivery polish** — add `placeholder="blur"` + `blurDataURL` to the `next/image`
   in `EarthBackground.tsx`; confirm `sizes` still matches the 115→180 vw wrapper.
5. **No changes** to atmosphere layers, region logic, theme logic, or component API.

Optional follow-on (separate change, not this one): real SVG `feDisplacementMap`
refraction on glass panels — deferred; the asset choice above already supports it.

---

## 4. Impact map / rollback / validation (for the eventual implementation step)

**Impact map**
- Touches: `public/hero/*`, `public/oval-world.png` (or new files), `lib/hero-region.ts`
  (paths only), `components/brief/EarthBackground.tsx` (add blur placeholder only).
- Does **not** touch: schema, migrations, API routes, auth, region-detection logic,
  theme system, `GlassPanel`, any Space/dashboard UI.

**Rollback plan**
- Assets are static and additive. Revert = restore prior filenames or revert the
  one-line path/table change in `lib/hero-region.ts` + the `next/image` prop addition.
  No data or migration risk. Safe to ship behind nothing.

**Validation checklist**
- Visual: each of the 13 crops, dark + light, at mobile / tablet / 1440 / 4K /
  ultrawide — Earth stays cover-filled, arc + terminator in frame.
- Readability: hero text contrast ≥ 4.5:1 over the busiest crop, both themes.
- Perf: delivered AVIF weight per crop, LCP of the hero image, no CLS (blur
  placeholder present).
- Glass: sample a `GlassPanel` over the new asset — terminator/city-lights read
  through the frost.
- `npx tsc --noEmit`, `npm run lint` (only if `EarthBackground.tsx` / `hero-region.ts`
  changed).

---

## 5. Open questions for Chris (before any implementation)

1. **Asset generation** — do you want NASA-sourced composites, or regenerate the
   existing AI-art crops at 4K? (Affects who/what produces the 13 files.)
2. **Format** — OK to standardise on AVIF + WebP and drop PNG, or keep PNG fallback?
3. **Scope of "4K-ready"** — target 4096 px long edge, or push to 5120 px for
   ultrawide headroom (bigger files)?
4. **Refraction** — is real SVG-displacement glass in scope *now*, or is frosted-glass
   compatibility (what exists) sufficient for this pass?

---

**Investigation ends here — no code, schema, assets, or component changes made.**

---

## 6. Approved decisions (2026-07-03, Chris)

1. **Source:** NASA-sourced composites (Blue Marble day / Black Marble night). **Not** AI crops.
2. **Format:** AVIF + WebP. PNG fallback only if necessary.
3. **Resolution:** target **5120 px** long edge (ultrawide headroom).
4. **Refraction:** do **not** implement real SVG displacement this pass. Frosted-glass
   compatibility (current `backdrop-filter` frost) is sufficient.

---

## 7. Implementation checklist — Earth asset upgrade (awaiting approval to start)

> Per project working style: this checklist is the plan. **No code, assets, or path
> changes until approved.** When approved, implement in the small additive steps below,
> then run validation.

### Step A — Produce NASA composites (13 slots)
- [ ] Pull NASA public-domain source mosaics: **Blue Marble Next Generation / Visible
      Earth** (day) and **Black Marble** (night city lights). Record source URLs +
      "NASA imagery, public domain" attribution in an `ATTRIBUTION` note beside the assets.
- [ ] Composite six regional crops × {dark night, light day} + one default night-side
      Earth = **13 renders**, each **≥ 5120 px** on the long edge.
- [ ] Match existing framing exactly: same Earth:space ratio, curve/terminator
      placement, and the `POSITION_Y` composition (`{base:24, md:20, xl:17, xxl:14}`)
      so no CSS retuning is needed.
- [ ] Author the **lower third darker** (hero-text zone) and keep a strong
      **terminator + atmospheric rim + city-light clusters** (glass mid-frequency
      contrast, see §2). Give the default its **own** asset so `oval-world.png` stops
      double-duty.

### Step B — Encode + LQIP
- [ ] Encode each render to **AVIF** (primary) and **WebP** (fallback). PNG only if a
      target path can't take either. Budget ≈ ≤ 300–500 KB delivered per crop at 5120 px AVIF.
- [ ] Generate a tiny base64 **LQIP blurDataURL** per crop.
- [ ] Verify each file's long edge = 5120 px and visually lossless at hero scale.

### Step C — Wire paths (data-only)
- [ ] Point `HERO_REGION_SRC`, `HERO_REGION_SRC_LIGHT`, `DEFAULT_HERO_SRC`,
      `DEFAULT_HERO_SRC_LIGHT` in `lib/hero-region.ts` at the new files. **Paths only —
      no logic change.**
- [ ] Add `placeholder="blur"` + per-crop `blurDataURL` to the `next/image` in
      `EarthBackground.tsx`. Confirm `sizes` still matches the 115→180 vw wrapper.
- [ ] Leave atmosphere layers, region detection, theme logic, and `GlassPanel`
      untouched.

### Step D — Validation
- [ ] Visual: all 13 crops, dark + light, at mobile / tablet / 1440 / 4K / ultrawide —
      cover-filled, arc + terminator in frame, no upscaling softness.
- [ ] Readability: hero text contrast ≥ 4.5:1 over the busiest crop, both themes.
- [ ] Perf: delivered AVIF weight per crop, hero LCP, zero CLS (blur placeholder present).
- [ ] Glass: a `GlassPanel` sampled over the new asset — terminator / city lights read
      through the frost.
- [ ] `npx tsc --noEmit`, `npm run lint` (since `EarthBackground.tsx` + `hero-region.ts` change).

**Rollback:** additive/static. Revert the path table + the one `next/image` prop; restore
old filenames. No schema/data/migration risk.

**Awaiting approval before Step A.**
