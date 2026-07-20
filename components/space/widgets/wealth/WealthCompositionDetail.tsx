"use client";

/**
 * components/space/widgets/wealth/WealthCompositionDetail.tsx
 *
 * The INSPECT body behind a "Where it sits" selection (UX-CLOSE-2), shown in a
 * RightPanel — the same "tell me more about what I selected" role the ledgers
 * already use (SourceAccountDetail, DebtAccountDetail, HoldingDetail).
 *
 * Panel ROLE, not panel CONTENT, decides the edge. This shows a LIST when an
 * institution is selected, but it is still INSPECT: the question is "what is
 * inside this one thing", not "which thing do I want". A browse surface would
 * be the full set of institutions to choose from, and would dock LEFT.
 *
 * HONESTY: institution/account composition reads LIVE accounts, so it is
 * present-day even when the workspace is anchored to a historical As Of. The
 * card says so; this panel repeats it rather than letting a drill imply the
 * figures belong to the selected date. Per-account history is not carried by
 * any contract (SpaceSnapshot stores pre-aggregated columns), so there is
 * nothing to show for a past date and we do not pretend otherwise.
 *
 * Presentation only — every figure is already display-converted by the shared
 * wealthAccountRows / wealthInstitutionGroups authority the chart reads, so a
 * segment and this panel cannot disagree.
 */

import { formatCurrency } from "@/lib/format";
import { Surface } from "@/components/atlas/Surface";
import type {
  WealthCompositionAccount,
  WealthCompositionGroup,
} from "@/components/space/widgets/wealth-adapters";

const TYPE_LABEL: Record<string, string> = {
  checking:   "Checking",
  savings:    "Savings",
  investment: "Investment",
  crypto:     "Digital asset",
  other:      "Other",
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
      <span className="text-sm tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

/** Shared footer note — the drill is present-day, always. */
function CurrentOnlyNote() {
  return (
    <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-faint)]">
      Current classification — these are today&apos;s connected accounts, not the
      selected As Of date. Per-account history isn&apos;t tracked.
    </p>
  );
}

/** One institution: its total, its share, and the accounts that produce it. */
export function InstitutionCompositionDetail({
  group,
  totalAssets,
  currency,
}: {
  group:       WealthCompositionGroup;
  totalAssets: number;
  currency:    string;
}) {
  const share = totalAssets > 0 ? (group.value / totalAssets) * 100 : 0;

  return (
    <div className="space-y-3">
      <Surface className="px-4 py-3">
        <Fact label="Held here" value={formatCurrency(group.value, currency)} />
        <Fact label="Share of assets" value={`${share.toFixed(1)}%`} />
        <Fact
          label="Accounts"
          value={`${group.accounts.length} ${group.accounts.length === 1 ? "account" : "accounts"}`}
        />
      </Surface>

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-hairline)]">
        {group.accounts.map((a, i) => (
          <div
            key={a.id}
            className={`flex items-center gap-3 px-4 py-3 ${
              i > 0 ? "border-t border-[var(--border-hairline)]" : ""
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[var(--text-primary)]">{a.name}</p>
              <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{typeLabel(a.type)}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="tabular-nums text-sm text-[var(--text-primary)]">
                {formatCurrency(a.value, currency)}
              </p>
              <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">
                {group.value > 0 ? ((a.value / group.value) * 100).toFixed(0) : "0"}% of {group.label}
              </p>
            </div>
          </div>
        ))}
      </div>

      <CurrentOnlyNote />
    </div>
  );
}

/** One account: its facts and its weight. An account has no constituents in this
 *  contract, so inspecting it means its identity and share — not a sub-list. */
export function AccountCompositionDetail({
  account,
  totalAssets,
  currency,
}: {
  account:     WealthCompositionAccount;
  totalAssets: number;
  currency:    string;
}) {
  const share = totalAssets > 0 ? (account.value / totalAssets) * 100 : 0;

  return (
    <div className="space-y-3">
      <Surface className="px-4 py-3">
        <Fact label="Balance" value={formatCurrency(account.value, currency)} />
        <Fact label="Share of assets" value={`${share.toFixed(1)}%`} />
        <Fact label="Type" value={typeLabel(account.type)} />
        <Fact label="Institution" value={account.institution} />
      </Surface>
      <CurrentOnlyNote />
    </div>
  );
}
