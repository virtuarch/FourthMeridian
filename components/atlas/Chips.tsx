"use client";

/**
 * components/atlas/Chips.tsx
 *
 * The prototype's loose-chip control — the SAME independent, bordered buttons the
 * Perspective/Lens selector uses (components/space/shell/PerspectiveTabs.tsx),
 * extracted so any secondary switcher can adopt that language instead of a
 * segmented track. A set of options you could pick, not a rail you travel.
 *
 * Deliberately NOT a SegmentedControl: no track, no sliding highlight, no
 * container — just chips whose colour/background/border fade on selection (120ms
 * ease-standard). Real radiogroup semantics.
 */

export function Chips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = "",
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={["no-scrollbar flex flex-wrap gap-1.5 overflow-x-auto", className].join(" ")}
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={[
              "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[12px]",
              "transition-[color,background-color,border-color] duration-[120ms] ease-[var(--ease-standard)]",
              on
                ? "border-[rgba(255,255,255,.22)] bg-[rgba(255,255,255,.08)] text-[var(--text-primary)]"
                : "border-[var(--border-hairline)] text-[var(--text-muted)] hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-secondary)]",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
