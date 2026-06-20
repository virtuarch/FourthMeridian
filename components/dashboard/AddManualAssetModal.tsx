"use client";

/**
 * AddManualAssetModal
 *
 * Two-step modal for creating a manually-entered asset account.
 *
 * Step 1 — Core fields: kind, name, current value, currency
 * Step 2 — Optional metadata + workspace sharing
 *
 * On submit:
 *   POST /api/accounts/manual   → creates FinancialAccount (type=other, syncStatus='manual')
 *   Shares into personal workspace automatically.
 *   Shares into any additionally selected workspaces.
 *
 * After success: calls onAdd() so the parent can refresh data (router.refresh()).
 *
 * Styling: ported to Atlas Glass (GlassPanel/GlassButton + theme tokens) to
 * match CreateSpaceModal — same backdrop, sheet, header, and footer recipe.
 * No functional changes from the previous version.
 */

import { useState, useEffect } from "react";
import { useRouter }           from "next/navigation";
import {
  X, ChevronRight, ChevronLeft, Loader2,
  Home, Car, Wrench, Package,
} from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { displaySpaceName } from "@/lib/format";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassButton } from "@/components/atlas/GlassButton";

// ─── Types ────────────────────────────────────────────────────────────────────

type AssetKind = "real_estate" | "vehicle" | "equipment" | "other";

interface WorkspaceOption {
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
  defaultWorkspaceIds?: string[];
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
    iconCls:     "bg-blue-500/15 text-blue-400",
  },
  {
    value:       "vehicle",
    label:       "Vehicle",
    placeholder: "e.g. 2022 Honda CR-V",
    icon:        Car,
    iconCls:     "bg-emerald-500/15 text-emerald-400",
  },
  {
    value:       "equipment",
    label:       "Equipment",
    placeholder: "e.g. Freelance Business Equipment",
    icon:        Wrench,
    iconCls:     "bg-violet-500/15 text-violet-400",
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

export function AddManualAssetModal({ onClose, onAdd, defaultWorkspaceIds, zIndex }: Props) {
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
  const [workspaces,    setWorkspaces]    = useState<WorkspaceOption[]>([]);
  const [selectedWsIds, setSelectedWsIds] = useState<string[]>(defaultWorkspaceIds ?? []);
  const [loadingWs,     setLoadingWs]     = useState(false);

  // ── Submission state ───────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // ── Fetch workspaces for step 2 ───────────────────────────────────────────
  useEffect(() => {
    if (step !== 2) return;
    async function load() {
      setLoadingWs(true);
      try {
        const r    = await fetch("/api/workspaces");
        const data = await r.json();
        const list: WorkspaceOption[] = (data.mine ?? [])
          .filter((w: WorkspaceOption) => w.type !== "PERSONAL")
          .map((w: { id: string; name: string; type: string }) => ({
            id:   w.id,
            name: w.name,
            type: w.type,
          }));
        setWorkspaces(list);
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
        workspaceIds:  selectedWsIds,
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

      {/* Workspace sharing */}
      {loadingWs ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 size={12} className="animate-spin" />
          Loading Spaces…
        </div>
      ) : workspaces.length > 0 ? (
        <Field label="Share into Spaces (optional)">
          <div className="space-y-2">
            {workspaces.map((ws) => {
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

  // ─── Modal shell ──────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{
        zIndex: zIndex ?? 100,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <GlassPanel depth="thick" elevation="e4" radius="xl" className="w-full sm:max-w-md">
        <div className="flex flex-col max-h-[92dvh] sm:max-h-[88dvh]">

          {/* ── Header ────────────────────────────────────────────────────────── */}
          <div
            className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 shrink-0"
            style={{ borderBottom: "1px solid var(--border-hairline)" }}
          >
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Add Asset</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Step {step} of 2 — {step === 1 ? "Basic details" : "Optional details & sharing"}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              aria-label="Close"
              className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* ── Body ──────────────────────────────────────────────────────────── */}
          <div className="px-6 py-6 overflow-y-auto flex-1 min-h-0">
            {step === 1 ? step1 : step2}
          </div>

          {/* ── Footer ────────────────────────────────────────────────────────── */}
          <div
            className="px-6 py-5 shrink-0 space-y-3"
            style={{ borderTop: "1px solid var(--border-hairline)" }}
          >
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
        </div>
      </GlassPanel>
    </div>
  );
}
