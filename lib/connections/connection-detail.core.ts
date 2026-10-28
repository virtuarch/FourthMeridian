/**
 * lib/connections/connection-detail.core.ts  (Connections detail — tabbed refinement)
 *
 * PURE. What the connection detail's three tabs say, derived from the SAME
 * authorities the row and the Daily Brief read (SyncConnection.state, the
 * connection intelligence facets, sourceHealth, the wallet coverage licence):
 *
 *   Overview  account groups (by the account's own type) and the headline facts
 *   Health    one line per dimension — connection, balances/holdings,
 *             transactions, history, valuation — never one blended "Healthy"
 *   History   the proven interval, the import state and its limitations
 *
 * Customer language only: no error codes, no provider errors, no identifiers.
 * Dates only, never balances (the Connections PCS-2 boundary). Nothing here
 * classifies money — grouping reads `type` / the provider's subtype as stored.
 */

import type { SyncConnection } from "@/lib/sync/status";
import type { ConnectionIntelligenceStatus } from "@/lib/connections/intelligence";
import type { AccountLite } from "@/components/connections/ConnectionCard";
import { relativeUpdated, type ConnectionTone } from "@/lib/connections/connection-summary";

// ── Overview: account groups ─────────────────────────────────────────────────

export type AccountGroupKey = "checking" | "savings" | "credit" | "loans" | "debt" | "investments" | "crypto" | "other";

const GROUP_LABEL: Record<AccountGroupKey, string> = {
  checking: "Checking", savings: "Savings", credit: "Credit cards", loans: "Loans",
  debt: "Credit & loans", investments: "Investments", crypto: "Crypto", other: "Other accounts",
};
const GROUP_ORDER: AccountGroupKey[] = ["checking", "savings", "credit", "loans", "debt", "investments", "crypto", "other"];

const CREDIT_SUBTYPE = /credit|paypal|charge/i;
const LOAN_SUBTYPE = /loan|mortgage|student|auto|home equity|heloc|line of credit|construction|consumer|commercial/i;

export function accountGroupKey(a: Pick<AccountLite, "type" | "subtype">): AccountGroupKey {
  switch (a.type) {
    case "checking":   return "checking";
    case "savings":    return "savings";
    case "investment": return "investments";
    case "crypto":     return "crypto";
    case "debt":
      if (a.subtype && CREDIT_SUBTYPE.test(a.subtype)) return "credit";
      if (a.subtype && LOAN_SUBTYPE.test(a.subtype)) return "loans";
      return "debt";
    default:           return "other";
  }
}

export interface AccountGroup { key: AccountGroupKey; label: string; accounts: AccountLite[] }

/** Only the groups that exist, in a stable order; accounts keep their given order. */
export function groupAccounts(accounts: readonly AccountLite[]): AccountGroup[] {
  const by = new Map<AccountGroupKey, AccountLite[]>();
  for (const a of accounts) {
    const k = accountGroupKey(a);
    (by.get(k) ?? by.set(k, []).get(k)!).push(a);
  }
  return GROUP_ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, label: GROUP_LABEL[k], accounts: by.get(k)! }));
}

/** "7irK…qBMSN" — enough to recognise, never the whole address. */
export function abbreviateAddress(address: string | null | undefined): string | null {
  const a = address?.trim();
  if (!a) return null;
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

const NETWORK: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB Chain", AVAX: "Avalanche", POLYGON: "Polygon" };
const NATIVE_ASSET: Record<string, string> = { BTC: "BTC", ETH: "ETH", SOL: "SOL", BNB: "BNB", AVAX: "AVAX", POLYGON: "POL" };
export function networkName(chain: string | null | undefined): string | null {
  const k = chain?.trim().toUpperCase();
  return k ? NETWORK[k] ?? k : null;
}
export function nativeAssetSymbol(chain: string | null | undefined): string | null {
  const k = chain?.trim().toUpperCase();
  return k ? NATIVE_ASSET[k] ?? null : null;
}

// ── Health: one line per dimension ───────────────────────────────────────────

export interface HealthLine { key: string; label: string; tone: ConnectionTone; text: string }
export interface HealthView { headline: string; tone: ConnectionTone; lines: HealthLine[] }

const rel = (iso: string | null | undefined, now: Date) => (iso ? relativeUpdated(iso, now) : null);

export function connectionHealth(
  connection: SyncConnection,
  intelligence: ConnectionIntelligenceStatus | undefined,
  now: Date = new Date(),
): HealthView {
  const i = intelligence;
  const lines: HealthLine[] = [];
  const h = i?.sourceHealth;
  const stale = !!h?.needsAttention && (h.state === "OUT_OF_DATE" || h.state === "SYNC_INCOMPLETE");

  if (connection.provider === "WALLET") {
    lines.push(connection.state === "error"
      ? { key: "connection", label: "Connection", tone: "attention", text: "This wallet can’t be updated right now" }
      : { key: "connection", label: "Connection", tone: "ok", text: "Watching this public address" });
    const pos = rel(i?.positionObservedAt, now);
    lines.push(pos
      ? { key: "holdings", label: "Current holdings", tone: stale ? "attention" : "ok", text: `Updated ${pos}` }
      : { key: "holdings", label: "Current holdings", tone: "neutral", text: "Not read yet" });
    if (i?.transactionsSyncedAt) {
      lines.push({ key: "transactions", label: "Transactions", tone: "ok", text: `Imported ${rel(i.transactionsSyncedAt, now)}` });
    }
    const wh = i?.walletHistory;
    if (wh) {
      lines.push(!wh.supported
        ? { key: "history", label: "Historical coverage", tone: "neutral", text: "Not available for this network yet" }
        : wh.licensed
          ? { key: "history", label: "Historical coverage", tone: "ok", text: "Complete" }
          : { key: "history", label: "Historical coverage", tone: "neutral", text: "Incomplete — current holdings are unaffected" });
    }
    lines.push(i?.valuationIsReadTime
      ? { key: "valuation", label: "Valuation", tone: "ok", text: "Priced at the current market rate when you view it" }
      : i?.valuationUpdatedAt
        ? { key: "valuation", label: "Valuation", tone: "ok", text: `Updated ${rel(i.valuationUpdatedAt, now)}` }
        : { key: "valuation", label: "Valuation", tone: "neutral", text: "Not valued yet" });
  } else {
    const conn: HealthLine =
      connection.state === "needs_reauth" ? { key: "connection", label: "Connection", tone: "attention", text: "Needs reconnecting" }
      : connection.state === "error" ? { key: "connection", label: "Connection", tone: "attention", text: "Connection issue" }
      : connection.state === "sync_deferred" ? { key: "connection", label: "Connection", tone: "neutral", text: "Connected — syncing resumes automatically" }
      : { key: "connection", label: "Connection", tone: "ok", text: "Connected" };
    lines.push(conn);
    const bal = rel(i?.balancesUpdatedAt, now);
    lines.push(bal
      ? { key: "balances", label: "Balances", tone: stale ? "attention" : "ok", text: `Updated ${bal}` }
      : { key: "balances", label: "Balances", tone: "neutral", text: "Not received yet" });
    lines.push(
      connection.state === "importing" ? { key: "transactions", label: "Transactions", tone: "progress", text: "Importing" }
      : connection.state === "import_paused" ? { key: "transactions", label: "Transactions", tone: "neutral", text: "Paused — resumes automatically" }
      : connection.lastSyncedAt ? { key: "transactions", label: "Transactions", tone: stale ? "attention" : "ok", text: `Updated ${rel(connection.lastSyncedAt, now)}` }
      : { key: "transactions", label: "Transactions", tone: "neutral", text: "Not imported yet" });
    if (i) {
      lines.push(
        i.phase === "BUILDING_INTELLIGENCE" ? { key: "history", label: "Financial history", tone: "progress", text: "Building" }
        : i.phase === "INTELLIGENCE_NOT_BUILT" ? { key: "history", label: "Financial history", tone: "attention", text: "Not built yet" }
        : i.intelligenceReady ? { key: "history", label: "Financial history", tone: "ok", text: i.lastReconstructedAt ? `Built ${rel(i.lastReconstructedAt, now)}` : "Built" }
        : { key: "history", label: "Financial history", tone: "neutral", text: "Waiting for transactions" });
    }
    if (connection.investments === "enabled") lines.push({ key: "investments", label: "Investments", tone: "ok", text: "Holdings synced" });
    if (connection.investments === "available") lines.push({ key: "investments", label: "Investments", tone: "neutral", text: "Available to enable" });
  }

  const has = (t: ConnectionTone) => lines.some((l) => l.tone === t);
  const historyIncomplete = lines.some((l) => l.key === "history" && l.tone === "neutral" && /Incomplete/.test(l.text));
  const headline =
    lines[0].tone === "attention" ? "Connection needs attention"
    : has("attention") ? "Some data needs attention"
    : has("progress") ? (connection.provider === "WALLET" ? "Current holdings available; history is still importing" : "Current balances available; historical transactions are still importing")
    : historyIncomplete ? "Current holdings available; historical coverage incomplete"
    : has("neutral") ? "Connected; some data isn’t available yet"
    : "Connected and up to date";
  const tone: ConnectionTone = has("attention") ? "attention" : has("progress") ? "progress" : historyIncomplete || has("neutral") ? "neutral" : "ok";
  return { headline, tone, lines };
}

// ── History ──────────────────────────────────────────────────────────────────

/** COMPLETE is claimed only where a licence proves it (wallets); a bank's history is AVAILABLE, never "complete". */
export type HistoryCoverage = "COMPLETE" | "AVAILABLE" | "PARTIAL" | "IMPORTING" | "UNAVAILABLE" | "NOT_BUILT";

export interface HistoryView {
  coverage: HistoryCoverage;
  /** Customer sentence for the coverage state. */
  summary: string;
  /** Earliest date with data, when known. */
  fromISO: string | null;
  /** Latest proven / imported date, when known. */
  toISO: string | null;
  /** When history was last successfully (re)built, when known. */
  lastBuiltISO: string | null;
  limitations: string[];
}

export function connectionHistory(
  connection: SyncConnection,
  intelligence: ConnectionIntelligenceStatus | undefined,
  accounts: readonly AccountLite[] = [],
): HistoryView {
  const i = intelligence;
  const lastBuiltISO = i?.lastReconstructedAt ?? null;
  if (connection.provider === "WALLET") {
    const wh = i?.walletHistory ?? null;
    const sol = accounts.some((a) => a.walletChain?.toUpperCase() === "SOL");
    if (!wh || !wh.supported) {
      return { coverage: "UNAVAILABLE", summary: "Historical coverage isn’t available for this network yet. Current holdings are tracked.",
        fromISO: null, toISO: null, lastBuiltISO, limitations: [] };
    }
    if (wh.licensed) {
      return { coverage: "COMPLETE", summary: "Complete — every change to this wallet’s balance in this period is accounted for.",
        fromISO: wh.activityFromISO ?? wh.licensedFromISO, toISO: wh.licensedToISO, lastBuiltISO, limitations: [] };
    }
    return {
      coverage: "PARTIAL",
      summary: "Incomplete — Fourth Meridian hasn’t been able to prove this wallet’s earlier history yet. Current holdings are unaffected.",
      fromISO: null, toISO: null, lastBuiltISO,
      limitations: sol
        ? ["Solana history is being moved to an importer that works through large wallets in stages, without the previous 5,000-transaction limit. Earlier days stay unavailable until they are proven — they are never estimated."]
        : ["Earlier days stay unavailable until they are proven — they are never estimated."],
    };
  }
  // PLAID — the earliest transaction is the evidence; the institution decides how far back it goes.
  const fromISO = i?.earliestTransactionDate ?? null;
  const toISO = connection.lastSyncedAt ?? null;
  if (connection.state === "importing" || connection.state === "import_paused" || i?.phase === "BUILDING_INTELLIGENCE") {
    return { coverage: "IMPORTING", summary: "Importing — history appears as it arrives. You can leave this page.",
      fromISO, toISO, lastBuiltISO, limitations: [] };
  }
  if (i?.phase === "INTELLIGENCE_NOT_BUILT") {
    return { coverage: "NOT_BUILT", summary: "Transactions are imported, but your financial history hasn’t been built from them yet.",
      fromISO, toISO, lastBuiltISO, limitations: [] };
  }
  if (!fromISO) {
    return { coverage: "UNAVAILABLE", summary: "No transactions have been received from this institution yet.",
      fromISO: null, toISO, lastBuiltISO, limitations: [] };
  }
  return { coverage: "AVAILABLE", summary: "Available — as far back as your institution provides.",
    fromISO, toISO, lastBuiltISO, limitations: ["How far back history goes is set by your institution."] };
}
