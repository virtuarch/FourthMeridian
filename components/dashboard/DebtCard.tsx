import { Account } from "@/types";
import { formatCurrency, formatCompactCurrency } from "@/lib/format";
import { getDebtStatusMessage } from "@/lib/summary-status";
import { SummaryStatCard, SummaryStatRow } from "./SummaryStatCard";

interface Props {
  accounts:     Account[];   // debt-type accounts only
  lastUpdated?: string;
}

export function DebtCard({ accounts, lastUpdated }: Props) {
  // Net debt: positive = you owe, negative = bank owes you
  const total  = accounts.reduce((s, a) => s + a.balance, 0);
  const status = getDebtStatusMessage(Math.max(0, total));

  const rows: SummaryStatRow[] = accounts.map((a) => {
    const subParts: string[] = [];
    if (a.interestRate != null)   subParts.push(`${a.interestRate.toFixed(2)}% APR`);
    if (a.minimumPayment != null) subParts.push(`${formatCurrency(a.minimumPayment)}/mo min`);

    return {
      id:             a.id,
      label:          a.name, // already resolved: displayName ?? officialName ?? plaidName ?? raw name
      value:          `${a.balance > 0 ? "-" : "+"}${formatCurrency(Math.abs(a.balance))}`,
      valueClassName: a.balance > 0 ? "text-red-400" : "text-emerald-400",
      subLabel:       subParts.length > 0 ? subParts.join(" · ") : undefined,
    };
  });

  return (
    <SummaryStatCard
      title="Debt"
      value={formatCompactCurrency(Math.abs(total))}
      valueClassName={total > 0 ? "text-red-400" : "text-emerald-400"}
      message={status.message}
      messageClassName={status.className}
      rows={rows}
      lastUpdated={lastUpdated}
    />
  );
}
