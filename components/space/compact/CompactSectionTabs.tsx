"use client";

/**
 * components/space/compact/CompactSectionTabs.tsx  (COMPACT DASHBOARD — P2/P3)
 *
 * The compact (<1024px) contextual category tabs — Assets (All · Cash ·
 * Investments) and Debt (All · Credit · Loans). A touch-friendly segmented row;
 * desktop never renders it (root `lg:hidden`), where every section shows as today.
 *
 * WAI-ARIA tabs: role="tablist" of role="tab" buttons with aria-selected and a
 * roving tabindex (only the selected tab is in the Tab order); ArrowLeft/Right,
 * Home/End move between tabs and select (automatic activation). Each tab names
 * the section ids it reveals in aria-controls. The sections it hides are
 * `max-lg:hidden` (display:none), so on compact they are neither focusable nor
 * exposed to assistive technology; at ≥1024px nothing is hidden.
 *
 * Presentation only: the host owns the value (URL-backed) and the change handler.
 */

import { useRef, type KeyboardEvent } from "react";

export interface CompactSectionTab<T extends string> {
  id: T;
  label: string;
  /** Section element ids this tab reveals (aria-controls). */
  controls: string[];
}

export function CompactSectionTabs<T extends string>({ tabs, value, onChange, ariaLabel, variant = "secondary" }: {
  tabs: CompactSectionTab<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  /**
   * v2.7 P0 — "primary" is the prominent page-level selector (Net Worth:
   * Total · Assets · Debt); "secondary" the quieter category row beneath it
   * (Assets: All · Cash · Investments), so the two levels never look alike.
   */
  variant?: "primary" | "secondary";
}) {
  const primary = variant === "primary";
  const list = useRef<HTMLDivElement>(null);
  const select = (index: number) => {
    const t = tabs[(index + tabs.length) % tabs.length];
    onChange(t.id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[(index + tabs.length) % tabs.length]?.focus();
  };
  const at = Math.max(0, tabs.findIndex((t) => t.id === value));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") { e.preventDefault(); select(at + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); select(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); select(0); }
    else if (e.key === "End") { e.preventDefault(); select(tabs.length - 1); }
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      data-compact-section-tabs
      data-variant={variant}
      className={primary
        ? "lg:hidden grid gap-1 rounded-[var(--radius-lg)] border border-[var(--border-hairline-strong)] bg-[var(--surface-inset)] p-1 shadow-[var(--shadow-e1)]"
        : "lg:hidden grid gap-1 rounded-full p-0.5"}
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={t.controls.join(" ") || undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={[
              primary
                ? "min-h-11 truncate rounded-[var(--radius-sm)] px-2 text-[15px] font-semibold touch-manipulation"
                : "min-h-10 truncate rounded-full border px-2 text-[12px] font-medium touch-manipulation",
              "transition-[color,background-color,border-color] duration-[120ms] ease-[var(--ease-standard)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]",
              primary
                ? (on ? "bg-[rgba(255,255,255,.12)] text-[var(--text-primary)] shadow-[var(--shadow-e1)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]")
                : (on ? "border-[rgba(255,255,255,.22)] bg-[rgba(255,255,255,.08)] text-[var(--text-primary)]" : "border-[var(--border-hairline)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"),
            ].join(" ")}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** The class that hides a section on compact only (never at ≥1024px). */
export const compactHidden = (hidden: boolean): string => (hidden ? "max-lg:hidden" : "");
