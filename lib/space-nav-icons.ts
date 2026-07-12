/**
 * lib/space-nav-icons.ts
 *
 * Single source of truth for the Space RAIL tabs' Lucide icons (SHELL_NAV
 * Phase 2 §2.2). Sibling to lib/perspective-icons.ts — kept SEPARATE because
 * the rail (sections of a Space) and Perspectives (lenses onto its data) are
 * different concepts (see lib/perspectives.ts's own doc comment). Same
 * ICON_MAP + safe-fallback shape already used by lib/perspective-icons.ts and
 * TimelineWidget.tsx — not a third, different resolver.
 *
 * Where a rail section names the same idea as a Perspective, it reuses that
 * Perspective's glyph so the two nav surfaces stay visually consistent:
 * OVERVIEW→Compass (perspectives "overview"), ACCOUNTS→Landmark, ACTIVITY→
 * Activity (both already used in TimelineWidget's map). The rest are chosen
 * for the section they name.
 *
 * The `satisfies Record<SpaceTabId, ElementType>` clause is a COMPILE-TIME
 * completeness guard: every SpaceTabId must have an icon, or this file fails to
 * type-check (stop condition #2 — no rail tab ships silently iconless). A
 * runtime completeness test mirrors it in lib/space-nav-icons.test.ts.
 *
 * Client-safe: pure config + type-only React import, no engine/server code.
 */

import type { ElementType } from "react";
import {
  Compass, Layers, Activity, Wallet, Landmark, ArrowLeftRight, Users, FileText,
  Settings, LayoutGrid,
} from "lucide-react";
import type { SpaceTabId } from "@/lib/space-nav";

export const SPACE_TAB_ICON_MAP: Record<string, ElementType> = {
  OVERVIEW:     Compass,        // matches lib/perspectives.ts "overview" → Compass
  PERSPECTIVES: Layers,         // "lenses onto the same data" reads as layered views
  ACTIVITY:     Activity,       // matches TimelineWidget's ICON_MAP
  FINANCES:     Wallet,         // placeholder section, but never iconless
  ACCOUNTS:     Landmark,       // institution/accounts glyph (also in TimelineWidget)
  TRANSACTIONS: ArrowLeftRight, // money movement in/out
  MEMBERS:      Users,          // people in the Space
  DOCUMENTS:    FileText,       // placeholder section, but never iconless
  SETTINGS:     Settings,       // (filtered out of the rendered rail, still mapped)
} satisfies Record<SpaceTabId, ElementType>;

/**
 * Neutral fallback for an unknown/unmapped tab id. Should never fire — the
 * compile-time `satisfies` above and the runtime completeness test guarantee
 * every SpaceTabId is mapped — but a caller passing an off-list id gets a calm
 * generic glyph rather than nothing. Callers resolve with member access:
 *
 *   const Icon = SPACE_TAB_ICON_MAP[id] ?? SPACE_TAB_ICON_FALLBACK;
 */
export const SPACE_TAB_ICON_FALLBACK: ElementType = LayoutGrid;
