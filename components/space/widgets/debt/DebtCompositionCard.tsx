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
 *
 * v2.7 final UX pass — `scope` reuses this SAME card for the compact Credit and
 * Loans views (one donut implementation, not three):
 *   • Credit — the "cards" class (credit cards + lines of credit), by account
 *     or by institution;
 *   • Loans  — the "loans" class, by stated KIND (Mortgage / Auto / Student /
 *     Personal / HELOC — every loan-class row has one by construction, since the
 *     class itself comes from that stated subtype) when ≥2 kinds exist, else by
 *     account; by institution also offered.
 * Each reconciles exactly to the class's owed total (the centre figure = Σ the
 * class's ledger rows). Accounts owing nothing are not slices but are counted
 * honestly under the donut; a class with no accounts gets its own empty state.
 */

import { useMemo, useState } from "react";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { Dropdown } from "@/components/atlas/Dropdown";
import { Block, Surface } from "@/components/atlas/Surface";
import { formatCurrency } from "@/lib/currency";
import type { ConversionContext } from "@/lib/money/types";
import {
  debtCompositionItems,
  debtScopeSummary,
  type DebtCompositionGrouping,
  type DebtCompositionScope,
  type DebtPerspectiveAccount,
} from "@/components/space/widgets/debt-perspective-adapters";

export const DEBT_COMPOSITION_GROUPINGS: { id: DebtCompositionGrouping; label: string }[] = [
  { id: "account",     label: "By account" },
  { id: "type",        label: "By type" },
  { id: "institution", label: "By institution" },
];

/** v2.7 final UX pass — the groupings each scoped view supports (never "type": one class). */
export const DEBT_SCOPE_GROUPINGS: Record<DebtCompositionScope, { id: DebtCompositionGrouping; label: string }[]> = {
  cards: [
    { id: "account",     label: "By account" },
    { id: "institution", label: "By institution" },
  ],
  loans: [
    { id: "kind",        label: "By loan type" },
    { id: "account",     label: "By account" },
    { id: "institution", label: "By institution" },
  ],
};

const NOUN: Record<DebtCompositionGrouping, string> = { account: "account", type: "type", institution: "institution", kind: "loan type" };

const SCOPE_COPY: Record<DebtCompositionScope, { label: string; centre: string; none: string; noneSub: string; paid: string; paidSub: string; notOwed: (n: number) => string }> = {
  cards: {
    label: "Where your credit is owed",
    centre: "credit owed",
    none: "No credit cards or lines of credit",
    noneSub: "None of this Space's liabilities is a credit card or line of credit.",
    paid: "Nothing owed on credit",
    paidSub: "Every credit card and line here is paid off or in credit.",
    notOwed: (n) => `${n} credit account${n === 1 ? "" : "s"} with nothing owed ${n === 1 ? "isn't" : "aren't"} shown.`,
  },
  loans: {
    label: "Where your loans are owed",
    centre: "loans owed",
    none: "No loans",
    noneSub: "None of this Space's liabilities is a loan.",
    paid: "Nothing owed on loans",
    paidSub: "Every loan here is paid off.",
    notOwed: (n) => `${n} loan${n === 1 ? "" : "s"} with nothing owed ${n === 1 ? "isn't" : "aren't"} shown.`,
  },
};

/** Loans default to by-kind only when it actually splits (≥2 stated kinds); else by account. */
export function defaultScopeGrouping(scope: DebtCompositionScope, kindCount: number): DebtCompositionGrouping {
  return scope === "loans" && kindCount >= 2 ? "kind" : "account";
}

export function DebtCompositionCard({
  accounts,
  ctx,
  currency,
  className,
  scope,
}: {
  accounts:   DebtPerspectiveAccount[];
  ctx?:       ConversionContext;
  currency:   string;
  className?: string;
  /** v2.7 final UX pass — scope to one class (compact Credit / Loans views). */
  scope?:     DebtCompositionScope;
}) {
  const summary = useMemo(() => (scope ? debtScopeSummary(accounts, ctx, scope) : null), [accounts, ctx, scope]);
  const [picked, setGrouping] = useState<DebtCompositionGrouping | null>(null);
  const grouping: DebtCompositionGrouping = picked ?? (scope ? defaultScopeGrouping(scope, summary?.kindCount ?? 0) : "account");
  const items = useMemo(() => debtCompositionItems(accounts, ctx, grouping, scope), [accounts, ctx, grouping, scope]);
  const total = items.reduce((s, i) => s + i.value, 0);
  const copy = scope ? SCOPE_COPY[scope] : null;
  const options = scope ? DEBT_SCOPE_GROUPINGS[scope] : DEBT_COMPOSITION_GROUPINGS;
  const notOwed = summary?.notOwedCount ?? 0;

  return (
    <Block
      id={scope ? `debt-${scope === "cards" ? "credit" : "loans"}-composition` : undefined}
      label={copy?.label ?? "Where it's owed"}
      className={className}
      hint={
        <span className="text-[11px] text-[var(--text-muted)]" title="Current classification — your debts today. Per-account debt history isn't tracked, so this reflects now, not the selected As Of date." data-current-classification>
          Current · today&rsquo;s debts
        </span>
      }
      action={<Dropdown options={options} value={grouping} onChange={setGrouping} ariaLabel={scope ? `${scope === "cards" ? "Credit" : "Loans"} composition grouping` : "Debt composition grouping"} />}
    >
      <Surface className="px-4 py-4">
        <BreakdownWidget
          items={items}
          viewMode="donut"
          itemNoun={NOUN[grouping]}
          emptyHeadline={copy ? (summary && summary.accountCount > 0 ? copy.paid : copy.none) : "No debt"}
          emptySubline={copy ? (summary && summary.accountCount > 0 ? copy.paidSub : copy.noneSub) : "Nothing owed in this Space — nice."}
          formatValue={(v: number) => formatCurrency(v, currency)}
          centerTotal={total > 0 ? { value: total, label: copy?.centre ?? "total debt" } : undefined}
          centerTone="neutral"
          footer={copy && items.length > 0 && notOwed > 0 ? (
            <p className="text-center text-[11px] leading-snug text-[var(--text-muted)]" data-debt-scope-not-owed>{copy.notOwed(notOwed)}</p>
          ) : undefined}
        />
      </Surface>
    </Block>
  );
}
