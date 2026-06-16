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
      className={`flex items-center gap-1.5 text-xs border rounded-lg px-3 py-1.5 transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
        isError
          ? "text-red-400 border-red-700/50 hover:border-red-500"
          : "text-gray-400 border-gray-700 hover:text-white hover:border-gray-500"
      } ${className}`}
    >
      {status === "loading" && <Loader2 size={13} className="animate-spin shrink-0" />}
      {status === "done" && <Check size={13} className="shrink-0 text-green-400" />}
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
