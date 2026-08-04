"use client";

/**
 * components/space/widgets/investments/InvestmentsActivityCard.tsx
 *
 * Thin renderer over `buildActivityGroups` (the pure model). Shows the period's
 * intent-grouped flows as deterministic template sentences — money in, money
 * out, and inside-the-portfolio — plus one caveat line built from the honesty
 * counters. The no-comparison and no-events states come straight from the model
 * (honest copy, never a fabricated window). This card holds no state and does no
 * arithmetic; every number and sentence is the model's.
 */

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Repeat, ChevronRight } from "lucide-react";
import type { PeriodFlows } from "@/lib/investments/investment-flows-core";
import { formatCurrencyExact } from "@/lib/format";
import {
  buildActivityGroups, UNATTRIBUTED_LABEL,
  type ActivityGroupKey, type ActivitySection,
} from "./investments-activity";

/**
 * One enumerable section: the heading states the count and subtotal the model
 * derived, and the disclosure lists the exact rows that produced them.
 *
 * This component performs NO arithmetic and NO filtering — every number and
 * every row is the model's. It formats and lays out.
 */
function ActivitySectionRows({ section, currency }: { section: ActivitySection; currency: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md" style={{ background: "var(--surface-inset)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]"
      >
        <ChevronRight
          size={13}
          aria-hidden
          className="shrink-0 transition-transform"
          style={{ color: "var(--text-faint)", transform: open ? "rotate(90deg)" : undefined }}
        />
        <span className="min-w-0 flex-1 text-xs" style={{ color: "var(--text-secondary)" }}>
          {section.title} · {section.count}
        </span>
        {section.amount != null && (
          <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--text-secondary)" }}>
            {formatCurrencyExact(section.amount, currency)}
          </span>
        )}
      </button>

      {open && (
        <ul className="px-2.5 pb-2">
          {section.rows.map((r, i) => (
            <li
              key={`${r.dateISO}-${r.label}-${i}`}
              className="flex items-baseline gap-2 py-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              <span className="shrink-0 tabular-nums">{r.dateISO}</span>
              <span
                className="min-w-0 flex-1 truncate"
                style={{ color: r.attributed ? "var(--text-secondary)" : "var(--text-faint)" }}
                title={r.attributed ? undefined : "The provider gave no security identity for this event."}
              >
                {r.label}
                {!r.attributed && <span className="sr-only"> — {UNATTRIBUTED_LABEL}</span>}
              </span>
              {r.quantity != null && r.quantity !== 0 && (
                <span className="shrink-0 tabular-nums">{r.quantity}</span>
              )}
              {r.amount != null && (
                <span className="shrink-0 tabular-nums">{formatCurrencyExact(r.amount, currency)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const GROUP_ICON: Record<ActivityGroupKey, typeof ArrowDownLeft> = {
  money_in:  ArrowDownLeft,
  money_out: ArrowUpRight,
  inside:    Repeat,
};

export function InvestmentsActivityCard({ flows }: { flows: PeriodFlows | null }) {
  const model = buildActivityGroups(flows);
  const currency = flows?.reportingCurrency ?? "USD";

  if (model.state !== "events") {
    return <p className="text-sm py-4" style={{ color: "var(--text-muted)" }}>{model.message}</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {model.groups.map((g) => {
        const Icon = GROUP_ICON[g.key];
        return (
          <div key={g.key} className="flex items-start gap-2.5">
            <Icon size={15} className="shrink-0 mt-0.5" style={{ color: "var(--text-secondary)" }} aria-hidden />
            <p className="text-sm min-w-0" style={{ color: "var(--text-primary)" }}>{g.sentence}</p>
          </div>
        );
      })}

      {/* THE EVIDENCE. Each section's count and subtotal are computed FROM these
          rows by the pure model, so a heading and its list cannot disagree.
          Collapsed by default — a card is a summary, and the rows are there for
          the reader who asks. */}
      {model.sections.length > 0 && (
        <div className="mt-1 flex flex-col gap-1">
          {model.sections.map((s) => (
            <ActivitySectionRows key={s.key} section={s} currency={currency} />
          ))}
        </div>
      )}
      {model.caveat && (
        <p className="text-xs mt-1 pt-2 border-t" style={{ color: "var(--text-muted)", borderColor: "var(--border-hairline)" }}>
          {model.caveat}
        </p>
      )}
    </div>
  );
}
