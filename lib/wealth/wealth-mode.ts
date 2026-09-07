/**
 * lib/wealth/wealth-mode.ts  (OVERVIEW-CONSOLIDATION)
 *
 * The Net Worth page's SUBJECT vocabulary — pure, framework-free, URL-facing.
 *
 * Overview is now two lenses (Net Worth · Cash Flow), and Net Worth is read
 * through three page-level MODES:
 *
 *   total   — the net-worth experience (the default)
 *   assets  — total assets, with Cash and Investments living INSIDE it
 *   debt    — the debt experience
 *
 * Inside `assets` the balance-history chart is SLICEABLE (All · Cash ·
 * Investments). A slice changes which series the chart plots and which drivers
 * the change ledger reconciles to; it is NOT a page — Cash and Investments are
 * sections of Assets, not destinations.
 *
 * This module evolves the former `?metric=` WealthMetric mechanism rather than
 * adding a second navigation system: the URL param keeps its name, the four
 * legacy values (netWorth / totalAssets / totalLiabilities / liquidNetWorth)
 * canonicalise to a mode, and the retired peer lenses (?perspective=liquidity |
 * investments | debt) canonicalise to a mode + slice. Nothing 404s.
 */

export type WealthMode = "total" | "assets" | "debt";
export const WEALTH_MODES: readonly WealthMode[] = ["total", "assets", "debt"];
export const DEFAULT_WEALTH_MODE: WealthMode = "total";

export type AssetsSlice = "all" | "cash" | "investments";
export const ASSETS_SLICES: readonly AssetsSlice[] = ["all", "cash", "investments"];
export const DEFAULT_ASSETS_SLICE: AssetsSlice = "all";

/** User-facing labels for the page-level selector — the SUBJECT of the page. */
export const WEALTH_MODE_LABELS: Record<WealthMode, string> = {
  total:  "Total",
  assets: "Assets",
  debt:   "Debt",
};

/** User-facing labels for the Assets balance-history slice. */
export const ASSETS_SLICE_LABELS: Record<AssetsSlice, string> = {
  all:         "All",
  cash:        "Cash",
  investments: "Investments",
};

/**
 * The historical series keys the Wealth chart can plot. The four original keys
 * are RETAINED (their series still ride every WealthChartPoint — Liquid Net Worth
 * is still computed, still plotted-able, and still a hero stat); `cash` and
 * `invested` are the two Assets slices.
 */
export type WealthMetricKey =
  | "netWorth"
  | "totalAssets"
  | "totalLiabilities"
  | "liquidNetWorth"
  | "cash"
  | "invested";

/**
 * Legacy `?metric=` values → mode. The old selector was a SERIES switcher; the
 * new one is a SUBJECT switcher, so each old series maps to the page that now
 * carries it. `liquidNetWorth` lands on Total, where the Liquid NW figure lives
 * as a secondary stat (it is a derived metric spanning Assets and Debt — no
 * single mode owns it as a page).
 */
const LEGACY_METRIC_MODE: Record<string, WealthMode> = {
  networth:         "total",
  totalassets:      "assets",
  totalliabilities: "debt",
  liquidnetworth:   "total",
};

/** `?metric=` → mode. Unknown / absent ⇒ the default (never a crash). */
export function parseWealthMode(raw: string | null | undefined): WealthMode {
  if (!raw) return DEFAULT_WEALTH_MODE;
  const k = raw.toLowerCase();
  if ((WEALTH_MODES as string[]).includes(k)) return k as WealthMode;
  return LEGACY_METRIC_MODE[k] ?? DEFAULT_WEALTH_MODE;
}

/** `?slice=` → Assets slice. Unknown / absent ⇒ All. */
export function parseAssetsSlice(raw: string | null | undefined): AssetsSlice {
  if (!raw) return DEFAULT_ASSETS_SLICE;
  const k = raw.toLowerCase();
  return (ASSETS_SLICES as string[]).includes(k) ? (k as AssetsSlice) : DEFAULT_ASSETS_SLICE;
}

/** The URL value for a mode (the default clears the param). */
export function serializeWealthMode(mode: WealthMode): string | null {
  return mode === DEFAULT_WEALTH_MODE ? null : mode;
}

/** The URL value for a slice (All clears the param). */
export function serializeAssetsSlice(slice: AssetsSlice): string | null {
  return slice === DEFAULT_ASSETS_SLICE ? null : slice;
}

/**
 * The retired peer lenses → where they live now. A `?perspective=liquidity` link
 * opens Net Worth → Assets with the chart sliced to Cash (and the Cash section
 * focused); `investments` likewise; `debt` opens Net Worth → Debt. Any other id
 * is not a legacy target (null).
 */
export interface LegacyPerspectiveTarget {
  mode:  WealthMode;
  slice: AssetsSlice;
  /** The Assets section the link pointed at, for a one-shot scroll on arrival. */
  focus: "cash" | "investments" | null;
}

const LEGACY_PERSPECTIVE_TARGET: Record<string, LegacyPerspectiveTarget> = {
  liquidity:   { mode: "assets", slice: "cash",        focus: "cash" },
  investments: { mode: "assets", slice: "investments", focus: "investments" },
  debt:        { mode: "debt",   slice: "all",         focus: null },
};

export const LEGACY_PERSPECTIVE_IDS: readonly string[] = Object.keys(LEGACY_PERSPECTIVE_TARGET);

export function legacyPerspectiveTarget(id: string | null | undefined): LegacyPerspectiveTarget | null {
  if (!id) return null;
  return LEGACY_PERSPECTIVE_TARGET[id] ?? null;
}

/**
 * Which series the Wealth chart plots for a mode + slice. Debt has no wealth
 * series here — the Debt mode renders the Debt workspace's own balance history
 * (the same shared TrendChart over the same snapshot rows).
 */
export function wealthSeriesKey(mode: WealthMode, slice: AssetsSlice): WealthMetricKey {
  if (mode === "assets") {
    return slice === "cash" ? "cash" : slice === "investments" ? "invested" : "totalAssets";
  }
  if (mode === "debt") return "totalLiabilities";
  return "netWorth";
}
