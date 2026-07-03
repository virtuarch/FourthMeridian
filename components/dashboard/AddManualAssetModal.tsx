"use client";

/**
 * AddManualAssetModal
 *
 * Two-step modal for creating a manually-entered asset account.
 *
 * Step 1 — Core fields: kind, name, current value, currency
 * Step 2 — Optional metadata + space sharing
 *
 * On submit:
 *   POST /api/accounts/manual   → creates FinancialAccount (type=other, syncStatus='manual')
 *   Shares into personal space automatically.
 *   Shares into any additionally selected spaces.
 *
 * After success: calls onAdd() so the parent can refresh data (router.refresh()).
 *
 * Styling: migrated onto the Atlas Glass modal primitive (FormModal →
 * OverlaySurface) per docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md,
 * doctrine Phase 3 (migration 3.1, retires recipe R3). The primitive owns the
 * portal, focus-trap, body-scroll-lock, panel-level height cap, and z-scale;
 * asset-type chips are neutral ink (decorative category colour dropped). No
 * functional or API changes — same props, two-step flow, and /api call.
 */

import { useState, useEffect } from "react";
import { useRouter }           from "next/navigation";
import {
  ChevronRight, ChevronLeft, Loader2,
  Home, Car, Wrench, Package,
} from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { displaySpaceName } from "@/lib/format";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";

// ─── Types ────────────────────────────────────────────────────────────────────

type AssetKind = "real_estate" | "vehicle" | "equipment" | "other";

interface SpaceOption {
  id:   string;
  name: string;
  type: string;      // "PERSONAL" | "SHARED"
}

interface Props {
  onClose: () => void;
  onAdd?:  () => void;
  /** Pre-checks these Space ids in the step-2 sharing picker (e.g. the Space
   *  a user just created in the onboarding flow), instead of starting empty.
   *  Purely a default — the picker is still freely editable. */
  defaultSpaceIds?: string[];
  /** Override the stacking order so this can render above another modal
   *  (e.g. the Create Space onboarding flow's Add Accounts step). Defaults
   *  to the standard z-[100] modal layer when omitted. */
  zIndex?: number;
}

// ─── Asset kind config ────────────────────────────────────────────────────────

const KIND_OPTIONS: {
  value:       AssetKind;
  label:       string;
  placeholder: string;
  icon:        React.ElementType;
  iconCls:     string;
}[] = [
  {
    value:       "real_estate",
    label:       "Property",
    placeholder: "e.g. Austin Home, Lake Cabin",
    icon:        Home,
    iconCls:     "bg-[var(--surface-hover-strong)] text-[var(--text-muted)]",
  },
  {
    value:       "vehicle",
    label:       "Vehicle",
    placeholder: "e.g. 2022 Honda CR-V",
    icon:        Car,
    iconCls:     "bg-[var(--surface-hover-strong)] text-[var(--text-muted)]",
  },
  {
    value:       "equipment",
    label:       "Equipment",
    placeholder: "e.g. Freelance Business Equipment",
    icon:        Wrench,
    iconCls:     "bg-[var(--surface-hover-strong)] text-[var(--text-muted)]",
  },
  {
    value:       "other",
    label:       "Other",
    placeholder: "e.g. Art Collection, Jewelry",
    icon:        Package,
    iconCls:     "bg-[var(--surface-hover-strong)] text-[var(--text-muted)]",
  },
];

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF"];

// ─── Input helpers ────────────────────────────────────────────────────────────

function Field({
  label, children, error,
}: {
  label:    string;
  children: React.ReactNode;
  error?:   string | null;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-[var(--text-secondary)]">{label}</label>
      {children}
      {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}
    </div>
  );
}

function TextInput({
  value, onChange, placeholder, type = "text",
}: {
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  type?:        string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors"
      style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
    />
  );
}

// Selected/unselected tint for chip-style choices (asset kind, Space sharing)
// — same recipe as CreateSpaceModal's chipTone().
function chipTone(selected: boolean): string {
  return selected
    ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]"
    : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] hover:bg-[var(--surface-hover)]";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddManualAssetModal({ onClose, onAdd, defaultSpaceIds, zIndex }: Props) {
  const router = useRouter();

  // ── Step state ─────────────────────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2>(1);

  // ── Step 1 fields ──────────────────────────────────────────────────────────
  const [kind,     setKind]     = useState<AssetKind>("real_estate");
  const [name,     setName]     = useState("");
  const [value,    setValue]    = useState("");
  const [currency, setCurrency] = useState(DEFAULT_DISPLAY_CURRENCY);

  // ── Step 2 fields ──────────────────────────────────────────────────────────
  const [purchasePrice, setPurchasePrice] = useState("");
  const [purchaseDate,  setPurchaseDate]  = useState("");
  const [notes,         setNotes]         = useState("");
  const [spaces,    setSpaces]    = useState<SpaceOption[]>([]);
  const [selectedWsIds, setSelectedWsIds] = useState<string[]>(defaultSpaceIds ?? []);
  const [loadingWs,     setLoadingWs]     = useState(false);

  // ── Submission state ───────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // ── Fetch spaces for step 2 ───────────────────────────────────────────
  useEffect(() => {
    if (step !== 2) return;
    async function load() {
      setLoadingWs(true);
      try {
        const r    = await fetch("/api/spaces");
        const data = await r.json();
        const list: SpaceOption[] = (data.mine ?? [])
          .filter((w: SpaceOption) => w.type !== "PERSONAL")
          .map((w: { id: string; name: string; type: string }) => ({
            id:   w.id,
            name: w.name,
            type: w.type,
          }));
        setSpaces(list);
      } catch {
        // non-fatal — user can still create without sharing
      } finally {
        setLoadingWs(false);
      }
    }
    load();
  }, [step]);

  // ── Step 1 validation ──────────────────────────────────────────────────────
  const parsedValue = parseFloat(value.replace(/,/g, ""));
  const step1Valid  = name.trim().length > 0 && !isNaN(parsedValue) && parsedValue >= 0;

  // ── Submission ─────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!step1Valid) return;
    setError(null);
    setLoading(true);

    const parsedPurchasePrice = purchasePrice.trim() ? parseFloat(purchasePrice.replace(/,/g, "")) : undefined;

    const res = await fetch("/api/accounts/manual", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name:          name.trim(),
        balance:       parsedValue,
        currency,
        assetKind:     kind,
        purchasePrice: parsedPurchasePrice,
        purchaseDate:  purchaseDate || undefined,
        notes:         notes.trim() || undefined,
        spaceIds:  selectedWsIds,
      }),
    });

    const data = await res.json().catch(() => ({}));
    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Failed to add asset. Please try again.");
      return;
    }

    onAdd?.();
    onClose();
    router.refresh();
  }

  const selectedKind = KIND_OPTIONS.find((k) => k.value === kind)!;

  // ─── Step 1 ───────────────────────────────────────────────────────────────
  const step1 = (
    <div className="space-y-5">
      {/* Asset kind picker */}
      <Field label="Asset type">
        <div className="grid grid-cols-2 gap-2">
          {KIND_OPTIONS.map((opt) => {
            const Icon   = opt.icon;
            const active = kind === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { setKind(opt.value); setName(""); }}
                className={`flex items-center gap-2.5 px-3.5 py-3 rounded-[var(--radius-sm)] border text-left transition-[transform,background-color,border-color] active:scale-[0.97] ${chipTone(active)}`}
              >
                <div className={`w-7 h-7 rounded-[var(--radius-xs)] flex items-center justify-center shrink-0 ${active ? "bg-[rgba(59,130,246,.18)] text-[var(--meridian-400)]" : opt.iconCls}`}>
                  <Icon size={14} />
                </div>
                <span className={`text-sm font-medium ${active ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </Field>

      {/* Name */}
      <Field label="Asset name">
        <TextInput
          value={name}
          onChange={setName}
          placeholder={selectedKind.placeholder}
        />
      </Field>

      {/* Value + currency row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Field label="Current value ($)">
            <TextInput
              value={value}
              onChange={setValue}
              placeholder="0"
              type="text"
            />
          </Field>
        </div>
        <Field label="Currency">
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none transition-colors appearance-none"
            style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
          >
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </div>
    </div>
  );

  // ─── Step 2 ───────────────────────────────────────────────────────────────
  const step2 = (
    <div className="space-y-5">
      {/* Purchase details (optional) */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Purchase price (optional)">
          <TextInput
            value={purchasePrice}
            onChange={setPurchasePrice}
            placeholder="0"
            type="text"
          />
        </Field>
        <Field label="Purchase date (optional)">
          <input
            type="date"
            value={purchaseDate}
            onChange={(e) => setPurchaseDate(e.target.value)}
            className="w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none transition-colors"
            style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
          />
        </Field>
      </div>

      {/* Notes */}
      <Field label="Notes (optional)">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="e.g. 3BR/2BA primary residence — Austin, TX"
          className="w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors resize-none"
          style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
        />
      </Field>

      {/* Space sharing */}
      {loadingWs ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 size={12} className="animate-spin" />
          Loading Spaces…
        </div>
      ) : spaces.length > 0 ? (
        <Field label="Share into Spaces (optional)">
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
        <p className="text-xs text-[var(--text-muted)]">No shared Spaces found. The asset will be added to your personal dashboard.</p>
      )}
    </div>
  );

  // ─── Modal shell (Atlas Glass modal primitive: FormModal → OverlaySurface,
  //     doctrine Phase 3 / migration 3.1). Portal + focus-trap + body-lock +
  //     panel-level height cap + z-scale come from the primitive; the previous
  //     hand-rolled `fixed inset-0` shell (recipe R3) is retired. No functional
  //     or API changes — same props, same two-step flow, same /api call. The
  //     `zIndex` override is still honoured so this stacks above the (not yet
  //     migrated) CreateSpaceModal, which passes zIndex={300}. ────────────────
  return (
    <FormModal
      open
      onClose={() => { if (!loading) onClose(); }}
      title="Add Asset"
      subtitle={`Step ${step} of 2 — ${step === 1 ? "Basic details" : "Optional details & sharing"}`}
      size="sm"
      zIndex={zIndex}
      preventClose={loading}
      footer={
        <div className="space-y-3">
          {error && (
            <p className="text-xs text-[var(--coral-400)] text-center">{error}</p>
          )}

          <div className="flex gap-3">
            {step === 2 && (
              <GlassButton onClick={() => setStep(1)} disabled={loading} tone="neutral">
                <ChevronLeft size={14} />
                Back
              </GlassButton>
            )}

            {step === 1 ? (
              <GlassButton
                onClick={() => { if (step1Valid) setStep(2); }}
                disabled={!step1Valid}
                tone="meridian"
                fullWidth
              >
                Continue
                <ChevronRight size={14} />
              </GlassButton>
            ) : (
              <GlassButton
                onClick={handleSubmit}
                disabled={loading || !step1Valid}
                tone="meridian"
                fullWidth
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                {loading ? "Adding asset…" : "Add Asset"}
              </GlassButton>
            )}
          </div>
        </div>
      }
    >
      {step === 1 ? step1 : step2}
    </FormModal>
  );
}
