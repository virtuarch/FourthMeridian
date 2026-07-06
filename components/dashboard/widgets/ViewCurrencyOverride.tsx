"use client";

/**
 * components/dashboard/widgets/ViewCurrencyOverride.tsx
 *
 * MC1 Phase 4 Slice 8 (plan D-10) — the EPHEMERAL "view as" currency
 * selector for aggregate surfaces.
 *
 * Doctrine (approved):
 *   - View-only, in-memory React state in the host — never persisted (no
 *     Space PATCH, no User PATCH, no cookie, no storage), so a reload
 *     resets to the Space's saved reporting currency by construction.
 *   - Writers never consult it: the only data flow is
 *     GET /api/money/view-context (read-only) → serialized rate table →
 *     client-side re-render of the host's aggregate math.
 *   - Copy makes "preview, not saved" explicit.
 */

import { useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import type { SerializedConversionContext } from "@/lib/money/convert";

export interface ViewOverride {
  currency: string;
  moneyCtx: SerializedConversionContext;
}

export function ViewCurrencyOverride({
  spaceCurrency,
  override,
  onChange,
}: {
  /** The Space's persisted reporting currency (the "off" position). */
  spaceCurrency: string;
  override: ViewOverride | null;
  onChange: (next: ViewOverride | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function select(target: string) {
    setError("");
    if (target === spaceCurrency) {
      onChange(null); // back to the persisted currency — no fetch needed
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/money/view-context?target=${encodeURIComponent(target)}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Could not load rates for that currency");
      } else {
        const d = await res.json();
        onChange({ currency: d.target, moneyCtx: d.moneyCtx });
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]">
        <Eye size={12} className="shrink-0" />
        View as
      </span>
      <select
        value={override?.currency ?? spaceCurrency}
        onChange={(e) => select(e.target.value)}
        disabled={busy}
        className="bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-lg px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors"
      >
        {[FX_BASE, ...SUPPORTED_QUOTES].map((c) => (
          <option key={c} value={c}>
            {c === spaceCurrency ? `${c} (saved)` : c}
          </option>
        ))}
      </select>
      {busy && <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" />}
      {override && !busy && (
        <span className="text-[10px] text-[var(--text-muted)]">
          Preview only — not saved. Reload returns to {spaceCurrency}.
        </span>
      )}
      {error && <span className="text-[10px] text-[var(--coral-400)]">{error}</span>}
    </div>
  );
}
