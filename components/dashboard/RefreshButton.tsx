"use client";

/**
 * RefreshButton
 *
 * Calls POST /api/plaid/refresh — the one reusable refresh pipeline
 * (lib/plaid/refresh.ts) that also backs the future daily cron job and
 * webhook handler. On success, calls router.refresh() so the Server
 * Component data on the current page (balances, transactions, holdings)
 * re-fetches without a full reload.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Check, AlertTriangle } from "lucide-react";

interface Props {
  label?: string;
  className?: string;
}

type Status = "idle" | "loading" | "done" | "error";

export function RefreshButton({ label = "Refresh", className = "" }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");

  async function handleClick() {
    if (status === "loading") return;
    setStatus("loading");
    try {
      const res = await fetch("/api/plaid/refresh", { method: "POST" });
      if (!res.ok) throw new Error("Refresh failed");
      setStatus("done");
      router.refresh();
    } catch (e) {
      console.error("[RefreshButton] refresh failed:", e);
      setStatus("error");
    } finally {
      setTimeout(() => setStatus("idle"), 2500);
    }
  }

  const isError = status === "error";

  return (
    <button
      onClick={handleClick}
      disabled={status === "loading"}
      className={`flex items-center gap-1.5 text-xs border rounded-[var(--radius-sm)] px-3 py-1.5 backdrop-blur-xl transition-[transform,background-color,border-color] duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:-translate-y-[1px] active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:active:scale-100 ${
        isError
          ? "text-[var(--coral-400)] border-[rgba(237,82,71,.3)] bg-[rgba(237,82,71,.08)] hover:bg-[rgba(237,82,71,.14)]"
          : "text-[var(--text-secondary)] border-[var(--border-hairline)] bg-[var(--glass-ultrathin)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] hover:border-[var(--border-hairline-strong)]"
      } ${className}`}
    >
      {status === "loading" && <Loader2 size={13} className="animate-spin shrink-0" />}
      {status === "done" && <Check size={13} className="shrink-0 text-[var(--emerald-400)]" />}
      {status === "error" && <AlertTriangle size={13} className="shrink-0" />}
      {status === "idle" && <RefreshCw size={13} className="shrink-0" />}
      <span>
        {status === "loading"
          ? "Refreshing…"
          : status === "done"
          ? "Synced"
          : status === "error"
          ? "Failed — retry"
          : label}
      </span>
    </button>
  );
}
