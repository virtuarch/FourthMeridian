"use client";

/**
 * components/space/widgets/debt/DebtCompositionCard.tsx  (v2.7 — Debt page donut)
 *
 * "Where is my debt owed?" — the Debt counterpart of Net Worth's "Where it sits"
 * card, in the SAME idiom: a Block whose header carries the grouping Dropdown
 * (outside and above the donut surface), a Surface holding the shared donut
 * (BreakdownWidget), the centre figure in the neutral tone.
 *
 * Present-day only: per-account debt history isn't tracked, so the header says
 * "Current · today's debts" exactly as the Net Worth liabilities regime does.
 * The slices are debtCompositionItems — the owed amounts renderDebtByAccount
 * already ranks; nothing is recomputed here.
 */

import { useMemo, useState } from "react";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { Dropdown } from "@/components/atlas/Dropdown";
import { Block, Surface } from "@/components/atlas/Surface";
import { formatCurrency } from "@/lib/currency";
import type { ConversionContext } from "@/lib/money/types";
import {
  debtCompositionItems,
  type DebtCompositionGrouping,
  type DebtPerspectiveAccount,
} from "@/components/space/widgets/debt-perspective-adapters";

export const DEBT_COMPOSITION_GROUPINGS: { id: DebtCompositionGrouping; label: string }[] = [
  { id: "account",     label: "By account" },
  { id: "type",        label: "By type" },
  { id: "institution", label: "By institution" },
];

const NOUN: Record<DebtCompositionGrouping, string> = { account: "account", type: "type", institution: "institution" };

export function DebtCompositionCard({
  accounts,
  ctx,
  currency,
  className,
}: {
  accounts:   DebtPerspectiveAccount[];
  ctx?:       ConversionContext;
  currency:   string;
  className?: string;
}) {
  const [grouping, setGrouping] = useState<DebtCompositionGrouping>("account");
  const items = useMemo(() => debtCompositionItems(accounts, ctx, grouping), [accounts, ctx, grouping]);
  const total = items.reduce((s, i) => s + i.value, 0);

  return (
    <Block
      label="Where it's owed"
      className={className}
      hint={
        <span className="text-[11px] text-[var(--text-muted)]" title="Current classification — your debts today. Per-account debt history isn't tracked, so this reflects now, not the selected As Of date." data-current-classification>
          Current · today&rsquo;s debts
        </span>
      }
      action={<Dropdown options={DEBT_COMPOSITION_GROUPINGS} value={grouping} onChange={setGrouping} ariaLabel="Debt composition grouping" />}
    >
      <Surface className="px-4 py-4">
        <BreakdownWidget
          items={items}
          viewMode="donut"
          itemNoun={NOUN[grouping]}
          emptyHeadline="No debt"
          emptySubline="Nothing owed in this Space — nice."
          formatValue={(v: number) => formatCurrency(v, currency)}
          centerTotal={total > 0 ? { value: total, label: "total debt" } : undefined}
          centerTone="neutral"
        />
      </Surface>
    </Block>
  );
}
