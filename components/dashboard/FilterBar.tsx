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
              ? "bg-blue-600 border-blue-600 text-white"
              : "bg-transparent border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
