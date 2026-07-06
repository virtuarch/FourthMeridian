import { Account } from "@/types";
import { formatCurrency, formatCompactCurrency } from "@/lib/format";
import { useDisplayCurrency } from "@/lib/currency-context";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { EstimatedChip } from "@/components/ui/EstimatedChip";
import type { ConversionContext } from "@/lib/money/types";
import { getDebtStatusMessage } from "@/lib/summary-status";
import { SummaryStatCard, SummaryStatRow } from "./SummaryStatCard";

interface Props {
  accounts:     Account[];   // debt-type accounts only
  lastUpdated?: string;
  /** MC1 QA Q2 — optional conversion context for the headline aggregate. */
  ctx?:         ConversionContext;
}

export function DebtCard({ accounts, lastUpdated, ctx }: Props) {
// MC1 QA Q2 — the headline on this card is an AGGREGATE: it converts into the
// display currency when a context is supplied (labels follow values); the
// per-account rows below stay native (itemized rule, untouched this slice).
  const displayCurrency = useDisplayCurrency();
  const conv = (amount: number, currency: string | null | undefined) =>
    ctx ? convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx) : { amount, estimated: false };
  // Net debt: positive = you owe, negative = bank owes you
  const totalConv = accounts.map((a) => conv(a.balance, a.currency));
  const total  = totalConv.reduce((s, c) => s + c.amount, 0);
  const headlineEstimated = totalConv.some((c) => c.estimated);
  const status = getDebtStatusMessage(Math.max(0, total));

  const rows: SummaryStatRow[] = accounts.map((a) => {
    const subParts: string[] = [];
    if (a.interestRate != null)   subParts.push(`${a.interestRate.toFixed(2)}% APR`);
    if (a.minimumPayment != null) subParts.push(`${formatCurrency(a.minimumPayment)}/mo min`);

    return {
      id:        a.id,
      label:     a.name, // already resolved: displayName ?? officialName ?? plaidName ?? raw name
      value:     `${a.balance > 0 ? "-" : "+"}${formatCurrency(Math.abs(a.balance))}`,
      valueTone: a.balance > 0 ? "negative" as const : "positive" as const,
      subLabel:  subParts.length > 0 ? subParts.join(" · ") : undefined,
    };
  });

  return (
    <SummaryStatCard
      title="Debt"
      value={`${headlineEstimated ? "\u2248 " : ""}${formatCompactCurrency(Math.abs(total), displayCurrency)}`}
      valueSuffix={headlineEstimated ? <EstimatedChip /> : undefined}
      valueTone={total > 0 ? "negative" : "positive"}
      message={status.message}
      messageTone={status.tone}
      rows={rows}
      lastUpdated={lastUpdated}
    />
  );
}
