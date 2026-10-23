"use client";

/**
 * components/space/widgets/debt/InterestCostWidget.tsx
 *
 * Interest cost — and THE ONE PLACE a user views and edits a debt's APR.
 *
 * Every debt account is listed with its rate. A known rate shows the estimated
 * monthly interest it costs; an UNKNOWN rate shows no figure at all (never 0)
 * and an "Add APR" affordance. Editing a rate writes it to the canonical
 * liability authority and nothing else:
 *
 *   edit → saveAccountApr → PATCH /api/accounts/[id]/debt-profile {apr}
 *        → DebtProfile.apr → resolveEffectiveDebtTerms (profile wins)
 *        → SPACE_ACCOUNTS_CHANGED_EVENT → the host re-reads the accounts
 *        → this widget, the Payoff Strategy, the ledger and the KPIs re-render
 *          from the SAME re-read `interestRate`.
 *
 * There is no local APR. The draft string in the input is the only state this
 * component owns; the displayed rate is always the prop. The interest figures
 * come from `computeInterestCost` (lib/debt/interest-cost.ts) — no arithmetic
 * lives in this file.
 */

import { useState } from "react";
import { Check, Loader2, Pencil, Plus, X } from "lucide-react";
import { computeInterestCost } from "@/lib/debt/interest-cost";
import { parseAprInput, saveAccountApr } from "@/lib/debt/user-terms";
import { SPACE_ACCOUNTS_CHANGED_EVENT } from "@/lib/space-nav";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { formatAggregateMoney } from "@/components/space/widgets/display-money";
import type { ConversionContext } from "@/lib/money/types";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

function inDisp(amount: number, currency: string | null | undefined, ctx?: ConversionContext): number {
  if (!ctx) return amount;
  // V25-FINAL-1 — an unavailable conversion contributes 0, never a native magnitude.
  return convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx).amount ?? 0;
}

export function InterestCostWidget({
  accounts,
  ctx,
  onSaved,
}: {
  accounts: DebtPerspectiveAccount[];
  ctx?:     ConversionContext;
  /** Test seam / host override. Default: broadcast the accounts-changed refresh. */
  onSaved?: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState("");
  const [savingId, setSavingId]   = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);

  const debts = accounts.filter((a) => a.type === "debt");
  const cost = computeInterestCost(
    debts.map((a) => ({ id: a.id, balance: inDisp(a.balance, a.currency, ctx), aprPct: a.interestRate })),
  );
  const byId = new Map(debts.map((a) => [a.id, a]));
  const owingIds = new Set(cost.rows.map((r) => r.id));
  // Owing rows first (costliest first, unknowns last — the authority's order),
  // then the accounts that owe nothing: their rate still matters the day they do.
  const ordered = [
    ...cost.rows.map((r) => ({ account: byId.get(r.id)!, monthly: r.monthly, owes: true })),
    ...debts.filter((a) => !owingIds.has(a.id)).map((a) => ({ account: a, monthly: null, owes: false })),
  ];

  function open(a: DebtPerspectiveAccount) {
    setEditingId(a.id);
    setDraft(a.interestRate != null ? String(a.interestRate) : "");
    setError(null);
  }

  async function save(id: string) {
    const parsed = parseAprInput(draft);
    if (!parsed.ok) { setError(parsed.error); return; }
    setSavingId(id);
    setError(null);
    const res = await saveAccountApr(id, parsed.value);
    setSavingId(null);
    if (!res.ok) { setError(res.error); return; }
    setEditingId(null);
    setDraft("");
    if (onSaved) onSaved();
    else window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
  }

  if (debts.length === 0) {
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm text-[var(--text-secondary)]">No debt</p>
        <p className="text-xs text-[var(--text-faint)]">Nothing owed in this Space — nice.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-widget="interest-cost">
      <ul className="divide-y divide-[var(--border-hairline)]">
        {ordered.map(({ account: a, monthly, owes }) => {
          const editing = editingId === a.id;
          const saving  = savingId === a.id;
          // A privacy-aggregated row stands for several accounts behind one
          // synthetic id — there is no single liability to attach a rate to.
          const editable = a.aggregate == null;
          return (
            <li key={a.id} className="py-2 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[12px] text-[var(--text-secondary)]">{a.name}</p>
                  <p className="text-[10px] text-[var(--text-faint)]">
                    {!owes
                      ? "No balance owed"
                      : monthly != null
                        ? `${formatAggregateMoney(monthly, ctx)}/mo est. interest`
                        : "Interest unknown — no APR on file"}
                  </p>
                </div>

                {editing ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      autoFocus
                      inputMode="decimal"
                      aria-label={`APR for ${a.name}`}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save(a.id);
                        if (e.key === "Escape") { setEditingId(null); setError(null); }
                      }}
                      placeholder="e.g. 24.99"
                      className="w-20 bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-lg px-2 py-1 text-xs text-right tabular-nums text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-info)]"
                    />
                    <span className="text-[11px] text-[var(--text-faint)]">%</span>
                    <button
                      type="button"
                      onClick={() => save(a.id)}
                      disabled={saving}
                      aria-label="Save APR"
                      className="p-1 rounded text-[var(--accent-info)] disabled:opacity-50"
                    >
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingId(null); setError(null); }}
                      disabled={saving}
                      aria-label="Cancel"
                      className="p-1 rounded text-[var(--text-muted)] disabled:opacity-50"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : a.interestRate != null ? (
                  <button
                    type="button"
                    disabled={!editable}
                    onClick={() => open(a)}
                    aria-label={`Edit APR for ${a.name}`}
                    className="group flex items-center gap-1.5 shrink-0 text-[12px] font-semibold tabular-nums text-[var(--text-primary)] disabled:cursor-default"
                  >
                    {a.interestRate.toFixed(2)}% APR
                    {editable && <Pencil size={11} className="text-[var(--text-faint)] group-hover:text-[var(--accent-info)]" />}
                  </button>
                ) : editable ? (
                  <button
                    type="button"
                    onClick={() => open(a)}
                    className="flex items-center gap-1 shrink-0 text-[11px] font-medium text-[var(--accent-info)]"
                  >
                    <Plus size={12} /> Add APR
                  </button>
                ) : (
                  <span className="shrink-0 text-[11px] text-[var(--text-faint)]">APR unknown</span>
                )}
              </div>
              {editing && error && (
                <p className="mt-1 text-right text-[10px] text-[var(--accent-negative)]">{error}</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="border-t border-[var(--border-hairline)] pt-2 text-center">
        <p className="text-[11px] text-[var(--text-muted)]">Estimated interest</p>
        {cost.rows.some((r) => r.monthly != null) ? (
          <p className="text-sm font-semibold text-[var(--accent-negative)]">{formatAggregateMoney(cost.totalMonthly, ctx)}/mo</p>
        ) : (
          <p className="text-sm text-[var(--text-faint)]">Unknown</p>
        )}
        {cost.unknownCount > 0 && (
          <p className="text-[10px] text-[var(--text-faint)] mt-0.5">
            {cost.unknownCount} debt{cost.unknownCount === 1 ? "" : "s"} without an APR not counted — an unknown rate is never treated as 0%
          </p>
        )}
      </div>
    </div>
  );
}
