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
import { tokenCaptureSupported } from "@/lib/crypto/token-asset";
import { unsupportedReasonText, type Erc20UnsupportedReason } from "@/lib/crypto/erc20-history.core";
import { laterHoldingsUnpricedText, tokenPriceGapsText } from "@/lib/connections/valuation-coverage.core";

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
    // A. Monitoring  B. Current holdings  C. History import  D. Native history
    // E. Token history  F. Historical prices  — separate lines, never one "healthy".
    lines.push(connection.state === "error"
      ? { key: "connection", label: "Monitoring", tone: "attention", text: "This wallet can’t be read right now" }
      : { key: "connection", label: "Monitoring", tone: "ok", text: "Watching this public address" });
    const pos = fmtDay(i?.positionObservedAt);
    lines.push(pos
      ? { key: "holdings", label: "Current holdings", tone: stale ? "attention" : "ok", text: `Updated ${pos}` }
      : { key: "holdings", label: "Current holdings", tone: "neutral", text: "Not read yet" });
    const wh = i?.walletHistory;
    const imp = historyImportText(wh?.historyImport?.state, i?.facts?.historyWorkerEnabled === true, wh?.historyImport?.lastFailureCode);
    if (imp && wh?.historyImport?.state !== "COMPLETE") lines.push({ key: "import", label: "History import", tone: imp.tone, text: imp.text });
    if (wh) {
      lines.push(!wh.supported
        ? { key: "history", label: "Native history", tone: "neutral", text: "Not available for this network yet" }
        : wh.licensed
          ? { key: "history", label: "Native history", tone: "ok", text: `Verified since ${fmtDay(wh.activityFromISO ?? wh.licensedFromISO)}` }
          : { key: "history", label: "Native history", tone: "neutral", text: "Not verified yet" });
      // TOKEN HOLDINGS (PR-A) — data-driven from the per-instrument facets: each
      // token is its own history, never folded into the native line above.
      const chain = wh.chain ?? null;
      if (wh.supported || wh.tokens?.length) {
        const t = tokenHistoryLabel(chain, wh.tokens);
        const allVerified = !!wh.tokens?.length && wh.tokens.every((x) => x.historyState === "RECONSTRUCTED");
        lines.push({ key: "tokens", label: "Token history", tone: allVerified ? "ok" : "neutral", text: t });
      }
      lines.push(wh.priceFromISO
        ? { key: "prices", label: "Historical prices", tone: "ok", text: `Available since ${fmtDay(wh.priceFromISO)}` }
        : { key: "prices", label: "Historical prices", tone: "neutral", text: "Not available yet" });
    }
    lines.push(i?.valuationIsReadTime
      ? { key: "valuation", label: "Current value", tone: "ok", text: "Priced at the market rate when you view it" }
      : i?.valuationUpdatedAt
        ? { key: "valuation", label: "Current value", tone: "ok", text: `Updated ${fmtDay(i.valuationUpdatedAt)}` }
        : { key: "valuation", label: "Current value", tone: "neutral", text: "Not valued yet" });
  } else {
    const conn: HealthLine =
      connection.state === "needs_reauth" ? { key: "connection", label: "Connection", tone: "attention", text: "Needs reconnecting" }
      : connection.state === "error" ? { key: "connection", label: "Connection", tone: "attention", text: "Connection issue" }
      : connection.state === "sync_deferred" ? { key: "connection", label: "Connection", tone: "neutral", text: "Connected — syncing resumes automatically" }
      : { key: "connection", label: "Connection", tone: "ok", text: "Connected" };
    lines.push(conn);
    const bal = rel(i?.balancesUpdatedAt, now);
    lines.push(bal
      ? { key: "balances", label: "Balances", tone: stale ? "attention" : "ok", text: `Updated ${fmtDay(i?.balancesUpdatedAt)}` }
      : { key: "balances", label: "Balances", tone: "neutral", text: "Not received yet" });
    lines.push(
      connection.state === "importing" ? { key: "transactions", label: "Transactions", tone: "progress", text: "Importing" }
      : connection.state === "import_paused" ? { key: "transactions", label: "Transactions", tone: "neutral", text: "Paused — resumes automatically" }
      : connection.lastSyncedAt ? { key: "transactions", label: "Transactions", tone: stale ? "attention" : "ok", text: `Updated ${fmtDay(connection.lastSyncedAt)}` }
      // No sync clock, but transactions are evidenced — say so; never contradict the state detail.
      : i?.earliestTransactionDate ? { key: "transactions", label: "Transactions", tone: "ok", text: "Available" }
      : { key: "transactions", label: "Transactions", tone: "neutral", text: "Not imported yet" });
    if (i) {
      lines.push(
        i.phase === "BUILDING_INTELLIGENCE" ? { key: "history", label: "Net Worth history", tone: "progress", text: "Being built" }
        : i.phase === "INTELLIGENCE_NOT_BUILT" ? { key: "history", label: "Net Worth history", tone: "neutral", text: "Not built yet — rebuilt automatically after the next sync" }
        : i.intelligenceReady ? { key: "history", label: "Net Worth history", tone: "ok", text: i.lastReconstructedAt ? `Built ${fmtDay(i.lastReconstructedAt)}` : "Built" }
        : { key: "history", label: "Net Worth history", tone: "neutral", text: "Waiting for transactions" });
    }
    if (connection.investments === "enabled") lines.push({ key: "investments", label: "Investments", tone: "ok", text: "Holdings synced" });
    if (connection.investments === "available") lines.push({ key: "investments", label: "Investments", tone: "neutral", text: "Available to enable" });
  }

  const has = (t: ConnectionTone) => lines.some((l) => l.tone === t);
  if (connection.provider === "WALLET") {
    const attention = has("attention");
    const importing = lines.some((l) => l.key === "import" && l.tone === "progress");
    // Held tokens without reconstructed history keep the wallet LIMITED: native
    // history being verified says nothing about the tokens beside it.
    // A token verified only from a later start (PARTIAL) is limited too.
    // Owner ruling 2026-10-30: BALANCE history only — a token's missing historical
    // prices never make the balance import "limited" (they are disclosed on the History tab).
    const tokensLimited = (i?.walletHistory?.tokens ?? []).some((x) => x.historyState !== "RECONSTRUCTED" || x.coverageKind === "PARTIAL");
    const limited = tokensLimited
      || lines.some((l) => (l.key === "history" || l.key === "prices" || l.key === "import") && l.tone === "neutral")
      || (i?.walletHistory?.licensed === true && (i.walletHistory.chart?.fromISO ?? "9999") > (i.walletHistory.activityFromISO ?? i.walletHistory.licensedFromISO ?? "0000"));
    // Attention is attributed to the facet that has it: stale HOLDINGS are not
    // "ready", and must never be blamed on history (Preview finding 2026-10-28).
    const holdingsStale = lines.some((l) => l.key === "holdings" && l.tone === "attention");
    const historyAttention = lines.some((l) => l.tone === "attention" && l.key !== "holdings" && l.key !== "connection");
    const headline = lines[0].tone === "attention" ? "This wallet needs attention"
      : holdingsStale ? (historyAttention ? "Current holdings are out of date; history needs attention" : "Current holdings are out of date")
      : historyAttention ? "Current holdings ready; history needs attention"
      : importing ? "Current holdings ready; history is being imported"
      : limited ? "Current holdings ready; some history is limited"
      : "Current holdings ready";
    // Limited history is NOT green: current holdings being right says nothing about history.
    return { headline, tone: attention ? "attention" : importing ? "progress" : limited ? "neutral" : "ok", lines };
  }
  const historyIncomplete = lines.some((l) => l.key === "history" && l.tone === "neutral" && /Incomplete/.test(l.text));
  const headline =
    lines[0].tone === "attention" ? "Connection needs attention"
    : has("attention") ? "Some data needs attention"
    : has("progress") ? "Current balances available; historical transactions are still importing"
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
  /** WALLETS — the two ranges the History tab states separately (owner requirement 2026-10-28). */
  blockchain?: { label: string; fromISO: string | null; toISO: string | null } | null;
  chart?: { fromISO: string; toISO: string; days: number; continuous: boolean } | null;
  /** One sentence when the ranges differ (older chain activity than chart values). */
  rangeNote?: string | null;
  /**
   * TOKEN HOLDINGS (PR-A) — one history line PER held token, separate from the
   * native facet. Empty when the wallet holds no recorded tokens.
   */
  tokenFacets?: Array<{ key: string; label: string; text: string }>;
}

type WalletTokens = NonNullable<NonNullable<ConnectionIntelligenceStatus["walletHistory"]>["tokens"]>;

/** The token standard's customer name on a chain, or null when the chain has none here. */
function tokenKind(chain: string | null | undefined): string | null {
  const k = chain?.trim().toUpperCase();
  return k === "SOL" ? "SPL" : k === "ETH" ? "ERC-20" : null;
}

/**
 * Why a token's history couldn't be verified, in plain words — from the stored
 * coverage caveat (the existing ChainCoverage vocabulary), never a code.
 */
export function tokenUnverifiedReason(caveats: readonly string[] | undefined): string {
  const c = caveats ?? [];
  if (c.includes("PROOF_PREMISES_UNMET")) return "this token’s balance can change without a recorded transfer";
  if (c.includes("ADDRESS_INDEX_INCOMPLETE")) return "its recorded transfers don’t add up to its current balance";
  if (c.includes("INVALID_DATA")) return "the network returned data that couldn’t be checked";
  if (c.includes("PAGE_BUDGET_EXHAUSTED")) return "it has more activity than could be checked so far";
  return "the network couldn’t provide its full history";
}

function daysApart(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}

/** One token's history facet, in the customer's words — absolute dates only, never a quantity (PCS-2). */
export function tokenHistoryText(t: WalletTokens[number]): string {
  if (t.historyState === "RECONSTRUCTED") {
    const from = t.licensedFromISO ? fmtDay(t.licensedFromISO) : null;
    // A licence that stopped well short of the latest observation was FROZEN:
    // newer activity couldn't be proven, so the verified stretch ends there.
    if (t.coverageKind === "PARTIAL" && t.licensedToISO && t.lastObservedISO && daysApart(t.licensedToISO, t.lastObservedISO) > 2) {
      return `Verified ${from ? `from ${from} ` : ""}through ${fmtDay(t.licensedToISO)} — later activity couldn’t be proven`;
    }
    if (t.coverageKind === "PARTIAL") return from ? `Verified from ${from} — earlier history couldn’t be proven` : "Verified only in part — earlier history couldn’t be proven";
    return from ? `History verified since ${from}` : "History verified";
  }
  // ERC-20 refusals carry their own reason code (erc20-history.core); SPL ones a coverage caveat.
  if (t.historyState === "UNLICENSED") return `Couldn’t be verified — ${t.historyReason ? unsupportedReasonText(t.historyReason as Erc20UnsupportedReason) : tokenUnverifiedReason(t.caveats)}; current balance only`;
  return "Not reconstructed yet";
}

/**
 * Owner ruling 2026-10-30 — the one concise VALUATION disclosure for token
 * histories (balances are verified; prices are a separate fact): which tokens'
 * held days lack historical prices, never a value. Null when nothing applies.
 */
export function tokenValuationText(
  notValuedYet: number | undefined, valuedFromLater: number | undefined, verifiedThroughISO?: string | null, withoutMarket?: number, excluded?: number,
  more: { valuedUntilEarlier?: number; valuedUntilRange?: { fromISO: string | null; toISO: string } | null; withGaps?: number } = {},
): string | null {
  // NO_MARKET is a legitimate unpriced holding (owner clarification) — counted with the others.
  // Only tokens whose OLDER held days are unpriced say "older" (re-review F3): prices that
  // stop early leave the RECENT days unpriced, and interior gaps are said as gaps.
  const n = (notValuedYet ?? 0) + (valuedFromLater ?? 0) + (withoutMarket ?? 0);
  const later = laterHoldingsUnpricedText(more.valuedUntilEarlier ?? 0, more.valuedUntilRange, (iso) => fmtDay(iso) ?? iso);
  const gaps = tokenPriceGapsText(more.withGaps ?? 0);
  const x = excluded ?? 0;
  if (n <= 0 && !later && !gaps && x <= 0) return null;
  const through = verifiedThroughISO ? `Balance history verified through ${fmtDay(verifiedThroughISO)}. ` : "";
  const unpriced = n > 0 ? `Older holdings exist but lack historical prices (${n === 1 ? "1 token" : `${n} tokens`}) — those days aren’t valued, never counted as zero.` : null;
  const excl = x > 0 ? `${x === 1 ? "1 token" : `${x} tokens`} excluded as spam or non-economic.` : null;
  return `${through}${[unpriced, later, gaps, excl].filter((t): t is string => t !== null).join(" ")}`;
}

/** Token limitations for the History tab, derived from the facets (never a per-chain constant). */
function tokenLimitations(chain: string | null, sym: string, tokens: WalletTokens | undefined, notValuedYet?: number, valuedFromLater?: number, verifiedThroughISO?: string | null, withoutMarket?: number, excluded?: number, more: Parameters<typeof tokenValuationText>[5] = {}): string[] {
  const kind = tokenKind(chain);
  if (!kind || !tokenCaptureSupported(chain)) return [];
  const extra = tokenValuationText(notValuedYet, valuedFromLater, verifiedThroughISO, withoutMarket, excluded, more);
  if (extra) return [...tokenLimitations(chain, sym, tokens), extra];
  if (!tokens) return [];
  if (tokens.length === 0) return [`No ${kind} token balances have been recorded for this wallet. Native ${sym} history is shown above.`];
  const pending = tokens.filter((t) => t.historyState !== "RECONSTRUCTED").length;
  // The stated discovery limit (SPL): verified means "as far as can be discovered".
  const scope = kind === "SPL" && tokens.some((t) => t.historyState === "RECONSTRUCTED")
    ? ["Verified token history covers every token account this wallet’s own transactions reveal. An account opened and closed by others without ever involving this wallet can’t be discovered."]
    : [];
  if (pending === 0) return scope;
  return [...scope, `Token history is tracked separately from native ${sym} history. ${pending === tokens.length ? (tokens.length === 1 ? "This wallet’s token shows" : `All ${tokens.length} tokens show`) : `${pending} of ${tokens.length} tokens show`} its current balance only — earlier balances are never estimated.`
    .replace("tokens show its", "tokens show their")];
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
    const sol = accounts.some((a) => a.chain?.toUpperCase() === "SOL");
    if (!wh || !wh.supported) {
      return { coverage: "UNAVAILABLE", summary: "Historical coverage isn’t available for this network yet. Current holdings are tracked.",
        fromISO: null, toISO: null, lastBuiltISO, limitations: [] };
    }
    const chain = accounts.find((a) => a.chain)?.chain?.toUpperCase() ?? null;
    const sym = nativeAssetSymbol(chain) ?? "native";
    const tokenNote = tokenLimitations(chain, sym, wh.tokens, wh.tokensNotValuedYet, wh.tokensValuedFromLater, wh.licensedToISO, wh.tokensWithoutMarket, wh.tokensExcluded,
      { valuedUntilEarlier: wh.tokensValuedUntilEarlier, valuedUntilRange: wh.tokenValuedUntilRange, withGaps: wh.tokensValuedWithGaps });
    const tokenFacets = (wh.tokens ?? []).map((t, n) => ({ key: `${t.label}-${n}`, label: `${t.label} history`, text: tokenHistoryText(t) }));
    if (wh.licensed) {
      const fromISO = wh.activityFromISO ?? wh.licensedFromISO;
      const chart = wh.chart ?? null;
      const rangeNote = fromISO && (!chart || chart.fromISO > fromISO)
        ? "Older blockchain activity is preserved. Earlier chart values require historical prices." : null;
      return {
        coverage: "COMPLETE",
        // NATIVE scope, said so — never an unqualified "Complete" for the wallet.
        summary: `Native ${sym} history verified — every change to this wallet’s ${sym} balance in this period is accounted for.`,
        fromISO, toISO: wh.licensedToISO, lastBuiltISO, limitations: tokenNote,
        blockchain: { label: `Native ${sym}`, fromISO, toISO: wh.licensedToISO },
        chart, rangeNote, tokenFacets,
      };
    }
    return {
      coverage: "PARTIAL",
      // The headline follows the import's persisted state: a queued or running
      // import is not a failure, and must not read like one.
      summary: unprovenHistorySummary(wh.historyImport?.state, i?.facts?.historyWorkerEnabled === true, wh.historyImport?.provenFromISO ?? null, wh.historyImport?.lastFailureCode ?? null),
      fromISO: null, toISO: null, lastBuiltISO,
      blockchain: null, chart: null, rangeNote: null, tokenFacets,
      limitations: [
        ...(sol
          ? ["Large Solana wallets are imported in stages. Earlier days stay unavailable until they are proven — they are never estimated."]
          : ["Earlier days stay unavailable until they are proven — they are never estimated."]),
        ...tokenNote,
      ],
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

/**
 * PURE. Chart-ready history: the days that are licensed (balance proven),
 * priced (a stored daily close exists from `priceFromISO` on) AND persisted as
 * a snapshot. Counts real snapshot dates — a gap is reported, never bridged.
 */
export function chartReadyRange(
  wh: { licensed: boolean; licensedFromISO: string | null; licensedToISO: string | null; activityFromISO: string | null },
  priceFromISO: string | null,
  snapshotDatesAsc: readonly string[],
): { fromISO: string; toISO: string; days: number; continuous: boolean } | null {
  const licFrom = wh.activityFromISO ?? wh.licensedFromISO;
  if (!wh.licensed || !licFrom || !wh.licensedToISO || !priceFromISO) return null;
  const lo = licFrom > priceFromISO ? licFrom : priceFromISO;
  const inRange = snapshotDatesAsc.filter((d) => d >= lo && d <= wh.licensedToISO!);
  if (inRange.length === 0) return null;
  const fromISO = inRange[0], toISO = inRange[inRange.length - 1];
  const span = Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000) + 1;
  return { fromISO, toISO, days: inRange.length, continuous: inRange.length === span };
}

// ── Honest facts (owner requirement 2026-10-28: "everything should be honest") ─

/** "Oct 28, 2026" — one absolute format across the detail, so nothing goes stale. */
export function fmtDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Customer words for the resumable history import state. Never a percentage. */
export function historyImportText(state: string | null | undefined, workerEnabled: boolean, failureCode?: string | null): { text: string; tone: ConnectionTone } | null {
  // A recovery says WHY, in the failure's own terms — "a gap was found" is
  // Solana's/Bitcoin's continuity case, not every chain's.
  if (state === "RECOVERY_REQUIRED" && failureCode === "BALANCE_BEFORE_PROVABLE_FLOOR") {
    return { text: "Needs attention — this wallet held ETH before the earliest block we can verify, so its full history can’t be proven", tone: "attention" };
  }
  if (state === "RECOVERY_REQUIRED" && failureCode === "LEDGER_DOES_NOT_RECONCILE") {
    return { text: "Needs attention — its history doesn’t add up to the current balance, so it can’t be proven", tone: "attention" };
  }
  switch (state) {
    case "QUEUED":            return { text: workerEnabled ? "Queued — starts automatically" : "Queued", tone: "neutral" };
    case "IMPORTING":         return { text: workerEnabled ? "In progress — continues automatically" : "In progress", tone: "progress" };
    case "COMPLETE":          return { text: "Complete for the native coin", tone: "ok" };
    case "FAILED":            return { text: "Paused after repeated errors — retries daily", tone: "attention" };
    case "RECOVERY_REQUIRED": return { text: "Needs attention — a gap was found", tone: "attention" };
    case "UNAVAILABLE":       return { text: "Not available in this environment", tone: "neutral" };
    default:                  return null;
  }
}

/**
 * The History tab's headline while a wallet's earlier history is not yet
 * proven — said in the import's own state. Queued and running imports are not
 * failures; only FAILED / RECOVERY_REQUIRED say something went wrong.
 */
export function unprovenHistorySummary(state: string | null | undefined, workerEnabled: boolean, provenFromISO: string | null, failureCode?: string | null): string {
  const held = "Current holdings are unaffected.";
  switch (state) {
    case "QUEUED":
      return workerEnabled
        ? `Not verified yet — the history import is queued and starts automatically. ${held}`
        : `Not verified yet — the history import is queued. ${held}`;
    case "IMPORTING":
      return provenFromISO
        ? `Importing — verified back to ${fmtDay(provenFromISO)} so far${workerEnabled ? "; earlier history continues automatically" : ""}. ${held}`
        : `Importing — earlier history is being verified${workerEnabled ? " and continues automatically" : ""}. ${held}`;
    case "FAILED":
      return workerEnabled
        ? `Paused — the history import hit repeated errors and retries daily. ${held}`
        : `Paused — the history import hit repeated errors. ${held}`;
    case "RECOVERY_REQUIRED": {
      const why = historyImportText(state, workerEnabled, failureCode)?.text ?? "Needs attention";
      return `${why}. ${held}`;
    }
    default:
      return `Incomplete — Fourth Meridian hasn’t been able to prove this wallet’s earlier history yet. ${held}`;
  }
}

/**
 * Token history scope — DATA-DRIVEN from the per-instrument facets
 * (lib/crypto/wallet-instrument-history via intelligence.walletHistory.tokens),
 * never a per-chain constant, and never folded into "complete".
 */
export function tokenHistoryLabel(chain: string | null | undefined, tokens: WalletTokens | undefined): string {
  const k = chain?.trim().toUpperCase();
  if (k === "BTC") return "Not applicable (Bitcoin has no tokens here)";
  const kind = tokenKind(k);
  if (!kind || !tokenCaptureSupported(k)) return "Tokens aren’t tracked on this network yet";
  if (!tokens) return `${kind} tokens not read yet`;
  if (tokens.length === 0) return `No ${kind} token balances recorded`;
  const n = tokens.length;
  const verified = tokens.filter((t) => t.historyState === "RECONSTRUCTED").length;
  const noun = `${n} ${kind} token${n === 1 ? "" : "s"}`;
  if (verified === n) return `${noun} · history verified`;
  if (verified === 0) return `${noun} · current balance only, history not reconstructed yet`;
  return `${noun} · ${verified} verified, the rest current balance only`;
}

/** Back-compat name for the scope label when no facets were loaded. */
export function tokenScopeLabel(chain: string | null | undefined): string {
  return tokenHistoryLabel(chain, undefined);
}

/** Valued / unpriced, in the customer's words. */
export function tokenPriceText(status: "MARKET_PRICE" | "NO_MARKET_PRICE" | "THIN_MARKET"): string {
  return status === "MARKET_PRICE" ? "Valued at market price"
    : status === "THIN_MARKET" ? "Not valued — thin market"
    : "Not valued — no market price";
}
