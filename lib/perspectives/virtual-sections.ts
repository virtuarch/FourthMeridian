/**
 * lib/perspectives/virtual-sections.ts
 *
 * UX-PER-3 — Perspective Workspace Renderer.
 *
 * Pure mapping: a Perspective's `widgets[]` → VIRTUAL, render-only section
 * objects that are fed through the EXISTING SectionCard / SectionRegistry
 * compositor (no second widget renderer, no new layout model).
 *
 * "Virtual" = not backed by a SpaceDashboardSection DB row:
 *  - ids are prefixed `virtual:` so they can never be mistaken for a real
 *    section id and must never reach a mutation endpoint (reorder / toggle).
 *  - `tab` is a sentinel — the workspace never dispatches on tab.
 *  - no persistence, no drag/drop, no reorder in this slice.
 *
 * The returned shape is structurally the `DashboardSection` the SectionCard
 * consumes ({ id, key, label, tab, enabled, order, config }).
 */

import { getWidgetMeta } from "@/lib/widget-registry";

/** Prefix that marks a section id as virtual (render-only, never persisted). */
export const VIRTUAL_SECTION_PREFIX = "virtual:";

/** Sentinel tab value for virtual sections — the workspace never reads it. */
export const VIRTUAL_SECTION_TAB = "PERSPECTIVE";

export interface VirtualSection {
  id: string;
  key: string;
  label: string;
  tab: string;
  enabled: boolean;
  order: number;
  config: Record<string, unknown> | null;
}

/** True if a section id is a virtual (render-only) id. Mutation paths can use
 *  this to hard-refuse virtual ids. */
export function isVirtualSectionId(id: string): boolean {
  return id.startsWith(VIRTUAL_SECTION_PREFIX);
}

/**
 * Synthesize virtual sections for a Perspective's widget keys, in order.
 * Pure and synchronous; labels come from WIDGET_REGISTRY (falls back to the
 * key). Caller feeds the result straight into SectionCard.
 */
export function toVirtualSections(
  perspectiveId: string,
  widgets: readonly string[],
): VirtualSection[] {
  return widgets.map((key, i) => ({
    id:      `${VIRTUAL_SECTION_PREFIX}${perspectiveId}:${key}`,
    key,
    label:   getWidgetMeta(key)?.label ?? key,
    tab:     VIRTUAL_SECTION_TAB,
    enabled: true,
    order:   i,
    config:  null,
  }));
}
