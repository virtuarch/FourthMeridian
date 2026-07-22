"use client";

/**
 * components/space/widgets/liquidity/LiquidityLadderTiers.tsx
 *
 * S2 — the upgraded Liquidity Ladder presenter: access-horizon tier tiles with
 * per-tier total, % of assets, and per-tier account rows, plus a Total liquidity
 * / Total assets footer. Pure over (accounts, ctx) — CURRENT-STATE ONLY, no time
 * input, no history read. It is a presentation upgrade of the SAME three-horizon
 * ladder the registry's renderLiquidityLadder builds from `classifyAccounts`; the
 * adapter renderer stays untouched as the generic-path renderer (the same pattern
 * Cash Flow used for its Spending panel).
 *
 * Honest reductions preserved from the adapter doctrine (liquidity-adapters.tsx):
 *   - Three horizons only (now / days / illiquid) — the schema has no
 *     retirement/settlement typing, so no "locked/penalty" tier is faked.
 *   - No coverage multiple in the footer — there is no monthly-expense baseline
 *     (the same rule the Emergency Fund Readiness widget enforces).
 */

import { classifyAccounts } from "@/lib/account-classifier";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import type { LiquidityAdapterAccount } from "@/components/space/widgets/liquidity-adapters";

// Local money helpers — identical in mechanic to the (module-private) helpers in
// liquidity-adapters.tsx, so tier totals and rows convert byte-identically to the
// widgets they sit beside. Convert each row at the latest close (yesterdayUTCISO),
// exactly as renderLiquidityConcentration does.
function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}
function inDisp(amount: number, currency: string | null | undefined, ctx?: ConversionContext): number {
  if (!ctx) return amount;
  // V25-FINAL-1 — unavailable conversion excluded (0), never a native magnitude.
  return convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx).amount ?? 0;
}

const ROWS_PER_TIER = 4;

export function LiquidityLadderTiers({
  accounts,
  ctx,
}: {
  accounts: LiquidityAdapterAccount[];
  ctx?:     ConversionContext;
}) {
  const c = classifyAccounts(accounts, ctx);

  // Same three horizons + color language + honest-reduction metas as the adapter.
  const tiers = [
    { id: "now",      label: "Available now",     color: "#22c55e", meta: "Checking · savings",             total: c.totalLiquid,                             rows: c.liquid },
    { id: "days",     label: "Available in days", color: "#3b82f6", meta: "Brokerage · crypto (settlement)", total: c.totalInvestments + c.totalDigitalAssets, rows: [...c.investments, ...c.digitalAssets] },
    { id: "illiquid", label: "Illiquid",          color: "#6b7280", meta: "Property · other long-term",      total: c.totalRealAssets,                         rows: c.realAssets },
  ].filter((t) => t.total > 0);

  if (c.totalAssets <= 0 || tiers.length === 0) {
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm text-[var(--text-secondary)]">No assets yet</p>
        <p className="text-xs text-[var(--text-faint)]">Connect asset accounts to see how accessible your money is.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tiers.map((tier) => {
        const pct = c.totalAssets > 0 ? (tier.total / c.totalAssets) * 100 : 0;
        const rows = tier.rows
          .map((a) => ({ id: a.id, name: a.name, institution: a.institution, value: inDisp(a.balance, a.currency, ctx) }))
          .filter((r) => r.value > 0)
          .sort((x, y) => y.value - x.value);
        const shown = rows.slice(0, ROWS_PER_TIER);
        const moreCount = rows.length - shown.length;

        return (
          <div key={tier.id} className="rounded-xl border p-3" style={{ background: "var(--surface-inset)", borderColor: "var(--border-subtle, rgba(255,255,255,0.06))" }}>
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: tier.color }} />
                <span className="text-sm font-medium text-[var(--text-primary)] truncate">{tier.label}</span>
                <span className="text-[10px] tabular-nums text-[var(--text-faint)] shrink-0">{pct.toFixed(0)}% of assets</span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)] shrink-0">{fmtMoney(tier.total, ctx)}</span>
            </div>
            <p className="text-[10px] text-[var(--text-faint)] mt-0.5">{tier.meta}</p>

            {shown.length > 0 && (
              <ul className="mt-2 space-y-1">
                {shown.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: tier.color, opacity: 0.55 }} />
                      <span className="text-xs text-[var(--text-secondary)] truncate">{r.name}</span>
                      {r.institution && <span className="text-[10px] text-[var(--text-faint)] truncate shrink-0">{r.institution}</span>}
                    </span>
                    <span className="text-xs tabular-nums text-[var(--text-secondary)] shrink-0">{fmtMoney(r.value, ctx)}</span>
                  </li>
                ))}
                {moreCount > 0 && (
                  <li className="text-[10px] text-[var(--text-faint)] pl-3.5">+{moreCount} more account{moreCount === 1 ? "" : "s"}</li>
                )}
              </ul>
            )}
          </div>
        );
      })}

      {/* Footer — Total liquidity / Total assets (both landed totals). Coverage
          multiple deliberately omitted: no monthly-expense baseline exists. */}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <div className="rounded-lg px-3 py-2" style={{ background: "var(--surface-inset)" }}>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Total liquidity</p>
          <p className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{fmtMoney(c.totalLiquid, ctx)}</p>
        </div>
        <div className="rounded-lg px-3 py-2" style={{ background: "var(--surface-inset)" }}>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Total assets</p>
          <p className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{fmtMoney(c.totalAssets, ctx)}</p>
        </div>
      </div>
    </div>
  );
}
