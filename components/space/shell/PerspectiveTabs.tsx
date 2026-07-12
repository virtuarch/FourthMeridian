"use client";

/**
 * components/space/shell/PerspectiveTabs.tsx
 *
 * Perspective shell — Container 2 ("the lens"). The six lenses as ONE
 * SegmentedControl track, so the shell has a single active-state grammar (the
 * Meridian-glass sliding highlight) across presets and tabs. The track scrolls
 * horizontally on narrow widths (SegmentedControl's built-in overflow) — never a
 * <select>, never a sidebar. Workspace-less lenses keep the "· soon" suffix.
 *
 * Extracted from the former inline PerspectiveTabSelector; role=tablist and
 * aria-selected come from SegmentedControl. (Roving arrow-key nav is not provided
 * by the shared control; every tab stays Tab-focusable and clickable.)
 */

import { SegmentedControl } from "@/components/atlas/SegmentedControl";

export interface PerspectiveTabItem {
  id:           string;
  label:        string;
  hasWorkspace: boolean;
}

export function PerspectiveTabs({
  items,
  activeId,
  onSelect,
  className = "",
}: {
  items:     PerspectiveTabItem[];
  activeId:  string | null;
  onSelect:  (id: string) => void;
  className?: string;
}) {
  const options = items.map((i) => ({
    id:    i.id,
    label: i.hasWorkspace ? i.label : `${i.label} · soon`,
  }));

  return (
    <SegmentedControl
      aria-label="Perspectives"
      className={["max-w-full", className].join(" ")}
      options={options}
      value={activeId ?? ""}
      onChange={onSelect}
    />
  );
}
