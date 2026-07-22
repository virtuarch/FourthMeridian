"use client";

/**
 * lib/currency-context.tsx
 *
 * MC1 Phase 4 Slice 1 (plan D-1) — the runtime display-currency source for
 * AGGREGATE surfaces. This is the seam lib/currency.ts always promised:
 * DEFAULT_DISPLAY_CURRENCY remains the build-time constant and the universal
 * fallback; this provider supplies the per-Space value
 * (Space.reportingCurrency) at render time.
 *
 * Rules (roadmap §6.3, unchanged):
 *   - AGGREGATE values (totals, chart axes/tooltips, hero numbers) format in
 *     the display currency from this hook.
 *   - ITEMIZED rows (a single account's balance, a single transaction) keep
 *     formatting in their own native row `currency` — never this hook.
 *
 * Kill switch: useDisplayCurrency() falls back to DEFAULT_DISPLAY_CURRENCY
 * ("USD") when no provider is mounted, so unwrapped trees render exactly as
 * they always have. The provider is mounted by the dashboard shell layout
 * from the resolved Space context; pages outside it inherit the fallback.
 *
 * NOTE (transitional, until Phase 4 Slice 4): chart HISTORY renders stored
 * snapshot totals in their stamped currency. A Space switched to a non-USD
 * currency before Slice 4 lands would see new-currency axis labels over
 * mixed-stamp history; Slice 4's stamp-aware readers resolve this. All-USD
 * Spaces (every Space today) are unaffected.
 */

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

const DisplayCurrencyContext = createContext<string>(DEFAULT_DISPLAY_CURRENCY);

/**
 * The active Space's reporting currency for aggregate formatting.
 * Falls back to DEFAULT_DISPLAY_CURRENCY when no provider is mounted.
 */
export function useDisplayCurrency(): string {
  return useContext(DisplayCurrencyContext);
}

export function DisplayCurrencyProvider({
  currency,
  children,
}: {
  /** The Space's reportingCurrency (server-resolved); falls back to USD when empty. */
  currency?: string | null;
  children: ReactNode;
}) {
  return (
    <DisplayCurrencyContext.Provider value={currency || DEFAULT_DISPLAY_CURRENCY}>
      {children}
    </DisplayCurrencyContext.Provider>
  );
}
