"use client";

/**
 * components/atlas/SegmentedControl.tsx
 *
 * Apple-style segmented control — single glass capsule, one shared
 * material, with a sliding Meridian highlight that animates between
 * segments instead of each segment being its own independent pill.
 *
 * Replaces the old "row of separate glass buttons" tab pattern (which read
 * as web-native chips) with the native iOS/macOS segmented-control feel:
 * one continuous track, hairline dividers only between adjacent *inactive*
 * segments (never adjacent to the active one, matching UISegmentedControl
 * behavior), and a highlight that slides + resizes to the active segment's
 * measured bounds rather than each button owning its own background.
 *
 * The active highlight uses the same restrained Meridian-tint glass recipe
 * as GlassButton's `tone="meridian"` (a translucent wash + hairline border +
 * specular top edge) rather than a flat `var(--meridian-600)` color block —
 * keeps the "rail" feeling premium/quiet instead of a chunky solid button.
 *
 * Overflow scrolls horizontally with a hidden scrollbar (.no-scrollbar in
 * globals.css) — used here because Daily Brief's range strip has 9 options,
 * more than a typical 2-5 segment control comfortably fits at once.
 *
 * Motion respects prefers-reduced-motion automatically via the global
 * `*, *::before, *::after { transition-duration: .01ms !important }` rule
 * in globals.css, which overrides this component's inline transition.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface SegmentedControlOption<T extends string> {
  id: T;
  label: string;
  /**
   * Optional pre-resolved icon node rendered before the label (SHELL_NAV §2.3).
   * A NODE, not an icon-name string, so this primitive stays icon-library-
   * agnostic — callers resolve their own name→component (e.g. via
   * lib/perspective-icons) and pass the element. Additive and optional: when
   * absent, the segment renders exactly its bare label as before, so the five
   * consumers that pass no icon are byte-identical.
   */
  icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /**
   * "always" (default) — every segment shows its label, exactly as before, so
   * the consumers that don't pass this are byte-identical (SHELL_NAV Phase 2 §2.1).
   * "activeOnly" — only the active segment shows its label; inactive segments
   * render icon-only (the label is visually collapsed via sr-only, so the button
   * narrows to the icon while the label stays in the DOM). Pair with per-option
   * `icon` for a legible icon-only rail. Accessible name is preserved either way
   * (see the per-button aria-label below).
   */
  labelVisibility?: "always" | "activeOnly";
  "aria-label"?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = "",
  labelVisibility = "always",
  ...rest
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const [highlight, setHighlight] = useState<{ left: number; width: number } | null>(null);

  const measure = () => {
    const track = trackRef.current;
    const el = itemRefs.current.get(value);
    // When `value` matches no option (e.g. this group is inactive because the
    // active period lives in a SIBLING control), clear the highlight instead of
    // leaving a stale one lit — otherwise two groups can look selected at once.
    if (!track) return;
    if (!el) { setHighlight(null); return; }
    const trackRect = track.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    setHighlight({
      left: elRect.left - trackRect.left + track.scrollLeft,
      width: elRect.width,
    });
  };

  // Re-measure synchronously before paint whenever the active segment (or
  // the option set) changes, so the highlight never flashes at a stale rect.
  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options.length]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={rest["aria-label"]}
      className={[
        "relative inline-flex max-w-full overflow-x-auto no-scrollbar p-1.5 gap-0",
        className,
      ].join(" ")}
      style={{
        background: "var(--glass-ultrathin)",
        border: "1px solid var(--border-hairline)",
        borderRadius: "var(--radius-full)",
        backdropFilter: "blur(30px) saturate(160%)",
        WebkitBackdropFilter: "blur(30px) saturate(160%)",
      }}
    >
      {/* Sliding active-segment highlight — translucent Meridian wash, not a
          solid color block (see GlassButton's tone="meridian" recipe). */}
      {highlight && (
        <div
          aria-hidden
          className="absolute top-1 bottom-1 left-0 rounded-[var(--radius-full)] overflow-hidden transition-[transform,width] duration-[var(--dur-base)] ease-[var(--ease-spring)]"
          style={{
            width: highlight.width,
            transform: `translateX(${highlight.left}px)`,
            background: "rgba(59,130,246,.14)",
            border: "1px solid rgba(125,168,255,.32)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,.10), 0 1px 6px rgba(37,99,235,.16)",
          }}
        >
          {/* Specular top-edge highlight — same signature as GlassPanel/GlassButton */}
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 left-2 right-2 h-px"
            style={{
              background: "linear-gradient(90deg, transparent, var(--specular-edge), transparent)",
              opacity: 0.5,
            }}
          />
        </div>
      )}

      {options.map((opt, i) => {
        const isActive = opt.id === value;
        const prevIsActive = i > 0 && options[i - 1].id === value;
        // Under "activeOnly", an inactive segment collapses its label to
        // icon-only. The label stays in the DOM (sr-only, not display:none) so
        // the button still carries an accessible name from its text content;
        // an explicit aria-label is added ONLY here, where the visible text is
        // hidden — never alongside a VISIBLE label, which is the pattern that
        // makes some screen readers double-announce. Active segments and every
        // "always" consumer name themselves from their visible text, as before.
        const collapse = labelVisibility === "activeOnly" && !isActive;
        const label = collapse ? <span className="sr-only">{opt.label}</span> : opt.label;
        return (
          <button
            key={opt.id}
            ref={(node) => {
              if (node) itemRefs.current.set(opt.id, node);
              else itemRefs.current.delete(opt.id);
            }}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-label={collapse ? opt.label : undefined}
            onClick={() => onChange(opt.id)}
            className={[
              "relative z-10 shrink-0 whitespace-nowrap rounded-[var(--radius-full)] px-4 py-2 text-xs font-semibold",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]",
              isActive
                ? "text-[var(--meridian-400)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            ].join(" ")}
            style={{
              borderLeft:
                !isActive && !prevIsActive && i > 0
                  ? "1px solid var(--border-hairline)"
                  : "1px solid transparent",
            }}
          >
            {opt.icon != null ? (
              // Icon + label share the segment; the inner flex owns the gap so
              // the button's own padding/box is unchanged from the label-only
              // path. The icon is decorative — the visible label (or, when
              // collapsed, the aria-label) is the accessible name (role=tab), so
              // the glyph carries aria-hidden.
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-flex shrink-0">{opt.icon}</span>
                {label}
              </span>
            ) : (
              label
            )}
          </button>
        );
      })}
    </div>
  );
}
