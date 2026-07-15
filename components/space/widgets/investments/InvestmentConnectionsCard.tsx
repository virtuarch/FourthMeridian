"use client";

/**
 * components/space/widgets/investments/InvestmentConnectionsCard.tsx
 *
 * The operational counterpart to the A10 valuation view. The Investments Time
 * Machine DTO (correctly) knows nothing about connection health —
 * consent_required / needs_reauth / error / zero_holdings, plaidItemId, the
 * Enable/Refresh affordances — those live ONLY in the legacy current-holdings
 * read model. So this card keeps the legacy `GET /api/spaces/[id]/investments`
 * as its source and renders ONLY accounts that need attention, as compact action
 * rows reusing the EXISTING `EnableInvestmentsButton` and `AccountRefreshButton`
 * (no forked logic).
 *
 * Healthy accounts (`holdings` / `wallet`) render nothing — the valuation panels
 * already own the holdings list, so there is no duplicate. When every account is
 * healthy this component renders null and its host Panel is omitted entirely.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { EnableInvestmentsButton } from "@/components/dashboard/EnableInvestmentsButton";
import { AccountRefreshButton } from "@/components/plaid/AccountRefreshButton";
import type { InvestmentAccountView } from "@/lib/investments/current-holdings";

/** The states this card surfaces — everything else (holdings/wallet) is healthy. */
const ATTENTION_STATES: ReadonlySet<InvestmentAccountView["state"]> = new Set([
  "consent_required",
  "needs_reauth",
  "error",
  "zero_holdings",
]);

function AttentionRow({ acct, onReload }: { acct: InvestmentAccountView; onReload: () => void }) {
  return (
    <div className="py-2.5 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{acct.name}</p>
          <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{acct.institution}</p>
        </div>
      </div>

      {acct.state === "consent_required" && acct.plaidItemId && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            Investment holdings are available for this connection but not yet enabled.
          </p>
          <EnableInvestmentsButton plaidItemId={acct.plaidItemId} onEnabled={onReload} />
        </div>
      )}

      {acct.state === "needs_reauth" && (
        <div className="flex items-start gap-2 text-xs" style={{ color: "var(--accent-warning,#f59e0b)" }}>
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span>
            This connection needs to be reconnected before holdings can sync.{" "}
            <Link href="/dashboard/connections" className="underline font-semibold">Reconnect →</Link>
          </span>
        </div>
      )}

      {acct.state === "error" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start gap-2 text-xs" style={{ color: "var(--accent-warning,#f59e0b)" }}>
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>We hit a problem syncing this connection{acct.itemErrorCode ? ` (${acct.itemErrorCode})` : ""}.</span>
          </div>
          {acct.plaidItemId && <AccountRefreshButton plaidItemId={acct.plaidItemId} onDone={onReload} />}
        </div>
      )}

      {acct.state === "zero_holdings" && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>No individual holdings were reported for this account.</p>
          {acct.plaidItemId && <AccountRefreshButton plaidItemId={acct.plaidItemId} onDone={onReload} />}
        </div>
      )}
    </div>
  );
}

/**
 * Self-contained: mounted unconditionally in the side column (so it always
 * fetches), it renders its OWN "Connections" panel ONLY when an account needs
 * attention, and renders null (Panel omitted entirely) whenever every account is
 * healthy or the fetch failed — no duplicate holdings list, no empty box. This
 * single-mount design avoids the fetch/unmount race a host-conditional wrapper
 * would create.
 */
export function InvestmentConnectionsCard({ spaceId }: { spaceId: string }) {
  const [accounts, setAccounts] = useState<InvestmentAccountView[] | null>(null);

  const load = useCallback(() => {
    fetch(`/api/spaces/${spaceId}/investments`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => setAccounts(Array.isArray(data.accounts) ? data.accounts : []))
      .catch(() => setAccounts([]));
  }, [spaceId]);

  useEffect(() => { load(); }, [load]);

  if (!accounts) return null;
  const attention = accounts.filter((a) => ATTENTION_STATES.has(a.state));
  if (attention.length === 0) return null;

  // Same card language as the composition's local Panel (GlassPanel thin/e2/lg,
  // p-4, text-sm font-semibold header) — subdued, since it's a secondary surface.
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
      <p className="text-sm font-semibold px-1 mb-2" style={{ color: "var(--text-muted)" }}>Connections</p>
      <div className="divide-y divide-[var(--border-hairline)]">
        {attention.map((a) => <AttentionRow key={a.accountId} acct={a} onReload={load} />)}
      </div>
    </GlassPanel>
  );
}
