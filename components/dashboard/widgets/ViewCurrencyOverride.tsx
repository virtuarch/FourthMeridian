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
import { ChevronDown, Loader2 } from "lucide-react";
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
        // V25-CLOSE-3A-FIX — carry the REQUESTED currency, not the effective one.
        // When the request was unsatisfiable the server reverts (`d.target` /
        // `d.effective` = USD); storing that here would silently snap the control
        // back to USD and hide the failure. Storing the requested currency routes
        // the override's display currency back through useSpaceData → the shared
        // /view-context verdict → the ONE composition-root CurrencyRevertedBanner,
        // exactly as the persisted-currency path does. `moneyCtx` is already the
        // effective (USD) context, so values stay accurate either way.
        onChange({ currency: d.requested ?? d.target, moneyCtx: d.moneyCtx });
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  // M3-Reset — compact prototype-style currency control: `USD ▾`. The verbose
  // "View as" label, the "(saved)" suffix, and the "Preview only…" sentence are
  // gone; the preview-not-saved honesty survives as a quiet "preview" cue (with
  // the full explanation on hover) only WHEN an override is active. All FX
  // behaviour/state/semantics underneath are unchanged.
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative inline-flex items-center">
        <select
          value={override?.currency ?? spaceCurrency}
          onChange={(e) => select(e.target.value)}
          disabled={busy}
          aria-label="Reporting currency (view as)"
          className="appearance-none cursor-pointer bg-transparent hover:bg-[var(--surface-hover)] rounded-lg pl-2.5 pr-6 py-1 text-xs font-medium text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-hairline-strong)] transition-colors"
        >
          {[FX_BASE, ...SUPPORTED_QUOTES].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <ChevronDown size={13} aria-hidden className="pointer-events-none absolute right-1.5 text-[var(--text-muted)]" />
      </div>
      {busy && <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" />}
      {override && !busy && (
        <span
          className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]"
          title={`Preview only — not saved. Reload returns to ${spaceCurrency}.`}
        >
          preview
        </span>
      )}
      {error && <span className="text-[10px] text-[var(--coral-400)]">{error}</span>}
    </div>
  );
}
