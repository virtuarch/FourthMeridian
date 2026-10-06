/**
 * components/space/widgets/investments/InvestmentAccountsLedger.tsx  (2026-10-07)
 *
 * Every investment account behind the canonical investment figure, at its
 * balance — a 401(k) or IRA with no security-level holdings is still an
 * investment asset and is listed here with "Holdings unavailable", never hidden
 * and never given invented positions. The rows come from the server's
 * investment-account slice (lib/investments/investment-accounts.ts), whose
 * counted total IS the canonical aggregate (snapshot stocks + crypto); this
 * component only formats it.
 *
 * Per-asset connection state lives on the row it describes ("Connection needs
 * attention → Connections"); the generic Connections card that used to sit at
 * the bottom of Assets is gone — Connections has its own surface.
 */

import Link from "next/link";
import type { InvestmentAccountsSlice, InvestmentAccountRow } from "@/lib/investments/investment-accounts";
import { investedClassLabel } from "@/lib/wealth/invested-label";
import { formatCurrency } from "@/lib/currency";
import { Surface } from "@/components/atlas/Surface";

function statusLine(r: InvestmentAccountRow): string {
  if (r.status === "consent_required") return "Not counted yet — Investments permission needed";
  if (r.status === "holdings") return `${r.holdings.toLocaleString()} holding${r.holdings === 1 ? "" : "s"}`;
  return "Holdings unavailable";
}

export function InvestmentAccountsLedger({ slice }: { slice: InvestmentAccountsSlice }) {
  const total = slice.investmentsTotal + slice.cryptoTotal;
  const totalLabel = investedClassLabel({ investments: slice.investmentsTotal, crypto: slice.cryptoTotal });
  return (
    <Surface className="divide-y divide-[var(--border-hairline)]">
      {slice.rows.map((r) => (
        <div key={r.id} className="flex items-start justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--text-primary)]">{r.name}</p>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {r.institution ? `${r.institution} · ` : ""}{statusLine(r)}
            </p>
            {(r.connectionNeedsAttention || r.status === "consent_required") && (
              <Link href="/dashboard/connections" className="mt-1 inline-block text-xs font-semibold text-[var(--meridian-400)] hover:underline">
                {r.connectionNeedsAttention ? "Connection needs attention →" : "Grant access in Connections →"}
              </Link>
            )}
          </div>
          <p className={`shrink-0 text-sm tabular-nums ${r.counted ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}>
            {r.value == null ? "—" : formatCurrency(r.value, slice.reportingCurrency)}
          </p>
        </div>
      ))}
      {totalLabel && (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{totalLabel} total</p>
          <p className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{formatCurrency(total, slice.reportingCurrency)}</p>
        </div>
      )}
    </Surface>
  );
}
