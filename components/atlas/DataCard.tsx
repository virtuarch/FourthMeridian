/**
 * components/atlas/DataCard.tsx
 *
 * Step A foundation — the single semantic wrapper every dashboard data card
 * will migrate onto (Step B). Composes GlassPanel; it does NOT re-implement
 * glass. Defaults reproduce the legacy components/ui/Card box (thin glass,
 * radius-lg, space-4 padding) so a later migration is a MATERIAL swap, not a
 * layout change.
 *
 * Rules baked into the API (see
 * docs/investigations/ATLAS_GLASS_UNIFICATION_STEP_A_CHECKLIST.md §3):
 *  - Motion is orthogonal to material: `interactive` defaults false, so a card
 *    never moves just because it became glass (Interaction Doctrine §2).
 *  - No `glow` is exposed — the brass/AI accent stays scarce (Design Language
 *    Law 7). DataCard is for data, not the Briefing.
 *  - `accent` is SEMANTIC ONLY (no raw color strings); it resolves to the
 *    --accent-* tokens and is surfaced as a `--data-card-accent` custom
 *    property + `data-accent` attribute for later consumers. Default "none"
 *    adds nothing.
 *  - No Liquid Glass surface props (displacement / refraction / aberration /
 *    curvature / draggable) exist here by construction.
 *
 * Mounted nowhere in Step A. Additive and inert — renders no pixel until a
 * consumer adopts it in Step B.
 */

"use client";

import { CSSProperties, ElementType, ReactNode, forwardRef } from "react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type {
  GlassDepth,
  GlassElevation,
  GlassRadius,
} from "@/components/atlas/GlassPanel";

export type DataCardAccent = "none" | "positive" | "negative" | "neutral" | "info";

const ACCENT_VAR: Record<Exclude<DataCardAccent, "none">, string> = {
  positive: "var(--accent-positive)",
  negative: "var(--accent-negative)",
  neutral: "var(--accent-neutral)",
  info: "var(--accent-info)",
};

export interface DataCardProps {
  children?: ReactNode;
  /** Optional uppercase label slot — replaces the legacy <CardTitle>. */
  title?: ReactNode;

  /** Material — locked defaults, narrowly overridable. */
  depth?: GlassDepth; // default "thin"
  elevation?: GlassElevation; // default "e2"
  radius?: GlassRadius; // default "lg" (≈ legacy rounded-2xl)
  padding?: string; // default var(--space-4) (≈ legacy p-4)

  /** Affordance — SEPARATE from material. Inert by default. */
  interactive?: boolean; // default false → GlassPanel hover lift only when true
  onClick?: () => void;
  as?: ElementType;

  /** Accent — SEMANTIC ONLY. Never accepts a raw color string. */
  accent?: DataCardAccent; // default "none"

  className?: string;
  style?: CSSProperties;
}

export const DataCard = forwardRef<HTMLElement, DataCardProps>(function DataCard(
  props,
  ref
) {
  const {
    children,
    title,
    depth = "thin",
    elevation = "e2",
    radius = "lg",
    padding = "var(--space-4)",
    interactive = false,
    onClick,
    as,
    accent = "none",
    className = "",
    style,
    ...rest
  } = props;

  const accentStyle: CSSProperties =
    accent === "none"
      ? {}
      : ({ "--data-card-accent": ACCENT_VAR[accent] } as CSSProperties);

  return (
    <GlassPanel
      ref={ref}
      as={as}
      depth={depth}
      elevation={elevation}
      radius={radius}
      interactive={interactive}
      onClick={onClick}
      data-accent={accent === "none" ? undefined : accent}
      className={className}
      style={{ padding, ...accentStyle, ...(style as CSSProperties | undefined) }}
      {...rest}
    >
      {title != null && <DataCardTitle>{title}</DataCardTitle>}
      {children}
    </GlassPanel>
  );
});

export function DataCardTitle({ children }: { children: ReactNode }) {
  return (
    <p
      className="text-xs font-semibold uppercase tracking-widest mb-1"
      style={{ color: "var(--text-muted)" }}
    >
      {children}
    </p>
  );
}
