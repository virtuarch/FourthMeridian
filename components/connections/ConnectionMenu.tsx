"use client";

/**
 * components/connections/ConnectionMenu.tsx  (CONN-4A)
 *
 * The per-connection ⋯ menu. Exposes the connection lifecycle honestly:
 *   - Refresh connection            (Plaid — reuses POST /api/plaid/refresh {plaidItemId})
 *   - Restore financial intelligence (reuses POST /api/connections/build-intelligence)
 *   - Disconnect <institution>       (CONN-4A — stop syncing, PRESERVE history)
 *
 * "Disconnect" is Model A only: reversible, non-destructive, honestly worded. There
 * is deliberately NO "Delete permanently" here (deferred). The confirm copy never
 * claims data is gone — historical values remain until a separate correction slice.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, RefreshCw, Sparkles, Unplug } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
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

  async function post(url: string, body: unknown) {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  }

  async function refresh() {
    setBusy("refresh"); setOpen(false);
    await post("/api/plaid/refresh", { plaidItemId: connection.id });
    setBusy(null);
    router.refresh();
  }

  async function restore() {
    setBusy("restore"); setOpen(false);
    await post("/api/connections/build-intelligence", { connectionIds: [connection.id] });
    setBusy(null);
    router.refresh();
  }

  async function disconnect() {
    setBusy("disconnect");
    await post(`/api/connections/${connection.id}/disconnect`, {});
    setBusy(null);
    setConfirmDisconnect(false);
    router.refresh();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Connection options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-[var(--radius-sm)] p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2,rgba(255,255,255,0.04))] hover:text-[var(--text-primary)]"
      >
        <MoreHorizontal size={18} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-1,#161a22)] py-1 shadow-lg"
        >
          {isPlaid && <MenuItem icon={RefreshCw} label="Refresh connection" onClick={refresh} disabled={busy !== null} />}
          <MenuItem icon={Sparkles} label="Restore financial intelligence" onClick={restore} disabled={busy !== null} />
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
