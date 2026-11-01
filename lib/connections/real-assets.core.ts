/**
 * lib/connections/real-assets.core.ts  (Connections 2.0 — categories + real assets)
 *
 * PURE. Everything Connections says about its CATEGORIES (All · Banks · Crypto ·
 * Real assets) and about a MANUAL ASSET's row and detail. No React, no DB, no
 * ambient clock — `now` is an argument wherever age is computed.
 *
 * ── Why real assets are here at all ──────────────────────────────────────────
 * A home or a car added through POST /api/accounts/manual is a FinancialAccount
 * (type `other`, syncStatus `"manual"`) with an AccountConnection that has no
 * PlaidItem and no wallet Connection. Connections listed provider connections
 * only, so once added an asset never appeared here again — the one place a user
 * goes to see "what have I brought in". It is listed now, as what it is: a thing
 * the user values themselves, never a provider, never a sync.
 *
 * ── The value carve-out (owner-approved) ─────────────────────────────────────
 * Provider rows keep the PCS-2 boundary — names, counts and dates, never
 * balances. A manual asset's row DOES show its value: that figure is the user's
 * own typed estimate, it is the only thing the asset is, and the owner asked for
 * it. Nothing here sums values: the category bar shows COUNTS, never a total, so
 * Connections can never become a second net-worth figure.
 *
 * ── Words ────────────────────────────────────────────────────────────────────
 * Manual-asset copy never uses provider/sync language (sync, connected,
 * provider, refresh, import, Plaid). Its freshness is the user's: an estimate
 * older than a year asks to be reconsidered, it is never "out of date" the way
 * a feed is. History is what the ledger holds — nothing earlier is inferred.
 */

import type { SyncConnection } from "@/lib/sync/status";
import type { AccountLite } from "@/components/connections/ConnectionCard";
import { networkName } from "@/lib/connections/connection-detail.core";
import type { ConnectionTone } from "@/lib/connections/connection-summary";

// ── Categories ───────────────────────────────────────────────────────────────

export type ConnectionsCategory = "all" | "banks" | "crypto" | "real_assets";

export const CATEGORY_ORDER: readonly ConnectionsCategory[] = ["all", "banks", "crypto", "real_assets"];

export const CATEGORY_LABEL: Record<ConnectionsCategory, string> = {
  all: "All", banks: "Banks", crypto: "Crypto", real_assets: "Real assets",
};

/** Which category a provider connection belongs to. Plaid = Banks; a wallet = Crypto. */
export function connectionCategory(c: Pick<SyncConnection, "provider">): Exclude<ConnectionsCategory, "all" | "real_assets"> {
  return c.provider === "WALLET" ? "crypto" : "banks";
}

export type CategoryCounts = Record<ConnectionsCategory, number>;

/**
 * One count per category: connections (institutions / wallets), and assets.
 * Every item is in exactly one category, so `all` is their sum — never a second
 * count of anything (no double counting), and never a money total.
 */
export function categoryCounts(
  connections: readonly Pick<SyncConnection, "provider">[],
  assets: readonly unknown[],
): CategoryCounts {
  let banks = 0, crypto = 0;
  for (const c of connections) {
    if (connectionCategory(c) === "crypto") crypto++;
    else banks++;
  }
  return { all: banks + crypto + assets.length, banks, crypto, real_assets: assets.length };
}

/** The segmented-control label: "Banks · 2". */
export function categoryOptionLabel(cat: ConnectionsCategory, counts: CategoryCounts): string {
  return `${CATEGORY_LABEL[cat]} · ${counts[cat]}`;
}

/** The provider connections a category shows (Real assets shows none; All shows all). */
export function connectionsInCategory<T extends Pick<SyncConnection, "provider">>(
  connections: readonly T[],
  cat: ConnectionsCategory,
): T[] {
  if (cat === "all") return [...connections];
  if (cat === "real_assets") return [];
  return connections.filter((c) => connectionCategory(c) === cat);
}

/** Honest empty state per category — what is missing and the way to add it. */
export function categoryEmptyState(cat: ConnectionsCategory): { title: string; body: string } {
  switch (cat) {
    case "banks":       return { title: "No banks or brokerages connected", body: "Use + Connect → Bank or brokerage above to bring in checking, savings, cards, loans and investments." };
    case "crypto":      return { title: "No crypto wallets yet", body: "Use + Connect → Crypto wallet above with a public address. Watch-only — never a seed phrase or private key." };
    case "real_assets": return { title: "No real assets yet", body: "Use + Add Manual Asset above for a home, vehicle or anything else you value yourself." };
    case "all":         return { title: "Nothing here yet", body: "Connect an institution, add a wallet or add an asset to get started." };
  }
}

// ── Crypto: wallets grouped by blockchain ────────────────────────────────────

export interface ChainGroup<T> { key: string; label: string; connections: T[] }

const CHAIN_ORDER = ["BTC", "ETH", "SOL"];

/**
 * Wallet connections grouped by the chain their account denominates
 * (FinancialAccount.walletChain, carried on AccountLite.chain). Bitcoin,
 * Ethereum, Solana first, any other network after (alphabetical); a wallet
 * whose chain is not known lands in "Other networks" — never guessed.
 */
export function groupWalletsByChain<T extends Pick<SyncConnection, "id" | "provider">>(
  connections: readonly T[],
  accountsByConnectionId: Readonly<Record<string, readonly Pick<AccountLite, "chain">[]>>,
): ChainGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const c of connections) {
    if (c.provider !== "WALLET") continue;
    const chain = accountsByConnectionId[c.id]?.find((a) => a.chain)?.chain?.trim().toUpperCase() || "";
    (by.get(chain) ?? by.set(chain, []).get(chain)!).push(c);
  }
  const rank = (k: string) => (k === "" ? 1e6 : CHAIN_ORDER.includes(k) ? CHAIN_ORDER.indexOf(k) : 1e3);
  return [...by.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((k) => ({ key: k || "unknown", label: k ? networkName(k) ?? k : "Other networks", connections: by.get(k)! }));
}

// ── Manual assets ────────────────────────────────────────────────────────────

/** One of the user's own manual assets, as Connections shows it. Serializable. */
export interface ManualAssetLite {
  id:       string;
  /** Resolved display name (displayName ?? … ?? name — the one identity authority). */
  name:     string;
  /** The user's current estimate = FinancialAccount.balance (= the latest-dated valuation). */
  value:    number;
  currency: string;
  /** YYYY-MM-DD the current estimate describes; null when no dated valuation exists. */
  valuedAsOfISO: string | null;
  /** Acquisition facts (ManualAssetProfile), when the user gave them. */
  acquisitionDateISO: string | null;
  purchasePrice:      number | null;
  purchaseCurrency:   string | null;
  /** The Spaces it is shown in (ACTIVE links), display names. */
  spaces:   { id: string; name: string }[];
  /** The user's own audit events for this asset, newest first. Kinds and dates only. */
  activity: ManualAssetActivity[];
}

/**
 * The kind line. The create form used to ask for a kind (home / vehicle / …),
 * but nothing stores it (RWA-1 removed the field for exactly that reason), so
 * every manual asset is honestly a "Real asset" — never a guessed kind.
 */
export const MANUAL_ASSET_KIND_LABEL = "Real asset";
export const MANUAL_ASSET_SOURCE_LABEL = "Valued by you";

/** An estimate older than this asks to be reconsidered. */
export const MANUAL_ASSET_STALE_AFTER_DAYS = 365;

const MS_PER_DAY = 86_400_000;
const dayUTC = (iso: string) => Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);

export interface ManualAssetFreshness { stale: boolean; note: string }

/**
 * The user's freshness, not a feed's. Older than 12 months ⇒ "Consider
 * updating"; otherwise the estimate simply stands. No date ⇒ the user is asked
 * to record one — an age is never invented.
 */
export function manualAssetFreshness(valuedAsOfISO: string | null, now: Date): ManualAssetFreshness {
  if (!valuedAsOfISO || Number.isNaN(dayUTC(valuedAsOfISO))) {
    return { stale: true, note: "No dated value yet. Consider recording one." };
  }
  const days = Math.floor((now.getTime() - dayUTC(valuedAsOfISO)) / MS_PER_DAY);
  if (days > MANUAL_ASSET_STALE_AFTER_DAYS) {
    return { stale: true, note: "Last valued over a year ago. Consider updating your estimate." };
  }
  return { stale: false, note: "Your estimate is recent. Update it whenever its value changes." };
}

export function formatAssetDate(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export interface ManualAssetSummary {
  kind:   string;
  source: string;
  /** "Valued Oct 2, 2026" / "No valuation date". */
  valued: string;
  status: string;
  tone:   ConnectionTone;
}

/** The row's one-line summary — the same freshness rule the Health tab states. */
export function summarizeManualAsset(asset: Pick<ManualAssetLite, "valuedAsOfISO">, now: Date): ManualAssetSummary {
  const f = manualAssetFreshness(asset.valuedAsOfISO, now);
  return {
    kind:   MANUAL_ASSET_KIND_LABEL,
    source: MANUAL_ASSET_SOURCE_LABEL,
    valued: asset.valuedAsOfISO ? `Valued ${formatAssetDate(asset.valuedAsOfISO)}` : "No valuation date",
    status: f.stale ? "Consider updating" : "Your estimate",
    tone:   f.stale ? "attention" : "ok",
  };
}

export interface ManualAssetHealth {
  headline: string;
  tone:     ConnectionTone;
  lines:    { key: string; label: string; text: string; tone: ConnectionTone }[];
}

/** Health for a manual asset: who values it, when, and whether to look again. */
export function manualAssetHealth(asset: Pick<ManualAssetLite, "valuedAsOfISO">, now: Date): ManualAssetHealth {
  const f = manualAssetFreshness(asset.valuedAsOfISO, now);
  return {
    headline: "You value this asset yourself",
    tone:     f.stale ? "attention" : "ok",
    lines: [
      { key: "source",    label: "Value",          text: "Your own estimate, not a market price", tone: "ok" },
      { key: "valuation", label: "Last valuation", text: asset.valuedAsOfISO ? formatAssetDate(asset.valuedAsOfISO) : "Not dated", tone: asset.valuedAsOfISO ? "ok" : "attention" },
      { key: "freshness", label: "Freshness",      text: f.note, tone: f.stale ? "attention" : "ok" },
    ],
  };
}

// ── Activity: the user's own audit events for an asset ───────────────────────

/**
 * The audit actions that describe a manual asset's life, as written by the
 * existing routes (POST/PATCH/DELETE /api/accounts/manual[/id], its restore,
 * and PATCH /api/accounts/[id] for a rename). Every one carries
 * `metadata.accountId`.
 */
export const MANUAL_ASSET_ACTIVITY_ACTIONS = [
  "MANUAL_ASSET_ADD", "MANUAL_ASSET_UPDATE", "ACCOUNT_RENAMED", "MANUAL_ASSET_DELETE", "MANUAL_ASSET_RESTORE",
] as const;
export type ManualAssetActivityAction = (typeof MANUAL_ASSET_ACTIVITY_ACTIONS)[number];

const ACTIVITY_LABEL: Record<ManualAssetActivityAction, string> = {
  MANUAL_ASSET_ADD:     "Added",
  MANUAL_ASSET_UPDATE:  "Valuation recorded",
  ACCOUNT_RENAMED:      "Renamed",
  MANUAL_ASSET_DELETE:  "Removed",
  MANUAL_ASSET_RESTORE: "Restored",
};

export interface ManualAssetActivity { action: ManualAssetActivityAction; label: string; atISO: string }

export interface AuditRowLite { action: string; createdAt: Date | string; metadata: unknown }

/**
 * Audit rows → activity per asset id, newest first. Reads ONLY
 * `metadata.accountId` (the reference) — never a value, a name or anything
 * else the metadata may carry. Unknown actions and other accounts are dropped.
 */
export function groupAssetActivity(
  rows: readonly AuditRowLite[],
  assetIds: ReadonlySet<string>,
): Record<string, ManualAssetActivity[]> {
  const out: Record<string, ManualAssetActivity[]> = {};
  for (const r of rows) {
    if (!(MANUAL_ASSET_ACTIVITY_ACTIONS as readonly string[]).includes(r.action)) continue;
    const accountId = (r.metadata as { accountId?: unknown } | null)?.accountId;
    if (typeof accountId !== "string" || !assetIds.has(accountId)) continue;
    const action = r.action as ManualAssetActivityAction;
    const atISO = (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString();
    (out[accountId] ??= []).push({ action, label: ACTIVITY_LABEL[action], atISO });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.atISO.localeCompare(a.atISO));
  return out;
}

/** The confirm copy for Remove — archive semantics, as the DELETE route behaves. */
export function removeAssetMessage(name: string): string {
  return `${name} leaves your net worth and every Space it's shown in. Its value history is kept, and you can restore it from Settings → Data & Privacy → Archive & Trash.`;
}
