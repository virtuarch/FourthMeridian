/**
 * lib/snapshots/real-asset-amendment-offer.core.ts   (RWA-2B — CONSENT FLOW)
 *
 * WHEN the UI may offer "Update past net worth?" after a manual real asset
 * gains history, and HOW the amendment preview is clipped and summarised for
 * the user to confirm. Pure: no DB, no React, no clock — `today` is an argument.
 *
 * ── The owner's rules this encodes ───────────────────────────────────────────
 *   · Frozen historical snapshots are preserved by default. Nothing here writes;
 *     it only decides whether to ASK, and what to show before the user says yes.
 *   · PERSONAL Spaces only. The existing consent-based amendment
 *     (lib/snapshots/snapshot-amendment.ts, kind ACCOUNT_ADDED_RETROACTIVE,
 *     POST /api/spaces/[id]/wealth/amend { preview } then { consent }) is the
 *     ONE path that may revise frozen days, and it refuses a SHARED Space; the
 *     offer is never shown there (fail-closed on an unknown type too).
 *   · The offer appears only when the asset has an anchor BEFORE today — a
 *     backdated or purchase-price starting value on creation, a backdated
 *     valuation, or a second value on an asset that already had one (which
 *     re-models the days between). An asset first valued today has no past
 *     to rebuild and gets no offer.
 *   · The requested range is [first anchor, yesterday]: today's row belongs to
 *     the live writer and is never amended.
 *   · The applied range is CLIPPED to the Space's existing history: only days
 *     that already have a net-worth row are revised. Rebuilding days before the
 *     Space's first snapshot would extend its net-worth series backwards with
 *     the asset alone, which is not what "update past net worth" means and not
 *     something the user was shown.
 */

import { HISTORICAL_AMENDMENT_ENABLED } from "./amendment-availability";

export interface AmendmentOffer {
  /** YYYY-MM-DD — the first anchor. */
  fromDate: string;
  /** YYYY-MM-DD — yesterday. */
  toDate: string;
}

const MS_PER_DAY = 86_400_000;

/** YYYY-MM-DD of the day before `today` (UTC calendar arithmetic). */
export function yesterdayOf(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Should the UI offer to update past net worth? Null means never ask.
 *
 *   spaceType !== "PERSONAL"  → null  (shared: never; unknown: fail closed)
 *   no first anchor           → null
 *   first anchor ≥ today      → null  (nothing before today to rebuild)
 */
export function realAssetAmendmentOffer(args: {
  spaceType: string | null | undefined;
  /** The asset's FIRST anchor date (YYYY-MM-DD), or null when it has none. */
  firstAnchorDate: string | null | undefined;
  today: string;
}): AmendmentOffer | null {
  // F1 (owner ruling 2026-10-15): while the amendment action is disabled the
  // offer is never made — see amendment-availability.ts.
  if (!HISTORICAL_AMENDMENT_ENABLED) return null;
  if (args.spaceType !== "PERSONAL") return null;
  const first = args.firstAnchorDate ?? null;
  if (first === null || first >= args.today) return null;
  return { fromDate: first, toDate: yesterdayOf(args.today) };
}

/** The per-day shape the amend route's preview returns (a subset of WealthHistoryDiff). */
export interface PreviewDay {
  date: string;
  action: string;
  netWorthBefore: number | null;
  netWorthAfter: number | null;
}

export interface ClippedPreview {
  /** The range to APPLY — clipped to the Space's existing history. */
  fromDate: string;
  toDate: string;
  /** Days inside that range the engine would actually change. */
  changedDays: number;
  firstChanged: string | null;
  lastChanged: string | null;
  /** Net worth on the most recent changed day: as recorded → as it would read. */
  netWorthBefore: number | null;
  netWorthAfter: number | null;
  /** Days in the requested range that precede the Space's first row (never created). */
  skippedBeforeHistory: number;
}

/**
 * Clip a preview to the days that already have a net-worth row and summarise
 * it. Null when the Space has no row anywhere in the requested range — there is
 * no past net worth to update, and the dialog says so instead of offering.
 */
export function clipAmendmentPreview(days: readonly PreviewDay[], requested: AmendmentOffer): ClippedPreview | null {
  const inRange = days.filter((d) => d.date >= requested.fromDate && d.date <= requested.toDate);
  const firstExisting = inRange.find((d) => d.netWorthBefore !== null);
  if (!firstExisting) return null;
  const fromDate = firstExisting.date;
  const skippedBeforeHistory = inRange.filter((d) => d.date < fromDate).length;
  const changed = inRange.filter((d) => d.date >= fromDate && (d.action === "write" || d.action === "write-partial"));
  const last = changed.length ? changed[changed.length - 1] : null;
  return {
    fromDate,
    toDate: requested.toDate,
    changedDays: changed.length,
    firstChanged: changed[0]?.date ?? null,
    lastChanged: last?.date ?? null,
    netWorthBefore: last?.netWorthBefore ?? null,
    netWorthAfter: last?.netWorthAfter ?? null,
    skippedBeforeHistory,
  };
}
