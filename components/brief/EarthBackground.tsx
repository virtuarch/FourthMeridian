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
 * Layering (bottom → top):
 *   1. Base fill — deep space navy
 *   2. Earth image — oversized viewport-width wrapper + object-cover
 *   3. Blue atmospheric multiply tint
 *   4. UTC warm sun bloom
 *   5. Blue atmospheric rim scatter
 *   6. Edge vignettes L / R / top
 *   7. Bottom dissolve into page background
 *   8. children — future map pins
 */

import Image from "next/image";
import { useMemo, ReactNode } from "react";

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
}

export function EarthBackground({ children }: EarthBackgroundProps) {
  const sun = useMemo(() => sunlight(), []);

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

        object-position pushes the image up so the curved top arc is in
        frame, giving the "curved horizon / looking down at Earth" feel.
      */}
      <style>{`
        .eb-wrap {
          position: absolute;
          top: -10%;
          bottom: -4%;
          left:  -7.5vw;
          right: -7.5vw;
          filter: blur(0.8px) brightness(0.66) saturate(1.05);
        }
        .eb-img {
          object-fit: cover;
          object-position: center 24%;
        }

        @media (min-width: 768px) {
          .eb-wrap {
            top: -14%;
            left:  -20vw;
            right: -20vw;
          }
          .eb-img { object-position: center 20%; }
        }

        @media (min-width: 1280px) {
          .eb-wrap {
            top: -18%;
            left:  -30vw;
            right: -30vw;
            filter: blur(0.5px) brightness(0.65) saturate(1.08);
          }
          .eb-img { object-position: center 17%; }
        }

        @media (min-width: 1920px) {
          .eb-wrap {
            top: -22%;
            left:  -40vw;
            right: -40vw;
          }
          .eb-img { object-position: center 14%; }
        }
      `}</style>

      {/* Layer 1: deep space base */}
      <div className="absolute inset-0 bg-[#030c1a]" />

      {/* Layer 2: Earth — always wider than viewport, always cover */}
      <div className="eb-wrap">
        <Image
          src="/oval-world.png"
          alt=""
          fill
          priority
          className="eb-img"
          sizes="(min-width: 1920px) 180vw, (min-width: 1280px) 160vw, (min-width: 768px) 140vw, 115vw"
        />
      </div>

      {/* Layer 3: blue atmospheric multiply tint */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(6,18,60,0.50)", mixBlendMode: "multiply" }}
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
            `radial-gradient(ellipse 100% 35% at 50% -2%, rgba(80,140,255,0.18) 0%, transparent 65%)`,
            `radial-gradient(ellipse 60% 25% at ${Math.min(sun.x + 15, 95)}% 5%, rgba(100,180,255,0.10) 0%, transparent 55%)`,
          ].join(", "),
        }}
      />

      {/* Layer 6a: left edge vignette */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(to right, #030c1a 0%, rgba(3,12,26,0.70) 6%, transparent 22%)" }}
      />

      {/* Layer 6b: right edge vignette */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(to left, #030c1a 0%, rgba(3,12,26,0.70) 6%, transparent 22%)" }}
      />

      {/* Layer 6c: top vignette — logo bar legibility */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(to bottom, rgba(3,7,18,0.75) 0%, rgba(3,7,18,0.20) 12%, transparent 25%)" }}
      />

      {/* Layer 7: bottom dissolve — Earth fades into page */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(to bottom, transparent 28%, rgba(3,7,18,0.40) 48%, rgba(3,7,18,0.82) 66%, #030712 82%)" }}
      />

      {/* Layer 8: future pin markers */}
      {children && (
        <div className="absolute inset-0 pointer-events-none">{children}</div>
      )}
    </div>
  );
}
