"use client";

/**
 * AddManualAssetModal
 *
 * One-step modal for creating a manually-entered asset (a home, a vehicle,
 * jewelry, a collection — anything the user owns that no provider reports).
 *
 * Fields: name, the user's ESTIMATE of its value, currency, and (optionally)
 * the shared Spaces to show it in. On submit:
 *   POST /api/accounts/manual → FinancialAccount (type=other, syncStatus='manual'),
 *   linked HOME into the personal Space, SHARED into any selected Spaces.
 *
 * ── RWA-1 (2026-10-15) — ONLY FIELDS THAT ARE KEPT ARE ASKED FOR ─────────────
 * This form used to collect an asset type, purchase price, purchase date and
 * notes. None of them is stored on the asset: the route has no column for them,
 * so they survived only inside an audit-log entry and were invisible everywhere
 * else afterwards — a house, a car and a watch were indistinguishable once
 * saved. Asking for data and then losing it is worse than not asking, so those
 * fields are removed until a schema slice (RWA-2, an asset profile) can persist
 * them. The value is labelled as the user's estimate, never a market price, and
 * the currency list is the server's own allowlist (lib/assets/manual-asset.ts).
 *
 * RWA-2A — OPTIONAL ACQUISITION FACTS, all persisted (ManualAssetProfile +
 * the first dated AssetValuation): when it was acquired, what was paid, and —
 * only if the user ticks it — whether that price is their estimate of its value
 * on that date (which lets the asset's chart model a line from purchase to
 * today). The value is dated ("as of", default today, never in the future, never
 * before acquisition). A purchase price alone is never treated as a market value.
 *
 * After success: calls onAdd() and router.refresh() so the host re-reads.
 *
 * Styling: Atlas Glass modal primitive (FormModal → OverlaySurface) per
 * docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md. Same props as before.
 */

import { useState, useEffect } from "react";
import { useRouter }           from "next/navigation";
import { Loader2 }             from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { displaySpaceName } from "@/lib/format";
import {
  ESTIMATE_DISCLOSURE, MANUAL_ASSET_CURRENCIES, estimateValueLabel, parseEstimateInput,
} from "@/lib/assets/manual-asset";
import { checkAcquisitionDate, checkEffectiveDate, isoDateOf } from "@/lib/assets/valuation-series.core";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SpaceOption {
  id:   string;
  name: string;
  type: string;      // "PERSONAL" | "SHARED"
}

interface Props {
  onClose: () => void;
  /**
   * RWA-2B — reports the created asset so a host in a PERSONAL Space can offer
   * "Update past net worth?" when the asset was given history (a backdated or
   * purchase-price starting value). Zero-argument callers are unaffected.
   */
  onAdd?:  (created: { accountId: string; name: string; currency: string }) => void;
  /** Pre-checks these Space ids in the sharing picker (e.g. the Space the user
   *  is adding from, or one just created in onboarding). Purely a default — the
   *  picker stays freely editable. The personal Space is always included by the
   *  server and is never listed. */
  defaultSpaceIds?: string[];
  /** Override the stacking order so this can render above another modal
   *  (e.g. the Create Space onboarding flow's Add Accounts step). Defaults
   *  to the standard z-[100] modal layer when omitted. */
  zIndex?: number;
}

// ─── Input helpers ────────────────────────────────────────────────────────────

function Field({
  label, children, error, htmlFor,
}: {
  label:    string;
  children: React.ReactNode;
  error?:   string | null;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-[var(--text-secondary)]">{label}</label>
      {children}
      {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}
    </div>
  );
}

const INPUT_CLS =
  "w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors";
const INPUT_STYLE = { background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" } as const;

// Selected/unselected tint for chip-style choices (Space sharing)
// — same recipe as CreateSpaceModal's chipTone().
function chipTone(selected: boolean): string {
  return selected
    ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]"
    : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] hover:bg-[var(--surface-hover)]";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddManualAssetModal({ onClose, onAdd, defaultSpaceIds, zIndex }: Props) {
  const router = useRouter();

  const [name,     setName]     = useState("");
  const [value,    setValue]    = useState("");
  const [currency, setCurrency] = useState(
    MANUAL_ASSET_CURRENCIES.includes(DEFAULT_DISPLAY_CURRENCY) ? DEFAULT_DISPLAY_CURRENCY : "USD",
  );
  // RWA-2A — the value's date and the optional acquisition facts.
  const today = isoDateOf(new Date());
  const [valuationDate,   setValuationDate]   = useState(today);
  const [showAcquisition, setShowAcquisition] = useState(false);
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [purchasePrice,   setPurchasePrice]   = useState("");
  const [useAsStart,      setUseAsStart]      = useState(false);
  const [spaces,        setSpaces]        = useState<SpaceOption[]>([]);
  const [selectedWsIds, setSelectedWsIds] = useState<string[]>(defaultSpaceIds ?? []);
  const [loadingWs,     setLoadingWs]     = useState(true);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // ── Shared Spaces for the optional sharing picker ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r    = await fetch("/api/spaces");
        const data = await r.json();
        const list: SpaceOption[] = (data.mine ?? [])
          .filter((w: SpaceOption) => w.type !== "PERSONAL")
          .map((w: { id: string; name: string; type: string }) => ({ id: w.id, name: w.name, type: w.type }));
        if (!cancelled) setSpaces(list);
      } catch {
        // non-fatal — the asset can still be created in the personal Space
      } finally {
        if (!cancelled) setLoadingWs(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const parsedValue = parseEstimateInput(value);
  const parsedPrice = purchasePrice.trim() === "" ? null : parseEstimateInput(purchasePrice);
  // The same rules the route enforces (lib/assets/valuation-series.core.ts).
  const acqError = acquisitionDate !== "" ? (() => { const c = checkAcquisitionDate(acquisitionDate, today); return c.ok ? null : c.error; })() : null;
  const dateError = (() => { const c = checkEffectiveDate(valuationDate, today, acquisitionDate || null); return c.ok ? null : c.error; })();
  const priceError = purchasePrice.trim() !== "" && parsedPrice === null ? "Enter a non-negative amount." : null;
  const startError = useAsStart && (acquisitionDate === "" || parsedPrice === null)
    ? "Add the acquisition date and purchase price to use it as a starting value." : null;
  const valid = name.trim().length > 0 && parsedValue !== null && !acqError && !dateError && !priceError && !startError;

  async function handleSubmit() {
    if (!valid || parsedValue === null) return;
    setError(null);
    setLoading(true);

    // Only Spaces the picker can actually show are sent: a default id for the
    // personal Space (or one the user left) is dropped rather than relied on.
    const listed  = new Set(spaces.map((s) => s.id));
    const shareTo = selectedWsIds.filter((id) => listed.has(id));

    const res = await fetch("/api/accounts/manual", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name:     name.trim(),
        balance:  parsedValue,
        currency,
        spaceIds: shareTo,
        valuationDate,
        ...(acquisitionDate ? { acquisitionDate } : {}),
        ...(parsedPrice !== null ? { purchasePrice: parsedPrice } : {}),
        ...(useAsStart ? { purchasePriceIsStartingValue: true } : {}),
      }),
    });

    const data = await res.json().catch(() => ({}));
    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Failed to add asset. Please try again.");
      return;
    }

    onAdd?.({ accountId: String(data.accountId ?? ""), name: String(data.name ?? name.trim()), currency: String(data.currency ?? currency) });
    onClose();
    router.refresh();
  }

  return (
    <FormModal
      open
      onClose={() => { if (!loading) onClose(); }}
      title="Add asset"
      subtitle="A home, vehicle, jewelry or anything else you own"
      size="sm"
      zIndex={zIndex}
      preventClose={loading}
      footer={
        <div className="space-y-3">
          {error && <p className="text-xs text-[var(--coral-400)] text-center" role="alert">{error}</p>}
          <GlassButton onClick={handleSubmit} disabled={loading || !valid} tone="meridian" fullWidth>
            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
            {loading ? "Adding asset…" : "Add asset"}
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Asset name" htmlFor="manual-asset-name">
          <input
            id="manual-asset-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Austin home, 2022 Honda CR-V, Grandmother's ring"
            className={INPUT_CLS}
            style={INPUT_STYLE}
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label={estimateValueLabel(currency)} htmlFor="manual-asset-value">
              <input
                id="manual-asset-value"
                type="text"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="0"
                className={INPUT_CLS}
                style={INPUT_STYLE}
              />
            </Field>
          </div>
          <Field label="Currency" htmlFor="manual-asset-currency">
            <select
              id="manual-asset-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none transition-colors appearance-none"
              style={INPUT_STYLE}
            >
              {MANUAL_ASSET_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Value as of" htmlFor="manual-asset-value-date" error={dateError}>
          <input
            id="manual-asset-value-date"
            type="date"
            value={valuationDate}
            max={today}
            min={acquisitionDate || undefined}
            onChange={(e) => setValuationDate(e.target.value)}
            className={INPUT_CLS}
            style={INPUT_STYLE}
          />
        </Field>
        <p className="-mt-2 text-xs text-[var(--text-muted)]">
          {ESTIMATE_DISCLOSURE} You can update it at any time.
        </p>

        {!showAcquisition ? (
          <button
            type="button"
            onClick={() => setShowAcquisition(true)}
            className="text-xs font-medium text-[var(--meridian-400)] hover:underline"
          >
            + Add when you got it and what you paid (optional)
          </button>
        ) : (
          <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Acquired on" htmlFor="manual-asset-acq-date" error={acqError}>
                <input
                  id="manual-asset-acq-date"
                  type="date"
                  value={acquisitionDate}
                  max={today}
                  onChange={(e) => setAcquisitionDate(e.target.value)}
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                />
              </Field>
              <Field label={`Purchase price (${currency})`} htmlFor="manual-asset-price" error={priceError}>
                <input
                  id="manual-asset-price"
                  type="text"
                  inputMode="decimal"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                  placeholder="0"
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                />
              </Field>
            </div>
            <label className="flex items-start gap-2.5 text-xs text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={useAsStart}
                onChange={(e) => setUseAsStart(e.target.checked)}
                className="mt-0.5 rounded border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] text-[var(--meridian-400)]"
              />
              <span>
                Use the purchase price as my estimate of its value on that date.
                <span className="block text-[var(--text-muted)]">
                  Its chart then shows a modeled line from purchase to your current estimate — an illustration, not market history.
                </span>
              </span>
            </label>
            {startError && <p className="text-xs text-[var(--coral-400)]">{startError}</p>}
          </div>
        )}

        {loadingWs ? (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 size={12} className="animate-spin" />
            Loading Spaces…
          </div>
        ) : spaces.length > 0 ? (
          <Field label="Also show in (optional)">
            <div className="space-y-2">
              {spaces.map((ws) => {
                const checked = selectedWsIds.includes(ws.id);
                return (
                  <label
                    key={ws.id}
                    className={`flex items-center gap-3 px-3.5 py-3 rounded-[var(--radius-sm)] border cursor-pointer transition-colors ${chipTone(checked)}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setSelectedWsIds((prev) =>
                        checked ? prev.filter((id) => id !== ws.id) : [...prev, ws.id]
                      )}
                      className="rounded border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] text-[var(--meridian-400)] focus:ring-[var(--meridian-400)]/30"
                    />
                    <span className={`text-sm ${checked ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>{displaySpaceName(ws.name)}</span>
                  </label>
                );
              })}
            </div>
          </Field>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">The asset will be added to your personal Space.</p>
        )}
      </div>
    </FormModal>
  );
}
