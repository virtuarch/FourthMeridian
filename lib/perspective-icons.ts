/**
 * lib/perspective-icons.ts
 *
 * Single source of truth for turning a `PerspectiveDef.icon` string (a Lucide
 * icon NAME, per the convention documented in lib/perspectives.ts) into a real
 * Lucide component. Follows the established icon-name-string → component shape
 * used by TimelineWidget.tsx's local ICON_MAP, but is shared because more than
 * one component now resolves the SAME set of perspective icons:
 *
 *   - components/dashboard/widgets/PerspectivesWidget.tsx (the Overview row +
 *     full Perspectives grid cards), and
 *   - components/space/shell/PerspectiveTabs.tsx (the shell's lens tab track).
 *
 * Extracting it here keeps a single mapping (Wealth→Gem, Cash Flow→Waves, …)
 * instead of drifting duplicates — see the SHELL_NAV plan §2.1's "reuse that
 * resolver rather than writing a third one."
 *
 * Client-safe: pure config + type-only React import, no engine/server code.
 */

import type { ElementType } from "react";
import {
  Gem, Waves, TrendingUp, CreditCard, PiggyBank, Target, FileText, Home,
  Briefcase, Compass, Droplets, Sparkles,
} from "lucide-react";

// Compass (the "overview"/Atlas lens) is included for completeness, even
// though in practice items resolved here should already have "overview"
// filtered out — see lib/perspectives.ts's doc comment on that id never being
// rendered as a card/tab. Keeping it mapped avoids a silent Sparkles fallback
// if a caller ever forgets that filter.
export const PERSPECTIVE_ICON_MAP: Record<string, ElementType> = {
  Gem, Waves, TrendingUp, CreditCard, PiggyBank, Target, FileText, Home, Briefcase, Compass, Droplets,
};

/**
 * Neutral fallback for an unknown/empty icon name — the same one
 * PerspectivesWidget used before this was extracted, so behavior is preserved
 * exactly. Callers resolve with member access + this fallback:
 *
 *   const Icon = PERSPECTIVE_ICON_MAP[name] ?? PERSPECTIVE_ICON_FALLBACK;
 *
 * (A member-access lookup, not a function call, keeps the React static-component
 * lint rule satisfied — a call returning a component reads as "created during
 * render," a map lookup does not.)
 */
export const PERSPECTIVE_ICON_FALLBACK: ElementType = Sparkles;
