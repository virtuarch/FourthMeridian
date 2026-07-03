# Daily Brief Earth — Asset-Production Checklist

**Status:** Asset production only. **No code, no path changes, no component edits.**
**Depends on decisions (2026-07-03):** NASA-sourced composites · AVIF + WebP (PNG only if
needed) · 5120 px long edge · no SVG displacement this pass.
**Goal:** produce 13 print-quality Earth renders + their encoded deliverables, ready to be
wired in a *later* step.

---

## 1. The 13 required asset slots

Six regions × two themes (dark night / light day) = 12, plus one default = **13**.

| # | Slot | Theme | Framing centre | Purpose |
| --- | --- | --- | --- | --- |
| 1 | Americas — dark | night | ~90° W | region: `americas`, Midnight Glass |
| 2 | Americas — light | day | ~90° W | region: `americas`, Light Glass |
| 3 | Europe — dark | night | ~15° E | region: `europe`, Midnight Glass |
| 4 | Europe — light | day | ~15° E | region: `europe`, Light Glass |
| 5 | MENA — dark | night | ~40° E | region: `mena`, Midnight Glass |
| 6 | MENA — light | day | ~40° E | region: `mena`, Light Glass |
| 7 | Africa — dark | night | ~20° E / 0° lat | region: `africa`, Midnight Glass |
| 8 | Africa — light | day | ~20° E / 0° lat | region: `africa`, Light Glass |
| 9 | Asia — dark | night | ~100° E | region: `asia`, Midnight Glass |
| 10 | Asia — light | day | ~100° E | region: `asia`, Light Glass |
| 11 | Australia — dark | night | ~135° E | region: `australia`, Midnight Glass |
| 12 | Australia — light | day | ~135° E | region: `australia`, Light Glass |
| 13 | **Default** — dark | night | Europe/MENA wide (~20° E) | fallback when timezone doesn't map; night-side Earth |

**Note on the light default:** today the code reuses the Europe *light* crop as the
light-mode fallback (`DEFAULT_HERO_SRC_LIGHT = HERO_REGION_SRC_LIGHT.europe`). Keeping
that reuse holds the count at **13**. If you'd rather the default own a dedicated light
render too, that's a **14th** slot — flag it and I'll add it. Default (#13) replaces the
current double-duty `oval-world.png`.

---

## 2. Recommended NASA source datasets (all public domain)

- **Night (dark slots + default):** **NASA Black Marble** — VIIRS city-lights composite.
  City lights are the premium, correctly-placed mid-frequency detail the frosted glass
  needs. Source: NASA Earth Observatory / Visible Earth "Black Marble" (2016 global
  mosaic or newer).
- **Day (light slots):** **NASA Blue Marble Next Generation** (monthly true-colour land
  surface) + **Visible Earth** cloud/topography layers. Choose a month with pleasant
  cloud cover; avoid heavy storm systems over the framing centre.
- **Elevation/relief (optional, both):** **NASA/JPL SRTM** or Blue Marble bathymetry for
  subtle terrain shading — keeps landmasses from reading flat.
- **Star field (space around the globe):** any public-domain field, or NASA/ESA
  deep-field imagery. Keep it dim so it never competes with hero text.

**Attribution:** NASA imagery is public domain but courtesy attribution is expected. Ship
an `ATTRIBUTION.md` (or header note) beside the assets listing each dataset + source URL.

---

## 3. Target dimensions

- **Canonical size for all 13:** **5120 × 2880 px (16:9).** Long edge = 5120 per the
  approved decision; 16:9 matches the majority of the current canonical set (1672×941 is
  exactly 16:9) so the existing shared `object-position` tuning still lands.
- **All 13 identical aspect ratio.** The render wrapper is always *wider in aspect* than
  the source and crops **vertically only**; a single aspect ratio across every slot is
  what lets one shared crop rule work for all of them. Do not mix ratios.
- Colour: 8-bit, sRGB, no embedded ICC weirdness (convert to plain sRGB on export).

---

## 4. Crop / framing rules (must match existing composition)

The current pipeline uses one shared vertical crop, `POSITION_Y = {base:24, md:20,
xl:17, xxl:14}` (% from top). The *artwork* defines composition, not CSS — so every
render must be built to that same recipe:

- [ ] **Earth arc high in frame.** The curved top horizon / limb sits so it stays visible
      when the wrapper crops to ~14–24 % from the top. Roughly: Earth occupies the upper
      ~60–70 % of the 2880 px height; space/star field above the limb.
- [ ] **Consistent Earth:space ratio across all 13** — the globe must be the same apparent
      size and position in every slot, or the hero will "jump" when regions swap.
- [ ] **Terminator + atmospheric rim present** (dark slots especially): a clear day/night
      terminator and a bright blue atmospheric limb — this is the high-contrast structure
      that reads through the 30 px frosted glass.
- [ ] **City-light clusters** on dark slots (from Black Marble), positioned to the region.
- [ ] **Lower third authored darker.** Hero text sits in the bottom ~30 %. Bake in a
      darker, lower-detail lower third so CSS (`brightness(0.66)` + bottom dissolve) does
      less work and text contrast is safe.
- [ ] **Horizontal centre = region centre** (see §1 table). Vertical framing identical
      across all.
- [ ] No text, no UI, no watermarks, no lens flare gimmicks. Calm and still.

---

## 5. Dark vs light variant rules

- **Dark (Midnight Glass):** night-side or terminator-dominant view; deep navy space;
  city lights; cool blue rim. This is the "signature" look — the majority of viewing.
- **Light (Light Glass):** same framing, same globe size/position, but daylit true-colour
  surface; softer, brighter atmosphere; **still keep a darker lower third** so dark hero
  ink stays legible. Do not let the light variant blow out to white at the text zone.
- Pair each light/dark slot as a true match — only lighting changes between them, never
  framing or globe size.

---

## 6. Export settings — AVIF + WebP

Produce **both** formats per slot from the same 5120×2880 master. PNG only if a pipeline
step can't consume AVIF/WebP.

**AVIF (primary)**
- Quality ~**55–63** (on a 0–100 scale) / equivalently CRF ~24–28. Tune per image to hit
  the size budget without visible banding in the sky gradient.
- Chroma **4:2:0**, 8-bit, slowest/max effort (encode time is one-off).
- Colour: sRGB, full range.
- Target delivered weight **≤ 300–500 KB** per slot at 5120 px.

**WebP (fallback)**
- Quality **80–82**, method **6** (max effort).
- Expect ~2–3× the AVIF weight; acceptable as fallback.

**Master to keep (not shipped):** retain the lossless 16-bit/PNG or TIFF master per slot
for future re-encodes.

**Tooling options (any one):** `avifenc` (libavif) + `cwebp`; `sharp` (Node) batch;
Squoosh (GUI); ImageMagick 7 with AVIF/WebP delegates. Encode all 13 with one script for
consistent settings.

---

## 7. Naming convention

Extends the current scheme (`earth-{region}.png` / `earth-{region}-light.png`) and adds
formats. Lower-case, hyphenated, in `public/hero/`:

```
earth-americas.avif      earth-americas.webp        (dark)
earth-americas-light.avif  earth-americas-light.webp  (light)
earth-europe.avif        earth-europe.webp
earth-europe-light...    (same pattern for mena, africa, asia, australia)
earth-default.avif       earth-default.webp          (replaces oval-world.png)
```

- Region tokens: `americas · europe · mena · africa · asia · australia · default`.
- Dark = bare token; light = `-light` suffix.
- Keep masters as `earth-{slot}-master.png` in a **non-shipped** folder (e.g.
  `assets/hero-masters/`, gitignored or LFS), not `public/`.

---

## 8. How you can generate or provide the files

Any of these works — pick what suits you:

**Option A — You provide finished 5120×2880 masters (13 PNG/TIFF).**
Fastest for me: hand me the 13 masters and I do §6 encoding + LQIP + §9 checks. This is
the recommended hand-off.

**Option B — You provide the raw NASA source layers + framing intent.**
Give me the Black/Blue Marble source images (or exact dataset links you've downloaded)
and I composite the 13 crops to spec. *Caveat:* I can't reliably pull NASA mosaics
through the restricted web tools, so the source files need to reach me directly.

**Option C — You composite in Blender/Photoshop/GIMP.**
Map Blue/Black Marble onto a sphere, light for day/night, render each region at
5120×2880 to the §4 framing, export masters → then Option A hand-off.

Whichever path: the deliverable I need to start encoding is **13 masters at 5120×2880,
16:9, matching the §4 framing.**

---

## 9. Quality checks before wiring (do these on every slot)

- [ ] **Dimensions:** exactly 5120 × 2880, 16:9, sRGB 8-bit.
- [ ] **Framing match:** overlay against the `POSITION_Y` crop windows (14/17/20/24 %) —
      Earth arc stays in frame at all four; globe size + position identical across all 13.
- [ ] **Terminator/rim/city-lights** present on dark slots; day surface clean on light slots.
- [ ] **Lower-third luminance:** measurably darker than the globe centre; simulate hero
      text over it and confirm **≥ 4.5:1** contrast, both themes.
- [ ] **No banding** in the sky/space gradient after AVIF encode (the usual failure mode).
- [ ] **Weight budget:** AVIF ≤ 300–500 KB per slot; WebP within ~2–3×.
- [ ] **Both formats decode** and look identical (spot-check AVIF vs WebP).
- [ ] **Set consistency:** view all 13 in sequence — no jump in globe size, colour temp,
      or horizon height between regions or between light/dark pairs.
- [ ] **Default (#13)** reads as a night-side Earth and works as a neutral fallback.
- [ ] **LQIP** blurDataURL generated per slot (tiny base64) — needed later, produce now.

---

**Stop.** This is the asset-production checklist only. No files encoded, no paths changed,
no components edited. Next action is yours: choose an Option in §8 and provide masters (or
the 14th-slot decision from §1).
