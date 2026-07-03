/**
 * components/atlas/GlassPanel.tsx
 *
 * Canonical "Atlas Glass" surface primitive — the one place the frosted
 * panel recipe from Fourth Meridian Design Language v1 lives. Every glass
 * card on the Daily Brief should render through this component instead of
 * hand-rolling backdrop-filter/box-shadow inline styles, so all panels stay
 * visually identical and any future token change only happens here.
 *
 * Recipe (matches docs/design-system/Fourth-Meridian-Design-Language-v1.html
 * .panel class):
 *   border-radius: var(--radius-lg)
 *   border: 1px solid var(--border-hairline)
 *   background: var(--glass-{depth})
 *   backdrop-filter: var(--glass-filter-{depth})   ← Material Engine Phase 1B
 *   box-shadow: var(--shadow-{elevation})
 *   + a 1px top-edge specular highlight
 *
 * Phase 1B (docs/design-system/ATLAS_GLASS_MATERIAL_DOCTRINE.md): the
 * backdrop-filter now consumes the per-depth `--glass-filter-{depth}` tokens
 * instead of a hardcoded `blur(30px) saturate(160%)`, so DEPTH is now physical
 * thickness (blur + saturation + brightness scale with the tier) rather than a
 * fill-opacity change alone. Practical effect on existing surfaces: `thin` is
 * near-identical (28px vs 30px), `regular` blurs more (40px), and `thick`
 * (modals) blurs noticeably more (60px) — the intended, doctrine-specified
 * look. Under prefers-reduced-transparency the token resolves to `none`, so
 * the surface drops backdrop-filter and leans on the opaque --glass-{depth}
 * fill (an a11y improvement, not a regression). The new `floating` tier is the
 * rarest/most-separated depth (hero / critical only).
 *
 * Optional `glow` adds a restrained ambient bloom behind the content,
 * matching the directive's per-surface-type ambient lighting rules
 * (AI = meridian+brass, premium = brass, investments = navy, warning =
 * restrained coral). Lighting is intentionally subtle — opacity stays low
 * so it never competes with content.
 *
 * `as` makes this polymorphic (div, Next Link, button, ...). Because the
 * rendered tag is dynamic, extra props (href, role, onClick, ...) are
 * intentionally loosely typed and passed straight through to `Component`.
 */

"use client";

import { CSSProperties, ElementType, ReactNode, forwardRef } from "react";

export type GlassDepth = "ultrathin" | "thin" | "regular" | "thick" | "floating";
export type GlassElevation = "e1" | "e2" | "e3" | "e4";
export type GlassRadius = "xs" | "sm" | "md" | "lg" | "xl";
export type GlassGlow = "none" | "meridian" | "brass" | "coral" | "violet" | "ai";

const GLOW_RECIPES: Record<Exclude<GlassGlow, "none">, string> = {
  meridian:
    "radial-gradient(120% 100% at 18% -10%, rgba(59,130,246,0.16), transparent 60%)",
  brass:
    "radial-gradient(120% 100% at 18% -10%, rgba(201,162,39,0.14), transparent 60%)",
  coral:
    "radial-gradient(120% 100% at 18% -10%, rgba(237,82,71,0.12), transparent 60%)",
  violet:
    "radial-gradient(120% 100% at 18% -10%, rgba(139,92,246,0.14), transparent 60%)",
  ai:
    "radial-gradient(110% 90% at 12% -12%, rgba(59,130,246,0.16), transparent 55%), " +
    "radial-gradient(110% 90% at 92% 112%, rgba(201,162,39,0.13), transparent 55%)",
};

// Phase 2 — edge intensity scales with depth (Material Doctrine §4.3): thicker
// glass reads as a more polished slab with a brighter, tighter lit edge; thin
// stays restrained so cards (and DataCard, which is thin) keep a gentle edge,
// not a hard outline. Feeds the .atlas-fresnel-edge utility's --atlas-edge-strength.
const EDGE_STRENGTH: Record<GlassDepth, number> = {
  ultrathin: 0.7,
  thin: 0.85,
  regular: 1,
  thick: 1.25,
  floating: 1.5,
};

// Phase 3 — DIRECTIONAL interior bloom: a stronger pool of light entering at the
// top-left source, plus a faint counter-glow where light exits the far bottom-right
// edge. The two-source asymmetry reads as light passing THROUGH a slab (refraction)
// rather than a flat, symmetric frost. Still neutral/white and distinct from the
// brand-colored accent `glow`; defaults on for thick/floating only.
const INTERIOR_BLOOM =
  "radial-gradient(120% 90% at 14% -16%, rgba(255,255,255,0.10), transparent 52%), " +
  "radial-gradient(90% 80% at 108% 120%, rgba(255,255,255,0.045), transparent 55%)";

// Phase 3 — refraction bevel: the core "bends light" cue, done entirely with inset
// box-shadows (free — no extra backdrop-filter, no SVG/canvas). Each tier layers a
// directional bevel (bright top-left = light entry, dark bottom-right = exit) plus,
// on thicker tiers, a soft inner rim-light (`inset 0 0 …`) that brightens the edges
// more than the center — countering the "uniform center blur" flatness. Intensity
// scales with depth so thin stays restrained (DataCard is thin) and thick/floating
// read as genuinely deeper, more refractive slabs. Theme-neutral (white/black), the
// same convention the --shadow-e* recipes already use.
const REFRACTION_BEVEL: Record<GlassDepth, string> = {
  ultrathin:
    "inset 1px 1px 0 rgba(255,255,255,.05), inset -1px -1px 0 rgba(0,0,0,.06)",
  thin:
    "inset 1px 1px 0 rgba(255,255,255,.06), inset -1px -1px 0 rgba(0,0,0,.09)",
  regular:
    "inset 1px 1px 0 rgba(255,255,255,.08), inset -1px -1px 1px rgba(0,0,0,.11), " +
    "inset 0 0 10px rgba(255,255,255,.03)",
  thick:
    "inset 1px 2px 0 rgba(255,255,255,.11), inset -1px -2px 1px rgba(0,0,0,.15), " +
    "inset 0 0 16px rgba(255,255,255,.04)",
  floating:
    "inset 1px 2px 1px rgba(255,255,255,.13), inset -2px -2px 2px rgba(0,0,0,.18), " +
    "inset 0 0 22px rgba(255,255,255,.05)",
};

export interface GlassPanelOwnProps {
  as?: ElementType;
  depth?: GlassDepth;
  elevation?: GlassElevation;
  radius?: GlassRadius;
  glow?: GlassGlow;
  /**
   * Fresnel perimeter edge light (Phase 2). Default ON — every panel gets a
   * lit border, brightest toward the top-left light source, at a depth-scaled
   * intensity (thin restrained → thick/floating brighter). Set false to opt a
   * surface out and keep only the legacy top-edge specular.
   */
  edge?: boolean;
  /**
   * Neutral interior bloom (Phase 2). Defaults to true for `thick`/`floating`
   * (modals, hero) and false otherwise, so cards stay flat. Explicitly set to
   * override the depth-based default.
   */
  bloom?: boolean;
  /** Override the depth-scaled edge intensity (--atlas-edge-strength). */
  edgeStrength?: number;
  /** Adds hover lift + brighten; pairs with role="button"/tabIndex on the host. */
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

// Polymorphic — extra DOM/Link/button props (href, role, onClick, ...) pass
// straight through to whatever `as` resolves to.
export type GlassPanelProps = GlassPanelOwnProps & Record<string, unknown>;

export const GlassPanel = forwardRef<HTMLElement, GlassPanelProps>(
  function GlassPanel(props, ref) {
    const {
      as,
      depth = "thin",
      elevation = "e2",
      radius = "lg",
      glow = "none",
      edge = true,
      bloom,
      edgeStrength,
      interactive = false,
      className = "",
      style,
      children,
      ...rest
    } = props;

    const Component = (as ?? "div") as ElementType;

    // Bloom defaults on only for the thickest tiers; caller can override.
    const showBloom = bloom ?? (depth === "thick" || depth === "floating");
    const resolvedEdgeStrength = edgeStrength ?? EDGE_STRENGTH[depth as GlassDepth];

    return (
      <Component
        ref={ref}
        className={[
          "relative overflow-hidden",
          edge ? "atlas-fresnel-edge" : "",
          interactive
            ? "transition-[transform,box-shadow,background-color] duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:-translate-y-[1px]"
            : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          borderRadius: `var(--radius-${radius})`,
          border: "1px solid var(--border-hairline)",
          background: `var(--glass-${depth})`,
          backdropFilter: `var(--glass-filter-${depth})`,
          WebkitBackdropFilter: `var(--glass-filter-${depth})`,
          // Elevation shadow + the Phase 3 depth-scaled refraction bevel/rim-light.
          boxShadow: `var(--shadow-${elevation}), ${REFRACTION_BEVEL[depth as GlassDepth]}`,
          ...(edge
            ? ({ "--atlas-edge-strength": resolvedEdgeStrength } as CSSProperties)
            : {}),
          ...(style as CSSProperties | undefined),
        }}
        {...rest}
      >
        {/* Neutral interior bloom — soft interior light for thick/floating glass.
            Distinct from the accent `glow` below; sits on the base, below content. */}
        {showBloom && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0"
            style={{ background: INTERIOR_BLOOM }}
          />
        )}

        {/* Ambient lighting bloom — sits below content, above the base glass */}
        {glow !== "none" && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0"
            style={{ background: GLOW_RECIPES[glow as Exclude<GlassGlow, "none">] }}
          />
        )}

        {/* Specular top-edge highlight — the Atlas Glass signature */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 right-0 h-px z-[1]"
          style={{
            background:
              "linear-gradient(90deg, transparent, var(--specular-edge), transparent)",
          }}
        />

        {/* Content always sits above glow + specular layers */}
        <div className="relative z-10">{children as ReactNode}</div>
      </Component>
    );
  }
);
