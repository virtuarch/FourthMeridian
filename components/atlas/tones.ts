/**
 * components/atlas/tones.ts
 *
 * Single source of truth for how `BriefTone` (and a few category ids)
 * map to Fourth Meridian Design Language v1 colors.
 *
 * Locked global semantics (do not repurpose for unrelated categories):
 *   Net worth         → ink / white
 *   Positive change    → emerald
 *   Negative change     → coral
 *   Cash                → meridian
 *   Investments         → brass
 *   Debt / liabilities  → coral
 *   Goals               → violet
 *   AI                  → meridian blended with brass
 *
 * `BriefTone` is a *severity* axis (how urgent/positive is this line item),
 * not a data category. Per the redesign directive, warning and danger both
 * live in the coral family — warning is the restrained/lighter tint, danger
 * is the fully saturated one — so "caution" never borrows a category color
 * (brass/violet/meridian) that would teach the user the wrong association.
 */

import type { BriefTone } from "@/lib/brief-types";

export const TONE_TEXT: Record<BriefTone, string> = {
  positive: "text-[var(--emerald-400)]",
  warning:  "text-[var(--coral-300)]",
  danger:   "text-[var(--coral-400)]",
  info:     "text-[var(--meridian-400)]",
  neutral:  "text-[var(--text-secondary)]",
};

export const TONE_VALUE: Record<BriefTone, string> = {
  positive: "text-[var(--emerald-400)] font-semibold",
  warning:  "text-[var(--coral-300)] font-semibold",
  danger:   "text-[var(--coral-400)] font-semibold",
  info:     "text-[var(--meridian-400)] font-semibold",
  neutral:  "text-[var(--text-primary)] font-semibold",
};

export const TONE_BORDER_L: Record<BriefTone, string> = {
  positive: "border-l-[var(--emerald-500)]/50",
  warning:  "border-l-[var(--coral-400)]/40",
  danger:   "border-l-[var(--coral-600)]/60",
  info:     "border-l-[var(--meridian-500)]/50",
  neutral:  "border-l-[var(--border-hairline-strong)]",
};

export const TONE_CHIP_BG: Record<BriefTone, string> = {
  positive: "bg-[var(--emerald-500)]/10 border-[var(--emerald-500)]/20",
  warning:  "bg-[var(--coral-400)]/[0.08] border-[var(--coral-400)]/20",
  danger:   "bg-[var(--coral-600)]/[0.14] border-[var(--coral-600)]/30",
  info:     "bg-[var(--meridian-500)]/10 border-[var(--meridian-500)]/20",
  neutral:  "bg-[var(--surface-muted)] border-[var(--border-hairline)]",
};

export const TONE_ICON: Record<BriefTone, string> = {
  positive: "text-[var(--emerald-400)]",
  warning:  "text-[var(--coral-300)]",
  danger:   "text-[var(--coral-400)]",
  info:     "text-[var(--meridian-400)]",
  neutral:  "text-[var(--text-muted)]",
};

/**
 * Category accent — used only for icon/chip identity (e.g. "this row is a
 * goal"), never for the value text itself. The value's color always follows
 * TONE_VALUE so a negative number reads as coral regardless of category.
 */
export type BriefCategory = "netWorth" | "cash" | "goal" | "pending" | "generic";

export function categoryFromItemId(id: string): BriefCategory {
  if (id.startsWith("nw"))      return "netWorth";
  if (id.startsWith("account")) return "cash";
  if (id.startsWith("goal"))    return "goal";
  if (id.startsWith("pending")) return "pending";
  return "generic";
}

export const CATEGORY_ICON: Record<BriefCategory, string> = {
  netWorth: "text-[var(--text-primary)]",
  cash:     "text-[var(--meridian-400)]",
  goal:     "text-[var(--violet-400)]",
  pending:  "text-[var(--meridian-300)]",
  generic:  "text-[var(--text-muted)]",
};

/** Background + border for the circular icon chip behind a category icon. */
export const CATEGORY_CHIP_BG: Record<BriefCategory, string> = {
  netWorth: "bg-[var(--surface-muted)] border-[var(--border-hairline-strong)]",
  cash:     "bg-[var(--meridian-500)]/10 border-[var(--meridian-500)]/20",
  goal:     "bg-[var(--violet-500)]/10 border-[var(--violet-500)]/20",
  pending:  "bg-[var(--meridian-400)]/[0.08] border-[var(--meridian-400)]/15",
  generic:  "bg-[var(--surface-muted)] border-[var(--border-hairline)]",
};
