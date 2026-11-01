"use client";

/**
 * components/platform/ui/ControlledActionSurface.tsx  (Platform Operations 2.0 — R1 primitive)
 *
 * Deliberate actions, never casual buttons. Each action is LISTED with what it
 * does and the authority it needs; its only inline control is "Review…", which
 * opens the Atlas ConfirmDialog. The commit button exists ONLY inside that
 * dialog — this primitive renders no destructive button inline.
 *
 * R2 — an action may instead `opens` a deliberate surface (a DetailDrawer that
 * hosts an existing, fully gated widget — e.g. Manual operations with its own
 * reason + confirmation + audit). Its only inline control is then that opener
 * ("Run an operation…"); it still commits nothing inline.
 *
 * `requireReason` embeds the shared OperatorReasonField in the dialog and keeps
 * the confirm disabled until a reason code is chosen; the payload is handed to
 * `onConfirm`. An action the operator may not run is listed with its
 * `unavailableReason` and no opener at all. Authority stays server-side: the
 * caller's route decides; this only sequences the operator's intent.
 */

import { useState } from "react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { Surface } from "@/components/atlas/Surface";
import {
  EMPTY_OPERATOR_REASON,
  OperatorReasonField,
  reasonPayload,
  type OperatorReasonFieldCode,
  type OperatorReasonValue,
} from "@/components/platform/widgets/OperatorReasonField";

export interface ControlledAction {
  id: string;
  label: string;
  /** One line: what happens. */
  description: string;
  /** The authority it needs, in words ("Requires write access"). */
  authority: string;
  /** Present for a confirm-in-place action; absent for an `opens` action. */
  confirm?: { title: string; message: string; confirmLabel: string; destructive?: boolean };
  requireReason?: boolean;
  /** When set the action is listed but cannot be opened. */
  unavailableReason?: string | null;
  onConfirm?: (reason: { code: OperatorReasonFieldCode; note?: string } | null) => Promise<void> | void;
  /** R2 — open a deliberate surface instead (a drawer hosting a gated widget). */
  opens?: { label: string; onOpen: () => void };
}

export function ControlledActionSurface({ title, actions }: { title: string; actions: readonly ControlledAction[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [busy, setBusy] = useState(false);
  const open = actions.find((a) => a.id === openId) ?? null;

  const close = () => {
    if (busy) return;
    setOpenId(null);
    setReason(EMPTY_OPERATOR_REASON);
  };
  const commit = async () => {
    if (!open?.onConfirm) return;
    const payload = reasonPayload(reason);
    if (open.requireReason && !payload) return;
    setBusy(true);
    try {
      await open.onConfirm(payload);
    } catch {
      // The caller reports its own failure (its route's refusal, its toast);
      // the dialog closes either way so nothing is retried by accident.
    } finally {
      setBusy(false);
      setOpenId(null);
      setReason(EMPTY_OPERATOR_REASON);
    }
  };

  return (
    <Surface as="section" className="flex flex-col gap-2 p-4 sm:p-5">
      <h2 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h2>
      <ul className="flex flex-col divide-y divide-[var(--border-hairline)]">
        {actions.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-[var(--text-primary)]">{a.label}</span>
              <span className="text-xs text-[var(--text-secondary)]">{a.description}</span>
              <span className="text-[11px] text-[var(--text-muted)]">{a.authority}</span>
            </span>
            {a.unavailableReason ? (
              <span className="text-[11px] text-[var(--text-muted)]">{a.unavailableReason}</span>
            ) : a.opens ? (
              <button
                type="button"
                onClick={a.opens.onOpen}
                aria-haspopup="dialog"
                className="min-h-11 rounded-[var(--radius-sm)] border border-[var(--border-hairline-strong)] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
              >
                {a.opens.label}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setOpenId(a.id)}
                aria-haspopup="dialog"
                aria-label={`Review ${a.label}`}
                className="min-h-11 rounded-[var(--radius-sm)] border border-[var(--border-hairline-strong)] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
              >
                Review…
              </button>
            )}
          </li>
        ))}
      </ul>
      {open?.confirm && (
        <ConfirmDialog
          open
          onClose={close}
          onConfirm={commit}
          title={open.confirm.title}
          message={
            open.requireReason ? (
              <>
                <p>{open.confirm.message}</p>
                <OperatorReasonField value={reason} onChange={setReason} disabled={busy} />
              </>
            ) : open.confirm.message
          }
          confirmLabel={open.confirm.confirmLabel}
          confirmTone={open.confirm.destructive ? "danger" : "meridian"}
          busy={busy}
          confirmDisabled={open.requireReason === true && reasonPayload(reason) === null}
        />
      )}
    </Surface>
  );
}
