"use client";

/**
 * EarthBackground — cinematic responsive Earth backdrop
 *
 * Core principle: the image wrapper is ALWAYS wider than the viewport.
 * `object-cover` fills that oversized wrapper, so the Earth always acts
 * like `background-size: cover` — never like a contained image.
 *
 * At every breakpoint the wrapper bleeds past the viewport edge on both
 * sides. The hero's `overflow-hidden` clips the excess. The Earth's
 * top arc / curved horizon is always in frame via `object-position`.
 *
 *   Mobile   : wrapper 115vw, left -7.5vw   — slight bleed, arc visible
 *   Tablet   : wrapper 140vw, left -20vw    — wider scene
 *   Desktop  : wrapper 160vw, left -30vw    — immersive backdrop
 *   Ultrawide: wrapper 180vw, left -40vw    — still dominates
 *
 * The transform on the wrapper is gone — sizing now comes from
 * explicit viewport units, not scale(). This eliminates the "centered
 * picture" look caused by the image shrinking inside a bounded box.
 *
 * Atmosphere layers (blur, sun glow, rim scatter, vignettes, bottom
 * dissolve) are position:absolute inset-0 and are unaffected.
 *
 * Positioning is a single shared rule across every region/theme crop (see
 * POSITION_Y below) — the source artwork itself defines the composition,
 * not CSS. There is no per-image override table here on purpose.
 *
 * Layering (bottom → top):
 *   1. Base fill — deep space navy
 *   2. Earth image — oversized viewport-width wrapper + object-cover
 *   3. Blue atmospheric multiply tint
 *   4. UTC warm sun bloom
 *   5. Blue atmospheric rim scatter
 *   6. Edge vignettes L / R / top (top kept light — see Layer 6c — so the
 *      header reads as floating on the globe, not sitting on its own bar)
 *   7. Bottom dissolve into page background — long and gradual, the Earth
 *      stays visible nearly to the bottom edge of the hero
 *   8. children — future map pins
 *
 * Region:
 *   `region` selects which pre-rendered Earth crop to show (see
 *   lib/hero-region.ts) — a presentation-only nod to the viewer's
 *   timezone, not their real location. Pass null/undefined (or omit) to
 *   get the original wide default image. This component does no timezone
 *   detection itself; the caller (BriefHero) resolves the region and
 *   passes it down, so this stays a pure "given X, render X" component.
 *
 * Theme:
 *   `theme` ("dark" | "light", default "dark") picks the Midnight- or
 *   Light-Glass version of that same crop. Same philosophy as `region`:
 *   this component does no theme detection itself — the caller resolves
 *   it (via useTheme()) and passes it down. The atmosphere layers (base
 *   fill, edge vignettes, bottom dissolve) also branch on `theme` so a
 *   bright daytime crop doesn't get crushed under vignette colors tuned
 *   for a night-side image; the blue multiply tint and sun bloom are left
 *   alone since "soft blue atmosphere" is part of the Light Glass
 *   direction too.
 */

import Image from "next/image";
import { useMemo, ReactNode } from "react";
import { heroSrcForRegion, type HeroRegion, type HeroThemeMode } from "@/lib/hero-region";

// ── Shared vertical crop position ────────────────────────────────────────────
//
// `object-position`'s vertical percentage decides which slice of the
// (always-overflowing) source photo lands inside the cropped wrapper: 0%
// anchors the photo's own top edge to the wrapper's top — favors sky/sun,
// crops surface detail off the bottom; 100% does the opposite. The wrapper
// is always wider (in aspect ratio) than every source photo, so cropping
// only ever happens vertically — horizontal position is a no-op, which is
// why it stays "center" below.
//
// The regional hero set was regenerated so every crop (all five regions,
// both themes) shares the same composition, Earth:space ratio, and sunrise
// placement — there is deliberately no per-image table anymore. One set of
// breakpoint values applies everywhere. These reuse the original MENA-dark
// reference tuning, which already read as cinematic and is the composition
// the new artwork was built to match.
const POSITION_Y = { base: 24, md: 20, xl: 17, xxl: 14 } as const;

// ── UTC sun position ──────────────────────────────────────────────────────────

function sunlight(): { x: number; warmth: number } {
  const utcH    = new Date().getUTCHours();
  const utcMin  = new Date().getUTCMinutes();
  const utcFrac = (utcH * 60 + utcMin) / (24 * 60);
  const rawX    = ((utcFrac - 0.25 + 1) % 1);
  const x       = 5 + rawX * 90;
  return { x, warmth: utcH >= 5 && utcH <= 19 ? 0.22 : 0.07 };
}

interface EarthBackgroundProps {
  children?: ReactNode;
  /** Resolved hero region, or null/undefined for the default wide Earth. */
  region?: HeroRegion | null;
  /** Resolved appearance — "dark" (Midnight Glass) or "light" (Light Glass). */
  theme?: HeroThemeMode;
}

export function EarthBackground({ children, region, theme = "dark" }: EarthBackgroundProps) {
  const sun = useMemo(() => sunlight(), []);
  const heroSrc = heroSrcForRegion(region, theme);
  const isLight = theme === "light";

  // Atmosphere tones — dark literals for Midnight Glass (unchanged from the
  // original recipe), paper-matched literals for Light Glass so the same
  // layering reads as a soft daytime haze instead of a night vignette.
  // paper-0 (#FBFAF7) / paper-50 (#F2F1ED) are the existing tokens from
  // app/globals.css, spelled out in rgba() here only because these layers
  // need partial alpha that the flat token values don't carry.
  const baseFill       = isLight ? "var(--paper-50)"          : "var(--ink-950)";
  // Edge/top/bottom vignette opacities below are deliberately much lower in
  // Light Glass than the dark-mode values they sit beside. The Light Glass
  // hero fade was reading as a heavy "smoky" overlay rather than a gentle
  // dissolve — these were turned down so the light daytime crop stays mostly
  // visible while still giving text just enough contrast to read. Dark-mode
  // values and every gradient-stop position are untouched.
  const edgeStrong     = isLight ? "rgba(251,250,247,0.40)"    : "var(--ink-950)";
  const edgeSoft       = isLight ? "rgba(251,250,247,0.22)"    : "rgba(6,9,17,0.70)";
  // Top vignette — deliberately soft. This used to read as a near-solid bar
  // ("logo bar legibility"), which made the header look like it sat on its
  // own opaque strip instead of floating on the globe. Lower peak opacity +
  // a longer fade let the Earth show through behind the header while still
  // giving the logo/avatar enough contrast (each also has its own small
  // glass backing now — see BriefLogo / UserMenu).
  const topStrong      = isLight ? "rgba(251,250,247,0.30)"    : "rgba(6,9,17,0.45)";
  const topSoft        = isLight ? "rgba(251,250,247,0.08)"    : "rgba(6,9,17,0.12)";
  // Bottom dissolve — relaxed to stay later/longer (see Layer 7) so the
  // Earth remains visible well past the old 28%–82% window; same color
  // values, just pushed down and stretched out. Light Glass opacities are
  // additionally lowered (see comment above) — safe for hero-text contrast
  // since the greeting/status text now resolves to dark ink in Light Glass,
  // which reads fine against either this lighter dissolve or the daytime
  // image beneath it.
  const dissolveMid1   = isLight ? "rgba(242,241,237,0.12)"    : "rgba(12,17,29,0.40)";
  const dissolveMid2   = isLight ? "rgba(242,241,237,0.38)"    : "rgba(12,17,29,0.82)";
  const atmosphereTint = isLight ? "rgba(6,18,60,0.15)"        : "rgba(6,18,60,0.50)";

  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none select-none"
      aria-hidden="true"
    >
      {/*
        Responsive sizing for the Earth wrapper.

        The wrapper is positioned absolutely with explicit left/right values
        derived from viewport units — NOT inset:0. This makes it wider than
        the parent container at every breakpoint. object-cover then fills
        this oversized box and the hero's overflow-hidden clips the bleed.

        object-position's vertical value pushes the image up so the curved
        top arc and sunrise stay in frame — one shared percentage from
        POSITION_Y above, the same for every region and theme, since the
        artwork itself now defines the composition.
      */}
      <style>{`
        .eb-wrap {
          position: absolute;
          top: -10%;
          bottom: -4%;
          left:  -7.5vw;
          right: -7.5vw;
          /* Refraction-test pass: sharper + brighter + richer so coastlines and
             city-light detail read as high-frequency structure to judge glass
             against; the Brief stays the most cinematic of the three surfaces. */
          filter: blur(0.4px) brightness(0.74) saturate(1.2);
        }
        .eb-img {
          object-fit: cover;
          object-position: center ${POSITION_Y.base}%;
        }

        @media (min-width: 768px) {
          .eb-wrap {
            top: -14%;
            left:  -20vw;
            right: -20vw;
          }
          .eb-img { object-position: center ${POSITION_Y.md}%; }
        }

        @media (min-width: 1280px) {
          .eb-wrap {
            top: -18%;
            left:  -30vw;
            right: -30vw;
            filter: blur(0.3px) brightness(0.73) saturate(1.22);
          }
          .eb-img { object-position: center ${POSITION_Y.xl}%; }
        }

        @media (min-width: 1920px) {
          .eb-wrap {
            top: -22%;
            left:  -40vw;
            right: -40vw;
          }
          .eb-img { object-position: center ${POSITION_Y.xxl}%; }
        }
      `}</style>

      {/* Layer 1: deep space base (Midnight) / soft paper base (Light) */}
      <div className="absolute inset-0" style={{ background: baseFill }} />

      {/* Layer 2: Earth — always wider than viewport, always cover */}
      <div className="eb-wrap">
        <Image
          src={heroSrc}
          alt=""
          fill
          priority
          className="eb-img"
          sizes="(min-width: 1920px) 180vw, (min-width: 1280px) 160vw, (min-width: 768px) 140vw, 115vw"
        />
      </div>

      {/* Layer 3: blue atmospheric multiply tint — lighter in Light Glass so
          the daytime crop isn't crushed; still reads as "soft blue atmosphere" */}
      <div
        className="absolute inset-0"
        style={{ background: atmosphereTint, mixBlendMode: "multiply" }}
      />

      {/* Layer 4: UTC-driven warm sun bloom along the upper arc */}
      <div
        className="absolute inset-0"
        style={{
          background: [
            `radial-gradient(ellipse 55% 40% at ${sun.x}% -5%, rgba(255,210,90,${sun.warmth}) 0%, transparent 70%)`,
            `radial-gradient(ellipse 80% 50% at ${sun.x}% 0%, rgba(255,160,40,${sun.warmth * 0.5}) 0%, transparent 60%)`,
          ].join(", "),
        }}
      />

      {/* Layer 5: blue atmospheric rim — constant planet-edge scatter */}
      <div
        className="absolute inset-0"
        style={{
          background: [
            `radial-gradient(ellipse 100% 35% at 50% -2%, rgba(80,140,255,0.24) 0%, transparent 65%)`,
            `radial-gradient(ellipse 60% 25% at ${Math.min(sun.x + 15, 95)}% 5%, rgba(100,180,255,0.14) 0%, transparent 55%)`,
          ].join(", "),
        }}
      />

      {/* Layer 6a: left edge vignette */}
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(to right, ${edgeStrong} 0%, ${edgeSoft} 6%, transparent 22%)` }}
      />

      {/* Layer 6b: right edge vignette */}
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(to left, ${edgeStrong} 0%, ${edgeSoft} 6%, transparent 22%)` }}
      />

      {/* Layer 6c: top vignette — soft atmosphere, not a logo bar. Keeps the
          header legible without looking like its own opaque strip; the
          globe should read as continuing right up behind the nav. */}
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(to bottom, ${topStrong} 0%, ${topSoft} 16%, transparent 30%)` }}
      />

      {/* Layer 7: bottom dissolve — Earth fades into the page background
          (var(--bg-base)). Pushed later and stretched out: stays fully
          transparent (Earth untouched) until just past halfway down the
          hero, then dissolves gradually so it reaches solid right at the
          hero's bottom edge — roughly the top of the first content card —
          instead of going flat ~18% of the hero height early. */}
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(to bottom, transparent 55%, ${dissolveMid1} 74%, ${dissolveMid2} 90%, var(--bg-base) 100%)` }}
      />

      {/* Layer 8: future pin markers */}
      {children && (
        <div className="absolute inset-0 pointer-events-none">{children}</div>
      )}
    </div>
  );
}
