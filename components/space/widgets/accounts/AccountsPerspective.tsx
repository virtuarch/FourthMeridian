"use client";

/**
 * components/space/widgets/accounts/AccountsPerspective.tsx
 *
 * The ACCOUNTS rail tab (`accounts_overview`), extracted out of the inline
 * AccountsCard in SpaceDashboard.tsx and given the management-centric shape the
 * Accounts Tab redesign (Phase 1) calls for: per-account identity (name,
 * institution, ••••mask), connection health, historical-imports count, and a
 * row of real actions (Rename, Remove from Space, View transactions, Manage
 * Connections). See FOURTH_MERIDIAN_ACCOUNTS_TAB_REDESIGN_IMPLEMENTATION_PLAN_2026-07-12.md.
 *
 * Doctrine held to (per the investigation): Accounts and Connections are SEPARATE
 * surfaces. This card never imports a Connections component and never offers
 * reauth/credential/provider-settings actions — it only MATCHES the three-state
 * health visual language ConnectionCard/InvestmentConnectionsCard established, and
 * links out to the Connections page for anything provider-management-shaped.
 *
 * Self-fetching (same shape as InvestmentConnectionsCard): it owns its data via
 * GET /api/spaces/[id]/accounts/detail — a dedicated read, NOT the shared
 * `SpaceAccount` type every other widget consumes. The `accounts` prop is the
 * host's already-loaded list, rendered immediately (identity + balance only) for
 * zero-flash parity while the enriched detail loads and as the honest fallback if
 * that fetch fails.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Landmark, CheckCircle2, AlertTriangle, Loader2, Pencil, X, ArrowUpRight, Cable,
} from "lucide-react";
import { SPACE_ACCOUNTS_CHANGED_EVENT } from "@/lib/space-nav";
import { formatBalance } from "@/lib/currency";
import type { SyncConnectionState } from "@/lib/sync/status";
import type { AccountDetailRow } from "@/app/api/spaces/[id]/accounts/detail/route";

// ── Pure, testable presentation logic ─────────────────────────────────────────

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking:   "Checking",
  savings:    "Savings",
  investment: "Investment",
  crypto:     "Crypto",
  debt:       "Debt",
  other:      "Other",
};

// formatBalance now comes from the single lib/currency authority (SEC-3); the
// former local copy defaulted to "USD" (≡ DEFAULT_DISPLAY_CURRENCY), so this is
// byte-identical. Re-exported for any external consumer of the prior surface.
export { formatBalance };

export type HealthTone = "positive" | "warning" | "muted";
export interface HealthChip {
  label: string;
  tone:  HealthTone;
}

/**
 * Maps a derived connection state to the chip shown on a row. Returns null when
 * there is no chip to show — a manual account (connectionState === null) reports
 * NOTHING rather than a fabricated "healthy" state, per the plan's honesty rule.
 * The three visible states reuse ConnectionCard's language verbatim: ready =
 * "Synced" (positive/CheckCircle2), needs_reauth = "Needs reconnection" and
 * error = "Sync error" (warning/AlertTriangle), importing = "Importing…" (muted).
 */
export function healthChip(state: SyncConnectionState | null): HealthChip | null {
  switch (state) {
    case "ready":        return { label: "Synced",             tone: "positive" };
    case "needs_reauth": return { label: "Needs reconnection", tone: "warning"  };
    case "error":        return { label: "Sync error",         tone: "warning"  };
    case "importing":    return { label: "Importing…",         tone: "muted"    };
    default:             return null; // null state (manual / wallet-only / revoked): no chip
  }
}

/**
 * The historical-imports clause. Renders ONLY when count > 0 — the same
 * zero-count-clause discipline the Activity Tab plan holds ("0 imports" is noise,
 * never shown).
 */
export function importsLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} historical import${count === 1 ? "" : "s"}`;
}

/** Groups rows by account type, preserving first-seen order (parity with today). */
export function groupByType(rows: AccountDetailRow[]): [string, AccountDetailRow[]][] {
  const grouped = rows.reduce<Record<string, AccountDetailRow[]>>((acc, r) => {
    (acc[r.type] ??= []).push(r);
    return acc;
  }, {});
  return Object.entries(grouped);
}

// ── Fallback prop shape (the host's shared SpaceAccount, structurally) ─────────

interface FallbackAccount {
  id:          string;
  name:        string;
  type:        string;
  institution: string;
  balance:     number;
  currency:    string;
}

/** Maps the host's already-loaded accounts to detail rows for instant parity. */
function fallbackRows(accounts: FallbackAccount[]): AccountDetailRow[] {
  return accounts.map((a) => ({
    id:                 a.id,
    spaceAccountLinkId: null,
    visibility:         "FULL" as const,
    name:               a.name,
    institution:        a.institution,
    type:               a.type,
    mask:               null,
    balance:            a.balance,
    currency:           a.currency,
    isManual:           false,
    connectionState:    null,
    importBatchCount:   0,
  }));
}

// ── Chip ──────────────────────────────────────────────────────────────────────

function Chip({ chip }: { chip: HealthChip }) {
  const color =
    chip.tone === "positive" ? "var(--accent-positive,#34d399)"
    : chip.tone === "warning" ? "var(--accent-warning,#f59e0b)"
    : "var(--text-muted)";
  const Icon = chip.tone === "positive" ? CheckCircle2 : chip.tone === "warning" ? AlertTriangle : Loader2;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color }}>
      <Icon size={12} className={chip.tone === "muted" ? "animate-spin" : ""} />
      {chip.label}
    </span>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function AccountRow({
  row, spaceId, onChanged,
}: {
  row:       AccountDetailRow;
  spaceId:   string;
  onChanged: () => void;
}) {
  const [renaming,  setRenaming]  = useState(false);
  const [nameDraft, setNameDraft] = useState(row.name);
  const [busy,      setBusy]      = useState<"rename" | "remove" | null>(null);
  const [error,     setError]     = useState("");

  const isFull = row.visibility === "FULL";
  const chip   = healthChip(row.connectionState);
  const imports = importsLabel(row.importBatchCount);

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

  // Remove from Space = revoke the SpaceAccountLink (status → REVOKED). Matches
  // the established one-click, no-confirmation-dialog revoke pattern in
  // ManageSpaceModal (revoke-don't-delete is reversible: re-sharing re-activates).
  async function removeFromSpace() {
    setBusy("remove"); setError("");
    try {
      const res = await fetch(`/api/spaces/${spaceId}/accounts/share`, {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ financialAccountId: row.id }),
      });
      if (!res.ok) throw new Error("revoke failed");
      // Keep the host's shared-account totals in sync (same event ManageSpaceModal fires).
      window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
      onChanged();
    } catch {
      setError("Couldn't remove. Try again.");
      setBusy(null);
    }
  }

  return (
    <div className="px-3 py-2.5 rounded-xl bg-[var(--surface-inset)]">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          {renaming ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenaming(false); }}
              className="w-full bg-transparent text-sm text-white border-b border-[var(--border-hairline-strong)] focus:outline-none focus:border-[var(--meridian-400)]"
            />
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-sm text-white truncate">{row.name}</p>
              {row.mask && (
                <span className="text-xs text-[var(--text-faint)] shrink-0">••••{row.mask}</span>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 min-w-0">
            {row.institution && (
              <p className="text-xs text-[var(--text-muted)] truncate">{row.institution}</p>
            )}
            {chip && (row.institution ? <span className="text-[var(--text-faint)]">·</span> : null)}
            {chip && <Chip chip={chip} />}
          </div>
        </div>
        <p className="text-sm font-medium text-white shrink-0">
          {formatBalance(row.balance, row.currency)}
        </p>
      </div>

      {isFull && imports && (
        <p className="mt-1 text-[11px] text-[var(--text-faint)]">{imports}</p>
      )}

      {/* Actions — only real, verified-to-exist destinations. There is no
          per-account detail page in this app, so that navigation action is
          deliberately omitted (linking it would 404). BALANCE_ONLY aggregate rows
          have a synthetic id and no owner context, so they carry no actions. */}
      {isFull && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {renaming ? (
            <>
              <ActionButton onClick={saveRename} disabled={busy === "rename"}>
                {busy === "rename" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                Save
              </ActionButton>
              <ActionButton onClick={() => { setRenaming(false); setNameDraft(row.name); }}>Cancel</ActionButton>
            </>
          ) : (
            <ActionButton onClick={() => setRenaming(true)}>
              <Pencil size={12} /> Rename
            </ActionButton>
          )}

          {/* Banking→Transactions retarget — the standalone /dashboard/banking
              route is retired; deep-link to the Transactions tab scoped to this
              account. A plain <a> (full navigation, not a soft-nav <Link>) so
              the shell re-reads ?tab=/?account= on mount — the shell tracks URL
              state via window.history, not the search-params hook (seam
              contract), so a soft nav wouldn't switch the tab. */}
          <a
            href={`/dashboard?tab=transactions&account=${encodeURIComponent(row.id)}`}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ArrowUpRight size={12} /> View transactions
          </a>

          <ActionButton onClick={removeFromSpace} disabled={busy === "remove"} danger>
            {busy === "remove" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            Remove from Space
          </ActionButton>
        </div>
      )}

      {error && <p className="mt-1 text-[11px] text-[var(--coral-400)]">{error}</p>}
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
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 text-[11px] transition-colors disabled:opacity-50 ${
        danger
          ? "text-[var(--text-muted)] hover:text-[var(--coral-400)]"
          : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      }`}
    >
      {children}
    </button>
  );
}

// ── Composition ───────────────────────────────────────────────────────────────

export function AccountsPerspective({
  spaceId, accounts,
}: {
  spaceId:  string;
  accounts: FallbackAccount[];
}) {
  const [rows,  setRows]  = useState<AccountDetailRow[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/spaces/${spaceId}/accounts/detail`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => { setRows(Array.isArray(data) ? data : []); setError(false); })
      .catch(() => setError(true));
  }, [spaceId]);

  useEffect(() => { load(); }, [load]);

  // Until the enriched detail arrives (or if it fails), render the host's list so
  // accounts are never absent — strictly no worse than today's AccountsCard.
  const display = rows ?? fallbackRows(accounts);

  if (display.length === 0) {
    return (
      <div className="text-center py-4">
        <Landmark size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No accounts shared yet</p>
        <p className="text-xs text-[var(--text-faint)] mt-0.5">Share accounts from the Spaces page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && rows === null && (
        <button onClick={load} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] underline">
          Couldn&apos;t load account details — retry
        </button>
      )}

      {groupByType(display).map(([type, items]) => (
        <div key={type}>
          <p className="text-[10px] font-semibold text-[var(--text-faint)] uppercase tracking-widest mb-1">
            {ACCOUNT_TYPE_LABELS[type] ?? type}
          </p>
          <div className="space-y-1">
            {items.map((row) => (
              <AccountRow key={row.id} row={row} spaceId={spaceId} onChanged={load} />
            ))}
          </div>
        </div>
      ))}

      {/* Manage Connections — pure navigation to the existing, separate Connections
          surface. Accounts never manages connections itself (doctrine). */}
      <Link
        href="/dashboard/connections"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
      >
        <Cable size={13} /> Manage Connections →
      </Link>
    </div>
  );
}
