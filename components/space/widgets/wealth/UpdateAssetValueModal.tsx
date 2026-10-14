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
 * The currency is NOT editable here: the route accepts `{ balance }` only, and
 * a currency change would be a different fact (a different asset, or a data
 * repair) rather than a revaluation.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";
import { ESTIMATE_DISCLOSURE, estimateValueLabel, parseEstimateInput } from "@/lib/assets/manual-asset";

export function UpdateAssetValueModal({
  accountId, name, currency, currentValue, onClose, onSaved,
}: {
  accountId:    string;
  name:         string;
  currency:     string;
  currentValue: number;
  onClose:      () => void;
  onSaved:      () => void;
}) {
  const [value,   setValue]   = useState(String(currentValue));
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const parsed = parseEstimateInput(value);

  async function save() {
    if (parsed === null) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/accounts/manual/${encodeURIComponent(accountId)}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ balance: parsed }),
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
          <GlassButton onClick={save} disabled={saving || parsed === null} tone="meridian" fullWidth>
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
        <p className="text-xs text-[var(--text-muted)]">
          {ESTIMATE_DISCLOSURE} Today&rsquo;s net worth uses the new figure; earlier days keep the value they had.
        </p>
      </div>
    </FormModal>
  );
}
