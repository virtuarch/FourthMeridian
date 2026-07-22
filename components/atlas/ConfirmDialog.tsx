"use client";

/**
 * components/atlas/ConfirmDialog.tsx
 *
 * Thin preset over Dialog for destructive / decision confirmations: a
 * centered icon badge + title + message, with a Cancel / Confirm action bar.
 * role="alertdialog" — the correct a11y role for an "are you sure" that
 * guards a destructive action. Part of the Atlas Glass Modal Doctrine
 * confirmation family (Phase 4); additive, sits over Dialog → OverlaySurface.
 *
 * Behaviour comes from the primitive: portal, scrim, focus-trap, body-scroll-
 * lock, panel height cap, and Escape/backdrop dismissal (blocked while
 * `busy`). Actions use the canonical GlassButton (danger tone by default for
 * the destructive action).
 */

import { ReactNode, ElementType } from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "@/components/atlas/Dialog";
import { GlassButton, GlassButtonTone } from "@/components/atlas/GlassButton";

export interface ConfirmDialogProps {
  /** Controlled visibility. Defaults to true for the conditional-mount pattern. */
  open?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message?: ReactNode;
  /** Optional badge icon, rendered in a tinted circle above the title. */
  icon?: ElementType;
  /** Optional icon shown inside the confirm button (replaced by a spinner while busy). */
  confirmIcon?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** GlassButton tone for the confirm action. "danger" (default) for destructive. */
  confirmTone?: GlassButtonTone;
  /** Blocks dismissal (Escape/backdrop) and disables actions while an async commit runs. */
  busy?: boolean;
}

export function ConfirmDialog({
  open = true,
  onClose,
  onConfirm,
  title,
  message,
  icon: Icon,
  confirmIcon,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmTone = "danger",
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={title}
      hideHeader
      size="sm"
      role="alertdialog"
      preventClose={busy}
      footer={
        <div className="flex gap-2">
          <GlassButton tone="neutral" fullWidth onClick={onClose} disabled={busy}>
            {cancelLabel}
          </GlassButton>
          <GlassButton tone={confirmTone} fullWidth onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : confirmIcon}
            {confirmLabel}
          </GlassButton>
        </div>
      }
    >
      <div className="text-center">
        {Icon && (
          <div className="w-12 h-12 rounded-2xl bg-[rgba(237,82,71,.1)] border border-[rgba(237,82,71,.2)] flex items-center justify-center mx-auto mb-4">
            <Icon size={20} className="text-[var(--accent-negative)]" />
          </div>
        )}
        <h2 className="text-base font-semibold text-[var(--text-primary)] mb-1">{title}</h2>
        {message && (
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{message}</p>
        )}
      </div>
    </Dialog>
  );
}
