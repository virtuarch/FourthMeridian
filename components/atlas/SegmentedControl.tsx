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
 * Overflow scrolls horizontally with a hidden scrollbar (.no-scrollbar in
 * globals.css) — used here because Daily Brief's range strip has 9 options,
 * more than a typical 2-5 segment control comfortably fits at once.
 *
 * Motion respects prefers-reduced-motion automatically via the global
 * `*, *::before, *::after { transition-duration: .01ms !important }` rule
 * in globals.css, which overrides this component's inline transition.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SegmentedControlOption<T extends string> {
  id: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  "aria-label"?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = "",
  ...rest
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const [highlight, setHighlight] = useState<{ left: number; width: number } | null>(null);

  const measure = () => {
    const track = trackRef.current;
    const el = itemRefs.current.get(value);
    if (!track || !el) return;
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
        "relative inline-flex max-w-full overflow-x-auto no-scrollbar p-1 gap-0",
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
      {/* Sliding active-segment highlight */}
      {highlight && (
        <div
          aria-hidden
          className="absolute top-1 bottom-1 left-0 rounded-[var(--radius-full)] transition-[transform,width] duration-[var(--dur-base)] ease-[var(--ease-spring)]"
          style={{
            width: highlight.width,
            transform: `translateX(${highlight.left}px)`,
            background: "var(--meridian-600)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,.25), 0 2px 10px rgba(37,99,235,.35)",
          }}
        />
      )}

      {options.map((opt, i) => {
        const isActive = opt.id === value;
        const prevIsActive = i > 0 && options[i - 1].id === value;
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
            onClick={() => onChange(opt.id)}
            className={[
              "relative z-10 shrink-0 whitespace-nowrap rounded-[var(--radius-full)] px-3.5 py-1.5 text-xs font-medium",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]",
              isActive
                ? "text-[var(--ink-0)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            ].join(" ")}
            style={{
              borderLeft:
                !isActive && !prevIsActive && i > 0
                  ? "1px solid var(--border-hairline)"
                  : "1px solid transparent",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
