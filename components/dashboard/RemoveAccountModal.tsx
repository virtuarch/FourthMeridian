"use client";

/**
 * RemoveAccountModal
 *
 * Shows all non-deleted accounts grouped by institution.
 * Each account has a Remove button that calls DELETE /api/accounts/:id
 * and refreshes the page on success.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Account } from "@/types";
import { X, AlertTriangle, Trash2, Loader2 } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassButton } from "@/components/atlas/GlassButton";

interface Props {
  accounts: Account[];
  onClose:  () => void;
}

export function RemoveAccountModal({ accounts, onClose }: Props) {
  const router = useRouter();
  const [confirmId, setConfirmId]   = useState<string | null>(null);
  const [removing,  setRemoving]    = useState<string | null>(null);
  const [error,     setError]       = useState<string | null>(null);

  // Group by institution
  const order:  string[]                    = [];
  const groups: Record<string, Account[]>  = {};
  accounts.forEach((a) => {
    if (!groups[a.institution]) { groups[a.institution] = []; order.push(a.institution); }
    groups[a.institution].push(a);
  });

  async function handleRemove(id: string) {
    setRemoving(id);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Remove failed");
      router.refresh();
      // If we just removed the last account, close the modal
      const remaining = accounts.filter((a) => a.id !== id);
      if (remaining.length === 0) onClose();
      setConfirmId(null);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setRemoving(null);
    }
  }

  const typeLabel: Record<string, string> = {
    checking:   "Checking",
    savings:    "Savings",
    investment: "Brokerage / IRA",
    crypto:     "Crypto",
    debt:       "Credit / Debt",
    other:      "Other",
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <GlassPanel
        depth="thick"
        elevation="e4"
        radius="xl"
        className="w-full sm:max-w-md max-h-[88dvh] flex flex-col"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex flex-col max-h-[88dvh]">
          {/* Header */}
          <div
            className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 shrink-0"
            style={{ borderBottom: "1px solid var(--border-hairline)" }}
          >
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Remove Account</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Historical data is preserved — only hidden from the dashboard.
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Account list */}
          <div className="overflow-y-auto flex-1 min-h-0 divide-y divide-[var(--border-hairline)]">
            {order.map((institution) => (
              <div key={institution}>
                {/* Institution label */}
                <div className="px-6 pt-3 pb-1">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded-[var(--radius-xs)] flex items-center justify-center shrink-0"
                      style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
                    >
                      <span className="text-xs font-bold text-[var(--text-secondary)]">{institution[0]}</span>
                    </div>
                    <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-widest">
                      {institution}
                    </p>
                  </div>
                </div>

                {/* Accounts under this institution */}
                {groups[institution].map((a) => {
                  const isConfirming = confirmId === a.id;
                  const isRemoving   = removing  === a.id;

                  return (
                    <div key={a.id} className="px-6 py-3">
                      {isConfirming ? (
                        /* ── Confirm strip ── */
                        <div
                          className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-3 py-2.5"
                          style={{ background: "rgba(237,82,71,.08)", border: "1px solid rgba(237,82,71,.22)" }}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <AlertTriangle size={14} className="text-[var(--coral-400)] shrink-0" />
                            <p className="text-sm text-[var(--coral-400)] truncate">
                              Remove <span className="font-semibold">{a.name}</span>?
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <GlassButton
                              tone="danger"
                              size="sm"
                              onClick={() => handleRemove(a.id)}
                              disabled={!!isRemoving}
                            >
                              {isRemoving ? <Loader2 size={11} className="animate-spin" /> : null}
                              Remove
                            </GlassButton>
                            <GlassButton
                              tone="neutral"
                              size="sm"
                              onClick={() => setConfirmId(null)}
                            >
                              Cancel
                            </GlassButton>
                          </div>
                        </div>
                      ) : (
                        /* ── Normal row ── */
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-[var(--text-primary)]">{a.name}</p>
                            <p className="text-xs text-[var(--text-muted)]">
                              {typeLabel[a.type] ?? a.type} ·{" "}
                              <span className="tabular-nums">
                                {new Intl.NumberFormat("en-US", {
                                  style: "currency",
                                  currency: DEFAULT_DISPLAY_CURRENCY,
                                  maximumFractionDigits: 0,
                                }).format(Math.abs(a.balance))}
                              </span>
                            </p>
                          </div>
                          <button
                            onClick={() => setConfirmId(a.id)}
                            className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--coral-400)] hover:bg-[rgba(237,82,71,.08)] border border-[var(--border-hairline-strong)] hover:border-[rgba(237,82,71,.3)] px-2.5 py-1.5 rounded-[var(--radius-sm)] transition-colors"
                          >
                            <Trash2 size={12} />
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Error */}
          {error && (
            <p
              className="text-xs text-[var(--coral-400)] text-center px-6 py-2 shrink-0"
              style={{ borderTop: "1px solid var(--border-hairline)" }}
            >
              {error}
            </p>
          )}

          {/* Footer */}
          <div className="px-6 py-4 shrink-0" style={{ borderTop: "1px solid var(--border-hairline)" }}>
            <GlassButton tone="neutral" fullWidth onClick={onClose}>
              Done
            </GlassButton>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
