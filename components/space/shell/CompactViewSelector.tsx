"use client";

/**
 * components/space/shell/CompactViewSelector.tsx  (COMPACT DASHBOARD — P1)
 *
 * The compact (<1024px) financial-view selector: "Net Worth ▾" in the upper-left
 * of the Space header, opening Net Worth · Cash Flow · Markets. It REPLACES the
 * compact lens row (PerspectiveTabs) and writes EXACTLY the same navigation — the
 * host passes the same items and the same `selectLens` the row used, so URL and
 * history behaviour (a workspace switch is a PUSH) are unchanged.
 *
 * Desktop never sees it: its root is `lg:hidden`, and it only mounts inside
 * SpaceShell's compact header row (itself `lg:hidden`); the sidebar owns this
 * choice at ≥1024px.
 *
 * A menu button (WAI-ARIA menu pattern): aria-haspopup / aria-expanded; the menu
 * is role="menu" of menuitemradio items with aria-checked; ArrowUp/Down, Home/End
 * move focus; Enter/Space selects; Escape and an outside press close it and
 * return focus to the button. Presentation only — no fetch, no URL access.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface CompactViewItem {
  id: string;
  label: string;
  /** False for a destination that renders "Coming soon" (Markets today). */
  hasWorkspace: boolean;
}

export const COMPACT_VIEW_MENU_LABEL = "Financial view";
export const COMPACT_VIEW_SOON = "Coming soon";

export function CompactViewSelector({ items, activeId, onSelect }: {
  items: CompactViewItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const active = items.find((i) => i.id === activeId) ?? items[0];

  const focusItem = (index: number) => {
    const els = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    if (!els || els.length === 0) return;
    els[(index + els.length) % els.length]?.focus();
  };

  // Opening moves focus to the checked item; an outside press closes the menu.
  useEffect(() => {
    if (!open) return;
    focusItem(Math.max(0, items.findIndex((i) => i.id === active?.id)));
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once per opening
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const els = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const at = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(els.length - 1); }
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div ref={root} className="relative lg:hidden" data-compact-view-selector>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${COMPACT_VIEW_MENU_LABEL}: ${active?.label ?? ""}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}
        className="-ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-sm)] px-1 text-[22px] font-semibold tracking-tight text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)] touch-manipulation"
      >
        {active?.label}
        <ChevronDown size={18} aria-hidden className={`mt-0.5 text-[var(--text-muted)] transition-transform duration-[120ms] ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={COMPACT_VIEW_MENU_LABEL}
          onKeyDown={onMenuKey}
          className="absolute left-0 top-full z-30 mt-1 min-w-[220px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-hairline-strong)] bg-[var(--bg-deep)] p-1 shadow-[var(--shadow-e3)]"
        >
          {items.map((i) => {
            const on = i.id === active?.id;
            return (
              <li key={i.id} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => { close(true); onSelect(i.id); }}
                  className={[
                    "flex min-h-11 w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] px-3 text-left text-[15px] transition-colors focus-visible:outline-none focus-visible:bg-[var(--surface-hover-strong)] hover:bg-[var(--surface-hover)]",
                    on ? "font-medium text-[var(--text-primary)]" : "text-[var(--text-secondary)]",
                  ].join(" ")}
                >
                  <span className="flex flex-col">
                    <span>{i.label}</span>
                    {!i.hasWorkspace && <span className="text-[11px] text-[var(--text-faint)]">{COMPACT_VIEW_SOON}</span>}
                  </span>
                  {on && <Check size={15} aria-hidden className="text-[var(--accent-info)]" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
