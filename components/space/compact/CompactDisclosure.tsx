"use client";

/**
 * components/space/compact/CompactDisclosure.tsx  (v2.7 R4 — compact cockpit)
 *
 * The compact (<1024px) disclosure toggle: a real <button type="button"> with
 * aria-expanded + aria-controls, a ≥40px touch target and a visible focus ring.
 * Its className literal carries `lg:hidden`, so it never renders at ≥1024px
 * (desktop-markup.ts drops the whole subtree). The content it controls is
 * hidden on compact only (`max-lg:hidden`) while collapsed — at ≥1024px that
 * content renders exactly as before, whatever the toggle state.
 *
 * Presentation only: the caller owns `open`.
 */

import { ChevronDown } from "lucide-react";

export function CompactDisclosureButton({
  open,
  onToggle,
  controls,
  label,
  openLabel,
}: {
  open: boolean;
  onToggle: () => void;
  /** The id of the element this toggle reveals (aria-controls). */
  controls: string;
  /** Collapsed text ("Show", "Details", "Show all 9"). */
  label: string;
  /** Expanded text (defaults to "Hide"). */
  openLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      data-compact-disclosure
      className="lg:hidden inline-flex min-h-10 min-w-10 shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 text-[12px] font-medium text-[var(--meridian-400)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
    >
      {open ? (openLabel ?? "Hide") : label}
      <ChevronDown size={14} aria-hidden className={open ? "rotate-180 transition-transform" : "transition-transform"} />
    </button>
  );
}
