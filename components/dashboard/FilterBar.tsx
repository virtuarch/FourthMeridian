"use client";

export type FilterSlice =
  | "all"
  | "cash"
  | "banking"
  | "investments"
  | "credit";

export const FILTERS: { key: FilterSlice; label: string }[] = [
  { key: "all",         label: "All"         },
  { key: "cash",        label: "Cash"        },
  { key: "banking",     label: "Banking"     },
  { key: "investments", label: "Investments" },
  { key: "credit",      label: "Credit"      },
];

interface Props {
  active: FilterSlice;
  onChange: (f: FilterSlice) => void;
}

export function FilterBar({ active, onChange }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1">
      {FILTERS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`shrink-0 px-4 py-2.5 rounded-full text-xs font-semibold border transition-all touch-manipulation ${
            active === key
              ? "bg-[var(--accent-info)] border-[var(--accent-info)] text-white"
              : "bg-transparent border-[var(--border-hairline-strong)] text-[var(--text-secondary)] hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-primary)]"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
