"use client";

/**
 * PerspectiveSwitcher
 *
 * The dashboard-composition switcher from the IA refactor's point 2/3 — a
 * compact "Perspective ⌄" dropdown atop the Overview tab, sitting right
 * after the Overview pill in the rail. Fed by lib/perspectives.ts's
 * getCompositionSwitcherItems(), which scopes this to the default
 * "overview" lens plus any other still-comingSoon "Financial"-group lens
 * (Wealth, Cash Flow) — Investments/Debt/Goals/Retirement stay
 * Perspective-*card* modal launchers (point 5) instead, so there's exactly
 * one navigation path to each feature, not two competing ones.
 *
 * Rail/dropdown polish pass:
 *  - The trigger now always reads the static "Perspective" — not the
 *    active item's own label (previously "Atlas", "Wealth", etc). The
 *    control's identity is "this is the Perspective selector", not "this
 *    is currently set to X"; the active row is still marked with a Check
 *    inside the open menu. Trigger icon is likewise a fixed glyph (Compass)
 *    rather than swapping per selection.
 *  - Selecting an item is placeholder-only: it still calls onChange (so the
 *    host's `composition` state updates and the open row's Check mark
 *    moves), but the host currently keeps COMPOSITION_SWITCHING_ENABLED
 *    false (see DashboardClient.tsx), so the Overview body never actually
 *    swaps yet. This component doesn't know or care about that — it just
 *    reports selection, same as before.
 *  - The open menu is a plain `position: absolute` <div> wrapping the glass
 *    panel, instead of `absolute` living directly on the GlassPanel's own
 *    className. GlassPanel always force-prepends "relative" to whatever
 *    className it's given (components/atlas/GlassPanel.tsx), which
 *    collided with a consumer-supplied "absolute" and left the menu
 *    rendering in-flow — pushing the rail's height and shoving the KPI
 *    cards below it down the page instead of floating above them. A plain
 *    wrapper div sidesteps the clash (same convention GlassModal.tsx
 *    already uses).
 *  - Trigger content (icon + text + chevron) is wrapped in its own inner
 *    flex div rather than relying on a flex className passed straight to
 *    GlassPanel. GlassPanel renders children one level deeper inside its
 *    own `<div className="relative z-10">`, so a flex className on
 *    GlassPanel itself only ever has one child to lay out — `gap`/
 *    `items-center` silently did nothing, which is what made the icon and
 *    text look misaligned. Nesting our own flex div fixes that without
 *    touching the shared primitive.
 *
 * Visual shape otherwise mirrors components/atlas/InlineFilter.tsx's
 * mobile popover (compact glass trigger + glass menu, Check icon on the
 * active row) — same primitives, same interaction.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Compass, Gem, Waves } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { PerspectiveDef } from "@/lib/perspectives";

/** Icons for the lenses getCompositionSwitcherItems() can ever return. */
export const COMPOSITION_ICON_MAP: Record<string, React.ElementType> = {
  Compass, Gem, Waves,
};

export function PerspectiveSwitcher({
  items,
  value,
  onChange,
}: {
  items: PerspectiveDef[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = items.find((i) => i.id === value) ?? items[0];

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

  // Nothing to switch between yet (a category with no comingSoon Financial
  // lens) — render nothing rather than a dropdown with one disabled item.
  if (items.length <= 1 || !active) return null;

  return (
    <div ref={rootRef} className="relative inline-block shrink-0">
      {/* py-[14px] (not py-2) is a deliberate height match: SegmentedControl's
          Overview pill gets its height from its own button (py-2) *plus*
          the track's p-1.5 wrapper, which this standalone trigger doesn't
          have — py-[14px] = py-2 + that missing p-1.5 so both pills render
          at the same ~46px height in the rail. */}
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
        aria-label="Switch dashboard perspective"
        className="px-3.5 py-[14px]"
      >
        <span className="flex items-center gap-1.5">
          <Compass size={13} className="text-[var(--meridian-400)] shrink-0" />
          <span className="text-xs font-semibold text-[var(--text-primary)]">Perspective</span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          />
        </span>
      </GlassPanel>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-64 z-50">
          <GlassPanel
            as="div"
            role="menu"
            aria-label="Dashboard perspectives"
            depth="regular"
            radius="md"
            elevation="e3"
            className="py-1.5"
          >
            {items.map((item) => {
              const Icon = COMPOSITION_ICON_MAP[item.icon] ?? Compass;
              const isActive = item.id === value;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => { onChange(item.id); setOpen(false); }}
                  className={[
                    "w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors rounded-[var(--radius-sm)]",
                    isActive ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-hover)]",
                  ].join(" ")}
                >
                  <Icon size={14} className="text-[var(--meridian-400)] mt-0.5 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className={`text-sm font-medium ${isActive ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                        {item.label}
                      </span>
                      {item.status === "comingSoon" && (
                        <span className="text-[9px] font-medium uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-full px-1.5 py-0.5 shrink-0">
                          Soon
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-[var(--text-muted)] mt-0.5 line-clamp-1">{item.description}</span>
                  </span>
                  {isActive && <Check size={14} className="text-[var(--meridian-400)] mt-0.5 shrink-0" />}
                </button>
              );
            })}
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
