"use client";

/**
 * components/transactions/TransactionCorrection.tsx  (TX-3.4)
 *
 * The ACT step of the explorer's find → inspect → act loop: the user surface for the
 * already-existing POST /api/transactions/[id]/correct, which had shipped with no UI.
 *
 * SCOPE — deliberately only the CATEGORY corrections the endpoint already models:
 *   "override" → this transaction only          (row stamped USER_OVERRIDE)
 *   "category" → always for this merchant       (mints a USER MerchantRule)
 * These two are exactly the endpoint's two category paths; the wording maps 1:1 onto
 * what it actually does, so the UI cannot promise a scope the backend does not honor.
 *
 * The endpoint's third path — MERCHANT IDENTITY correction — is NOT surfaced here. It
 * needs a candidate search plus a 409 "needs confirmation" round-trip (a Merchant is
 * never minted from free text), which is a genuine picker flow, not a control. Adding
 * it would be building a correction workflow rather than surfacing one. Deferred.
 *
 * NO new authority: this component computes nothing, derives nothing, and stores
 * nothing. It POSTs, then hands the FRESH TransactionDetail the endpoint returns
 * straight back to the drawer — the server remains the only source of truth for what
 * the transaction now is.
 */

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { TransactionDetail } from "@/types";
import { BANKING_CATEGORIES } from "@/components/dashboard/widgets/transactions/transactions-filter-constants";
import { INPUT_BASE, inputStyle } from "@/components/dashboard/widgets/transactions/transactions-filter-constants";
import { notifyTransactionMutated } from "./transaction-mutation-signal";

/** Which of the endpoint's two category corrections to apply. */
type Scope = "override" | "category";

const SCOPE_LABEL: Record<Scope, string> = {
  override: "This transaction only",
  category: "Always for this merchant",
};

export function TransactionCorrection({
  detail,
  onCorrected,
}: {
  detail: TransactionDetail;
  /** Hands the drawer the fresh detail the endpoint returned (no refetch needed). */
  onCorrected: (detail: TransactionDetail) => void;
}) {
  const [category, setCategory] = useState<string>(detail.category);
  const [scope, setScope] = useState<Scope>("override");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = category !== detail.category;

  function apply() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    fetch(`/api/transactions/${detail.id}/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correction: scope, category }),
    })
      .then(async (res) => {
        if (!res.ok) {
          // 409 is the merchant-identity confirmation path, which this surface does
          // not drive — report honestly rather than pretending the save worked.
          throw new Error(res.status === 400 ? "That category isn’t valid." : "Couldn’t save that change.");
        }
        const data = (await res.json()) as { transaction: TransactionDetail };
        setSaved(true);
        // The list is a SIBLING tree — tell it to re-ask its question, so a row that
        // no longer matches the active filters leaves the list instead of lingering.
        notifyTransactionMutated();
        onCorrected(data.transaction);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn’t save that change."))
      .finally(() => setSaving(false));
  }

  return (
    <section aria-label="Correct category">
      <h3 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--text-faint)" }}>
        Correct category
      </h3>

      <div
        className="rounded-[var(--radius-lg)] border p-4 space-y-3"
        style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
      >
        <label className="block">
          <span className="sr-only">Category</span>
          <select
            value={category}
            onChange={(e) => { setCategory(e.target.value); setSaved(false); }}
            disabled={saving}
            aria-label="Category"
            className={`w-full px-3 py-2.5 ${INPUT_BASE}`}
            style={inputStyle}
          >
            {/* The row's current category may sit outside the banking presentation
                vocabulary (e.g. a legacy or investment value). Keep it selectable so
                the control never silently rewrites what it is showing. */}
            {!BANKING_CATEGORIES.includes(detail.category) && (
              <option value={detail.category}>{detail.category}</option>
            )}
            {BANKING_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        {/* Scope — the two paths the endpoint actually implements. */}
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Apply to">
          {(["override", "category"] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              onClick={() => setScope(s)}
              disabled={saving}
              className="text-xs px-2.5 py-1.5 rounded-full border transition-colors"
              style={scope === s
                ? { background: "var(--surface-hover)", borderColor: "var(--accent-info)", color: "var(--text-primary)" }
                : { borderColor: "var(--border-hairline)", color: "var(--text-muted)" }}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>

        <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          {scope === "override"
            ? "Only this transaction changes."
            : "Future transactions from this merchant will use this category. Existing ones are not rewritten."}
        </p>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={apply}
            disabled={!dirty || saving}
            className="text-sm font-medium px-3 py-2 rounded-[var(--radius-md)] transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "var(--meridian-400)", color: "#fff" }}
          >
            {saving ? <Loader2 size={14} className="animate-spin inline" /> : "Save correction"}
          </button>
          {saved && !dirty && (
            <span className="text-xs flex items-center gap-1" style={{ color: "var(--accent-positive)" }}>
              <Check size={13} /> Saved
            </span>
          )}
          {error && <span className="text-xs" style={{ color: "var(--accent-negative)" }}>{error}</span>}
        </div>
      </div>
    </section>
  );
}
