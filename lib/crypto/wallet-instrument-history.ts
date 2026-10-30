/**
 * lib/crypto/wallet-instrument-history.ts
 *
 * TOKEN HOLDINGS FOUNDATION (PR-A) — WALLET HISTORY COMPLETENESS IS PER INSTRUMENT.
 *
 * A wallet's native coin being fully reconstructed says nothing about the USDC
 * beside it. Before tokens were captured that was invisible — the native asset
 * was the only thing the system knew the wallet held — and every surface read
 * "native history verified" as if it were "wallet history verified". This
 * module is the one place that answers the wallet question honestly:
 *
 *   native   the native instrument's persisted licence (PositionCoverage)
 *   tokens   one facet per token instrument ever observed on the account, each
 *            with ITS OWN licence — absent today (history not reconstructed),
 *            so each reads NOT_RECONSTRUCTED: current balance only
 *   complete native RECONSTRUCTED **and** the chain's token history supported
 *            **and** every token facet RECONSTRUCTED. A chain with tokens whose
 *            token history is not supported can NEVER read complete — tokens
 *            held before capture began are unknown, not absent.
 *
 * ── FOR THE TOKEN-HISTORY PRs ───────────────────────────────────────────────
 * Nothing here needs to change when ERC-20 / SPL history lands. Those PRs:
 *   1. write DERIVED token rows + `persistPositionCoverage(tx, accountId,
 *      tokenInstrumentId, coverage)` — the facet then reads RECONSTRUCTED;
 *   2. add the chain to `TOKEN_HISTORY_CHAINS` once acquisition is proven for
 *      EVERY token on it (not merely the ones captured) — only then can a
 *      wallet on that chain read complete — and register its inventory reader
 *      in TOKEN_INVENTORY_READERS (SOL: lib/crypto/spl-history-inventory.ts).
 *
 * Pure core (`facetFromCoverage`, `walletHistoryComplete`) + one DB binding that
 * takes `client` explicitly. Dates, quantities and price PRESENCE only — no
 * valuation (the Connections PCS-2 surface reads this).
 */

import { PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { licensedInterval, loadInstrumentCoverage } from "./position-coverage";
import type { ChainCoverage } from "./chain-movement";
import { nativeAssetForChain } from "./native-asset";
import { unsupportedReasonOf, type Erc20UnsupportedReason } from "./erc20-history.core";
import { reconstructedTokenValuation } from "./token-valuation.core";
import { loadTokenHeldSpans, loadTokenCloseFacts } from "./token-held-spans";
import {
  parseTokenAssetKey, tokenDisplayLabel, shortenTokenAddress, TOKEN_ALIAS_PROVIDER, WALLET_TOKEN_POSITION_SOURCE, type TokenStandard,
} from "./token-asset";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Chains whose TOKEN history acquisition is proven, each with its inventory
 * reader below. SOL: SPL history (spl-history*.ts). ETH: ERC-20 history
 * (erc20-history*.ts) — every contract the wallet ever touched is discovered
 * from its transfer evidence, and each is licensed only after its replay
 * matched on-chain balanceOf at every anchor; the inventory reader answers
 * "discovery closed AND every discovered token decided" — not merely the
 * tokens current capture happened to see.
 */
export const TOKEN_HISTORY_CHAINS: ReadonlySet<string> = new Set<string>(["SOL", "ETH"]);

/**
 * SPL TOKEN HISTORY (2026-10-28) — per chain, whether every token the wallet
 * EVER held has been found (token-account discovery done, nothing beyond the
 * tracking bound, every discovered mint decided). Facets list only tokens seen
 * currently; a closed token never captured has no facet, so without this a
 * wallet whose old tokens were never found would read complete. Absent ⇒ false.
 */
export type TokenInventoryReader = (client: Client, accountIds: readonly string[]) => Promise<Map<string, boolean>>;
const TOKEN_INVENTORY_READERS: Record<string, () => Promise<TokenInventoryReader>> = {
  SOL: async () => (await import("./spl-history-inventory")).loadSplInventoryComplete,
  ETH: async () => (await import("./erc20-history-inventory")).loadErc20InventoryComplete,
};

/** Chains that carry tokens at all (a BTC wallet's history is native-only by construction). */
const TOKEN_BEARING_CHAINS: ReadonlySet<string> = new Set(["SOL", "ETH", "BNB", "AVAX", "MATIC"]);

export type InstrumentHistoryState =
  /** A licensed interval exists for this instrument. */
  | "RECONSTRUCTED"
  /** No coverage record at all — history was never reconstructed. Current balance only. */
  | "NOT_RECONSTRUCTED"
  /** A coverage record exists but licenses nothing (UNKNOWN / blocking caveat). */
  | "UNLICENSED";

export interface InstrumentHistoryFacet {
  instrumentId:    string | null;
  assetKey:        string | null;
  label:           string;
  state:           InstrumentHistoryState;
  licensedFromISO: string | null;
  licensedToISO:   string | null;
  /** The persisted coverage kind (COMPLETE vs PARTIAL licence), null without a record. */
  coverageKind?:   "COMPLETE" | "PARTIAL" | "UNKNOWN" | null;
  /** Stored caveats of an unlicensed/partial record — the plain-reason input for Connections copy. */
  caveats?:        string[];
  /** UNLICENSED tokens: why the history was refused (erc20-history.core reasons), else null. */
  reason?:         Erc20UnsupportedReason | null;
}

export interface TokenHistoryFacet extends InstrumentHistoryFacet {
  instrumentId: string;
  standard:     TokenStandard;
  contract:     string;
  /** Latest observed whole-unit quantity; 0 = closed (no longer held). */
  quantity:     number;
  held:         boolean;
  firstObservedISO: string;
  lastObservedISO:  string;
  /**
   * Whether ANY market price exists for this token on or after its latest
   * observation. Presence only — the value itself is lib/crypto/wallet-current-value's.
   * NO_MARKET_PRICE ⇒ "Not valued — no market price"; THIN_MARKET ⇒ "Not valued —
   * thin market" (listed below the liquidity floor). Both excluded from totals, never zero.
   *
   * `label`: a PRICED token may show its symbol; any other shows only its
   * shortened contract/mint — an unpriced token's symbol is attacker-controlled.
   */
  priceStatus:  "MARKET_PRICE" | "NO_MARKET_PRICE" | "THIN_MARKET";
}

export interface WalletInstrumentHistory {
  accountId: string;
  chain:     string;
  native:    InstrumentHistoryFacet;
  /** Every token instrument ever observed, held first, then by label. */
  tokens:    TokenHistoryFacet[];
  /** Is token history acquisition supported on this chain at all? */
  tokenHistorySupported: boolean;
  /** Every token this wallet ever held has been found and decided (chain reader; false when unknown). */
  tokenInventoryComplete: boolean;
  /**
   * VALUATION coverage (never balance completeness — owner ruling 2026-10-30):
   * LICENSED token histories (held now OR long since exited) none of whose held
   * days are priced (token-valuation.core NOT_VALUED_YET). Disclosed; a missing
   * price is never $0.
   */
  tokensNotValuedYet: number;
  /** F4/S1/F3 — valued over only PART of their held period (prices start later, end earlier, or leave interior gaps). Disclosed, not a balance limit. */
  tokensValuedFromLater: number;
  /** …and those confirmed to have no (liquid) market — never valued, disclosed. Never-held tokens count nowhere (F2). */
  tokensWithoutMarket: number;
  /** Explicitly classified (spam / non-economic) — never valued, never limiting, counted apart (owner clarification). */
  tokensExcluded: number;
  /** THE wallet-level answer. Never true because the native facet alone is. */
  complete:  boolean;
}

/** Pure: one instrument's coverage → its facet state. */
export function facetFromCoverage(coverage: ChainCoverage | null | undefined):
  Pick<InstrumentHistoryFacet, "state" | "licensedFromISO" | "licensedToISO" | "coverageKind" | "caveats"> {
  if (!coverage) return { state: "NOT_RECONSTRUCTED", licensedFromISO: null, licensedToISO: null, coverageKind: null, caveats: [] };
  const i = licensedInterval(coverage);
  const caveats = coverage.kind === "COMPLETE" ? [] : [...coverage.caveats];
  return i ? { state: "RECONSTRUCTED", licensedFromISO: i.fromISO, licensedToISO: i.toISO, coverageKind: coverage.kind, caveats }
    : { state: "UNLICENSED", licensedFromISO: null, licensedToISO: null, coverageKind: coverage.kind, caveats };
}

/** Pure: the wallet-level completeness rule (see the header). */
export function walletHistoryComplete(
  h: Pick<WalletInstrumentHistory, "chain" | "native" | "tokens"> & { tokenInventoryComplete?: boolean; tokensNotValuedYet?: number; tokensValuedFromLater?: number },
): boolean {
  if (h.native.state !== "RECONSTRUCTED") return false;
  // OWNER RULING 2026-10-30 — BALANCE completeness is independent of prices:
  // a token's missing historical prices never make this answer false. They are
  // a VALUATION fact, carried separately (tokensNotValuedYet / tokensValuedFromLater)
  // and disclosed; the per-day valuation refuses unpriced days (token-valuation.core
  // tokenDayMissingRequiredPrice) instead of this flag claiming anything.
  const chain = h.chain.trim().toUpperCase();
  if (!TOKEN_BEARING_CHAINS.has(chain)) return true;
  if (!TOKEN_HISTORY_CHAINS.has(chain)) return false;
  // Every token ever held found and decided — and each current one licensed
  // COMPLETE: a token verified only from a later start leaves the wallet partial.
  if (h.tokenInventoryComplete !== true) return false;
  return h.tokens.every((t) => t.state === "RECONSTRUCTED" && (t.coverageKind ?? "COMPLETE") === "COMPLETE");
}

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Per-instrument history for wallet accounts the caller has ALREADY authorized,
 * keyed by account id. Every account passed is present in the result.
 */
export async function loadWalletInstrumentHistory(
  client: Client,
  accounts: readonly { id: string; walletChain: string | null | undefined }[],
): Promise<Map<string, WalletInstrumentHistory>> {
  const out = new Map<string, WalletInstrumentHistory>();
  if (accounts.length === 0) return out;
  const ids = accounts.map((a) => a.id);

  const [coverage, spans] = await Promise.all([
    loadInstrumentCoverage(client, ids),
    client.positionObservation.groupBy({
      by: ["financialAccountId", "instrumentId"],
      where: { financialAccountId: { in: ids }, source: WALLET_TOKEN_POSITION_SOURCE, origin: PositionOrigin.OBSERVED, supersededById: null, deletedAt: null },
      _min: { date: true },
      _max: { date: true },
    }),
  ]);

  const tokenInstrumentIds = [...new Set(spans.map((s) => s.instrumentId))];
  const inventory = new Map<string, boolean>();
  for (const [chainKey, load] of Object.entries(TOKEN_INVENTORY_READERS)) {
    const ids = accounts.filter((a) => (a.walletChain ?? "").trim().toUpperCase() === chainKey).map((a) => a.id);
    if (ids.length === 0) continue;
    try { for (const [id, ok] of await (await load())(client, ids)) inventory.set(id, ok); }
    catch { /* unreadable ⇒ not proven complete */ }
  }
  const coveredInstrumentIds = [...new Set([...coverage.values()].flatMap((m) => [...m.keys()]))];
  const aliasIds = [...new Set([...tokenInstrumentIds, ...coveredInstrumentIds])];

  const [aliases, latestRows, prices] = await Promise.all([
    aliasIds.length === 0 ? [] : client.instrumentAlias.findMany({
      where: { instrumentId: { in: aliasIds }, provider: TOKEN_ALIAS_PROVIDER },
      select: { instrumentId: true, externalId: true, metadata: true },
    }),
    spans.length === 0 ? [] : client.positionObservation.findMany({
      where: {
        source: WALLET_TOKEN_POSITION_SOURCE, origin: PositionOrigin.OBSERVED, supersededById: null, deletedAt: null,
        OR: spans.filter((s) => s._max.date).map((s) => ({ financialAccountId: s.financialAccountId, instrumentId: s.instrumentId, date: s._max.date! })),
      },
      select: { financialAccountId: true, instrumentId: true, quantity: true },
    }),
    tokenInstrumentIds.length === 0 ? [] : client.priceObservation.groupBy({
      by: ["instrumentId"], where: { instrumentId: { in: tokenInstrumentIds } }, _max: { date: true },
    }),
  ]);

  const aliasByInstrument = new Map<string, { assetKey: string; symbol: string | null; thin: boolean; metadata: unknown }>();
  for (const a of aliases) {
    const meta = a.metadata as { symbol?: unknown; quote?: { outcome?: unknown } } | null;
    // A native alias shares the namespace; record it too so the native facet can name its key.
    aliasByInstrument.set(a.instrumentId, {
      assetKey: a.externalId, symbol: typeof meta?.symbol === "string" ? meta.symbol : null,
      thin: meta?.quote?.outcome === "THIN", metadata: a.metadata,
    });
  }
  // B1 — which LICENSED token instruments have any stored historical close.
  const licensedTokenIds = [...new Set([...coverage.values()].flatMap((m) => [...m.entries()]
    .filter(([id, c]) => parseTokenAssetKey(aliasByInstrument.get(id)?.assetKey) !== null && licensedInterval(c) !== null).map(([id]) => id)))];
  // B1 / S1 / delta F3 — where each token's historical closes start, END, and
  // every day between: RAW_CLOSE only (an INTRADAY quote never extends coverage).
  const closeFacts = await loadTokenCloseFacts(client, licensedTokenIds);
  // F2/F4 — when each was actually held (never-held ⇒ absent).
  const heldSpans = licensedTokenIds.length === 0 ? new Map() : await loadTokenHeldSpans(client, ids, licensedTokenIds);
  const latestQty = new Map(latestRows.map((r) => [`${r.financialAccountId}|${r.instrumentId}`, r.quantity]));
  const latestPrice = new Map(prices.map((p) => [p.instrumentId, p._max.date ? isoOf(p._max.date) : null]));

  for (const a of accounts) {
    const chain = (a.walletChain ?? "").trim().toUpperCase();
    const native = nativeAssetForChain(chain);
    const cov = coverage.get(a.id) ?? new Map<string, ChainCoverage>();

    // NATIVE: the coverage row whose instrument is NOT a token.
    const nativeEntry = [...cov.entries()].find(([instrumentId]) => !parseTokenAssetKey(aliasByInstrument.get(instrumentId)?.assetKey));
    const nativeFacet: InstrumentHistoryFacet = {
      instrumentId: nativeEntry?.[0] ?? null,
      assetKey:     native?.assetKey ?? null,
      label:        native?.symbol ?? chain,
      ...facetFromCoverage(nativeEntry?.[1] ?? null),
    };

    const tokens: TokenHistoryFacet[] = [];
    for (const s of spans) {
      if (s.financialAccountId !== a.id || !s._min.date || !s._max.date) continue;
      const alias = aliasByInstrument.get(s.instrumentId);
      const parsed = parseTokenAssetKey(alias?.assetKey);
      if (!alias || !parsed) continue; // not a token identity — never guessed into one
      const quantity = latestQty.get(`${a.id}|${s.instrumentId}`) ?? 0;
      const lastObservedISO = isoOf(s._max.date);
      const priceISO = latestPrice.get(s.instrumentId) ?? null;
      // A price serving the latest observation day — the day rule's d / d−1 window.
      const servesISO = new Date(Date.parse(`${lastObservedISO}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      const priceStatus: TokenHistoryFacet["priceStatus"] =
        priceISO !== null && priceISO >= servesISO ? "MARKET_PRICE" : alias.thin ? "THIN_MARKET" : "NO_MARKET_PRICE";
      tokens.push({
        instrumentId: s.instrumentId, assetKey: alias.assetKey,
        label: priceStatus === "MARKET_PRICE" ? tokenDisplayLabel({ symbol: alias.symbol, contract: parsed.contract }) : shortenTokenAddress(parsed.contract),
        standard: parsed.standard, contract: parsed.contract,
        quantity, held: quantity > 0,
        firstObservedISO: isoOf(s._min.date), lastObservedISO,
        priceStatus,
        ...facetFromCoverage(cov.get(s.instrumentId) ?? null),
        reason: unsupportedReasonOf(cov.get(s.instrumentId) ?? null),
      });
    }
    tokens.sort((x, y) => (x.held === y.held ? x.label.localeCompare(y.label) : x.held ? -1 : 1));

    let tokensNotValuedYet = 0, tokensWithoutMarket = 0, tokensValuedFromLater = 0, tokensExcluded = 0;
    for (const [id, c] of cov) {
      const alias = aliasByInstrument.get(id);
      const licence = licensedInterval(c);
      if (!parseTokenAssetKey(alias?.assetKey) || licence === null) continue;
      const v = reconstructedTokenValuation({ licence, held: heldSpans.get(`${a.id}|${id}`) ?? null, closesFromISO: closeFacts.get(id)?.fromISO ?? null, closesToISO: closeFacts.get(id)?.toISO ?? null, closeDatesISO: closeFacts.get(id)?.datesISO ?? [] }, alias?.metadata);
      if (v === "NOT_VALUED_YET") tokensNotValuedYet++;
      else if (v === "VALUED_FROM_LATER" || v === "VALUED_UNTIL_EARLIER" || v === "VALUED_WITH_GAPS") tokensValuedFromLater++; // partly valued
      else if (v === "NO_MARKET") tokensWithoutMarket++;
      else if (v === "EXCLUDED") tokensExcluded++;
    }
    const h = { accountId: a.id, chain, native: nativeFacet, tokens, tokenHistorySupported: TOKEN_HISTORY_CHAINS.has(chain),
      tokenInventoryComplete: inventory.get(a.id) === true, tokensNotValuedYet, tokensValuedFromLater, tokensWithoutMarket, tokensExcluded };
    out.set(a.id, { ...h, complete: walletHistoryComplete(h) });
  }
  return out;
}

