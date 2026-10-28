"use client";

/**
 * components/connections/ConnectionMenu.tsx  (CONN-4A)
 *
 * The per-connection ⋯ menu. Exposes the connection lifecycle honestly:
 *   - Refresh connection            (Plaid — reuses POST /api/plaid/refresh {plaidItemId})
 *   (No customer "rebuild" action: rebuilding derived history is not a
 *   customer chore. It runs automatically after syncs, history imports and the
 *   background worker — owner directive 2026-10-28.)
 *   - Disconnect <institution>       (CONN-4A — stop syncing, PRESERVE history)
 *
 * "Disconnect" is Model A only: reversible, non-destructive, honestly worded. There
 * is deliberately NO "Delete permanently" here (deferred). The confirm copy never
 * claims data is gone — historical values remain until a separate correction slice.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, RefreshCw, Unplug } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { connectionActionError } from "@/lib/connections/action-errors";
import type { SyncConnection } from "@/lib/sync/status";
import type { LucideIcon } from "lucide-react";

function MenuItem({ icon: Icon, label, onClick, disabled, danger }: {
  icon: LucideIcon; label: string; onClick: () => void; disabled: boolean; danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-2,rgba(255,255,255,0.04))] disabled:opacity-50 ${danger ? "text-[var(--accent-warning,#f59e0b)]" : "text-[var(--text-secondary)]"}`}
    >
      <Icon size={15} className="shrink-0" />
      {label}
    </button>
  );
}

export function ConnectionMenu({ connection }: { connection: SyncConnection }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState<null | "refresh" | "restore" | "disconnect">(null);
  // UI-006: a failed action is said out loud, never swallowed into a silent refresh.
  const [failure, setFailure] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isPlaid = connection.provider === "PLAID";

  /** UI-006 — resolves to null on success, or the message to show on failure. Never throws. */
  async function post(url: string, body: unknown): Promise<string | null> {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null) as { error?: unknown; enabled?: unknown } | null;
      // The rebuild route answers 200 {enabled:false} when rebuilding is switched
      // off. That is a refusal, not a success — say so instead of going quiet.
      if (res.ok && data?.enabled === false) return "Rebuilding is unavailable right now. Your existing history is unchanged.";
      if (res.ok) return null;
      return connectionActionError(data?.error) ?? `The request failed (${res.status}).`;
    } catch {
      return "Could not reach Fourth Meridian. Check your connection and try again.";
    }
  }

  async function refresh() {
    setBusy("refresh"); setOpen(false);
    setFailure(null);
    const err = await post("/api/plaid/refresh", { plaidItemId: connection.id });
    if (err) setFailure(err);
    setBusy(null);
    router.refresh();
  }

  async function disconnect() {
    setBusy("disconnect");
    setFailure(null);
    const err = await post(`/api/connections/${connection.id}/disconnect`, {});
    if (err) setFailure(err);
    setBusy(null);
    setConfirmDisconnect(false);
    router.refresh();
  }

  return (
    <div ref={rootRef} className="relative">
      {failure && (
        <p role="alert" aria-live="assertive" data-connection-failure
          className="absolute right-0 top-full z-10 mt-1 w-64 rounded-[var(--radius-sm)] border border-[rgba(248,113,113,.3)] bg-[var(--surface-1,#161a22)] px-2 py-1.5 text-[11px] text-[var(--danger-400,#f87171)]">
          {failure}
        </p>
      )}
      <button
        type="button"
        aria-label="Connection options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // 44px touch target (WCAG 2.5.5) — the icon stays 18px.
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] hover:bg-[var(--surface-2,rgba(255,255,255,0.04))] hover:text-[var(--text-primary)]"
      >
        <MoreHorizontal size={18} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-1,#161a22)] py-1 shadow-lg"
        >
          {isPlaid && <MenuItem icon={RefreshCw} label="Refresh connection" onClick={refresh} disabled={busy !== null} />}
          <div className="my-1 h-px bg-[var(--border-hairline)]" />
          <MenuItem icon={Unplug} label={`Disconnect ${connection.institution}`} onClick={() => { setOpen(false); setConfirmDisconnect(true); }} disabled={busy !== null} danger />
        </div>
      )}

      {confirmDisconnect && (
        <ConfirmDialog
          icon={Unplug}
          title={`Disconnect ${connection.institution}?`}
          message={
            <>
              Fourth Meridian will stop receiving updates from {connection.institution}.
              Your existing financial history will remain available. You can reconnect anytime.
            </>
          }
          confirmLabel="Disconnect"
          confirmTone="meridian"
          busy={busy === "disconnect"}
          onConfirm={disconnect}
          onClose={() => setConfirmDisconnect(false)}
        />
      )}
    </div>
  );
}
