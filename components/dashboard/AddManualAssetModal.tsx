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
 */

import { useState, useEffect } from "react";
import { useRouter }           from "next/navigation";
import {
  X, ChevronRight, ChevronLeft, Loader2,
  Home, Car, Wrench, Package,
} from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

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
    iconCls:     "bg-gray-500/15 text-gray-400",
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
      <label className="block text-xs font-medium text-gray-400">{label}</label>
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
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
      className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
    />
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddManualAssetModal({ onClose, onAdd }: Props) {
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
  const [selectedWsIds, setSelectedWsIds] = useState<string[]>([]);
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
                className={`flex items-center gap-2.5 px-3.5 py-3 rounded-xl border text-left transition-all ${
                  active
                    ? "border-blue-500 bg-blue-500/10 text-white"
                    : "border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600 hover:text-gray-300"
                }`}
              >
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${active ? "bg-blue-500/20 text-blue-400" : opt.iconCls}`}>
                  <Icon size={14} />
                </div>
                <span className="text-sm font-medium">{opt.label}</span>
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
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors appearance-none"
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
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors [color-scheme:dark]"
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
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors resize-none"
        />
      </Field>

      {/* Workspace sharing */}
      {loadingWs ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" />
          Loading workspaces…
        </div>
      ) : workspaces.length > 0 ? (
        <Field label="Share into workspaces (optional)">
          <div className="space-y-2">
            {workspaces.map((ws) => {
              const checked = selectedWsIds.includes(ws.id);
              return (
                <label
                  key={ws.id}
                  className={`flex items-center gap-3 px-3.5 py-3 rounded-xl border cursor-pointer transition-all ${
                    checked
                      ? "border-blue-500/60 bg-blue-500/8 text-white"
                      : "border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setSelectedWsIds((prev) =>
                      checked ? prev.filter((id) => id !== ws.id) : [...prev, ws.id]
                    )}
                    className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500/30"
                  />
                  <span className="text-sm">{ws.name}</span>
                </label>
              );
            })}
          </div>
        </Field>
      ) : (
        <p className="text-xs text-gray-600">No shared workspaces found. The asset will be added to your personal dashboard.</p>
      )}
    </div>
  );

  // ─── Modal shell ──────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm">
      <div className="flex flex-col w-full max-h-[92dvh] sm:h-auto sm:max-w-md bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl shadow-2xl">

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800 shrink-0">
          <div>
            <p className="text-sm font-semibold text-white">Add Asset</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Step {step} of 2 — {step === 1 ? "Basic details" : "Optional details & sharing"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Body ──────────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0">
          {step === 1 ? step1 : step2}
        </div>

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <div className="p-5 border-t border-gray-800 shrink-0 space-y-3">
          {error && (
            <p className="text-xs text-red-400 text-center">{error}</p>
          )}

          <div className="flex gap-3">
            {step === 2 && (
              <button
                onClick={() => setStep(1)}
                disabled={loading}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-gray-700 text-sm text-gray-400 hover:text-white hover:border-gray-600 transition-colors disabled:opacity-50"
              >
                <ChevronLeft size={14} />
                Back
              </button>
            )}

            {step === 1 ? (
              <button
                onClick={() => { if (step1Valid) setStep(2); }}
                disabled={!step1Valid}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-semibold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue
                <ChevronRight size={14} />
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={loading || !step1Valid}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-semibold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                {loading ? "Adding asset…" : "Add Asset"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
