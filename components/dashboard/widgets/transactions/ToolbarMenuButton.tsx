"use client";

/**
 * components/dashboard/widgets/transactions/ToolbarMenuButton.tsx
 *
 * Transactions redesign — a compact toolbar dropdown: a glass trigger (icon +
 * current-value label + chevron) that opens a small popover of `menuitemradio`
 * rows. Generalizes the lightweight popover recipe InlineFilter already ships
 * (outside-click + Escape to close, Check marks the active row) into a reusable
 * trigger-style control. Used by the Time selector and (Slice 7) the Sort menu.
 *
 * Presentation only — it owns no filter state; selection calls `onChange`.
 * `children` render at the bottom of the popover (e.g. the custom date pickers),
 * and `shouldCloseOnSelect` lets a caller keep the popover open for options that
 * reveal inline sub-controls (Time's "Custom").
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Check } from "lucide-react";
import { INPUT_BASE, inputStyle } from "./transactions-filter-constants";

export interface ToolbarMenuOption<T extends string> {
  id: T;
  label: string;
}

interface Props<T extends string> {
  icon?: ReactNode;
  /** Trigger text — usually the active option's label, optionally prefixed. */
  triggerLabel: ReactNode;
  options: ToolbarMenuOption<T>[];
  value: T;
  onChange: (id: T) => void;
  "aria-label": string;
  /** Rendered at the foot of the popover (e.g. custom date pickers). */
  children?: ReactNode;
  /** Popover horizontal anchor. Default "right". */
  align?: "left" | "right";
  /** Return false to keep the popover open after selecting an option. */
  shouldCloseOnSelect?: (id: T) => boolean;
  className?: string;
}

export function ToolbarMenuButton<T extends string>({
  icon,
  triggerLabel,
  options,
  value,
  onChange,
  children,
  align = "right",
  shouldCloseOnSelect,
  className = "",
  ...rest
}: Props<T>) {
  const ariaLabel = rest["aria-label"];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    <div ref={rootRef} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`flex items-center gap-2 px-3 py-2.5 touch-manipulation ${INPUT_BASE}`}
        style={inputStyle}
      >
        {icon && <span aria-hidden className="inline-flex shrink-0" style={{ color: "var(--text-muted)" }}>{icon}</span>}
        <span className="whitespace-nowrap">{triggerLabel}</span>
        <ChevronDown size={13} className={`shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} style={{ color: "var(--text-muted)" }} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          className={`absolute z-50 mt-2 min-w-[11rem] py-1.5 rounded-[var(--radius-md)] border ${align === "right" ? "right-0" : "left-0"}`}
          style={{
            background: "var(--glass-regular)",
            borderColor: "var(--border-hairline)",
            backdropFilter: "var(--glass-filter-regular)",
            WebkitBackdropFilter: "var(--glass-filter-regular)",
            boxShadow: "var(--shadow-e3)",
          }}
        >
          {options.map((opt) => {
            const isActive = opt.id === value;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  onChange(opt.id);
                  if (shouldCloseOnSelect ? shouldCloseOnSelect(opt.id) : true) setOpen(false);
                }}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-left transition-colors"
                style={{ color: isActive ? "var(--accent-info)" : "var(--text-secondary)" }}
              >
                {opt.label}
                {isActive && <Check size={13} className="shrink-0" />}
              </button>
            );
          })}
          {children}
        </div>
      )}
    </div>
  );
}
