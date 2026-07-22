"use client";

/**
 * components/space/shell/PerspectiveTabs.tsx
 *
 * The Lens / Perspective selector — the prototype's LensSelector (DS-5 §5). It is
 * DELIBERATELY NOT a segmented control: each lens is its own loose, bordered chip
 * on a rule, so the row reads as "a set of questions you could ask" rather than
 * "a set of places you could go". No track, no sliding highlight, no container —
 * just independent buttons, matching the prototype 1:1.
 *
 * Kept as `PerspectiveTabs` (name + props) so both call sites — the Overview
 * summary selector and the engaged PerspectiveShell — are unchanged; only the
 * PRESENTATION moved from SegmentedControl to prototype chips. Selection state,
 * ids, and semantics are untouched. Workspace-less lenses keep the "· soon" suffix.
 */

export interface PerspectiveTabItem {
  id:           string;
  label:        string;
  hasWorkspace: boolean;
  /** Retained for API compatibility with the registry item shape; the prototype
   *  lens chips are TEXT-ONLY, so it is intentionally not rendered. */
  icon?:        string;
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
  return (
    <div
      role="radiogroup"
      aria-label="Perspectives"
      className={["no-scrollbar flex flex-wrap justify-center gap-1.5 overflow-x-auto", className].join(" ")}
    >
      {items.map((i) => {
        const on = i.id === activeId;
        const label = i.hasWorkspace ? i.label : `${i.label} · soon`;
        return (
          <button
            key={i.id}
            role="radio"
            aria-checked={on}
            onClick={() => onSelect(i.id)}
            className={[
              "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[12px]",
              "transition-[color,background-color,border-color] duration-[120ms] ease-[var(--ease-standard)]",
              on
                ? "border-[rgba(255,255,255,.22)] bg-[rgba(255,255,255,.08)] text-[var(--text-primary)]"
                : "border-[var(--border-hairline)] text-[var(--text-muted)] hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-secondary)]",
            ].join(" ")}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
