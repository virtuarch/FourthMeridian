/**
 * lib/investments/sync-current-holdings.ts
 *
 * Slice A2 — Holding Writer Modernization.
 *
 * Replaces the destructive `deleteMany → create all` refresh behavior with a
 * stable, per-holding synchronization of the current-state `Holding` projection
 * (the UI read model). Existing positions are UPDATED IN PLACE (row ids stay
 * stable — btc-sync's upsert precedent); new positions are inserted; positions
 * absent from a COMPLETE payload are removed. No historical intent lives here —
 * append-only history is PositionObservation, captured separately BEFORE this
 * runs.
 *
 * Holding stays symbol-keyed per account (@@unique([financialAccountId,symbol]))
 * — its existing UI contract — and keeps skipping cash / no-ticker securities
 * (those live only in PositionObservation). No schema change.
 *
 * Pure core (isHoldingEligible / mapPlaidHoldingToRow / planHoldingSync) is
 * unit-testable without a DB; the thin DB binding applies the plan in one
 * transaction so a failure never deletes or corrupts valid existing rows.
 */

import type { Holding as PlaidHolding, Security } from "plaid";
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

// ─── Pure core ────────────────────────────────────────────────────────────────

/** The current-state UI projection excludes cash and no-ticker securities. */
export function isHoldingEligible(sec: Security | undefined): sec is Security {
  return !!sec && (sec.type ?? "").toLowerCase() !== "cash" && !!sec.ticker_symbol;
}

/** Target Holding row for an eligible position — byte-identical to the prior create mapping. */
export interface TargetRow {
  symbol:    string;
  name:      string;
  quantity:  number;
  price:     number;
  value:     number;
  change24h: number;
  currency:  string | null;
}

export interface ExistingRow extends TargetRow {
  id: string;
}

/**
 * Map a raw Plaid holding + eligible security to a Holding row, preserving the
 * exact valuation/currency/change24h semantics of the prior writer.
 */
export function mapPlaidHoldingToRow(
  h: PlaidHolding,
  sec: Security,
  accountCurrency: string | null,
): TargetRow {
  const currentPrice = h.institution_price ?? 0;
  const prevClose = sec.close_price ?? currentPrice;
  const change24h = prevClose > 0
    ? parseFloat((((currentPrice - prevClose) / prevClose) * 100).toFixed(2))
    : 0;
  return {
    symbol:    sec.ticker_symbol!,
    name:      sec.name ?? sec.ticker_symbol!,
    quantity:  h.quantity,
    price:     currentPrice,
    value:     h.institution_value ?? h.quantity * currentPrice,
    change24h,
    currency:  h.iso_currency_code ?? sec.iso_currency_code ?? accountCurrency ?? null,
  };
}

function rowsEqual(a: TargetRow, b: TargetRow): boolean {
  return a.name === b.name && a.quantity === b.quantity && a.price === b.price &&
    a.value === b.value && a.change24h === b.change24h && a.currency === b.currency;
}

export interface SyncPlan {
  insert:    TargetRow[];
  update:    Array<{ id: string; row: TargetRow }>;
  unchanged: string[];         // symbols already current
  deleteIds: string[];         // stale Holding ids to remove
  conflicts: string[];         // duplicate symbols in one payload (extras skipped)
}

export interface SyncCounts {
  inserted:  number;
  updated:   number;
  unchanged: number;
  removed:   number;
  skipped:   number;   // ineligible (cash / no-ticker / no security) holdings
  conflicts: number;
}

/**
 * Pure diff of desired current rows against existing rows, keyed by symbol.
 * `removeStale` gates deletion — pass false for an incomplete payload so a
 * degraded fetch never removes valid rows.
 */
export function planHoldingSync(params: {
  current: TargetRow[];
  existing: ExistingRow[];
  removeStale: boolean;
}): SyncPlan {
  const plan: SyncPlan = { insert: [], update: [], unchanged: [], deleteIds: [], conflicts: [] };
  const existingBySymbol = new Map(params.existing.map((r) => [r.symbol, r]));

  const seen = new Set<string>();
  for (const row of params.current) {
    if (seen.has(row.symbol)) { plan.conflicts.push(row.symbol); continue; } // dup symbol → keep first
    seen.add(row.symbol);
    const existing = existingBySymbol.get(row.symbol);
    if (!existing) { plan.insert.push(row); continue; }
    if (rowsEqual(existing, row)) plan.unchanged.push(row.symbol);
    else plan.update.push({ id: existing.id, row });
  }

  if (params.removeStale) {
    for (const r of params.existing) if (!seen.has(r.symbol)) plan.deleteIds.push(r.id);
  }
  return plan;
}

// ─── DB binding ───────────────────────────────────────────────────────────────

type Client = PrismaClient | Prisma.TransactionClient;

export interface SyncCurrentHoldingsParams {
  financialAccountId: string;
  /** RAW, unfiltered Plaid holdings for THIS account. */
  plaidHoldings: PlaidHolding[];
  securitiesById: Record<string, Security>;
  /** fa.currency — last-resort currency fallback, matching the prior writer. */
  accountCurrency: string | null;
  /** false ⇒ degraded payload (is_investments_fallback_item); stale rows are NOT removed. */
  payloadComplete?: boolean;
  client?: Client;
}

/**
 * Synchronize the current Holding projection for one account. Idempotent:
 * a same-payload re-run produces all-unchanged and no id churn. Only ever call
 * this after a SUCCESSFUL holdings fetch (a partial/failed fetch must not reach
 * here) so removal is safe. Applies the plan in a single transaction.
 */
export async function syncCurrentHoldings(params: SyncCurrentHoldingsParams): Promise<SyncCounts> {
  const client = params.client ?? db;
  const removeStale = params.payloadComplete ?? true;

  const current: TargetRow[] = [];
  let skipped = 0;
  for (const h of params.plaidHoldings) {
    const sec = params.securitiesById[h.security_id];
    if (!isHoldingEligible(sec)) { skipped++; continue; }
    current.push(mapPlaidHoldingToRow(h, sec, params.accountCurrency));
  }

  const existingRaw = await client.holding.findMany({
    where:  { financialAccountId: params.financialAccountId },
    select: { id: true, symbol: true, name: true, quantity: true, price: true, value: true, change24h: true, currency: true },
  });
  const existing: ExistingRow[] = existingRaw;

  const plan = planHoldingSync({ current, existing, removeStale });

  // Single transaction: delete stale → update in place → insert new. A failure
  // rolls back, so valid existing rows are never left corrupted or removed.
  const apply = async (tx: Client) => {
    if (plan.deleteIds.length) {
      await tx.holding.deleteMany({ where: { id: { in: plan.deleteIds } } });
    }
    for (const u of plan.update) {
      await tx.holding.update({ where: { id: u.id }, data: { ...u.row, financialAccountId: params.financialAccountId } });
    }
    if (plan.insert.length) {
      await tx.holding.createMany({
        data: plan.insert.map((r) => ({ ...r, financialAccountId: params.financialAccountId })),
      });
    }
  };
  // Use an interactive transaction only when not already inside one.
  if ("$transaction" in client) {
    await (client as PrismaClient).$transaction((tx) => apply(tx));
  } else {
    await apply(client);
  }

  if (plan.conflicts.length) {
    console.warn(
      `[sync-current-holdings] duplicate symbol(s) in one account payload — kept first, skipped extras: ${plan.conflicts.join(", ")} (account ${params.financialAccountId})`,
    );
  }

  return {
    inserted:  plan.insert.length,
    updated:   plan.update.length,
    unchanged: plan.unchanged.length,
    removed:   plan.deleteIds.length,
    skipped,
    conflicts: plan.conflicts.length,
  };
}
