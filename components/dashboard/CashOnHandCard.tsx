import { Account } from "@/types";
import { formatCurrency, formatCompactCurrency } from "@/lib/format";
import { getCashStatusMessage } from "@/lib/summary-status";
import { SummaryStatCard, SummaryStatRow } from "./SummaryStatCard";

interface Props {
  accounts:     Account[];   // checking + savings accounts only
  investable?:  number;      // uninvested cash inside brokerage / crypto accounts
  lastUpdated?: string;
}

export function CashOnHandCard({ accounts, investable = 0, lastUpdated }: Props) {
  const bankCash      = accounts.reduce((s, a) => s + a.balance, 0);
  const hasInvestable = investable > 0;
  const totalCash      = bankCash + investable;
  const status         = getCashStatusMessage(bankCash);

  const rows: SummaryStatRow[] = accounts.map((a) => ({
    id:    a.id,
    label: a.name, // already resolved: displayName ?? officialName ?? plaidName ?? raw name
    value: formatCurrency(a.balance),
  }));

  if (hasInvestable) {
    rows.push({
      id:    "brokerage-cash",
      label: "Brokerage Cash",
      value: formatCurrency(investable),
    });
  }

  return (
    <SummaryStatCard
      title="Cash on Hand"
      value={formatCompactCurrency(hasInvestable ? totalCash : bankCash)}
      message={status.message}
      messageTone={status.tone}
      rows={rows}
      lastUpdated={lastUpdated}
    />
  );
}
