"use client";

/**
 * components/platform/widgets/RemoveConnectionAction.tsx  (PB-5)
 *
 * "Remove connection" for ONE live connection, inside the Connection
 * diagnostics panel. Rendered only when the diagnostics response says the
 * viewer is a SYSTEM_ADMIN (`viewer.canRemove`, descriptive); the route is the
 * authority and re-checks with requireFreshSystemAdmin.
 *
 * The confirm dialog names the CUSTOMER (their Customer Success label when the
 * viewer can resolve it — a SYSTEM_ADMIN always can — else the opaque
 * reference) and the INSTITUTION, and requires a reason from the fixed list
 * before Confirm enables. The note is optional and capped at the envelope's
 * 280 characters (the server scrubs it again).
 */

import { useState } from "react";
import { Unplug } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { OwnerResolution } from "./connection-health-table";
import { REMOVAL_REASONS, REMOVAL_REASON_LABEL, REMOVAL_NOTE_MAX, type RemovalReason } from "@/lib/platform/connections/removal-reasons";
import type { RemoveConnectionResponse } from "@/app/api/platform/platform-ops/connections/[id]/remove/route";
import { outcomeLabel, removeConfirmMessage, removeConnectionRoute } from "./removed-connections-view";
import { BTN, BTN_NEUTRAL, FIELD } from "./policy-editor-kit";

export function RemoveConnectionAction({ connection, onRemoved }: {
  connection: { id: string; source: string; provider: "PLAID" | "WALLET"; ownerRef: string };
  onRemoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<RemovalReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function confirm() {
    if (!reason) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(removeConnectionRoute(connection.id), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ reason, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as (RemoveConnectionResponse & { error?: string }) | null;
      if (res.ok && body?.ok) {
        setMessage(`Removed — ${outcomeLabel(body.outcome)}. It now appears under Removed.`);
        setOpen(false);
        onRemoved();
      } else {
        setMessage(body?.error ?? `Remove failed (${res.status}).`);
      }
    } catch {
      setMessage("Remove failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Remove connection" className="flex flex-col gap-2 border-t border-[var(--border-hairline)] pt-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Remove connection</p>
      <p className="text-[11px] leading-snug text-[var(--text-muted)]">
        System administrators only. Runs the customer&apos;s own disconnect, is audited with your reason, and tells the customer.
      </p>
      <button type="button" className={BTN} style={BTN_NEUTRAL} onClick={() => { setOpen(true); setMessage(null); }}>
        <Unplug size={12} aria-hidden /> Remove connection
      </button>
      {message && <p role="status" className="text-[11px] text-[var(--text-secondary)]">{message}</p>}

      <OwnerResolution rows={[{ source: connection.provider, id: connection.id }]}>
        {(owners) => (
          <ConfirmDialog
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={confirm}
            title={`Remove ${connection.source}?`}
            icon={Unplug}
            confirmLabel="Remove connection"
            busy={busy}
            confirmDisabled={reason === ""}
            message={
              <div className="flex flex-col gap-2 text-left">
                <p>{removeConfirmMessage({ owner: owners?.get(`${connection.provider}:${connection.id}`) ?? connection.ownerRef, source: connection.source, provider: connection.provider })}</p>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-[var(--text-muted)]">Reason (required)</span>
                  <select className={FIELD} value={reason} onChange={(e) => setReason(e.target.value as RemovalReason | "")}>
                    <option value="">Choose a reason…</option>
                    {REMOVAL_REASONS.map((r) => <option key={r} value={r}>{REMOVAL_REASON_LABEL[r]}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-[var(--text-muted)]">Note (optional, {REMOVAL_NOTE_MAX} characters, no personal details)</span>
                  <textarea className={FIELD} rows={2} maxLength={REMOVAL_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
              </div>
            }
          />
        )}
      </OwnerResolution>
    </section>
  );
}
