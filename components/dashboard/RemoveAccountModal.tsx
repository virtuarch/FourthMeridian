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
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center px-4 pt-4 pb-40 sm:p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl shadow-2xl overflow-hidden max-h-[calc(100dvh-180px)] sm:max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-white">Remove Account</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Historical data is preserved — only hidden from the dashboard.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-500 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Account list */}
        <div className="overflow-y-auto max-h-[60vh] divide-y divide-gray-800/60">
          {order.map((institution) => (
            <div key={institution}>
              {/* Institution label */}
              <div className="px-5 pt-3 pb-1">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-gray-700 to-gray-600 flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-white">{institution[0]}</span>
                  </div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                    {institution}
                  </p>
                </div>
              </div>

              {/* Accounts under this institution */}
              {groups[institution].map((a) => {
                const isConfirming = confirmId === a.id;
                const isRemoving   = removing  === a.id;

                return (
                  <div key={a.id} className="px-5 py-3">
                    {isConfirming ? (
                      /* ── Confirm strip ── */
                      <div className="flex items-center justify-between gap-3 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <AlertTriangle size={14} className="text-red-400 shrink-0" />
                          <p className="text-sm text-red-300 truncate">
                            Remove <span className="font-semibold">{a.name}</span>?
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => handleRemove(a.id)}
                            disabled={!!isRemoving}
                            className="flex items-center gap-1 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 disabled:opacity-60 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            {isRemoving ? <Loader2 size={11} className="animate-spin" /> : null}
                            Remove
                          </button>
                          <button
                            onClick={() => setConfirmId(null)}
                            className="text-xs font-medium text-gray-400 hover:text-white border border-gray-700 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* ── Normal row ── */
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-white">{a.name}</p>
                          <p className="text-xs text-gray-500">
                            {typeLabel[a.type] ?? a.type} ·{" "}
                            <span className="tabular-nums">
                              {new Intl.NumberFormat("en-US", {
                                style: "currency",
                                currency: "USD",
                                maximumFractionDigits: 0,
                              }).format(Math.abs(a.balance))}
                            </span>
                          </p>
                        </div>
                        <button
                          onClick={() => setConfirmId(a.id)}
                          className="flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-red-400 hover:bg-red-500/10 border border-gray-700 hover:border-red-500/30 px-2.5 py-1.5 rounded-lg transition-colors"
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
          <p className="text-xs text-red-400 text-center px-5 py-2 border-t border-gray-800">
            {error}
          </p>
        )}

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-800">
          <button
            onClick={onClose}
            className="w-full text-sm font-medium text-gray-400 hover:text-white border border-gray-700 py-2.5 rounded-xl transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
