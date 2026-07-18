"use client";

/**
 * components/atlas/Dropdown.tsx
 *
 * A compact anchored dropdown (the prototype CurrencyPicker pattern) for a
 * secondary switcher that shouldn't spend a whole rail of horizontal space — the
 * current option as a quiet button, options in a small solid-glass popover.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export function Dropdown<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-[var(--glass-ultrathin)] px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-primary)]"
      >
        {current?.label ?? value}
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={["text-[var(--text-muted)] transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)]", open ? "rotate-180" : ""].join(" ")}
        />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-1.5 min-w-[11rem] origin-top-right rounded-[var(--radius-md)] p-1 shadow-[var(--shadow-e3)]"
          style={{
            background: "var(--glass-thick)",
            border: "1px solid var(--border-hairline-strong)",
            backdropFilter: "blur(48px) saturate(150%)",
            WebkitBackdropFilter: "blur(48px) saturate(150%)",
          }}
        >
          <ul role="listbox" aria-label={ariaLabel}>
            {options.map((o) => {
              const on = o.id === value;
              return (
                <li key={o.id}>
                  <button
                    role="option"
                    aria-selected={on}
                    onClick={() => {
                      onChange(o.id);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-[var(--surface-hover)]"
                  >
                    <span className={["flex-1 text-[13px]", on ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"].join(" ")}>
                      {o.label}
                    </span>
                    {on && <Check size={13} strokeWidth={2.25} className="text-[var(--meridian-400)]" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
