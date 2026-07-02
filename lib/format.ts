/**
 * lib/format.ts
 *
 * Shared formatting helpers for Fourth Meridian.
 *
 * ── HYDRATION SAFETY ──────────────────────────────────────────────────────────
 * All date formatters in this module use an explicit timezone ("UTC") so that
 * the server (Next.js SSR) and the client (browser) produce identical strings
 * for the same ISO timestamp, regardless of the device's local timezone.
 *
 * Example — WITHOUT explicit timezone (old pattern, hydration-unsafe):
 *   new Date("2024-01-16T03:00:00Z").toLocaleDateString("en-US", { month: "short", ... })
 *   → Server (Mac US-Eastern UTC-5): "Jan 15, 2024"
 *   → Client (Android UTC+5:30):      "Jan 16, 2024"  ← MISMATCH
 *
 * Example — WITH explicit UTC timezone (this module):
 *   → Server: "Jan 16, 2024"
 *   → Client: "Jan 16, 2024"  ← always consistent
 *
 * For values that SHOULD reflect the user's local timezone (e.g. a greeting
 * based on local hour), compute them AFTER mount with useEffect and a neutral
 * initial state. See getGreeting() + useGreeting() below.
 *
 * ── CURRENCY ──────────────────────────────────────────────────────────────────
 * These wrappers live alongside the existing lib/currency.ts. They call through
 * to the same Intl.NumberFormat machinery; import from here when you need
 * a self-contained helper.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────
 *   import { formatDate, formatCurrency, useGreeting } from "@/lib/format";
 */

import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// ── Date ──────────────────────────────────────────────────────────────────────

/**
 * "Jan 15, 2024" — UTC calendar date, SSR-safe.
 * Use for account sync dates, transaction dates, etc.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month:    "short",
    day:      "numeric",
    year:     "numeric",
  }).format(new Date(iso));
}

/**
 * "January 2026" — UTC month + year only, SSR-safe.
 * Use for payoff date projections, goal target dates.
 */
export function formatMonthYear(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month:    "long",
    year:     "numeric",
  }).format(new Date(iso));
}

/**
 * "Jan 15, 2024 at 10:30 AM" — UTC datetime, SSR-safe.
 * Use for audit logs, session timestamps.
 *
 * Uses formatToParts + manual assembly instead of format() because the
 * separator between date and time varies across ICU versions:
 *   Node 18 / ICU 71: "Jan 15, 2024, 10:30 AM"   (comma)
 *   Node 22 / ICU 73: "Jan 15, 2024 at 10:30 AM"  ("at")
 * Manual assembly pins the output to "Month D, YYYY at H:MM AM/PM".
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month:    "short",
    day:      "numeric",
    year:     "numeric",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  }).formatToParts(new Date(iso));

  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  return `${p.month} ${p.day}, ${p.year} at ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/**
 * "Jan 15 at 10:30 AM" (no year) — UTC datetime, SSR-safe.
 * Use for recent activity, advice banners.
 *
 * Same manual-assembly approach as formatDateTime — avoids ICU separator drift.
 */
export function formatDateTimeShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month:    "short",
    day:      "numeric",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  }).formatToParts(new Date(iso));

  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  return `${p.month} ${p.day} at ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

// ── Relative time ─────────────────────────────────────────────────────────────

/**
 * "2 hours ago", "3 days ago", etc. — uses client local time.
 * NOT safe to call during SSR render. Use only in:
 *   - useEffect
 *   - event handlers
 *   - after-mount state (e.g. useRelativeTime hook)
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diffMs  = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)  return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)  return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay !== 1 ? "s" : ""} ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12)  return `${diffMo} month${diffMo !== 1 ? "s" : ""} ago`;
  return `${Math.floor(diffMo / 12)} year${Math.floor(diffMo / 12) !== 1 ? "s" : ""} ago`;
}

// ── Greeting ──────────────────────────────────────────────────────────────────

/**
 * Time-of-day greeting based on client local hour.
 * NOT safe to call during SSR. Use useSyncExternalStore to avoid hydration
 * mismatch and React Compiler's react-hooks/set-state-in-effect rule:
 *
 *   const greeting = useSyncExternalStore(
 *     () => () => {},
 *     () => getGreeting(),
 *     () => GREETING_PLACEHOLDER,
 *   );
 */
export function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** Neutral text shown during SSR and first client paint. */
export const GREETING_PLACEHOLDER = "Welcome back";

// ── Currency ──────────────────────────────────────────────────────────────────

/**
 * "$1,234" — no cents, explicit locale + currency, SSR-safe.
 * Standard dollar display for balances, totals.
 */
export function formatCurrency(
  amount:   number,
  currency: string = DEFAULT_DISPLAY_CURRENCY,
): string {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * "$1,234.56" — with cents, SSR-safe.
 */
export function formatCurrencyExact(
  amount:   number,
  currency: string = DEFAULT_DISPLAY_CURRENCY,
): string {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * "$1.2K", "$3.4M" — compact notation, SSR-safe.
 * Use for summary cards, charts.
 */
export function formatCompactCurrency(
  amount:   number,
  currency: string = DEFAULT_DISPLAY_CURRENCY,
): string {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency,
    notation:              "compact",
    maximumFractionDigits: 1,
  }).format(amount);
}

/**
 * "12.3%" — percentage with one decimal, SSR-safe.
 */
export function formatPercent(value: number, decimals = 1): string {
  return new Intl.NumberFormat("en-US", {
    style:                 "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value / 100);
}

/**
 * "1,234" — plain integer with commas, SSR-safe.
 * Use instead of .toLocaleString() without explicit locale.
 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

// ── Possessive ────────────────────────────────────────────────────────────────

/**
 * Proper English possessive of a name: "Chris" → "Chris'", "Sarah" → "Sarah's".
 * Names already ending in s/S take a bare trailing apostrophe; everything else
 * takes 's. Centralizes this so call sites stop hardcoding `${name}'s` (which
 * is wrong for any name ending in s) — e.g. default Space names, shared
 * account labels, activity-log subtitles.
 */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/**
 * Display-only normalization for legacy Space names.
 *
 * Catches two independent legacy issues at render time, without touching
 * the database:
 *
 *  1. Vocabulary rename — rows created before "Space" became "Space"
 *     still literally store a trailing " Dashboard" suffix.
 *  2. Possessive-grammar bug — rows created before possessive() existed
 *     hardcoded `${name}'s Space` / `${name}'s Dashboard` unconditionally,
 *     which is wrong for any base name ending in s/S ("Chris's Space"
 *     instead of "Chris' Space"). A row can have either issue alone
 *     ("Chris's Space", "John's Dashboard") or both at once ("Chris's
 *     Dashboard") — LEGACY_DEFAULT_NAME matches either apostrophe form
 *     ('s or bare ') in front of either suffix (Space or Dashboard),
 *     recovers the base name, and rebuilds the suffix from scratch with
 *     possessive() + " Space" so the output is correct no matter which
 *     legacy form (or combination) the stored row has.
 *
 * Deliberately narrow: only matches when the *entire* trailing segment is
 * an apostrophe immediately followed by "Space" or "Dashboard" and nothing
 * else. A user could legitimately name a Space "Dashboard Redesign Project"
 * or "Chris's Book Club" — neither matches this pattern, so both render
 * untouched. The plain "X Dashboard" (no apostrophe) case still falls
 * through to the simple vocabulary swap below.
 *
 * This does not touch the database. If a true backfill/migration is ever
 * added for this, this helper becomes unnecessary and can be removed.
 */
const LEGACY_DEFAULT_NAME = /^(.+?)(?:'s|')\s+(?:Space|Dashboard)$/;

export function displaySpaceName(name: string | null | undefined): string {
  if (!name) return name ?? "";

  const legacy = name.match(LEGACY_DEFAULT_NAME);
  if (legacy) return `${possessive(legacy[1])} Space`;

  return name.endsWith(" Dashboard") ? `${name.slice(0, -" Dashboard".length)} Space` : name;
}
