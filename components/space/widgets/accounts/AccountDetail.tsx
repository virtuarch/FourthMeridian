"use client";

/**
 * components/space/widgets/accounts/AccountDetail.tsx
 *
 * The per-account DETAIL body, shown inside the Accounts ledger's RightPanel (the
 * Atlas panel primitive — "tell me more about what I selected"). The Accounts
 * analogue of SourceAccountDetail / DebtAccountDetail: it leads with the customer's
 * ACCOUNT FACTS (identity, balance, where it lives, how it's connected) and stays
 * honest about visibility and what isn't tracked.
 *
 * PCS-2 BOUNDARY (held exactly as AccountsPerspective held it): Accounts is the
 * Space-scoped financial-object surface. This panel NEVER manages credentials, sync,
 * or provider auth — no reauth, no Plaid controls, no sync settings. It only MATCHES
 * the three-state health language and links OUT to the separate Connections surface
 * for anything provider-management-shaped. The management actions (Rename, Remove
 * from Space, View transactions) are the SAME endpoints and behaviour the former
 * AccountsPerspective row carried — relocated into the detail panel, not reinvented.
 *
 * HONESTY: the balance figure is display-converted with the SAME authority the rest
 * of the workspace uses (`toDisplay` mirror over convertMoney), and the native amount
 * is shown alongside when it differs. BALANCE_ONLY aggregate rows carry a synthetic
 * id, no identity, and no owner context — so they expose balance + type only and
 * carry NO management actions, exactly as the detail read neutralised them.
 */

import { useState } from "react";
import Link from "next/link";
import {
  CheckCircle2, AlertTriangle, Loader2, Pencil, X, ArrowUpRight, Cable,
} from "lucide-react";
import { SPACE_ACCOUNTS_CHANGED_EVENT } from "@/lib/space-nav";
import { formatCurrency } from "@/lib/format";
import type { AccountDetailRow } from "@/app/api/spaces/[id]/accounts/detail/route";
import { ACCOUNT_TYPE_LABELS, healthChip } from "./AccountsPerspective";

/** A converted balance the ledger already computed — the panel and the row can
 *  never disagree because both read this same display value. */
export interface AccountDisplay {
  amount:    number;
  estimated: boolean;
}

function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-xs text-[var(--text-faint)]">{label}</span>
      <span className="text-sm tabular-nums text-right text-[var(--text-secondary)]">{value}</span>
    </div>
  );
}

/** The connection-health line, in the ledger's own words — reuses the exact three
 *  states ConnectionCard established; a manual account (null state) says so plainly
 *  rather than fabricating a "healthy". */
function StatusValue({ row }: { row: AccountDetailRow }) {
  const chip = healthChip(row.connectionState);
  if (chip) {
    const color =
      chip.tone === "positive" ? "var(--accent-positive)"
      : chip.tone === "warning" ? "var(--accent-warning)"
      : "var(--text-muted)";
    const Icon = chip.tone === "positive" ? CheckCircle2 : chip.tone === "warning" ? AlertTriangle : Loader2;
    return (
      <span className="inline-flex items-center gap-1" style={{ color }}>
        <Icon size={12} className={chip.tone === "muted" ? "animate-spin" : ""} aria-hidden />
        {chip.label}
      </span>
    );
  }
  return <span className="text-[var(--text-muted)]">{row.isManual ? "Manual" : "—"}</span>;
}

export function AccountDetail({
  row, display, currency, spaceId, onChanged,
}: {
  row:       AccountDetailRow;
  display:   AccountDisplay;
  /** Display (target) currency — the workspace's conversion target. */
  currency:  string;
  spaceId:   string;
  onChanged: () => void;
}) {
  const [renaming,  setRenaming]  = useState(false);
  const [nameDraft, setNameDraft] = useState(row.name);
  const [busy,      setBusy]      = useState<"rename" | "remove" | null>(null);
  const [error,     setError]     = useState("");

  const isFull   = row.visibility === "FULL";
  const foreign  = row.currency !== currency;
  const approx   = display.estimated ? "≈ " : "";
  const typeLabel = ACCOUNT_TYPE_LABELS[row.type] ?? row.type;
  const imports  = row.importBatchCount;

  // Rename = PATCH the account displayName. Same endpoint and optimistic reload
  // the former AccountsPerspective row used.
  async function saveRename() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === row.name) { setRenaming(false); return; }
    setBusy("rename"); setError("");
    try {
      const res = await fetch(`/api/accounts/${row.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ displayName: trimmed }),
      });
      if (!res.ok) throw new Error("rename failed");
      setRenaming(false);
      onChanged();
    } catch {
      setError("Couldn't rename. Try again.");
    } finally {
      setBusy(null);
    }
  }

  // Remove from Space = revoke the SpaceAccountLink (status → REVOKED) — the
  // established reversible revoke-don't-delete pattern; re-sharing re-activates.
  async function removeFromSpace() {
    setBusy("remove"); setError("");
    try {
      const res = await fetch(`/api/spaces/${spaceId}/accounts/share`, {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ financialAccountId: row.id }),
      });
      if (!res.ok) throw new Error("revoke failed");
      window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
      onChanged();
    } catch {
      setError("Couldn't remove. Try again.");
      setBusy(null);
    }
  }

  return (
    <div className="min-w-0">
      {/* Headline balance — display-converted; native shown alongside when different. */}
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Current balance</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
        {approx}{formatCurrency(display.amount, currency)}
      </p>
      {foreign && (
        <p className="mt-1 tabular-nums text-xs text-[var(--text-muted)]">
          {formatCurrency(row.balance, row.currency)} native
        </p>
      )}

      {/* Rename affordance sits under the balance so the identity is editable in
          place; FULL rows only (aggregated BALANCE_ONLY rows have no single owner). */}
      {isFull && (
        <div className="mt-3">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") { setRenaming(false); setNameDraft(row.name); } }}
                className="min-w-0 flex-1 border-b border-[var(--border-hairline-strong)] bg-transparent text-sm text-[var(--text-primary)] focus:border-[var(--meridian-400)] focus:outline-none"
              />
              <ActionButton onClick={saveRename} disabled={busy === "rename"}>
                {busy === "rename" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Save
              </ActionButton>
              <ActionButton onClick={() => { setRenaming(false); setNameDraft(row.name); }}>Cancel</ActionButton>
            </div>
          ) : (
            <ActionButton onClick={() => setRenaming(true)}>
              <Pencil size={12} /> Rename account
            </ActionButton>
          )}
        </div>
      )}

      {/* Facts — the honest account identity. */}
      <div className="mt-5 divide-y divide-[var(--border-hairline)] border-t border-[var(--border-hairline)]">
        <FactRow label="Type" value={typeLabel} />
        {row.institution && <FactRow label="Institution" value={row.institution} />}
        {isFull && row.mask && <FactRow label="Account" value={`••••${row.mask}`} />}
        <FactRow label="Currency" value={row.currency} />
        <FactRow label="Status" value={<StatusValue row={row} />} />
        <FactRow label="Visibility" value={isFull ? "Full detail" : "Balance only"} />
        {isFull && imports > 0 && (
          <FactRow label="Historical imports" value={`${imports} import${imports === 1 ? "" : "s"}`} />
        )}
      </div>

      {/* Actions — only real, verified-to-exist destinations, FULL rows only. There
          is no per-account detail page, so that navigation is deliberately omitted.
          A plain <a> (full navigation) so the shell re-reads ?tab=/?account= on mount. */}
      {isFull && (
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <a
            href={`/dashboard?tab=transactions&account=${encodeURIComponent(row.id)}`}
            className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            <ArrowUpRight size={13} /> View transactions
          </a>
          <ActionButton onClick={removeFromSpace} disabled={busy === "remove"} danger>
            {busy === "remove" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} Remove from Space
          </ActionButton>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-[var(--coral-400)]">{error}</p>}

      {/* PCS-2: credentials / sync / provider auth live in the SEPARATE Connections
          surface. Accounts never manages them — it links out. */}
      {isFull && (
        <Link
          href="/dashboard/connections"
          className="mt-5 inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          <Cable size={13} /> Manage connection in Connections →
        </Link>
      )}

      {/* Honest scope note — per-account balance history isn't carried by this read. */}
      <p className="mt-5 text-[11px] leading-snug text-[var(--text-faint)]">
        {isFull
          ? "Balance is current. Per-account history isn't tracked here — see the Wealth or Cash Flow workspaces for balances over time."
          : "Shared as balance only. Identity, connection health, and transactions stay private to the owner."}
      </p>
    </div>
  );
}

function ActionButton({
  onClick, disabled, danger, children,
}: {
  onClick:   () => void;
  disabled?: boolean;
  danger?:   boolean;
  children:  React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 text-xs transition-colors disabled:opacity-50 ${
        danger
          ? "text-[var(--text-muted)] hover:text-[var(--coral-400)]"
          : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      }`}
    >
      {children}
    </button>
  );
}
