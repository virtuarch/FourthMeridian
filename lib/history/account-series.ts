/**
 * lib/history/account-series.ts
 *
 * V27-C — THE canonical account-history authority for stock lenses.
 *
 * ── One contract, several authorities ────────────────────────────────────────
 * A checking account and a brokerage account do not have the same kind of
 * history, and forcing both through one replay algorithm would mean inventing a
 * shared abstraction neither fits. So: ONE account-series CONTRACT
 * (`HistoricalAccountNode` + `HistoricalSeriesPoint`), several ASSET-CLASS
 * AUTHORITIES behind it, each already canonical:
 *
 *   cash / savings   `getAccountBalancesOverWindow` — the sanctioned as-of
 *   debt             resolver, widened to a window. NOT the walk-back primitives
 *                    directly: a second importer of those is a second
 *                    reconstruction basis, which the reconstruction-basis guard
 *                    fails the build over and which once put phantom cash in
 *                    Assets by reversing unsettled rows against a posted anchor.
 *   investment       `historicalHoldingsForWindow` — the ONE holdings authority,
 *                    grouped by account (brokerage cash included: it is a held
 *                    position on the same spine, not a bank balance)
 *   crypto           `valueCryptoDay` — the ONE crypto day valuation, gated by
 *                    ledger completeness and the constant-quantity licence
 *
 * Nothing here prices, owns, or replays anything of its own.
 *
 * ── Precedence (V27-C2) ──────────────────────────────────────────────────────
 *   1. exact-date direct observation
 *   2. licensed replay / reconstruction
 *   3. anchored carry, only where mathematically licensed
 *   4. unavailable
 *
 * ANCHORED BACKWARD REPLAY IS NOT A VIOLATION of "never use today's balance".
 * Walking today's balance back through a complete transaction ledger is exact
 * arithmetic from an anchor; the invariant forbids today's holdings deciding
 * OWNERSHIP or COMPOSITION, not being the anchor of a subtraction. A HELD-FLAT
 * carry is the case that is not licensed, and it is stamped `estimated` and
 * disclosed rather than silently blended in.
 *
 * ── Window inheritance (V27-C3) ──────────────────────────────────────────────
 * Every series spans exactly the window the caller passes down. No 30-day reset,
 * no one-year clamp, no current-date-only path.
 *
 * NO PERSISTENCE. Computed on demand, per V27's rule 11.
 * READ-ONLY. Nothing here writes.
 */

import { db } from "@/lib/db";
import { AccountType, ShareStatus, SettlementState, type Prisma, type PrismaClient } from "@prisma/client";
import { truncDateUTC, isoDate, fromISO, addDaysUTC } from "@/lib/snapshots/backfill-core";
import { getAccountBalancesOverWindow, type WindowAccount } from "@/lib/data/accounts-asof-window";
import type { ResolvedAsOfBalance } from "@/lib/data/accounts-asof.core";
import { historicalHoldingsForWindow } from "@/lib/investments/historical-holdings";
import { valueCryptoDay } from "@/lib/crypto/historical-crypto-valuation.core";
import { licenseConstantQuantityCarry } from "@/lib/crypto/quantity-carry.core";
import { reconcileWalletLedger } from "@/lib/crypto/ledger-completeness.core";
import { readBtcUsdWindow } from "@/lib/crypto/btc-price";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";
import { classifyAccounts } from "@/lib/account-classifier";
import { round2 } from "@/lib/perspective-engine/reconciliation.core";
import {
  extendBreadcrumb,
  type BucketKind, type HistoricalAccountNode, type HistoricalCrumb,
  type HistoricalSeriesPoint, type ValueBasis,
} from "./historical-node.core";

type Client = PrismaClient | Prisma.TransactionClient;

/** The account types each bucket draws from — the `classifyAccounts` partition. */
const BUCKET_ACCOUNT_TYPES: Partial<Record<BucketKind, readonly AccountType[]>> = {
  cash:        [AccountType.checking],
  savings:     [AccountType.savings],
  debt:        [AccountType.debt],
  investments: [AccountType.investment],
  crypto:      [AccountType.crypto],
};

export interface AccountSeriesArgs {
  spaceId:  string;
  bucketKind: BucketKind;
  /** The selected date. */
  dateISO:  string;
  /** The INHERITED window — used verbatim. */
  fromISO:  string;
  toISO:    string;
  currency: string;
  /** The parent's breadcrumb, extended by one step per account. */
  breadcrumb: readonly HistoricalCrumb[];
  client?: Client;
}

/**
 * The account existed earlier than any value can be shown for it — say so.
 *
 * Requirement 13: a child whose interval is narrower than its parent's must
 * EXPLAIN the difference rather than render an empty panel. "We know this
 * account goes back to 2023; we cannot value it before 2025" is an answer.
 */
function coverageNote(a: AccountRow): string | null {
  const { existenceFromISO, displayFromISO } = a.coverage;
  if (!existenceFromISO || existenceFromISO >= displayFromISO) return null;
  return `Evidence shows this account existed from ${existenceFromISO}, but its history can only be reconstructed from ${displayFromISO}.`;
}

/**
 * PRECEDENCE RULE 1 — an exact-date direct observation outranks any
 * reconstruction, at EVERY asset class and not just the ones with a ledger.
 *
 * On the present date the account's own balance IS the observation, and it is
 * the very input `classifyAccounts` fed into the stored snapshot total. Valuing
 * today from the price ARCHIVE instead produces a number that is defensible in
 * isolation and disagrees with the total it is supposed to explain — the
 * archive's close is simply not the quote the balance was struck at. Two
 * authorities for one date is the thing this arc exists to remove.
 */
function observedPoint(dateISO: string, todayISO: string, balance: number): HistoricalSeriesPoint | null {
  if (dateISO < todayISO) return null;
  return { dateISO, value: round2(balance), basis: "observed" };
}

/** Every ISO date in [from, to] inclusive. */
function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let d = truncDateUTC(fromISO(from));
  const end = truncDateUTC(fromISO(to));
  while (d.getTime() <= end.getTime()) {
    out.push(isoDate(d));
    d = addDaysUTC(d, 1);
  }
  return out;
}

/**
 * The account nodes composing one bucket on one date, each with its own series
 * over the inherited window.
 *
 * Returns `null` when the bucket has no account-level composition to offer —
 * real assets, or a bucket type this authority does not serve. That is a
 * statement ("no children here"), not an empty list pretending there are none.
 */
export async function bucketAccountNodes(
  args: AccountSeriesArgs,
): Promise<HistoricalAccountNode[] | null> {
  const types = BUCKET_ACCOUNT_TYPES[args.bucketKind];
  if (!types) return null;

  // ONE read for the whole bucket and the whole window: the sanctioned resolver,
  // the sanctioned floors, and POSTED-ONLY deltas — all inherited, none restated.
  // Investment and crypto buckets take their metadata and floors from the same
  // read and then answer through their own asset-class authority.
  const { accounts, byDate } = await getAccountBalancesOverWindow({
    spaceId: args.spaceId, fromISO: args.fromISO, toISO: args.toISO,
    types: [...types], client: args.client,
  });
  if (accounts.length === 0) return [];

  switch (args.bucketKind) {
    case "investments": return investmentAccountNodes(args, accounts, args.client);
    case "crypto":      return cryptoAccountNodes(args, accounts, args.client);
    default:            return balanceAccountNodes(args, accounts, byDate);
  }
}

// ── Cash / savings / debt — the anchored walk ────────────────────────────────

type AccountRow = WindowAccount;

async function balanceAccountNodes(
  args: AccountSeriesArgs,
  accounts: readonly AccountRow[],
  byDate: ReadonlyMap<string, ReadonlyMap<string, ResolvedAsOfBalance>>,
): Promise<HistoricalAccountNode[]> {
  const dates = eachDate(args.fromISO, args.toISO);

  return accounts.map((a) => {
    const point = (d: string): HistoricalSeriesPoint => {
      const r = byDate.get(d)?.get(a.id);
      if (!r) return { dateISO: d, value: null, basis: "reconstructed", unavailableReason: "NOT_RESOLVED" };
      switch (r.method) {
        // 4 — before the account existed: a gap, never a back-projected balance.
        case "before-coverage":
          return { dateISO: d, value: null, basis: "reconstructed", unavailableReason: "BEFORE_ACCOUNT_COVERAGE" };
        // 1 — the present IS an observation.
        case "observed":
          return { dateISO: d, value: round2(r.balance), basis: "observed" };
        // 2 — licensed replay.
        case "cash-walkback":
        case "card-walkback":
          return { dateISO: d, value: round2(r.balance), basis: "reconstructed" };
        // 3 — anchored carry. Carried, but never silently: an installment loan
        // has no ledger to walk, and saying so is the whole point.
        default:
          return { dateISO: d, value: round2(r.balance), basis: "reconstructed", unavailableReason: "HELD_FLAT_NO_LEDGER" };
      }
    };

    const points = dates.map(point);
    const at = points.find((p) => p.dateISO === args.dateISO) ?? point(args.dateISO);
    const method = byDate.get(args.dateISO)?.get(a.id)?.method ?? "held-flat";
    const tier = byDate.get(args.dateISO)?.get(a.id)?.tier ?? "estimated";

    return node(args, a, {
      value: at.value,
      basis: at.basis,
      tier,
      series: points,
      unavailableReason: method === "before-coverage" ? "BEFORE_ACCOUNT_COVERAGE" : null,
      supportedFromISO: a.coverage.existenceFromISO ?? a.floorISO,
      note: method === "held-flat"
        ? "No transaction ledger reaches this date; the current balance is carried and labelled."
        : coverageNote(a),
      // A balance account has no deeper level in this arc.
      drilldown: { available: false, reason: "NO_HOLDING_LEVEL_FOR_THIS_ACCOUNT_TYPE" },
      counts: { historicalCount: 0, valuedCount: 0 },
    });
  });
}

// ── Investment accounts — grouped from the ONE holdings authority ────────────

async function investmentAccountNodes(
  args: AccountSeriesArgs, accounts: readonly AccountRow[], client: Client | undefined,
): Promise<HistoricalAccountNode[]> {
  const dates = eachDate(args.fromISO, args.toISO);
  // ONE call values the whole window; identical arguments to the Investments
  // point authority, so an account's value here IS its share of that point.
  const byDate = await historicalHoldingsForWindow({
    spaceId: args.spaceId, dates, client: client ?? db,
    holdConstantBeforeEarliest: true, excludeDigitalAssetAccounts: true,
  });

  const todayISO = isoDate(truncDateUTC(new Date()));

  return accounts.map((a) => {
    const points: HistoricalSeriesPoint[] = dates.map((d) => {
      const observed = observedPoint(d, todayISO, a.balance);
      if (observed) return observed;
      const set = byDate.get(d);
      const mine = (set?.held ?? []).filter((h) => h.financialAccountId === a.id);
      if (mine.length === 0) {
        return { dateISO: d, value: null, basis: "reconstructed", unavailableReason: "NO_HELD_POSITIONS" };
      }
      const valued = mine.filter((h) => h.reportingValue != null);
      return {
        dateISO: d,
        value: round2(valued.reduce((n, h) => n + (h.reportingValue ?? 0), 0)),
        basis: "reconstructed",
      };
    });

    const set = byDate.get(args.dateISO);
    const mine = (set?.held ?? []).filter((h) => h.financialAccountId === a.id);
    const valued = mine.filter((h) => h.reportingValue != null);
    const present = args.dateISO >= todayISO;
    const at = points.find((p) => p.dateISO === args.dateISO)
      ?? observedPoint(args.dateISO, todayISO, a.balance);

    return node(args, a, {
      value: present ? round2(a.balance) : mine.length === 0 ? null : (at?.value ?? null),
      basis: present ? "observed" : "reconstructed",
      tier: present ? "observed"
        : mine.length === 0 ? "incomplete"
        : mine.every((h) => h.ownership === "KNOWN") ? "derived" : "estimated",
      series: points,
      unavailableReason: present || mine.length > 0 ? null : "NO_HELD_POSITIONS",
      supportedFromISO: a.coverage.existenceFromISO ?? a.floorISO,
      note: coverageNote(a),
      // The holding level (V27-D) lives beneath an investment account.
      drilldown: { available: present || mine.length > 0, reason: present || mine.length > 0 ? null : "NO_HELD_POSITIONS" },
      counts: { historicalCount: mine.length, valuedCount: valued.length },
    });
  });
}

// ── Crypto wallets — the ONE crypto day valuation ────────────────────────────

async function cryptoAccountNodes(
  args: AccountSeriesArgs, accounts: readonly AccountRow[], client: Client | undefined,
): Promise<HistoricalAccountNode[]> {
  const dates = eachDate(args.fromISO, args.toISO);
  const btcAt = await readBtcUsdWindow(args.fromISO, args.toISO);
  // FX through the SAME path every stored crypto total went through, for the
  // WHOLE window in one context — a per-date conversion would be N reads and
  // could disagree with the total it is explaining.
  const fx = await buildSpaceConversionContextById(args.spaceId, { currencies: ["USD"], dates });
  const toReporting = (usd: number, d: string): number =>
    classifyAccounts([{ type: "crypto", balance: usd, currency: "USD" }], fx, d).totalDigitalAssets;
  const todayISO = isoDate(truncDateUTC(new Date()));
  const movements = await (client ?? db).transaction.findMany({
    where: {
      financialAccountId: { in: accounts.map((a) => a.id) },
      currency: "BTC", deletedAt: null, settlementState: SettlementState.POSTED,
    },
    select: { financialAccountId: true, date: true, amount: true },
  });

  return accounts.map((a) => {
    const mine = movements.filter((m) => m.financialAccountId === a.id);
    // Ledger completeness gates EVERYTHING historical for a wallet (V26-S1).
    const ledger = reconcileWalletLedger({
      observedBalance: a.nativeBalance ?? null, movements: mine.map((m) => m.amount),
    });
    const anchorISO = a.lastUpdated ? isoDate(truncDateUTC(a.lastUpdated)) : null;
    const eventDates = mine.map((m) => isoDate(truncDateUTC(m.date)));

    const point = (d: string): HistoricalSeriesPoint => {
      const observed = observedPoint(d, todayISO, a.balance);
      if (observed) return observed;
      const licensed = licenseConstantQuantityCarry({
        targetISO: d, anchorISO, eventDatesISO: eventDates, ledgerComplete: ledger.complete,
      });
      const day = valueCryptoDay({
        accounts: [{ financialAccountId: a.id, name: a.name, nativeBalance: a.nativeBalance, symbol: "BTC" }],
        unitPrice: btcAt(d),
        quantityLicensed: licensed.licensed,
      });
      if (!day.licensed) {
        return {
          dateISO: d, value: null, basis: "reconstructed",
          // A price floor and an unlicensed quantity are different refusals and
          // are reported as such — never a flat carried balance either way.
          unavailableReason: day.refusal === "NO_PRICE" ? "BELOW_PRICE_PROVIDER_FLOOR"
            : ledger.complete ? "QUANTITY_NOT_LICENSED" : "WALLET_LEDGER_INCOMPLETE",
        };
      }
      return { dateISO: d, value: round2(toReporting(day.nativeTotal, d)), basis: "reconstructed" };
    };

    const points = dates.map(point);
    const at = points.find((p) => p.dateISO === args.dateISO) ?? point(args.dateISO);
    const firstSupported = points.find((p) => p.value != null)?.dateISO ?? null;

    return node(args, a, {
      value: at.value,
      basis: at.basis,
      tier: at.value == null ? "incomplete" : at.basis === "observed" ? "observed" : "estimated",
      series: points,
      unavailableReason: at.unavailableReason ?? null,
      // Existence reaches back to the wallet's first movement; `firstSupported`
      // is where a PRICE first exists. Both are reported, because they are
      // different facts and the gap between them is the honest answer.
      supportedFromISO: a.coverage.existenceFromISO ?? firstSupported,
      note: ledger.complete ? coverageNote(a) : ledger.reason,
      drilldown: { available: at.value != null, reason: at.value != null ? null : (at.unavailableReason ?? null) },
      counts: { historicalCount: Math.abs(a.nativeBalance ?? 0) > 0 ? 1 : 0, valuedCount: at.value != null ? 1 : 0 },
    });
  });
}

// ── Shared node construction (shape only) ────────────────────────────────────

function node(
  args: AccountSeriesArgs,
  a: AccountRow,
  r: {
    value: number | null; basis: ValueBasis; tier: HistoricalAccountNode["provenance"]["tier"];
    series: HistoricalSeriesPoint[]; unavailableReason: string | null;
    supportedFromISO: string | null; note: string | null;
    drilldown: { available: boolean; reason: string | null };
    counts: { historicalCount: number; valuedCount: number };
  },
): HistoricalAccountNode {
  return {
    nodeType: "account",
    id: `account:${a.id}`,
    label: a.name,
    accountId: a.id,
    accountType: a.type,
    institution: a.institution,
    dateISO: args.dateISO, fromISO: args.fromISO, toISO: args.toISO, currency: args.currency,
    displayedValue: r.value,
    // An account's own children arrive in V27-D; it explains nothing yet.
    explainedValue: null,
    unattributedObservedAmount: null,
    reconciliation: r.value == null ? "UNAVAILABLE" : "EXACT",
    assertable: r.value != null,
    unavailableReason: r.unavailableReason,
    provenance: {
      basis: r.basis, tier: r.tier,
      supportedFromISO: r.supportedFromISO,
      supportedToISO: null,
      note: r.note,
    },
    breadcrumb: extendBreadcrumb(args.breadcrumb, { id: `account:${a.id}`, label: a.name, nodeType: "account" }),
    components: [],
    drilldown: r.drilldown,
    series: r.series,
    historicalCount: r.counts.historicalCount,
    valuedCount: r.counts.valuedCount,
  };
}

export { eachDate };
