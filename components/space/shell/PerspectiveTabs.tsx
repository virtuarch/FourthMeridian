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
import { PERSPECTIVE_ICON_MAP, PERSPECTIVE_ICON_FALLBACK } from "@/lib/perspective-icons";

export interface PerspectiveTabItem {
  id:           string;
  label:        string;
  hasWorkspace: boolean;
  /** Lucide icon NAME (from PerspectiveDef.icon), resolved to a node here via
   *  lib/perspective-icons. Optional so callers that don't want icons omit it. */
  icon?:        string;
}

/**
 * Resolve a PerspectiveDef.icon NAME to its Lucide component and render it at
 * the tab scale — same shape as TimelineWidget's EventIcon (a static top-level
 * component, so the icon type is never "created during render"). Decorative:
 * the tab's visible label is its accessible name, so the glyph is aria-hidden.
 */
function TabIcon({ name }: { name: string }) {
  const Icon = PERSPECTIVE_ICON_MAP[name] ?? PERSPECTIVE_ICON_FALLBACK;
  return <Icon size={14} aria-hidden />;
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
    icon:  i.icon ? <TabIcon name={i.icon} /> : undefined,
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
