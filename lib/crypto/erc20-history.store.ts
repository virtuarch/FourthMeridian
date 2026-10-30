/**
 * lib/crypto/erc20-history.store.ts
 *
 * The database half of the ERC-20 history (erc20-history.ts step,
 * erc20-history-pass.ts worker pass):
 *
 *   checkpoint  the token SECTION on `Connection.historyCheckpoint` — inside the
 *               native ETH checkpoint when one is there, else a standalone
 *               `erc20-history` document (erc20-history.core readErc20Section) —
 *               on the SAME history link and compare-and-swap the native worker
 *               uses (btc-history-checkpoint.ts). No migration.
 *   rows        DERIVED PositionObservation rows, source "erc20-reconstruction",
 *               per (account, token instrument) — never the native instrument.
 *   coverage    persistPositionCoverage(tx, accountId, tokenInstrumentId, …):
 *               COMPLETE for a verified token, UNKNOWN + reason for a refused one.
 *
 * The client is always the CALLER's authority (audit-db-authority).
 */

import { PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { btcHistoryLink as historyLink, readHistoryCheckpoint, casHistoryCheckpoint } from "./btc-history-checkpoint";
import { persistPositionCoverage } from "./position-coverage";
import { ETH_NATIVE } from "./native-asset";
import { alchemyRpcUrl, ALCHEMY_NETWORKS } from "./alchemy";
import { resolveTokenInstrumentId, readTokenAliasMetadata } from "./token-instrument";
import { erc20AssetKey, parseTokenAssetKey, IS_TOKEN_INSTRUMENT, TOKEN_ALIAS_PROVIDER, WALLET_TOKEN_POSITION_SOURCE } from "./token-asset";
import {
  readErc20Section, withErc20Section, resetErc20Section, ERC20_RECONSTRUCTION_SOURCE, ERC20_RECONSTRUCTION_VERSION,
  type Erc20HistorySection,
} from "./erc20-history.core";
import {
  runErc20HistoryStep, Erc20CheckpointConflictError,
  type Erc20HistoryStore, type Erc20HistoryOutcome, type Erc20HistoryStepDeps, type KnownToken, type Erc20TokenWrite,
} from "./erc20-history";
import type { Erc20HistoryPassDeps, Erc20HistoryWallet } from "./erc20-history-pass";

type Client = PrismaClient | Prisma.TransactionClient;

const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const minusDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Tokens current capture (PR-A) knows on this ETH account, by lowercase contract. */
export async function loadKnownErc20Tokens(client: Client, accountId: string): Promise<Map<string, KnownToken>> {
  const out = new Map<string, KnownToken>();
  const spans = await client.positionObservation.groupBy({
    by: ["instrumentId"],
    where: { financialAccountId: accountId, source: WALLET_TOKEN_POSITION_SOURCE, origin: PositionOrigin.OBSERVED, supersededById: null, deletedAt: null, instrument: IS_TOKEN_INSTRUMENT },
    _min: { date: true }, _max: { date: true },
  });
  if (spans.length === 0) return out;
  const ids = spans.map((s) => s.instrumentId);
  const [aliases, latest, prices] = await Promise.all([
    client.instrumentAlias.findMany({ where: { instrumentId: { in: ids }, provider: TOKEN_ALIAS_PROVIDER }, select: { instrumentId: true, externalId: true, metadata: true } }),
    client.positionObservation.findMany({
      where: { financialAccountId: accountId, source: WALLET_TOKEN_POSITION_SOURCE, origin: PositionOrigin.OBSERVED, supersededById: null, deletedAt: null,
        OR: spans.filter((s) => s._max.date).map((s) => ({ instrumentId: s.instrumentId, date: s._max.date! })) },
      select: { instrumentId: true, quantity: true },
    }),
    client.priceObservation.groupBy({ by: ["instrumentId"], where: { instrumentId: { in: ids } }, _max: { date: true } }),
  ]);
  const qty = new Map(latest.map((r) => [r.instrumentId, r.quantity]));
  const priceMax = new Map(prices.map((p) => [p.instrumentId, p._max.date ? isoOf(p._max.date) : null]));
  for (const s of spans) {
    const a = aliases.find((x) => x.instrumentId === s.instrumentId);
    const parsed = parseTokenAssetKey(a?.externalId);
    const meta = readTokenAliasMetadata(a?.metadata);
    if (!a || !parsed || parsed.standard !== "ERC20" || !meta || !s._min.date || !s._max.date) continue;
    const last = isoOf(s._max.date);
    const p = priceMax.get(s.instrumentId) ?? null;
    out.set(parsed.contract, {
      instrumentId: s.instrumentId, decimals: meta.decimals, priced: p !== null && p >= minusDay(last),
      firstObservedISO: isoOf(s._min.date), held: (qty.get(s.instrumentId) ?? 0) > 0,
    });
  }
  return out;
}

/** Write one step's token outcomes, then the checkpoint CAS — the caller wraps this in ONE transaction. */
export async function writeErc20TokenOutcomes(tx: Prisma.TransactionClient, accountId: string, writes: readonly Erc20TokenWrite[]): Promise<void> {
  for (const w of writes) {
    if (w.kind === "VERIFIED") {
      await tx.positionObservation.deleteMany({
        where: { financialAccountId: accountId, instrumentId: w.instrumentId, origin: PositionOrigin.DERIVED, source: ERC20_RECONSTRUCTION_SOURCE, date: { gte: dateOf(w.replaceFromISO) } },
      });
      if (w.rows.length > 0) {
        await tx.positionObservation.createMany({
          data: w.rows.map((r) => ({
            financialAccountId: accountId, instrumentId: w.instrumentId, date: dateOf(r.dateISO), quantity: r.quantity,
            origin: PositionOrigin.DERIVED, source: ERC20_RECONSTRUCTION_SOURCE, completeness: "derived", isCash: false,
            reconstructionVersion: ERC20_RECONSTRUCTION_VERSION,
          })),
          skipDuplicates: true,
        });
      }
    } else {
      // Refuted (or never verified): no reconstructed row may speak for any day.
      await tx.positionObservation.deleteMany({
        where: { financialAccountId: accountId, instrumentId: w.instrumentId, origin: PositionOrigin.DERIVED, source: ERC20_RECONSTRUCTION_SOURCE },
      });
    }
    await persistPositionCoverage(tx, accountId, w.instrumentId, w.coverage);
  }
}

/** The production store for one ETH wallet account. */
export async function prismaErc20HistoryStore(accountId: string, db: PrismaClient): Promise<{ store: Erc20HistoryStore; connectionId: string } | null> {
  const account = await db.financialAccount.findUnique({ where: { id: accountId }, select: { walletChain: true, walletAddress: true, deletedAt: true } });
  if (!account || account.deletedAt || account.walletChain?.trim().toUpperCase() !== ETH_NATIVE.chain || !account.walletAddress) return null;
  const link = await historyLink(db, accountId);
  if (!link) return null;
  const connectionId = link.connectionId;
  const store: Erc20HistoryStore = {
    walletAddress: account.walletAddress,
    readCursor: () => readHistoryCheckpoint(db, connectionId),
    casCursor: (expected, next) => casHistoryCheckpoint(db, connectionId, expected, next),
    knownTokens: () => loadKnownErc20Tokens(db, accountId),
    resolveInstrument: (contract, decimals) => resolveTokenInstrumentId(
      { assetKey: erc20AssetKey(contract), standard: "ERC20", contract: contract.toLowerCase(), decimals, symbol: null, name: null }, { client: db }),
    async commit({ expectedCursor, nextCursor, writes }) {
      await db.$transaction(async (tx) => {
        await writeErc20TokenOutcomes(tx, accountId, writes);
        if (!(await casHistoryCheckpoint(tx, connectionId, expectedCursor, nextCursor))) throw new Erc20CheckpointConflictError();
      }, { timeout: 30_000 });
    },
  };
  return { store, connectionId };
}

/** One worker step for one ETH wallet (the endpoint is the Alchemy Ethereum URL — transfers are an Alchemy method). */
export async function reconstructErc20HistoryStep(args: { accountId: string; client: PrismaClient; todayISO: string; deps: Erc20HistoryStepDeps }): Promise<Erc20HistoryOutcome> {
  const bound = await prismaErc20HistoryStore(args.accountId, args.client);
  if (!bound) {
    return { stoppedBecause: "NOTHING_OWED", requests: 0, pagesRead: 0, verified: [], unsupported: [], inconclusive: [], pending: 0, impactedFromISO: null, verifiedInstrumentIds: [], failure: null };
  }
  const rpcUrl = args.deps.eth?.rpcUrl !== undefined ? args.deps.eth.rpcUrl : alchemyRpcUrl(ALCHEMY_NETWORKS.ETHEREUM);
  return runErc20HistoryStep({ accountId: args.accountId, store: bound.store, todayISO: args.todayISO },
    { ...args.deps, eth: { ...(args.deps.eth ?? {}), rpcUrl } });
}

/** CAS the section of one account (the pass's regeneration marker). */
export async function setErc20Pending(client: PrismaClient, accountId: string, mutate: (s: Erc20HistorySection) => Erc20HistorySection): Promise<boolean> {
  const link = await historyLink(client, accountId);
  if (!link) return false;
  const raw = await readHistoryCheckpoint(client, link.connectionId);
  const { section } = readErc20Section(raw, accountId);
  if (!section) return false;
  const next = withErc20Section(raw, accountId, mutate(section));
  return next !== null && casHistoryCheckpoint(client, link.connectionId, raw, next);
}

/**
 * OPERATOR RESET (S5) — replace this account's token section with a fresh one
 * (core `resetErc20Section`): every token is re-derived from full evidence and
 * re-judged, including one refused earlier. Native checkpoint fields are
 * untouched (the section is written into its host). Rows and coverage are left
 * as they are until each token is decided again — a verified token's rows are
 * rewritten from its first day, a refused one's coverage stays UNKNOWN (licenses
 * nothing) meanwhile. CAS: false when the checkpoint moved or is foreign.
 */
export async function resetErc20History(client: PrismaClient, accountId: string): Promise<boolean> {
  const link = await historyLink(client, accountId);
  if (!link) return false;
  const raw = await readHistoryCheckpoint(client, link.connectionId);
  const { host, section } = readErc20Section(raw, accountId);
  if (host === "FOREIGN") return false;
  const next = withErc20Section(raw, accountId, resetErc20Section(section));
  return next !== null && casHistoryCheckpoint(client, link.connectionId, raw, next);
}

/** Production wiring for the job (fm_system client): every ACTIVE ETH wallet on its history link. */
export function prismaErc20HistoryPassDeps(systemDb: PrismaClient): Erc20HistoryPassDeps {
  return {
    async wallets(): Promise<Erc20HistoryWallet[]> {
      // The SAME link btcHistoryLink uses (canonical first, then oldest), one per account.
      return systemDb.$queryRaw<Erc20HistoryWallet[]>`
        SELECT DISTINCT ON (ac."financialAccountId")
               ac."financialAccountId" AS "accountId", ac."connectionId" AS "connectionId", c."historyCheckpoint" AS "cursor"
        FROM "AccountConnection" ac
        JOIN "Connection" c ON c."id" = ac."connectionId"
        JOIN "FinancialAccount" fa ON fa."id" = ac."financialAccountId"
        WHERE ac."deletedAt" IS NULL AND ac."connectionId" IS NOT NULL
          AND fa."deletedAt" IS NULL AND UPPER(TRIM(fa."walletChain")) = 'ETH' AND fa."walletAddress" IS NOT NULL
          AND c."provider" = 'WALLET' AND c."status" = 'ACTIVE'
        ORDER BY ac."financialAccountId", ac."isCanonical" DESC, ac."createdAt" ASC`;
    },
    step: ({ accountId, todayISO, deps }) => reconstructErc20HistoryStep({ accountId, client: systemDb, todayISO, deps }),
    setPending: (accountId, mutate) => setErc20Pending(systemDb, accountId, mutate),
    async recordUsage(meter, flushed) {
      const { recordProviderMeter, ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK } = await import("@/lib/usage/provider-budget");
      await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK.ETHEREUM, meter, { flushed });
    },
    async acquirePrices({ accountId, instrumentIds, maxTokens }) {
      const { acquireErc20HistoricalPrices } = await import("./erc20-history-prices");
      return acquireErc20HistoricalPrices({ client: systemDb, accountId, instrumentIds, maxTokens });
    },
  };
}
