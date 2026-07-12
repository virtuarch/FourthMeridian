"use client";

/**
 * components/connections/import/ImportHistoryButton.tsx
 *
 * A7-6 — the capability-aware "Import historical data" affordance on a
 * ConnectionCard. Rendered only when the connection can host an investment
 * import: a Plaid connection (not mid first-import) that owns at least one
 * investment/crypto account. Otherwise renders nothing — never misleading. Opens
 * the ImportHistoryWizard with the STABLE connection id (never a display label).
 *
 * Mirrors the EnableInvestmentsButton leaf pattern: a small styled button + its
 * own open/close state; the heavy wizard is lazy-mounted only when opened.
 */

import { useState } from "react";
import { FileUp } from "lucide-react";
import type { SyncConnection } from "@/lib/sync/status";
import type { AccountLite } from "@/components/connections/ConnectionCard";
import { ImportHistoryWizard } from "@/components/connections/import/ImportHistoryWizard";

const INVESTMENT_TYPES = new Set(["investment", "crypto"]);

export function ImportHistoryButton({ connection, accounts }: { connection: SyncConnection; accounts: AccountLite[] }) {
  const [open, setOpen] = useState(false);

  // Capability gate: Plaid connection, past first import, with an investment
  // account. (Import doesn't need a live provider session, so error/needs_reauth
  // still qualify — history import is provider-session-independent.)
  const eligible =
    connection.provider === "PLAID" &&
    connection.state !== "importing" &&
    accounts.some((a) => INVESTMENT_TYPES.has(a.type));
  if (!eligible) return null;

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs font-semibold text-[var(--meridian-400)] border border-[rgba(125,168,255,.3)] bg-[rgba(59,130,246,.08)] px-2.5 py-1 rounded-lg hover:bg-[rgba(59,130,246,.16)] transition-colors"
      >
        <FileUp size={12} />
        Import historical data
      </button>
      {open && <ImportHistoryWizard connectionId={connection.id} institution={connection.institution} onClose={() => setOpen(false)} />}
    </div>
  );
}
