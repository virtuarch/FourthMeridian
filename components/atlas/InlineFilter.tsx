"use client";

/**
 * components/atlas/InlineFilter.tsx
 *
 * Compact time/range selector — text only, no pill, no track, no filled
 * background. Designed to sit quietly opposite a modal title
 * ("Since Your Last Visit                    Since Visit · Day · Week...")
 * rather than compete with it as its own UI object.
 *
 * Two renders, picked by CSS media query rather than JS viewport
 * detection (same dual-render approach as EarthBackground's responsive
 * crops, so there's no hydration mismatch risk):
 *
 *   - Desktop (sm and up): the original inline row — every option as its
 *     own muted text button, separated by middots, active one underlined
 *     in Meridian Blue. Stays under 32px tall so it reads as a label, not
 *     a control surface.
 *   - Mobile (below sm): six inline text buttons don't fit next to a
 *     modal title and a close button on a narrow viewport — that
 *     combination was the root cause of the close button becoming
 *     unreachable without horizontal scrolling. Below sm, this collapses
 *     into a single compact dropdown trigger (current option + chevron)
 *     that opens a short glass popover listing all options as
 *     menuitemradio rows — same accessible popover shape used elsewhere
 *     in Atlas Glass (outside-click + Escape to close, Check icon marks
 *     the active option).
 *
 * This intentionally replaces the heavier capsule-track SegmentedControl
 * for this use case — that component remains available in
 * components/atlas/SegmentedControl.tsx for places where a denser, more
 * tactile control (rather than a quiet inline filter) is the right call.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";

export interface InlineFilterOption<T extends string> {
  id: T;
  label: string;
}

interface InlineFilterProps<T extends string> {
  options: InlineFilterOption<T>[];
  value: T;
  onChange: (id: T) => void;
  "aria-label"?: string;
  className?: string;
}

export function InlineFilter<T extends string>({
  options,
  value,
  onChange,
  className = "",
  ...rest
}: InlineFilterProps<T>) {
  const ariaLabel = rest["aria-label"];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeOption = options.find(opt => opt.id === value) ?? options[0];

  // Close on outside click / Escape — standard lightweight popover
  // behavior, same pattern used throughout Atlas Glass.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {/* Desktop / tablet — original inline text row */}
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={["hidden sm:flex items-center gap-2 flex-wrap justify-end", className].join(" ")}
      >
        {options.map((opt, i) => {
          const isActive = opt.id === value;
          return (
            <span key={opt.id} className="flex items-center gap-2">
              {i > 0 && (
                <span aria-hidden className="text-[var(--text-muted)]/35 text-xs select-none">
                  ·
                </span>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onChange(opt.id)}
                className={[
                  "relative pb-[3px] text-xs font-medium whitespace-nowrap rounded-[2px]",
                  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]",
                  isActive
                    ? "text-[var(--meridian-400)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                ].join(" ")}
                style={
                  isActive
                    ? {
                        boxShadow: "0 1px 0 0 var(--meridian-400)",
                        textShadow: "0 0 12px rgba(88,150,251,.45)",
                      }
                    : undefined
                }
              >
                {opt.label}
              </button>
            </span>
          );
        })}
      </div>

      {/* Mobile — compact dropdown, never wider than its own trigger */}
      <div ref={rootRef} className={["relative sm:hidden shrink-0", className].join(" ")}>
        <GlassPanel
          as="button"
          type="button"
          depth="thin"
          radius="full"
          elevation="e1"
          interactive
          onClick={() => setOpen(o => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 text-xs font-medium text-[var(--meridian-400)] max-w-[8.5rem]"
        >
          <span className="truncate">{activeOption?.label}</span>
          <ChevronDown className={`w-3 h-3 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </GlassPanel>

        {open && (
          <GlassPanel
            as="div"
            role="menu"
            aria-label={ariaLabel}
            depth="regular"
            radius="md"
            elevation="e3"
            className="absolute right-0 mt-2 w-36 py-1.5 z-50"
          >
            {options.map(opt => {
              const isActive = opt.id === value;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    onChange(opt.id);
                    setOpen(false);
                  }}
                  className={[
                    "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                    isActive ? "text-[var(--meridian-400)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  ].join(" ")}
                >
                  {opt.label}
                  {isActive && <Check className="w-3 h-3 shrink-0" />}
                </button>
              );
            })}
          </GlassPanel>
        )}
      </div>
    </>
  );
}
