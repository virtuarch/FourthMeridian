/**
 * components/brief/data-freshness-copy.ts
 *
 * v2.7 — the words of the Daily Brief's "Financial data" disclosure, pure.
 *
 * Every time shown here is a source's last SUCCESSFUL data receipt
 * (lib/connections/space-data-health.core.ts — successful-write clocks only; a
 * failed attempt never moves them), never the Brief's generation time, which the
 * page shows separately ("Brief updated …"). Relative phrases come from THE shared
 * formatter (lib/format.ts `formatUpdatedAgo`), so "Updated 37 min ago" here and
 * on the dashboard header are one convention.
 *
 * ⚠️ NEVER "ALL UPDATED TOGETHER". A source or group whose accounts updated at
 * different times says so — "Updated 2 hr ago – yesterday" (newest – oldest) — and
 * an undated account is counted, not hidden.
 */

import { formatUpdatedAgo } from "@/lib/format";
import { sourceStatusText } from "@/lib/connections/source-health-copy";
import type { DataGroupView, DataSourceView } from "@/lib/brief-types";

const shortDate = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone });

/** "2 hr ago – yesterday" when the two ends read differently; the single phrase otherwise. */
export function updatedRange(newest: string | null | undefined, oldest: string | null, nowMs: number, timeZone?: string): string | null {
  const o = formatUpdatedAgo(oldest, nowMs, timeZone);
  if (!o) return null;
  const n = newest ? formatUpdatedAgo(newest, nowMs, timeZone) : null;
  return n && n !== o ? `${n} – ${o}` : o;
}

/** The collapsed header's phrase for a provider group: attention first, then a conservative range. */
export function groupFreshnessText(g: DataGroupView, nowMs: number, timeZone?: string): string {
  if (g.attention > 0) {
    return g.sources === 1 ? "needs attention" : `${g.attention} of ${g.sources} ${g.attention === 1 ? "needs" : "need"} attention`;
  }
  const range = updatedRange(g.newestUpdatedAt, g.oldestUpdatedAt, nowMs, timeZone);
  return range ? `updated ${range}` : "update time unavailable";
}

/** One source's status line in the expanded list. */
export function sourceFreshnessText(s: DataSourceView, nowMs: number, timeZone?: string): string {
  if (s.state === "CURRENT") {
    const range = updatedRange(s.newestUpdatedAt, s.lastUpdatedAt, nowMs, timeZone);
    return range ? `Updated ${range}` : "Update time unavailable";
  }
  // Every other state keeps the shared Connections copy (a problem is named as the
  // provider's verdict, with the last SUCCESSFUL update as an absolute date).
  return sourceStatusText(s.state, s.lastUpdatedAt, {
    date: (iso) => shortDate(iso, timeZone),
    recent: (iso) => formatUpdatedAgo(iso, nowMs, timeZone) ?? shortDate(iso, timeZone),
  });
}

/** The account-level qualifier, when some of a source's accounts carry no update time. */
export function undatedAccountsNote(s: DataSourceView): string | null {
  const n = s.undatedAccounts ?? 0;
  if (n <= 0) return null;
  return `${n} ${n === 1 ? "account has" : "accounts have"} no recorded update time`;
}
