"use client";

/**
 * MoreMenu
 *
 * Compact "More ⌄" trigger for the far right of the Personal Space rail —
 * consolidates the data-tabs that don't need a standalone pill anymore
 * (Accounts, Transactions, Members, Documents) into one dropdown, the same
 * way the earlier IA refactor folded Investments/Debt/Goals behind
 * Perspective cards instead of giving every real feature its own rail
 * button forever. Pure navigation: each item just calls the host's
 * existing tab-change handler — no new routing/state, no business logic.
 *
 * Visual recipe mirrors PerspectiveSwitcher (glass capsule trigger + glass
 * panel menu, click-outside/Escape to close) but kept as its own component
 * rather than a PerspectiveSwitcher variant: these are plain navigation
 * links with no "active selection" concept, so there's no Check icon, no
 * status badge, no description copy — just an icon + label per row.
 *
 * Overlay positioning: the open menu is a plain `position: absolute` <div>
 * wrapping the glass panel, rather than putting `absolute` directly on the
 * GlassPanel's own className. GlassPanel always force-prepends "relative"
 * to whatever className it's given (see components/atlas/GlassPanel.tsx),
 * which collided with a consumer-supplied "absolute" and left the menu
 * rendering in-flow — i.e. it pushed the rail's height and shoved the KPI
 * cards below it down the page instead of floating above them. Wrapping
 * the positioning in a plain div sidesteps that clash entirely (same
 * convention GlassModal.tsx already uses: position on a plain wrapper,
 * GlassPanel itself stays purely visual).
 *
 * Trigger layout: label + chevron are wrapped in their own inner flex div
 * rather than relying on `className="flex ..."` passed straight to
 * GlassPanel. GlassPanel renders children one level deeper, inside its own
 * `<div className="relative z-10">` — so a flex className on GlassPanel
 * itself only ever has one child to lay out (that wrapper), not the actual
 * label/chevron, and `gap`/`items-center` silently do nothing. Nesting our
 * own flex div fixes alignment without touching the shared primitive.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";

export interface MoreMenuItem<T extends string = string> {
  id: T;
  label: string;
  icon: React.ElementType;
}

export function MoreMenu<T extends string>({
  items,
  onSelect,
  label = "More",
  align = "right",
  className = "",
}: {
  items: MoreMenuItem<T>[];
  onSelect: (id: T) => void;
  label?: string;
  /** Which edge of the trigger the open menu anchors to. Defaults to
   *  "right" since this control's only current placement is the far right
   *  of the rail — anchoring left there would overhang the viewport. */
  align?: "left" | "right";
  /** Extra classes for the root wrapper (e.g. "ml-auto" to push the whole
   *  control to the far right of a flex rail). */
  className?: string;
}) {
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

  // Nothing to consolidate (e.g. a future Space type with none of these
  // tabs) — render nothing rather than an empty menu.
  if (items.length === 0) return null;

  return (
    <div ref={rootRef} className={["relative inline-block shrink-0", className].filter(Boolean).join(" ")}>
      {/* py-[14px] (not py-2) matches the Overview pill's effective height —
          see the identical note in PerspectiveSwitcher.tsx. */}
      <GlassPanel
        as="button"
        type="button"
        depth="thin"
        radius="full"
        elevation="e1"
        interactive
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} navigation`}
        className="px-3.5 py-[14px] text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <span>{label}</span>
          <ChevronDown
            className={`w-3.5 h-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          />
        </span>
      </GlassPanel>

      {open && (
        <div className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full mt-2 w-56 z-50`}>
          <GlassPanel
            as="div"
            role="menu"
            aria-label={`${label} menu`}
            depth="regular"
            radius="md"
            elevation="e3"
            className="py-1.5"
          >
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect(item.id);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors rounded-[var(--radius-sm)] hover:bg-[var(--surface-hover)]"
                >
                  <Icon size={14} className="text-[var(--meridian-400)] shrink-0" />
                  <span className="text-sm font-medium text-[var(--text-secondary)]">{item.label}</span>
                </button>
              );
            })}
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
