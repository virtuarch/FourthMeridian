"use client";

/**
 * RemoveAccountButton
 *
 * Page-level trigger for RemoveAccountModal, scoped to /dashboard/accounts.
 * Previously this trigger + modal were duplicated in the Banking and
 * Investments tab headers — moved here since account removal is account
 * management, not a banking- or investment-specific action. `accounts` is
 * the full cross-type list (Plaid, manual, wallet — anything the workspace
 * shares to the current user via WorkspaceAccountShare), same shape
 * RemoveAccountModal already expected.
 */

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { RemoveAccountModal } from "@/components/dashboard/RemoveAccountModal";
import { Account } from "@/types";

interface Props {
  accounts: Account[];
}

export function RemoveAccountButton({ accounts }: Props) {
  const [showRemoveModal, setShowRemoveModal] = useState(false);

  if (accounts.length === 0) return null;

  return (
    <>
      {showRemoveModal && (
        <RemoveAccountModal
          accounts={accounts}
          onClose={() => setShowRemoveModal(false)}
        />
      )}
      <button
        onClick={() => setShowRemoveModal(true)}
        className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-red-400 border border-gray-700 hover:border-red-500/40 bg-gray-900 hover:bg-red-500/10 px-3 py-2 rounded-xl transition-colors"
      >
        <Trash2 size={13} />
        Remove
      </button>
    </>
  );
}
