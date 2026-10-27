"use client";

/**
 * components/space/widgets/liquidity/CashDistribution.tsx   (v2.7 — Cash accounts)
 *
 * Section ④ of the Cash slice — WHERE the cash is held, as a donut in the Net
 * Worth composition idiom (the shared BreakdownWidget donut, the shared derived
 * palette). Grouping control: By institution · By account · By account type.
 *
 * Every figure is the pure cash-accounts helper's (one per-account conversion,
 * the classifier's): the ring's centre is TOTAL CASH — the same figure as the
 * net-worth Cash composition — and Σ groups equals it. It is labelled "Total
 * cash", never "Accessible cash" (that is the Resilience tile's figure, which
 * the ledger below reconciles to).
 */

import { useMemo, useState } from "react";
import { formatCurrency } from "@/lib/currency";
import { Surface } from "@/components/atlas/Surface";
import { Chips } from "@/components/atlas/Chips";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import {
  CASH_GROUPINGS, groupCashAccounts, type CashAccountsSummary, type CashGrouping,
} from "./cash-accounts";

const NOUN: Record<CashGrouping, string> = { institution: "institution", account: "account", type: "account type" };

export function CashDistribution({
  summary,
  currency,
  initialGrouping = "institution",
}: {
  summary:          CashAccountsSummary;
  currency:         string;
  initialGrouping?: CashGrouping;
}) {
  const [by, setBy] = useState<CashGrouping>(initialGrouping);
  const groups = useMemo(() => groupCashAccounts(summary, by), [summary, by]);

  if (summary.rows.length === 0) {
    return (
      <Surface className="px-4 py-8">
        <p className="text-center text-sm text-[var(--text-muted)]">No cash accounts yet — connect a checking or savings account to see where your cash is held.</p>
      </Surface>
    );
  }

  const fmt = (v: number) => formatCurrency(v, currency);
  // A ring can only draw positive slices; an overdrawn group is stated beside it,
  // and the centre stays the full total cash (Σ of every group, signed).
  const items: BreakdownItem[] = groups
    .filter((g) => g.value > 0)
    .map((g) => ({
      id:    g.id,
      label: g.label,
      value: g.value,
      color: g.color,
      meta:  `${g.count} account${g.count === 1 ? "" : "s"}${g.meta ? ` · ${g.meta}` : ""}`,
    }));
  const negative = groups.filter((g) => g.value < 0);
  const groupingLabel = CASH_GROUPINGS.find((g) => g.id === by)?.label.toLowerCase() ?? "";

  return (
    <Surface className="p-4 min-w-0">
      <Chips options={CASH_GROUPINGS} value={by} onChange={setBy} ariaLabel="Group total cash" className="mb-4" />
      <div role="group" aria-label={`Total cash ${groupingLabel}: ${fmt(summary.totalCash)}`}>
        <BreakdownWidget
          items={items}
          viewMode="donut"
          itemNoun={NOUN[by]}
          formatValue={fmt}
          centerTotal={{ value: summary.totalCash, label: "Total cash" }}
          centerTone="neutral"
          emptyHeadline="No positive cash balances to draw"
        />
      </div>
      {negative.length > 0 && (
        <p className="mt-3 text-[11px] text-[var(--text-faint)]">
          Overdrawn, not drawn in the ring: {negative.map((g) => `${g.label} ${fmt(g.value)}`).join(" · ")}
        </p>
      )}
      {summary.unconverted && (
        <p className="mt-2 text-[11px] text-[var(--text-faint)]">Some balances couldn&rsquo;t be converted to {currency} and are excluded.</p>
      )}
    </Surface>
  );
}
