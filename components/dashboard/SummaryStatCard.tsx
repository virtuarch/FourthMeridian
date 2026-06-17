import { Card, CardTitle } from "@/components/ui/Card";

export interface SummaryStatRow {
  id:              string;
  label:           string;
  value:           string;   // pre-formatted currency string
  valueClassName?: string;
  subLabel?:       string;   // e.g. "4.99% APR · $320/mo min"
}

interface Props {
  title:             string;
  value:             string;  // pre-formatted headline (compact currency)
  valueClassName?:   string;
  message:           string;
  messageClassName?: string;
  rows:              SummaryStatRow[];
  lastUpdated?:      string;
}

/**
 * Shared layout for the Cash on Hand and Debt summary cards:
 *   TITLE → PRIMARY VALUE → SHORT MESSAGE → account rows → Updated date.
 *
 * Keeping this structure in one place guarantees the two cards stay in
 * lockstep (same spacing, same row layout, same message/date placement)
 * instead of drifting via independent JSX in each card.
 */
export function SummaryStatCard({
  title, value, valueClassName = "text-white",
  message, messageClassName = "text-gray-400",
  rows, lastUpdated,
}: Props) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>

      <p className={`text-2xl font-bold mt-1 ${valueClassName}`}>{value}</p>

      <p className={`text-xs font-medium mt-1.5 ${messageClassName}`}>{message}</p>

      {rows.length > 0 && (
        <div className="flex flex-col gap-2 mt-3">
          {rows.map((r) => (
            <div key={r.id}>
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500 truncate">{r.label}</p>
                <p className={`text-xs font-semibold tabular-nums shrink-0 ml-2 ${r.valueClassName ?? "text-white"}`}>
                  {r.value}
                </p>
              </div>
              {r.subLabel && (
                <p className="text-[10px] text-gray-600 mt-0.5">{r.subLabel}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {lastUpdated && <p className="text-xs text-gray-600 mt-3">Updated {lastUpdated}</p>}
    </Card>
  );
}
