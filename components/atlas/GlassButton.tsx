/**
 * components/atlas/GlassButton.tsx
 *
 * Canonical "Atlas Glass" button — the button-shaped sibling to GlassPanel.
 * Ports the .btn-ghost / tinted-selection recipe from Fourth Meridian
 * Design Language v1 into a real component so every primary/secondary
 * action across the app (Create Space, Accept invite, Refresh, ...) shares
 * one translucent, hairline-bordered, backdrop-blurred recipe instead of
 * solid color-block buttons.
 *
 * `tone` swaps the tint, never the material: "meridian" washes a restrained
 * 10–16% Meridian-blue tint over the same glass (the existing pattern
 * already used for selected Space-Type / Privacy chips on this page), it
 * never falls back to a flat `background: var(--meridian-600)` block.
 *
 * Note: background/border/text are Tailwind utility classes (not inline
 * `style`) specifically so the `hover:` variants below can actually take
 * effect — an inline `style` background would otherwise always win over a
 * class-based `:hover` rule regardless of specificity tricks.
 */

"use client";

import { ButtonHTMLAttributes, CSSProperties, forwardRef } from "react";

export type GlassButtonTone = "neutral" | "meridian" | "danger";
export type GlassButtonSize = "sm" | "md";

const TONE_CLASSES: Record<GlassButtonTone, string> = {
  neutral:
    "text-[var(--text-secondary)] hover:text-[var(--text-primary)] " +
    "bg-[var(--glass-ultrathin)] hover:bg-[var(--surface-hover-strong)] " +
    "border-[var(--border-hairline-strong)]",
  meridian:
    "text-[var(--meridian-400)] hover:text-[var(--meridian-300)] " +
    "bg-[rgba(59,130,246,.10)] hover:bg-[rgba(59,130,246,.16)] " +
    "border-[rgba(125,168,255,.35)]",
  danger:
    "text-[var(--coral-400)] hover:text-[var(--coral-300)] " +
    "bg-[rgba(237,82,71,.08)] hover:bg-[rgba(237,82,71,.14)] " +
    "border-[rgba(237,82,71,.3)]",
};

const SIZE_CLASSES: Record<GlassButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5",
  md: "px-4 py-2.5 text-sm gap-2",
};

export interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: GlassButtonTone;
  size?: GlassButtonSize;
  fullWidth?: boolean;
}

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  function GlassButton(
    { tone = "neutral", size = "md", fullWidth, className = "", style, children, ...rest },
    ref
  ) {
    return (
      <button
        ref={ref}
        className={[
          "relative overflow-hidden inline-flex items-center justify-center font-semibold",
          "rounded-[var(--radius-sm)] border",
          "transition-[transform,background-color,border-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-standard)]",
          "hover:-translate-y-[1px] active:translate-y-0 active:scale-[0.97]",
          "disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 disabled:cursor-not-allowed",
          SIZE_CLASSES[size],
          TONE_CLASSES[tone],
          fullWidth ? "w-full" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          backdropFilter: "blur(20px) saturate(160%)",
          WebkitBackdropFilter: "blur(20px) saturate(160%)",
          ...(style as CSSProperties | undefined),
        }}
        {...rest}
      >
        {/* Specular top-edge highlight — same signature as GlassPanel */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 left-2 right-2 h-px"
          style={{
            background: "linear-gradient(90deg, transparent, var(--specular-edge), transparent)",
            opacity: 0.6,
          }}
        />
        {children}
      </button>
    );
  }
);
