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
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import { amountOwed } from "@/lib/debt/balance-semantics";
import type { AccountDetailRow } from "@/app/api/spaces/[id]/accounts/detail/route";
import {
  accountBalanceClaimLabel, balanceBasisCaveat, describeLedgerCoverage,
  type LedgerCoverage,
} from "@/lib/freshness/observation";
import { RECONCILIATION_LABEL } from "@/lib/balances/reconciliation-labels";
import { ACCOUNT_TYPE_LABELS, healthChip } from "./AccountsPerspective";

/** A converted balance the ledger already computed — the panel and the row can
 *  never disagree because both read this same display value. */
export interface AccountDisplay {
  amount:    number;
  estimated: boolean;
  /**
   * V27-L2 — the AVAILABLE quantity, converted through the SAME authority as
   * `amount` so the two figures can never be quoted in different currencies.
   * Null when the balance authority refused to name an available quantity —
   * and null must render as the refusal, never as a zero or as `amount`.
   */
  available: number | null;
  /** V27-L3 — the predicted figure, converted through the SAME authority. Null
   *  when no pending evidence licensed one. */
  predicted: number | null;
  /** V27-L3 — the residual, converted. Null when not reconcilable. Signed:
   *  positive is a hold, negative is a provider over-report. */
  unexplained: number | null;
}

function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-xs text-[var(--text-faint)]">{label}</span>
      <span className="text-sm tabular-nums text-right text-[var(--text-secondary)]">{value}</span>
    </div>
  );
}

/** V27-L1 — ledger reach, phrased so it can never be read as a balance age.
 *  "Transactions through <date>" is a statement about how far the ledger REACHES;
 *  a quiet account with no recent spending is not a stale one. */
function ledgerValue(l: LedgerCoverage): string {
  return l.kind === "OBSERVED" ? l.throughDate : describeLedgerCoverage(l);
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
  // V27-L1 — the caveat that keeps our fetch clock from reading as the
  // institution's. Null when there is nothing to caveat.
  const basisCaveat = balanceBasisCaveat(row.freshness.balance);

  // V27-L2 — the canonical claims, resolved server-side and consumed here. This
  // component names quantities; it never interprets `availableBalance`.
  const balances = row.balances;
  // On a liability the headline quantity is AMOUNT_OWED; everywhere else it is
  // the observed ledger balance.
  const headline = balances.debt ? balances.debt.owed : balances.observed;
  // Headline VALUE in display currency. On a liability this is amountOwed of the
  // CONVERTED balance — clamp and conversion commute (FX rates are positive), so
  // this agrees with the native claim by construction.
  const headlineAmount = balances.debt ? amountOwed(display.amount) : display.amount;

  // V27-L3 — the reconciliation, resolved server-side. This component formats
  // it; it never filters pending rows and never runs the identity.
  const recon = row.reconciliation;
  const predictedDisplay   = display.predicted;
  const unexplainedDisplay = display.unexplained;

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
      {/* Headline balance — display-converted; native shown alongside when different.
          V27-L2 — the eyebrow NAMES the quantity. It read "Current balance" for
          every account type, which on a credit card describes $562.37 of debt in
          the same words it describes $5,106.77 of checking. On a liability the
          headline is the amount OWED (through lib/debt/balance-semantics), which
          is why a paid-off card reads $0 owed rather than a negative balance. */}
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {headline.label}
      </p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
        {approx}{formatCurrency(headlineAmount, currency)}
      </p>
      {foreign && (
        <p className="mt-1 tabular-nums text-xs text-[var(--text-muted)]">
          {formatCurrency(row.balance, row.currency)} native
        </p>
      )}

      {/* V27-L3 — the current-state block: what pending activity predicts, and
          what nothing explains. An unexplained hold is a FIRST-CLASS output —
          the Amex HYSA's $4,000 is stated in words, never smoothed into the
          prediction and never absorbed into the headline. */}
      {/* V27-L2 — the SECOND quantity, named. On the Chase card this is
          "Available credit $33,022.48" sitting beneath "Amount owed $562.37":
          two figures that were previously one polymorphic column, and that a
          uniform reader would have confused by $32,460. When the provider gave
          us nothing, or gave a figure whose meaning nothing attests, this states
          the refusal instead of showing a number. */}
      <div className="mt-3">
        {balances.available.status === "AVAILABLE" ? (
          <p className="text-xs text-[var(--text-secondary)]">
            <span className="text-[var(--text-faint)]">{balances.available.label}</span>{" "}
            <span className="tabular-nums">
              {display.available === null
                ? formatCurrency(balances.available.amount, row.currency)
                : `${approx}${formatCurrency(display.available, currency)}`}
            </span>
          </p>
        ) : (
          <p className="text-xs text-[var(--text-faint)]">{balances.available.label}</p>
        )}
        {/* The observed ledger figure stays visible on a liability, where the
            headline is the derived amount owed rather than the stored balance. */}
        {headline.quantity !== "OBSERVED_LEDGER" && (
          <p className="mt-1 text-xs text-[var(--text-faint)] tabular-nums">
            {balances.observed.label} {formatCurrency(display.amount, currency)}
          </p>
        )}
        {/* Predicted, only where provider-observed pending licenses it. */}
        {recon.predicted && (
          <p className="mt-1 text-xs text-[var(--text-faint)] tabular-nums">
            {recon.predicted.label} {formatCurrency(predictedDisplay!, currency)}
            <span className="ml-1 not-italic">
              ({recon.pending.count} pending)
            </span>
          </p>
        )}
        {/* The residual, in the user's words. Never hidden, never netted away —
            but only rendered when there IS one. Gating on `!== null` printed
            "$0 unavailable but not yet explained by transactions" on every
            EXACT account, which is noise that trains a reader to ignore the
            line that matters. The STATE is the authority's own decision about
            whether a residual is material; re-thresholding here would be a
            second opinion. */}
        {unexplainedDisplay !== null && recon.state !== "EXACT" && (
          <p className="mt-1 text-xs" style={{ color: "var(--accent-warning)" }}>
            {formatCurrency(Math.abs(unexplainedDisplay), currency)}{" "}
            {/* Basis-aware: on a card the residual is CREDIT LINE, not cash, and
                calling it "unavailable" would describe the wrong quantity. */}
            {recon.basis === "REVOLVING_CREDIT"
              ? unexplainedDisplay > 0
                ? "of the credit line is used but not yet explained by transactions"
                : "more credit available than the limit and what is owed support"
              : unexplainedDisplay > 0
                ? "unavailable but not yet explained by transactions"
                : "more available than the balance and pending activity support"}
          </p>
        )}
      </div>

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
        {/* V27-L1 — the balance above and the evidence for how old it is now travel
            together. The label itself carries the basis: "Balance as of" is only
            used when the institution attested its own computation time; otherwise
            it is "Balance checked", which claims nothing but our own fetch. */}
        <FactRow
          label={accountBalanceClaimLabel(row.freshness.balance.basis)}
          value={
            row.freshness.balance.observedAt
              ? formatRelativeTime(row.freshness.balance.observedAt)
              : "Unknown"
          }
        />
        {/* Ledger reach is a SEPARATE fact from balance age — the two feeds advance
            independently, and a wallet can carry a live balance over a ledger that
            stops years earlier. Never presented as staleness. */}
        <FactRow label="Transactions" value={ledgerValue(row.freshness.ledger)} />
        {/* V27-L3 — reconciliation state is its OWN dimension, beside freshness.
            A mathematically EXACT reconciliation over a two-month-old balance is
            still stale, and the two must never be collapsed into one badge. */}
        {recon.basis !== "NONE" && (
          <FactRow label="Reconciliation" value={RECONCILIATION_LABEL[recon.state]} />
        )}
        <FactRow label="Visibility" value={isFull ? "Full detail" : "Balance only"} />
        {isFull && imports > 0 && (
          <FactRow label="Historical imports" value={`${imports} import${imports === 1 ? "" : "s"}`} />
        )}
      </div>

      {recon.basis !== "NONE" && (
        <p className="mt-3 text-[11px] leading-snug text-[var(--text-faint)]">{recon.explanation}</p>
      )}
      {basisCaveat && (
        <p className="mt-1 text-[11px] leading-snug text-[var(--text-faint)]">{basisCaveat}</p>
      )}

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

      {/* Honest scope note — per-account balance history isn't carried by this read.
          V27-L1: this used to open "Balance is current", which is a freshness claim
          the read cannot make (24 of 35 accounts in the live corpus are past a
          week). The freshness facts above make the actual claim; this note is now
          about SCOPE only. */}
      <p className="mt-5 text-[11px] leading-snug text-[var(--text-faint)]">
        {isFull
          ? "This is the latest observed balance. Per-account history isn't tracked here — see the Wealth or Cash Flow workspaces for balances over time."
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
