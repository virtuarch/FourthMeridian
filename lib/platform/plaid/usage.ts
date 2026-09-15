/**
 * lib/platform/plaid/usage.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * Plaid USAGE and ECONOMICS for the operator: the Item × product × billing-cycle
 * census (lib/platform/plaid/item-months.ts — the existing authority, which had
 * no reader) fed from persistence, priced by the ONE rate card (PLAID_RATES),
 * beside the current Item population.
 *
 * USAGE vs COST are kept apart on the result:
 *   · usage = Item-months per product, exact from the rows and the append-only
 *     status transitions; both invoice readings reported, with `agree`;
 *   · cost  = Item-months × the invoice-derived rate, labelled ESTIMATED with its
 *     provenance; null (never zero) when a cycle predates the rate's evidence.
 * No daily allocation is produced: the billable unit is the Item-month, and
 * dividing it into days would be an allocation the invoice never makes.
 *
 * PRIVACY: Items are read without institution, user or token columns — the
 * census needs an id, a creation day, a status and the consent flag, nothing
 * else (item-months.ts refuses the token by type).
 */

import "server-only";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { PLAID_RATES, type PlaidRate } from "@/lib/usage/pricing";
import {
  censusCoverage,
  isBillableItem,
  monthCycle,
  priceCycleBothReadings,
  type BillingCycle,
  type PlaidCycleCost,
  type PlaidItemFact,
  type PlaidItemTransition,
} from "@/lib/platform/plaid/item-months";
import { todayUTCISO } from "@/lib/time/clock";

export interface PlaidUsage {
  checkedAt: string;
  population: {
    total: number;
    /** Excluding seeded demo fixtures — the rows the census bills. */
    billable: number;
    seeded: number;
    byStatus: Readonly<Record<string, number>>;
    byEnvironment: Readonly<Record<string, number>>;
    investmentsConsented: number;
    /** Items that produced a recorded status transition (the retirement evidence). */
    withTransitions: number;
  };
  cycles: readonly {
    cycle: BillingCycle;
    label: "current" | "previous";
    during: PlaidCycleCost;
    atEnd: PlaidCycleCost;
    agree: boolean;
  }[];
  priceAuthority: {
    configured: boolean;
    tier: "ESTIMATED";
    rates: readonly { product: string; usdPerItemMonth: number; effectiveFrom: string; source: string }[];
    note: string;
  };
  limits: { dailyAllocation: false; note: string };
}

export interface PlaidUsageReaders {
  today(): string;
  items(): Promise<PlaidItemFact[]>;
  transitions(take: number): Promise<PlaidItemTransition[]>;
}

const TRANSITIONS_LIMIT = 5000;

function realReaders(): PlaidUsageReaders {
  return {
    today: () => todayUTCISO(),
    async items() {
      const rows = await db.plaidItem.findMany({
        select: { id: true, externalItemId: true, createdAt: true, status: true, investmentsConsent: true, environment: true },
      });
      return rows.map((r) => ({ ...r, status: String(r.status), investmentsConsent: r.investmentsConsent ? String(r.investmentsConsent) : null }));
    },
    async transitions(take) {
      const rows = await db.auditLog.findMany({
        where: { action: AuditAction.PLAID_ITEM_STATUS_CHANGED },
        orderBy: { createdAt: "asc" },
        take,
        select: { createdAt: true, metadata: true },
      });
      return decodeTransitions(rows);
    },
  };
}

/** Decode CH-2 transition rows; a row without the three facts is dropped, never guessed. */
export function decodeTransitions(rows: readonly { createdAt: Date; metadata: unknown }[]): PlaidItemTransition[] {
  const out: PlaidItemTransition[] = [];
  for (const r of rows) {
    const m = (r.metadata ?? {}) as { plaidItemId?: unknown; from?: unknown; to?: unknown };
    if (typeof m.plaidItemId !== "string" || typeof m.from !== "string" || typeof m.to !== "string") continue;
    out.push({ plaidItemId: m.plaidItemId, at: r.createdAt, from: m.from, to: m.to });
  }
  return out;
}

function previousMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function buildPlaidUsage(
  items: readonly PlaidItemFact[],
  transitions: readonly PlaidItemTransition[],
  today: string,
  rates: readonly PlaidRate[] = PLAID_RATES,
): Omit<PlaidUsage, "checkedAt"> {
  const byStatus: Record<string, number> = {};
  const byEnvironment: Record<string, number> = {};
  let seeded = 0; let consented = 0;
  for (const i of items) {
    byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    const env = i.environment ?? "unknown";
    byEnvironment[env] = (byEnvironment[env] ?? 0) + 1;
    if (!isBillableItem(i)) seeded++;
    if (i.investmentsConsent) consented++;
  }
  const current = today.slice(0, 7);
  const cycles = [
    { label: "current" as const, cycle: monthCycle(current) },
    { label: "previous" as const, cycle: monthCycle(previousMonth(current)) },
  ].map(({ label, cycle }) => {
    const both = priceCycleBothReadings(items, transitions, cycle, { today, rates });
    return { cycle, label, during: both.during, atEnd: both.atEnd, agree: both.agree };
  });
  // Coverage is computed by priceCycle already; censusCoverage is called here
  // only to keep the census/coverage pairing explicit for the current cycle.
  void censusCoverage(items, transitions, cycles[0].cycle);
  return {
    population: {
      total: items.length,
      billable: items.length - seeded,
      seeded,
      byStatus,
      byEnvironment,
      investmentsConsented: consented,
      withTransitions: new Set(transitions.map((t) => t.plaidItemId)).size,
    },
    cycles,
    priceAuthority: {
      configured: rates.length > 0,
      tier: "ESTIMATED",
      rates: rates.map((r) => ({ product: r.product, usdPerItemMonth: r.usdPerItemMonth, effectiveFrom: r.effectiveFrom, source: r.source })),
      note: rates.length > 0
        ? "Rates are code-owned and derived from a Plaid invoice; a cycle before the earliest effective date is reported unpriced, never zero."
        : "No Plaid price authority is configured; usage is shown, cost is not.",
    },
    limits: {
      dailyAllocation: false,
      note: "The billable unit is the Item-subscription-month; no per-day cost is allocated.",
    },
  };
}

export async function getPlaidUsage(deps: { readers?: PlaidUsageReaders } = {}): Promise<PlaidUsage> {
  const readers = deps.readers ?? realReaders();
  const [items, transitions] = await Promise.all([readers.items(), readers.transitions(TRANSITIONS_LIMIT)]);
  return { checkedAt: new Date().toISOString(), ...buildPlaidUsage(items, transitions, readers.today()) };
}
