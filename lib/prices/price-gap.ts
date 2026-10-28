/**
 * lib/prices/price-gap.ts
 *
 * The I/O half of historical price-gap backfill (decisions:
 * ./price-gap.core.ts). Reads balance licences and archive floors, asks the
 * CANONICAL acquisition path (backfillPricesForInstruments — missing-only,
 * insert-only, closed dates, provenance on every row) for the planned windows,
 * and reports what the archive now reaches so the caller can regenerate.
 *
 * It does not regenerate. The caller already owns a regeneration (the Solana
 * worker, the crypto sweep) and calls the canonical planner after this, which
 * MEASURES the newly written closes (PriceObservation.createdAt) and reads the
 * lowered price floor — so the rebuilt window reaches the new dates with no
 * second date authority.
 *
 * Authority: every read goes through the `client` the caller passes (fm_system
 * in the worker). The acquisition itself is the existing shared archive writer.
 *
 * NEVER THROWS. Price maintenance must not fail a backfill or a sweep.
 */

import { AssetClass, PriceBasis, type Prisma, type PrismaClient } from "@prisma/client";
import { licensedInterval } from "@/lib/crypto/position-coverage";
import type { ChainCoverage, ChainCoverageCaveat } from "@/lib/crypto/chain-movement";
import { yesterdayUTCISO } from "./config";
import { routingKeyFor } from "./coverage-binding.core";
import { resolveProviderForInstrument } from "./registry";
import type { PriceRegistry } from "./types";
import {
  planPriceGaps, DEFAULT_PRICE_GAP_MAX_INSTRUMENTS,
  type HolderLicence, type InstrumentPriceFacts, type PriceGapDecision,
} from "./price-gap.core";

export * from "./price-gap.core";

type Client = PrismaClient | Prisma.TransactionClient;
const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** The three outside facts — Prisma below, fakes in tests. */
export interface PriceGapDeps {
  /** Licensed balance intervals of CRYPTO instruments (price-blocking) held by these accounts. */
  licences(accountIds: readonly string[]): Promise<HolderLicence[]>;
  /** Archive floor + routed provider per instrument. */
  priceFacts(instrumentIds: readonly string[]): Promise<Map<string, InstrumentPriceFacts>>;
  /** The canonical acquisition over one window. */
  acquire(instrumentId: string, fromISO: string, toISO: string): Promise<{ inserted: number; detail: string }>;
}

export interface PriceGapRun {
  decisions: PriceGapDecision[];
  /** Instruments a request was issued for. */
  acquired: number;
  /** RAW_CLOSE rows written. */
  inserted: number;
  failures: number;
  /** Per acquired instrument: the archive floor before and after. */
  instruments: Array<{ instrumentId: string; earliestBeforeISO: string | null; earliestAfterISO: string | null }>;
  /** The earliest date that became priceable this run, or null when nothing moved. */
  newlyPricedFromISO: string | null;
}

/**
 * Detect and fill historical price gaps for the instruments these accounts
 * hold a balance licence for. `attempted` (instrumentId → earliest day asked)
 * is the caller's per-run dedup and is updated in place.
 */
export async function acquireHistoricalPriceGaps(args: {
  accountIds: readonly string[];
  deps: PriceGapDeps;
  yesterdayISO?: string;
  maxInstruments?: number;
  attempted?: Map<string, string>;
  log?: (line: string) => void;
}): Promise<PriceGapRun> {
  const run: PriceGapRun = { decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null };
  const log = args.log ?? (() => {});
  if (args.accountIds.length === 0) return run;
  try {
    const licences = await args.deps.licences([...new Set(args.accountIds)].sort());
    if (licences.length === 0) return run;
    const instrumentIds = [...new Set(licences.map((l) => l.instrumentId))].sort();
    const facts = await args.deps.priceFacts(instrumentIds);
    run.decisions = planPriceGaps({
      licences, facts, yesterdayISO: args.yesterdayISO ?? yesterdayUTCISO(),
      maxInstruments: args.maxInstruments ?? DEFAULT_PRICE_GAP_MAX_INSTRUMENTS, attempted: args.attempted,
    });
    for (const d of run.decisions) {
      if (d.kind !== "ACQUIRE") continue;
      args.attempted?.set(d.instrumentId, d.fromISO);
      run.acquired++;
      try {
        const r = await args.deps.acquire(d.instrumentId, d.fromISO, d.toISO);
        run.inserted += r.inserted;
        log(`price gap ${d.instrumentId} ${d.fromISO}..${d.toISO} (${d.holders} holder(s)): ${r.detail}`);
      } catch (e) {
        run.failures++;
        log(`price gap ${d.instrumentId} ${d.fromISO}..${d.toISO}: acquisition failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const acquiredIds = run.decisions.filter((d) => d.kind === "ACQUIRE").map((d) => d.instrumentId);
    if (acquiredIds.length > 0) {
      // RE-READ the floor: rows written is not the question — only what the
      // archive now reaches is. A provider that returned nothing moves nothing.
      const after = await args.deps.priceFacts(acquiredIds);
      for (const id of acquiredIds) {
        const before = facts.get(id)?.earliestRawCloseISO ?? null;
        const now = after.get(id)?.earliestRawCloseISO ?? null;
        run.instruments.push({ instrumentId: id, earliestBeforeISO: before, earliestAfterISO: now });
        if (now !== null && (before === null || now < before)) {
          if (run.newlyPricedFromISO === null || now < run.newlyPricedFromISO) run.newlyPricedFromISO = now;
        }
      }
    }
  } catch (e) {
    run.failures++;
    log(`price gap detection failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
  return run;
}

// ── Read helpers (UI-ready coverage facts) ──────────────────────────────────

/** Earliest stored RAW_CLOSE per instrument. Instruments with none are absent from the map. */
export async function earliestRawCloseByInstrument(client: Client, instrumentIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (instrumentIds.length === 0) return out;
  const rows = await client.priceObservation.groupBy({
    by: ["instrumentId"],
    where: { instrumentId: { in: [...instrumentIds] }, basis: PriceBasis.RAW_CLOSE },
    _min: { date: true },
  });
  for (const r of rows) if (r._min.date) out.set(r.instrumentId, isoOf(r._min.date));
  return out;
}

/** Licensed balance intervals, through the ONE licence reader (position-coverage.ts licensedInterval). */
export async function cryptoHolderLicences(client: Client, accountIds: readonly string[]): Promise<HolderLicence[]> {
  if (accountIds.length === 0) return [];
  const rows = await client.positionCoverage.findMany({
    where: { financialAccountId: { in: [...accountIds] }, instrument: { assetClass: AssetClass.CRYPTO } },
    select: { financialAccountId: true, instrumentId: true, kind: true, coveredFromDate: true, coveredToDate: true, caveats: true, source: true },
  });
  const out: HolderLicence[] = [];
  for (const r of rows) {
    const caveats = r.caveats as ChainCoverageCaveat[];
    const coverage: ChainCoverage | null =
      r.kind === "COMPLETE" && r.coveredFromDate && r.coveredToDate
        ? { kind: "COMPLETE", fromISO: isoOf(r.coveredFromDate), toISO: isoOf(r.coveredToDate), source: r.source }
        : r.kind === "PARTIAL"
          ? { kind: "PARTIAL", coveredFromISO: r.coveredFromDate ? isoOf(r.coveredFromDate) : null, coveredToISO: r.coveredToDate ? isoOf(r.coveredToDate) : null, caveats, source: r.source }
          : null;
    const licence = coverage ? licensedInterval(coverage) : null;
    if (licence) out.push({ financialAccountId: r.financialAccountId, instrumentId: r.instrumentId, licensedFromISO: licence.fromISO });
  }
  return out;
}

/** Production deps over `client`, acquiring through the canonical backfill. */
export function prismaPriceGapDeps(client: Client, opts: { registry?: PriceRegistry; log?: (line: string) => void } = {}): PriceGapDeps {
  const registry = async (): Promise<PriceRegistry> => opts.registry ?? (await import("./registry")).defaultPriceRegistry();
  return {
    licences: (ids) => cryptoHolderLicences(client, ids),
    async priceFacts(ids) {
      const [earliest, instruments, reg] = await Promise.all([
        earliestRawCloseByInstrument(client, ids),
        client.instrument.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, assetClass: true, tickerSymbol: true, marketIdentifierCode: true, currency: true },
        }),
        registry(),
      ]);
      const out = new Map<string, InstrumentPriceFacts>();
      for (const i of instruments) {
        const meta = { instrumentId: i.id, assetClass: String(i.assetClass), tickerSymbol: i.tickerSymbol, marketIdentifierCode: i.marketIdentifierCode, currency: i.currency };
        const res = resolveProviderForInstrument(reg, routingKeyFor(meta, PriceBasis.RAW_CLOSE));
        out.set(i.id, {
          instrumentId: i.id,
          earliestRawCloseISO: earliest.get(i.id) ?? null,
          provider: res.kind === "provider" ? { kind: "provider", source: res.adapter.source, floorISO: res.adapter.historicalDepth } : { kind: "none" },
        });
      }
      return out;
    },
    async acquire(instrumentId, fromISO, toISO) {
      const { backfillPricesForInstruments } = await import("./backfill");
      const r = await backfillPricesForInstruments([instrumentId], {
        apply: true, forceWindow: { fromISO, toISO }, registry: await registry(), onProgress: opts.log,
      });
      const outcomes = Object.entries(r.outcomes).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(",");
      return { inserted: r.inserted, detail: `${r.inserted} row(s) written, outcomes ${outcomes || "none"}` };
    },
  };
}
