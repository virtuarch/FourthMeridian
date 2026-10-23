"use client";

/**
 * components/space/widgets/debt/CreditHealthInputs.tsx
 *
 * Credit health, inspectable and editable IN PLACE. What Credit health is made
 * of, sorted by who owns each value:
 *
 *   PROVIDER / CANONICAL FACTS   — balances. Read-only here.
 *   DERIVED                      — utilization %, utilization level, the score
 *                                  band ("Good"), the signal rows. Read-only:
 *                                  they are recomputed, never typed.
 *   USER-DECLARED INPUTS         — (1) the credit score: Fourth Meridian has no
 *                                  bureau feed; every CreditScore row is the
 *                                  user's own report (source "manual").
 *                                  (2) a line's credit limit: user-declared
 *                                  wherever the institution does not report one
 *                                  (a provider-reported limit is re-asserted on
 *                                  the next refresh — said on the row).
 *                                  EDITABLE, each through its existing authority
 *                                  (lib/debt/user-terms.ts).
 *   (APR is a user-declared input too, and is edited in ONE place — Interest cost.)
 *
 * No financial truth is held here. Limits are always the prop; after a save the
 * host re-reads the accounts and utilization + signals recompute from that. The
 * score shows the row THE SERVER RECORDED (its response), then the host's
 * refreshed prop — never an unsaved draft.
 */

import { useState } from "react";
import { Check, Loader2, Pencil, Plus, X } from "lucide-react";
import { FicoCard } from "@/components/dashboard/FicoCard";
import { creditUtilization, REVOLVING_DEBT_SUBTYPES } from "@/lib/accounts/credit-utilization";
import {
  parseCreditLimitInput,
  parseCreditScoreInput,
  saveAccountCreditLimit,
  saveCreditScore,
} from "@/lib/debt/user-terms";
import { SPACE_ACCOUNTS_CHANGED_EVENT } from "@/lib/space-nav";
import { formatBalance } from "@/lib/currency";
import { formatDate } from "@/lib/format";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

const INPUT_CLS =
  "bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-lg px-2 py-1 text-xs text-right tabular-nums text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-info)]";

// ─── Credit score ─────────────────────────────────────────────────────────────

export function CreditScoreInput({
  score,
  updatedAt,
  onSaved,
}: {
  /** The host's score. `undefined` ⇒ this host does not carry the user's score (a shared Space). */
  score:      number | null | undefined;
  updatedAt?: string | null;
  /** Called after the server records a score, so the host can re-read it. */
  onSaved?:   () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState("");
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  // The row the SERVER recorded — not a draft. Superseded as soon as the host's
  // refreshed prop is at least as new.
  const [recorded, setRecorded] = useState<{ score: number; recordedAt: string | null } | null>(null);

  if (score === undefined) {
    return (
      <p className="px-1 text-[12px] leading-snug text-[var(--text-muted)]">
        Your credit score is personal to you, so it is kept — and edited — in My Space, not in a shared Space.
      </p>
    );
  }

  const useRecorded =
    recorded != null && (updatedAt == null || recorded.recordedAt == null || recorded.recordedAt >= updatedAt);
  const shownScore   = useRecorded ? recorded!.score : score;
  const shownUpdated = useRecorded ? recorded!.recordedAt : updatedAt ?? null;

  function open() {
    setDraft(shownScore != null ? String(shownScore) : "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const parsed = parseCreditScoreInput(draft);
    if (!parsed.ok) { setError(parsed.error); return; }
    setSaving(true);
    setError(null);
    const res = await saveCreditScore(parsed.value);
    setSaving(false);
    if (!res.ok) { setError(res.error); return; }
    setRecorded(res.data);
    setEditing(false);
    onSaved?.();
  }

  return (
    <div data-widget="credit-score">
      <FicoCard
        score={shownScore}
        lastUpdated={shownUpdated ? formatDate(shownUpdated) : "—"}
        onAdd={open}
      />
      <div className="mt-2 px-1">
        {editing ? (
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="credit-score-input" className="text-[11px] text-[var(--text-muted)]">Your score (300–850)</label>
            <div className="flex items-center gap-1">
              <input
                id="credit-score-input"
                autoFocus
                inputMode="numeric"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
                placeholder="e.g. 720"
                className={`w-20 ${INPUT_CLS}`}
              />
              <button type="button" onClick={save} disabled={saving} aria-label="Save score" className="p-1 rounded text-[var(--accent-info)] disabled:opacity-50">
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              </button>
              <button type="button" onClick={() => setEditing(false)} disabled={saving} aria-label="Cancel" className="p-1 rounded text-[var(--text-muted)] disabled:opacity-50">
                <X size={13} />
              </button>
            </div>
          </div>
        ) : shownScore != null ? (
          <button type="button" onClick={open} className="flex items-center gap-1 text-[11px] font-medium text-[var(--accent-info)]">
            <Pencil size={11} /> Update score
          </button>
        ) : null}
        {error && <p className="mt-1 text-right text-[10px] text-[var(--accent-negative)]">{error}</p>}
        <p className="mt-1 text-[10px] leading-snug text-[var(--text-faint)]">
          Entered by you — Fourth Meridian does not pull a credit report. Each update is kept as a new dated entry.
        </p>
      </div>
    </div>
  );
}

// ─── Credit limits ────────────────────────────────────────────────────────────

/** A debt account that CAN carry a limit: a revolving subtype, or an untyped legacy row. */
function canCarryLimit(a: DebtPerspectiveAccount): boolean {
  return a.type === "debt" && a.aggregate == null
    && (a.debtSubtype == null || REVOLVING_DEBT_SUBTYPES.has(a.debtSubtype));
}

export function CreditLimitInputs({
  accounts,
  onSaved,
}: {
  accounts: DebtPerspectiveAccount[];
  /** Test seam / host override. Default: broadcast the accounts-changed refresh. */
  onSaved?: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState("");
  const [savingId, setSavingId]   = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);

  const lines = accounts.filter(canCarryLimit);
  // DERIVED, read-only: the utilization authority's own rows, keyed for lookup.
  const utilById = new Map(creditUtilization(accounts).rows.map((r) => [r.id, r]));

  async function save(id: string) {
    const parsed = parseCreditLimitInput(draft);
    if (!parsed.ok) { setError(parsed.error); return; }
    setSavingId(id);
    setError(null);
    const res = await saveAccountCreditLimit(id, parsed.value);
    setSavingId(null);
    if (!res.ok) { setError(res.error); return; }
    setEditingId(null);
    setDraft("");
    if (onSaved) onSaved();
    else window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
  }

  if (lines.length === 0) {
    return (
      <p className="px-1 py-4 text-center text-[12px] text-[var(--text-muted)]">
        No revolving credit lines — utilization needs a card or line of credit.
      </p>
    );
  }

  return (
    <div data-widget="credit-limits">
      <ul className="divide-y divide-[var(--border-hairline)]">
        {lines.map((a) => {
          const editing = editingId === a.id;
          const saving  = savingId === a.id;
          const util    = utilById.get(a.id);
          return (
            <li key={a.id} className="py-2 first:pt-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[12px] text-[var(--text-secondary)]">{a.name}</p>
                  <p className="text-[10px] text-[var(--text-faint)]">
                    {util ? `${util.pct.toFixed(0)}% used · calculated from balance ÷ limit` : "Utilization unknown — no limit on file"}
                  </p>
                </div>
                {editing ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      autoFocus
                      inputMode="decimal"
                      aria-label={`Credit limit for ${a.name}`}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save(a.id);
                        if (e.key === "Escape") { setEditingId(null); setError(null); }
                      }}
                      placeholder="Limit"
                      className={`w-24 ${INPUT_CLS}`}
                    />
                    <button type="button" onClick={() => save(a.id)} disabled={saving} aria-label="Save credit limit" className="p-1 rounded text-[var(--accent-info)] disabled:opacity-50">
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    </button>
                    <button type="button" onClick={() => { setEditingId(null); setError(null); }} disabled={saving} aria-label="Cancel" className="p-1 rounded text-[var(--text-muted)] disabled:opacity-50">
                      <X size={13} />
                    </button>
                  </div>
                ) : a.creditLimit != null && a.creditLimit > 0 ? (
                  <button
                    type="button"
                    onClick={() => { setEditingId(a.id); setDraft(String(a.creditLimit)); setError(null); }}
                    aria-label={`Edit credit limit for ${a.name}`}
                    className="group flex items-center gap-1.5 shrink-0 text-[12px] font-semibold tabular-nums text-[var(--text-primary)]"
                  >
                    {formatBalance(a.creditLimit, a.currency)} limit
                    <Pencil size={11} className="text-[var(--text-faint)] group-hover:text-[var(--accent-info)]" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setEditingId(a.id); setDraft(""); setError(null); }}
                    className="flex items-center gap-1 shrink-0 text-[11px] font-medium text-[var(--accent-info)]"
                  >
                    <Plus size={12} /> Add limit
                  </button>
                )}
              </div>
              {editing && error && <p className="mt-1 text-right text-[10px] text-[var(--accent-negative)]">{error}</p>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[10px] leading-snug text-[var(--text-faint)]">
        Limits are yours to set where your institution doesn&rsquo;t report one. If it does, its figure replaces yours at the next refresh.
        Utilization and the signals are calculated — they update when a limit or balance changes.
      </p>
    </div>
  );
}
