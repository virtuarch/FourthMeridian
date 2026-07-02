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
 *   backdrop-filter: blur(30px) saturate(160%)
 *   box-shadow: var(--shadow-{elevation})
 *   + a 1px top-edge specular highlight
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

export type GlassDepth = "ultrathin" | "thin" | "regular" | "thick";
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

export interface GlassPanelOwnProps {
  as?: ElementType;
  depth?: GlassDepth;
  elevation?: GlassElevation;
  radius?: GlassRadius;
  glow?: GlassGlow;
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
      interactive = false,
      className = "",
      style,
      children,
      ...rest
    } = props;

    const Component = (as ?? "div") as ElementType;

    return (
      <Component
        ref={ref}
        className={[
          "relative overflow-hidden",
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
          backdropFilter: "blur(30px) saturate(160%)",
          WebkitBackdropFilter: "blur(30px) saturate(160%)",
          boxShadow: `var(--shadow-${elevation})`,
          ...(style as CSSProperties | undefined),
        }}
        {...rest}
      >
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
