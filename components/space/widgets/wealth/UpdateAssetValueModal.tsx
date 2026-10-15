"use client";

/**
 * components/space/widgets/wealth/UpdateAssetValueModal.tsx   (RWA-1)
 *
 * Revalue one manual asset: a single field, the user's new ESTIMATE, in the
 * asset's own currency. Writes PATCH /api/accounts/manual/[id] — owner-only and
 * manual-only on the server, which also regenerates today's snapshot in every
 * Space the asset is linked into. The route stays the authority; this form is
 * only ever opened for a row the detail read marked `canManage`.
 *
 * RWA-2A — the value is DATED ("as of", default today) and APPENDED to the
 * asset's valuation ledger; an earlier date records a backdated correction that
 * never overwrites a more recent valuation, and a second value for the same date
 * replaces that date's anchor while the earlier entry is kept as history.
 *
 * The currency is NOT editable here: the route accepts `{ balance }` only, and
 * a currency change would be a different fact (a different asset, or a data
 * repair) rather than a revaluation.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";
import { ESTIMATE_DISCLOSURE, estimateValueLabel, parseEstimateInput } from "@/lib/assets/manual-asset";
import { checkEffectiveDate, isoDateOf } from "@/lib/assets/valuation-series.core";

export function UpdateAssetValueModal({
  accountId, name, currency, currentValue, acquisitionDate = null, onClose, onSaved,
}: {
  accountId:    string;
  name:         string;
  currency:     string;
  currentValue: number;
  /** RWA-2A — when known, a valuation may not be dated before it. */
  acquisitionDate?: string | null;
  onClose:      () => void;
  onSaved:      () => void;
}) {
  const [value,   setValue]   = useState(String(currentValue));
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const parsed = parseEstimateInput(value);
  const today = isoDateOf(new Date());
  const [asOf, setAsOf] = useState(today);
  const dateCheck = checkEffectiveDate(asOf, today, acquisitionDate);

  async function save() {
    if (parsed === null) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/accounts/manual/${encodeURIComponent(accountId)}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ balance: parsed, effectiveDate: asOf }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(data.error ?? "Couldn't update the value. Please try again.");
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <FormModal
      open
      onClose={() => { if (!saving) onClose(); }}
      title="Update value"
      subtitle={name}
      size="sm"
      preventClose={saving}
      footer={
        <div className="space-y-3">
          {error && <p className="text-xs text-[var(--coral-400)] text-center" role="alert">{error}</p>}
          <GlassButton onClick={save} disabled={saving || parsed === null || !dateCheck.ok} tone="meridian" fullWidth>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {saving ? "Saving…" : "Save new estimate"}
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-2">
        <label htmlFor="asset-new-value" className="block text-xs font-medium text-[var(--text-secondary)]">
          {estimateValueLabel(currency)}
        </label>
        <input
          id="asset-new-value"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none transition-colors"
          style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
          autoFocus
        />
        <label htmlFor="asset-new-value-date" className="mt-3 block text-xs font-medium text-[var(--text-secondary)]">
          Value as of
        </label>
        <input
          id="asset-new-value-date"
          type="date"
          value={asOf}
          max={today}
          min={acquisitionDate ?? undefined}
          onChange={(e) => setAsOf(e.target.value)}
          className="w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none transition-colors"
          style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
        />
        {!dateCheck.ok && <p className="text-xs text-[var(--coral-400)]" role="alert">{dateCheck.error}</p>}
        <p className="text-xs text-[var(--text-muted)]">
          {ESTIMATE_DISCLOSURE} Every value you record is kept with its date — an earlier date adds a correction to
          the history without replacing a more recent value.
        </p>
      </div>
    </FormModal>
  );
}
