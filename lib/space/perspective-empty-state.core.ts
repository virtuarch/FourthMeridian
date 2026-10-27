/**
 * lib/space/perspective-empty-state.core.ts  (Connections pass PR 4 — shared empty states)
 *
 * PURE. One answer, for every Personal perspective, to "why is there nothing
 * here?" — from the Space's per-source health (space-data-health.core: the SAME
 * authority the Daily Brief and Connections read, including each source's
 * `feeds` populations). It distinguishes:
 *
 *   NO_SOURCES   nothing is connected or added to this Space at all
 *   NOT_FED      sources exist, but none feeds THIS view (a wallet on Debt)
 *   MANUAL_ONLY  only manually valued assets — they have no transactions, so
 *                a flow view (Cash Flow, Spending) has nothing to read
 *   PROCESSING   a source that feeds this view is still importing / never updated
 *   FAILED       a source that feeds this view needs reconnecting / errored
 *
 * and returns null when the view should render its own content.
 *
 * ⚠️ IT NEVER REPLACES A GENUINE ZERO OR REAL DATA. `hasContent` (the view has
 * rows, or a computed figure — including an observed 0) always wins: the answer
 * is then null for the body, and only a NOTE (stale / failed / still importing)
 * may sit beside the content. An empty view whose sources are all CURRENT is a
 * genuine zero and also returns null — "No debt" is a fact, not an empty state.
 *
 * ⚠️ NO CALCULATION AUTHORITY. Nothing here sums, values or classifies money;
 * populations come from the account classifier via `feeds`. Labels follow the
 * detail grant already applied upstream.
 */

import type { DataSourceState, DataSourceView, FedPopulation } from "@/lib/connections/space-data-health.core";

export type PerspectiveKey = "netWorth" | "assets" | "debt" | "cash" | "investments" | "cashFlow" | "spending";

export type EmptyReason = "NO_SOURCES" | "NOT_FED" | "MANUAL_ONLY" | "PROCESSING" | "FAILED";
export type ContentNote = "STALE" | "FAILED" | "PROCESSING";

/** The balance populations each view reads. Flow views read banking rows. */
const POPULATIONS: Record<PerspectiveKey, readonly FedPopulation[]> = {
  netWorth:    ["liquid", "investments", "digitalAssets", "realAssets", "liabilities"],
  assets:      ["liquid", "investments", "digitalAssets", "realAssets"],
  debt:        ["liabilities"],
  cash:        ["liquid"],
  investments: ["investments", "digitalAssets"],
  cashFlow:    ["bankingRows"],
  spending:    ["bankingRows"],
};

const FAILED_STATES: ReadonlySet<DataSourceState> = new Set(["NEEDS_RECONNECT", "CONNECTION_ERROR", "SYNC_INCOMPLETE"]);
const PROCESSING_STATES: ReadonlySet<DataSourceState> = new Set(["IMPORTING", "NEVER_UPDATED"]);

/** Does this source feed the view? Flow views: bank sources (banking rows come only from them). */
export function sourceFeeds(source: DataSourceView, perspective: PerspectiveKey): boolean {
  const wanted = POPULATIONS[perspective];
  if (wanted.includes("bankingRows")) {
    return source.feeds ? source.feeds.includes("bankingRows") || (source.kind === "BANK" && source.feeds.some((f) => f === "liquid" || f === "liabilities")) : source.kind === "BANK";
  }
  // A caller that did not scope by population: every source may feed it.
  if (!source.feeds) return true;
  return source.feeds.some((f) => wanted.includes(f));
}

export interface PerspectiveEmptyState {
  /** Why the BODY is empty, or null when the view renders its own content. */
  reason: EmptyReason | null;
  /** A note to show beside real content (never replaces it). */
  note: ContentNote | null;
  /** The feeding sources the reason / note is about (labels already grant-filtered). */
  sources: Pick<DataSourceView, "label" | "state" | "lastUpdatedAt" | "actionable">[];
}

export function classifyPerspectiveEmpty(
  perspective: PerspectiveKey,
  allSources: readonly DataSourceView[],
  hasContent: boolean,
): PerspectiveEmptyState {
  const pick = (ss: readonly DataSourceView[]) => ss.map(({ label, state, lastUpdatedAt, actionable }) => ({ label, state, lastUpdatedAt, actionable }));
  const feeding = allSources.filter((s) => sourceFeeds(s, perspective));
  const failed = feeding.filter((s) => FAILED_STATES.has(s.state));
  const processing = feeding.filter((s) => PROCESSING_STATES.has(s.state));
  const stale = feeding.filter((s) => s.state === "OUT_OF_DATE");

  if (hasContent) {
    if (failed.length) return { reason: null, note: "FAILED", sources: pick(failed) };
    if (processing.length) return { reason: null, note: "PROCESSING", sources: pick(processing) };
    if (stale.length) return { reason: null, note: "STALE", sources: pick(stale) };
    return { reason: null, note: null, sources: [] };
  }

  if (allSources.length === 0) return { reason: "NO_SOURCES", note: null, sources: [] };
  if (feeding.length === 0) {
    const manualOnly = POPULATIONS[perspective].includes("bankingRows") && allSources.every((s) => s.kind === "MANUAL");
    return { reason: manualOnly ? "MANUAL_ONLY" : "NOT_FED", note: null, sources: [] };
  }
  if (processing.length) return { reason: "PROCESSING", note: null, sources: pick(processing) };
  if (failed.length) return { reason: "FAILED", note: null, sources: pick(failed) };
  // Every feeding source is current (or merely stale): the emptiness is real.
  return { reason: null, note: stale.length ? "STALE" : null, sources: pick(stale) };
}

/** Customer copy. Never a code, never a provider error. */
export const EMPTY_COPY: Record<EmptyReason, { title: string; body: string; cta?: { label: string; href: string } }> = {
  NO_SOURCES:  { title: "Nothing connected yet", body: "Add a bank, a crypto wallet or an asset and this view fills in from it.", cta: { label: "Add an account", href: "/dashboard/connections" } },
  NOT_FED:     { title: "Nothing here feeds this view", body: "None of the accounts in this Space are the kind this view shows.", cta: { label: "Add an account", href: "/dashboard/connections" } },
  MANUAL_ONLY: { title: "No transactions to show", body: "Assets you value yourself have no transactions. Connect a bank account to see money moving in and out.", cta: { label: "Connect a bank", href: "/dashboard/connections" } },
  PROCESSING:  { title: "Still importing", body: "Your accounts are connected and their data is on its way. This view fills in when it arrives — you can leave this page." },
  FAILED:      { title: "A connection needs attention", body: "The account that feeds this view stopped updating.", cta: { label: "Open Connections", href: "/dashboard/connections" } },
};
