"use client";

/**
 * RefreshButton
 *
 * Calls POST /api/plaid/refresh — the one reusable refresh pipeline
 * (lib/plaid/refresh.ts) that also backs the future daily cron job and
 * webhook handler. On success, calls router.refresh() so the Server
 * Component data on the current page (balances, transactions, holdings)
 * re-fetches without a full reload.
 *
 * Cooldown honesty (D2 Step 7B): the refresh/cooldown logic lives in the shared
 * useManualRefresh hook, so a 200 where every item was skipped for being on its
 * manual-refresh cooldown no longer shows a false "Synced ✓" — it shows a
 * temporary cooldown banner instead. The sidebar Refresh Data row reuses the
 * same hook.
 */

import { useManualRefresh } from "@/components/plaid/useManualRefresh";
import { Loader2, RefreshCw, Check, AlertTriangle, Clock } from "lucide-react";

interface Props {
  label?: string;
  className?: string;
  /** M3-Reset — prototype header language: render icon-only (no text), status
   *  conveyed via tooltip/aria-label. Used by the desktop shell header. */
  iconOnly?: boolean;
  /**
   * SHELL migration — GlobalHeader language: a BORDERLESS icon button (no glass
   * pill, no lift), just an icon that tints/spins on hover, matching the
   * prototype AppBar's utility buttons. Implies iconOnly. Keeps the canonical
   * cooldown pipeline (useManualRefresh) as the single source of truth.
   */
  bare?: boolean;
}

export function RefreshButton({ label = "Refresh", className = "", iconOnly = false, bare = false }: Props) {
  const { phase, banner, run } = useManualRefresh();

  const isError    = phase === "error";
  const isCooldown = phase === "cooldown";
  const icon = iconOnly || bare;

  const statusText =
    phase === "loading" ? "Refreshing…"
    : phase === "done" ? "Synced"
    : phase === "partial" ? "Partial sync"
    : phase === "cooldown" ? "On cooldown"
    : isError ? "Failed — retry"
    : label;

  const bareCls = `flex items-center justify-center rounded-[var(--radius-sm)] p-2 transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed ${
    isError
      ? "text-[var(--coral-400)] hover:bg-[rgba(237,82,71,.10)]"
      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
  } ${className}`;

  const pillCls = `flex items-center gap-1.5 text-xs border rounded-[var(--radius-sm)] ${iconOnly ? "px-2 py-2" : "px-3 py-1.5"} backdrop-blur-xl transition-[transform,background-color,border-color] duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:-translate-y-[1px] active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:active:scale-100 ${
    isError
      ? "text-[var(--coral-400)] border-[rgba(237,82,71,.3)] bg-[rgba(237,82,71,.08)] hover:bg-[rgba(237,82,71,.14)]"
      : "text-[var(--text-secondary)] border-[var(--border-hairline)] bg-[var(--glass-ultrathin)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] hover:border-[var(--border-hairline-strong)]"
  } ${className}`;

  return (
    <div className="relative inline-flex">
      <button
        onClick={run}
        disabled={phase === "loading"}
        aria-label={icon ? statusText : undefined}
        title={icon ? statusText : undefined}
        className={bare ? bareCls : pillCls}
      >
        {phase === "loading" && <Loader2 size={13} className="animate-spin shrink-0" />}
        {(phase === "done" || phase === "partial") && <Check size={13} className="shrink-0 text-[var(--emerald-400)]" />}
        {phase === "error" && <AlertTriangle size={13} className="shrink-0" />}
        {isCooldown && <Clock size={13} className="shrink-0 text-[var(--text-muted)]" />}
        {phase === "idle" && <RefreshCw size={bare ? 14 : 13} strokeWidth={bare ? 1.75 : undefined} className="shrink-0" />}
        {!icon && <span>{statusText}</span>}
      </button>

      {banner && (
        <div
          role="status"
          className="absolute top-full right-0 mt-1.5 z-20 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] backdrop-blur-xl shadow-[0_6px_18px_rgba(0,0,0,.18)]"
        >
          {banner}
        </div>
      )}
    </div>
  );
}
