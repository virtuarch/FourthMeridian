"use client";

/**
 * components/connections/ManualAssetMenu.tsx  (Connections 2.0 — real assets)
 *
 * The ⋯ menu for one manual asset, the ConnectionMenu pattern (outside click
 * and Escape close it; every action is said out loud when it fails). Every
 * action REUSES an existing, owner-gated route — there is no new write path:
 *
 *   Edit details     PATCH /api/accounts/[id] { displayName }   (rename — the only
 *                    detail an existing route can change; acquisition facts are
 *                    fixed at creation and say so)
 *   Update valuation PATCH /api/accounts/manual/[id] { balance, effectiveDate }
 *                    via the existing UpdateAssetValueModal (append-only ledger)
 *   Remove           DELETE /api/accounts/manual/[id] — the archive, with its
 *                    safeguards (every Space link revoked, history kept, restorable)
 *
 * After each success the server page is re-read (router.refresh()).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, MoreHorizontal, PencilLine, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";
import { UpdateAssetValueModal } from "@/components/space/widgets/wealth/UpdateAssetValueModal";
import { removeAssetMessage, type ManualAssetLite } from "@/lib/connections/real-assets.core";

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-2,rgba(255,255,255,0.04))] focus-visible:outline-none focus-visible:bg-[var(--surface-2,rgba(255,255,255,0.04))] ${danger ? "text-[var(--accent-warning,#f59e0b)]" : "text-[var(--text-secondary)]"}`}
    >
      <Icon size={15} className="shrink-0" />
      {label}
    </button>
  );
}

/** Rename — the one detail field an existing route (PATCH /api/accounts/[id]) can change. */
function EditAssetDetailsModal({ asset, onClose, onSaved }: { asset: ManualAssetLite; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(asset.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function save() {
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(asset.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: trimmed }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(data.error ?? "Couldn't save the name. Please try again."); return; }
      onSaved();
      onClose();
    } catch {
      setError("Could not reach Fourth Meridian. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      open
      onClose={() => { if (!saving) onClose(); }}
      title="Edit details"
      subtitle={asset.name}
      size="sm"
      preventClose={saving}
      footer={
        <div className="space-y-3">
          {error && <p className="text-center text-xs text-[var(--coral-400)]" role="alert">{error}</p>}
          <GlassButton onClick={save} disabled={saving || !trimmed || trimmed === asset.name} tone="meridian" fullWidth>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {saving ? "Saving…" : "Save"}
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-2">
        <label htmlFor="asset-name" className="block text-xs font-medium text-[var(--text-secondary)]">Name</label>
        <input
          id="asset-name"
          type="text"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] transition-colors focus:outline-none"
          style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
          autoFocus
        />
        <p className="text-xs text-[var(--text-muted)]">
          The purchase price and acquisition date are kept as you entered them when you added the asset. To change its
          value, use Update valuation.
        </p>
      </div>
    </FormModal>
  );
}

export function ManualAssetMenu({ asset }: { asset: ManualAssetLite }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "edit" | "value" | "remove">(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (d: "edit" | "value" | "remove") => () => { setOpen(false); setRemoveError(null); setDialog(d); };

  async function remove() {
    setBusy(true);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/accounts/manual/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setRemoveError(data.error ?? "Couldn't remove this asset. Please try again."); return; }
      setDialog(null);
      router.refresh();
    } catch {
      setRemoveError("Could not reach Fourth Meridian. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Options for ${asset.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] hover:bg-[var(--surface-2,rgba(255,255,255,0.04))] hover:text-[var(--text-primary)]"
      >
        <MoreHorizontal size={18} />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-1,#161a22)] py-1 shadow-lg">
          <MenuItem icon={PencilLine} label="Edit details" onClick={choose("edit")} />
          <MenuItem icon={TrendingUp} label="Update valuation" onClick={choose("value")} />
          <div className="my-1 h-px bg-[var(--border-hairline)]" />
          <MenuItem icon={Archive} label="Remove" onClick={choose("remove")} danger />
        </div>
      )}

      {dialog === "edit" && <EditAssetDetailsModal asset={asset} onClose={() => setDialog(null)} onSaved={() => router.refresh()} />}

      {dialog === "value" && (
        <UpdateAssetValueModal
          accountId={asset.id}
          name={asset.name}
          currency={asset.currency}
          currentValue={asset.value}
          acquisitionDate={asset.acquisitionDateISO}
          onClose={() => setDialog(null)}
          onSaved={() => router.refresh()}
        />
      )}

      {dialog === "remove" && (
        <ConfirmDialog
          icon={Archive}
          title={`Remove ${asset.name}?`}
          message={
            <span>
              {removeAssetMessage(asset.name)}
              {removeError && <span className="mt-2 block text-[var(--coral-400)]" role="alert">{removeError}</span>}
            </span>
          }
          confirmLabel="Remove"
          busy={busy}
          onConfirm={remove}
          onClose={() => { if (!busy) setDialog(null); }}
        />
      )}
    </div>
  );
}
