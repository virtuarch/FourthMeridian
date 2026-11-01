/**
 * lib/platform/merchant/overview-types.ts  (Platform Spaces 2.0 — Merchant Operations)
 *
 * What Merchant Operations IS today: transaction-merchant IDENTITY — how
 * customers' transactions resolve to a canonical merchant, where each
 * category comes from, and the operator merge review. Fourth Meridian does NOT
 * process payments, settle funds or run merchant onboarding, so there are no
 * payment, settlement or processing figures here — by design, not omission.
 * Client-safe (types only); counts only — no merchant names, no tenant data.
 */

export interface MerchantOverviewResponse {
  checkedAt: string;
  windowDays: 30 | 90;
  transactions: {
    total: number;
    /** Transactions with a resolved Merchant (merchantId set). */
    resolved: number;
    /** By category provenance; `null` key = pre-MI (provenance not recorded). */
    bySource: { key: string; label: string; count: number }[];
  };
  merchants: { total: number; aliases: { source: string; label: string; count: number }[]; userRules: number };
  decisions: {
    days: { day: string; merged: number; dismissed: number }[];
    merged: number;
    dismissed: number;
    /** All-time decisions by evidence tier. */
    byTier: { tier: string; merged: number; dismissed: number }[];
  };
  /** New aliases and user rules per day in the window. */
  growth: { days: { day: string; aliases: number; rules: number }[] };
  notes: string[];
}
