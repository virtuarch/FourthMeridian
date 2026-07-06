import { Account } from "@/types";
import { formatCurrency, formatCompactCurrency } from "@/lib/format";
import { useDisplayCurrency } from "@/lib/currency-context";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { EstimatedChip } from "@/components/ui/EstimatedChip";
import type { ConversionContext } from "@/lib/money/types";
import { getCashStatusMessage } from "@/lib/summary-status";
import { SummaryStatCard, SummaryStatRow } from "./SummaryStatCard";

interface Props {
  accounts:     Account[];   // checking + savings accounts only
  investable?:  number;      // uninvested cash inside brokerage / crypto accounts
  lastUpdated?: string;
  /** MC1 QA Q2 — optional conversion context for the headline aggregate. */
  ctx?:         ConversionContext;
}

export function CashOnHandCard({ accounts, investable = 0, lastUpdated, ctx }: Props) {
// MC1 QA Q2 — the headline on this card is an AGGREGATE: it converts into the
// display currency when a context is supplied (labels follow values); the
// per-account rows below stay native (itemized rule, untouched this slice).
  const displayCurrency = useDisplayCurrency();
  const conv = (amount: number, currency: string | null | undefined) =>
    ctx ? convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx) : { amount, estimated: false };
  const cashConv      = accounts.map((a) => conv(a.balance, a.currency));
  const bankCash      = cashConv.reduce((s, c) => s + c.amount, 0);
  const hasInvestable = investable > 0;
  const totalCash      = bankCash + investable; // investable arrives pre-converted from the host classification
  const headlineEstimated = cashConv.some((c) => c.estimated);
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
      value={`${headlineEstimated ? "\u2248 " : ""}${formatCompactCurrency(hasInvestable ? totalCash : bankCash, displayCurrency)}`}
      valueSuffix={headlineEstimated ? <EstimatedChip /> : undefined}
      message={status.message}
      messageTone={status.tone}
      rows={rows}
      lastUpdated={lastUpdated}
    />
  );
}
