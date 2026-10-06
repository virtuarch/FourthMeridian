/**
 * components/space/widgets/liquidity/horizons.ts
 *
 * The access horizons every liquidity surface groups by (Ladder, Sources
 * ledger, workspace tier composition) — one vocabulary, one colour per tier.
 * Which horizon an account is in is liquidityAccess (lib/account-classifier.ts);
 * this file only names and colours them.
 *
 * 2026-10-07 — `restricted` and `unverified` added. Before, every `investment`
 * was "Brokerage · crypto (settlement)" and every `checking` was cash, so a
 * 401(k) read as sellable within days and an HSA as spendable now. Neither tier
 * claims the money is unreachable: restricted money MAY be withdrawable, under
 * rules Fourth Meridian does not know; unverified is an investment whose kind
 * the provider has not reported.
 */

export type SourceHorizon = "now" | "days" | "restricted" | "unverified" | "illiquid";

export const HORIZON_LABEL: Record<SourceHorizon, string> = {
  now:        "Available now",
  days:       "Available in days",
  restricted: "Restricted",
  unverified: "Access unverified",
  illiquid:   "Illiquid",
};

/** The quiet sub-label under each horizon heading (what sits in it). */
export const HORIZON_META: Record<SourceHorizon, string> = {
  now:        "Checking · savings",
  days:       "Brokerage · crypto (settlement)",
  restricted: "Retirement · HSA · education (rules may apply)",
  unverified: "Investments of unreported type",
  illiquid:   "Property · other long-term",
};

/** Tier colours — identical across the Ladder, ledger and composition. */
export const HORIZON_COLOR: Record<SourceHorizon, string> = {
  now:        "#22c55e",
  days:       "#3b82f6",
  restricted: "#a78bfa",
  unverified: "#94a3b8",
  illiquid:   "#6b7280",
};

/** Ordered top (reachable now) → bottom (locked away) — the ladder reading order. */
export const HORIZON_ORDER: SourceHorizon[] = ["now", "days", "restricted", "unverified", "illiquid"];
