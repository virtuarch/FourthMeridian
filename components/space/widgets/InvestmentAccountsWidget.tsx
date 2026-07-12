"use client";

/**
 * components/space/widgets/InvestmentAccountsWidget.tsx
 *
 * Investments Perspective (Slice B) — read-only current holdings grouped BY
 * INVESTMENT ACCOUNT. One card per Schwab / Robinhood / Coinbase / future
 * brokerage/exchange account, each rendering an honest per-account state:
 *
 *   holdings          → positions list (+ brokerage cash if present)
 *   zero_holdings     → "no holdings reported" + Refresh (retry)
 *   consent_required  → "Enable Investments" (update-mode consent)
 *   needs_reauth      → reconnect prompt (→ Connections)
 *   error             → sync error + Refresh (retry)
 *   wallet            → self-custody / crypto balance (+ positions if any)
 *
 * Self-fetching (like ActivityCard/GoalsCard) from the membership + visibility
 * gated GET /api/spaces/[id]/investments, so it owns its data and can reload
 * after an Enable/Refresh without threading state through the host. It renders
 * only already-persisted CURRENT holdings — no history, prices-over-time, cost
 * basis, returns, or simulations (Slice B scope). Cost basis / unrealized P&L
 * are intentionally omitted: the current sync does not persist cost basis, and
 * we never fabricate values Plaid did not provide.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2, TrendingUp, RefreshCw, AlertTriangle,
  Landmark, ChevronDown, ChevronUp, Wallet, Coins,
} from "lucide-react";
import { DataCard } from "@/components/atlas/DataCard";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { EnableInvestmentsButton } from "@/components/dashboard/EnableInvestmentsButton";
import type { InvestmentAccountView, HoldingView } from "@/lib/investments/current-holdings";

const PREVIEW = 5;
const fmt = (n: number, cur: string = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 2 }).format(n);

function fmtSyncedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

// ── Per-account Refresh (reuses the existing holdings refresh path) ───────────
// Exported additively so the Investments Perspective's Connections card reuses
// this exact button (same /api/plaid/refresh path, cooldown handling, copy)
// instead of forking it — no behavior change to this widget.
export function AccountRefreshButton({ plaidItemId, onDone }: { plaidItemId: string; onDone: () => void }) {
  const [phase, setPhase] = useState<"idle" | "loading">("idle");
  const [note, setNote] = useState("");

  async function run() {
    if (phase === "loading") return;
    setPhase("loading");
    setNote("");
    try {
      const res = await fetch("/api/plaid/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plaidItemId }),
      });
      if (res.status === 429) {
        const d = await res.json().catch(() => ({}));
        const secs = typeof d.retryAfterSeconds === "number" ? d.retryAfterSeconds : null;
        setNote(secs ? `Cooling down — try again in ${Math.ceil(secs / 60)}m.` : "Cooling down — try again shortly.");
        return;
      }
      if (!res.ok) throw new Error("Refresh failed");
      onDone();
    } catch {
      setNote("Refresh failed — try again.");
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div>
      <button
        onClick={run}
        disabled={phase === "loading"}
        className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-2.5 py-1.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors disabled:opacity-50"
      >
        {phase === "loading" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        {phase === "loading" ? "Refreshing…" : "Refresh"}
      </button>
      {note && <p className="mt-1 text-xs text-[var(--text-muted)]">{note}</p>}
    </div>
  );
}

// ── One holding row ───────────────────────────────────────────────────────────
function HoldingRow({ h }: { h: HoldingView }) {
  const hasPrice = h.price > 0;
  const hasValue = Number.isFinite(h.value) && h.value !== 0;
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <CoinIcon symbol={h.symbol} size={32} />
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{h.symbol}</p>
          <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
            {h.name}
          </p>
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>
          {hasValue ? fmt(h.value, h.currency ?? "USD") : "Value unavailable"}
        </p>
        <p className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          {h.quantity} × {hasPrice ? fmt(h.price, h.currency ?? "USD") : "Price unavailable"}
        </p>
      </div>
    </div>
  );
}

// ── Cash row ──────────────────────────────────────────────────────────────────
function CashRow({ cash }: { cash: HoldingView }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "var(--surface-inset)" }}>
          <Coins size={16} style={{ color: "var(--text-secondary)" }} />
        </div>
        <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Cash</p>
      </div>
      <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>
        {fmt(cash.value, cash.currency ?? "USD")}
      </p>
    </div>
  );
}

// ── One account card ──────────────────────────────────────────────────────────
function AccountCard({ acct, onReload }: { acct: InvestmentAccountView; onReload: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const synced = fmtSyncedAt(acct.lastSyncedAt);
  const positions = expanded ? acct.positions : acct.positions.slice(0, PREVIEW);

  const providerLabel =
    acct.provider === "WALLET" ? "Self-custody" :
    acct.provider === "PLAID"  ? `Synced via Plaid` :
    "Manual";

  return (
    <DataCard>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {acct.type === "crypto" ? <Wallet size={15} className="text-[var(--meridian-400)] shrink-0" /> : <Landmark size={15} className="text-[var(--meridian-400)] shrink-0" />}
            <h3 className="text-base font-semibold truncate" style={{ color: "var(--text-primary)" }}>{acct.name}</h3>
          </div>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {acct.institution} · {providerLabel}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-lg font-bold tabular-nums" style={{ color: "var(--text-primary)" }}>{fmt(acct.totalValue, acct.currency)}</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {acct.positionCount} {acct.positionCount === 1 ? "holding" : "holdings"}
          </p>
        </div>
      </div>

      {synced && (
        <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>Holdings synced {synced}</p>
      )}

      {/* State-specific body */}
      <div className="mt-3">
        {acct.state === "consent_required" && acct.plaidItemId && (
          <div className="flex flex-col gap-2">
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Investment holdings are available for this connection but not yet enabled.
            </p>
            <EnableInvestmentsButton plaidItemId={acct.plaidItemId} onEnabled={onReload} />
          </div>
        )}

        {acct.state === "needs_reauth" && (
          <div className="flex items-start gap-2 text-sm" style={{ color: "var(--accent-warning,#f59e0b)" }}>
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span>
              This connection needs to be reconnected before holdings can sync.{" "}
              <Link href="/dashboard/connections" className="underline font-semibold">Reconnect in Connections →</Link>
            </span>
          </div>
        )}

        {acct.state === "error" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2 text-sm" style={{ color: "var(--accent-warning,#f59e0b)" }}>
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>We hit a problem syncing this connection{acct.itemErrorCode ? ` (${acct.itemErrorCode})` : ""}.</span>
            </div>
            {acct.plaidItemId && <AccountRefreshButton plaidItemId={acct.plaidItemId} onDone={onReload} />}
          </div>
        )}

        {acct.state === "zero_holdings" && (
          <div className="flex flex-col gap-2">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No individual holdings were reported for this account. Its balance is shown above.
            </p>
            {acct.plaidItemId && <AccountRefreshButton plaidItemId={acct.plaidItemId} onDone={onReload} />}
          </div>
        )}

        {(acct.state === "holdings" || (acct.state === "wallet" && (acct.positions.length > 0 || acct.cash))) && (
          <>
            <div className="divide-y divide-[var(--border-hairline)] border-t border-[var(--border-hairline)]">
              {positions.map((h) => <HoldingRow key={h.id} h={h} />)}
              {acct.cash && <CashRow cash={acct.cash} />}
            </div>
            {acct.positions.length > PREVIEW && (
              <button
                onClick={() => setExpanded((e) => !e)}
                className="flex items-center justify-center gap-1.5 w-full mt-2 pt-2 border-t text-sm font-medium transition-colors"
                style={{ borderColor: "var(--border-hairline)", color: "var(--meridian-400)" }}
              >
                {expanded ? <><ChevronUp size={15} /> Show less</> : <><ChevronDown size={15} /> Show {acct.positions.length - PREVIEW} more</>}
              </button>
            )}
            {acct.state === "holdings" && acct.plaidItemId && (
              <div className="mt-3 flex items-center justify-between gap-2">
                <p className="text-xs" style={{ color: "var(--text-faint)" }}>Cost basis and returns are not provided by this connection.</p>
                <AccountRefreshButton plaidItemId={acct.plaidItemId} onDone={onReload} />
              </div>
            )}
          </>
        )}

        {acct.state === "wallet" && acct.positions.length === 0 && !acct.cash && (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Balance shown above. Connect via an exchange to see individual holdings.
          </p>
        )}
      </div>
    </DataCard>
  );
}

// ── Widget ────────────────────────────────────────────────────────────────────
export function InvestmentAccountsWidget({ spaceId }: { spaceId: string }) {
  const [accounts, setAccounts] = useState<InvestmentAccountView[] | null>(null);
  const [error, setError] = useState(false);

  // Promise-chain (not async/await) so setState only ever runs inside an async
  // .then/.catch callback, never synchronously in the mount effect body —
  // mirrors the goals-workspace fetch pattern (react-hooks/set-state-in-effect).
  const load = useCallback(() => {
    fetch(`/api/spaces/${spaceId}/investments`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => {
        setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
        setError(false);
      })
      .catch(() => {
        setError(true);
        setAccounts([]);
      });
  }, [spaceId]);

  useEffect(() => { load(); }, [load]);

  if (accounts === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={18} className="animate-spin text-[var(--text-faint)]" />
      </div>
    );
  }

  if (error) {
    return (
      <DataCard>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Couldn’t load investments.</p>
          <button onClick={() => void load()} className="text-xs font-semibold text-[var(--meridian-400)] hover:underline">Retry</button>
        </div>
      </DataCard>
    );
  }

  if (accounts.length === 0) {
    return (
      <DataCard>
        <div className="py-6 text-center">
          <TrendingUp size={22} className="mx-auto text-[var(--text-faint)]" />
          <p className="mt-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>No investment accounts yet</p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            Connect a brokerage or exchange to see your holdings here.
          </p>
          <Link href="/dashboard/connections" className="mt-3 inline-block text-sm font-semibold text-[var(--meridian-400)] hover:underline">
            Connect an investment account →
          </Link>
        </div>
      </DataCard>
    );
  }

  return (
    <div className="space-y-3">
      {accounts.map((a) => <AccountCard key={a.accountId} acct={a} onReload={load} />)}
    </div>
  );
}
