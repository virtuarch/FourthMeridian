/**
 * lib/platform/plaid/item-months.ts  (Platform Ops cost accounting — Slice 4)
 *
 * PLAID COST AT ITS ACTUAL BILLING GRAIN: Item × billable product × cycle.
 *
 * ⚠️ A PURE DERIVATION, NOT A COLLECTOR. There is no PlaidInvocation and no
 * PlaidBillingEvent, because the economic fact is SUBSCRIPTION STATE, not request
 * volume. Everything below is a function of `PlaidItem` rows and the append-only
 * CH-2 `PLAID_ITEM_STATUS_CHANGED` ledger that already exist. Nothing is stored.
 *
 * ⚠️ CALLS ARE NOT COST. `PLAID/<method>/calls` counters stay exactly as they are
 * — operational telemetry, provider-health input — and no code path lets them
 * reach a dollar. `/transactions/sync` is included in the subscription and
 * `/transactions/refresh` costs $0; a cost curve built on call volume would be an
 * invention.
 *
 * ⚠️ NO USER FINANCIAL DATA CROSSES THIS BOUNDARY. Item id, external id, dates,
 * status and a product label. Never a balance, a transaction, an account number,
 * an access token or the encrypted credential.
 */

import type { PlaidBillableProduct, PlaidRate } from "@/lib/usage/pricing";
import { plaidRateAt, PLAID_RATES } from "@/lib/usage/pricing";
// ⚠️ THE CLOCK IS lib/time's, NOT THIS MODULE'S. A source scan pins that nothing
// outside lib/time re-implements the current day, and it caught the first draft
// doing exactly that. `todayUTCISO()` is injectable by design, which is also what
// keeps this derivation testable at a fixed date.
import { todayUTCISO } from "@/lib/time/clock";

// ── Inputs, injected so the derivation is testable without a database ────────

export interface PlaidItemFact {
  id: string;
  /** The provider's own item id. Its shape is how a seeded fixture is excluded. */
  externalItemId: string;
  createdAt: Date | string;
  /** CURRENT state only — never projected backward (see `retiredAtFrom`). */
  status: string;
  /** CURRENT consent only. Has no timestamp, so it evidences the present alone. */
  investmentsConsent: string | null;
  /** Stamped at creation. Null = genuinely unknown, never assumed. */
  environment: string | null;
}

/** One append-only CH-2 transition row, already decoded from AuditLog metadata. */
export interface PlaidItemTransition {
  plaidItemId: string;
  at: Date | string;
  from: string;
  to: string;
}

/**
 * ⚠️ SEEDED FIXTURES ARE NOT BILLABLE AND MUST NOT BE COUNTED. `prisma/seed.ts`
 * writes demo Items with a fabricated `externalItemId` and the literal token
 * placeholder "[demo-placeholder-not-a-real-token]" — they were never created at
 * Plaid, so they never appear on an invoice. On the development database they are
 * NINE OF THIRTEEN rows: counting them would inflate a census by 69%.
 *
 * The external id is the discriminator because it is the provider's identifier —
 * a fabricated one is definitionally not a Plaid subscription — and because the
 * alternative, reading `encryptedToken`, would pull a credential column into cost
 * accounting for no gain. A test pins that the seed still uses this prefix.
 */
export const SEEDED_ITEM_PREFIX = "demo_item_";
export const isBillableItem = (i: PlaidItemFact): boolean =>
  !i.externalItemId.startsWith(SEEDED_ITEM_PREFIX);

const iso = (d: Date | string): string =>
  typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * The day an Item stopped being billable, or null if it never did.
 *
 * ⚠️ RETIREMENT COMES FROM THE APPEND-ONLY LEDGER, NEVER FROM CURRENT STATE.
 * `disconnect.ts` sets status REVOKED and the CH-2 chokepoint records the
 * transition; the row itself is not deleted. Reading `status === "REVOKED"` and
 * treating today's state as true for a past cycle is precisely the backward
 * projection this function exists to prevent — an Item revoked yesterday was
 * still billable last month.
 *
 * NEEDS_REAUTH and ERROR are NOT retirement. A broken Item is still a live
 * subscription and is still billed; the operator's own record makes the point
 * that "an errored Item is exactly what looks like an orphan and is not".
 */
export function retiredAtFrom(itemId: string, transitions: readonly PlaidItemTransition[]): string | null {
  const revocations = transitions
    .filter((t) => t.plaidItemId === itemId && t.to === "REVOKED")
    .map((t) => iso(t.at))
    .sort();
  return revocations[0] ?? null;
}

// ── The census ───────────────────────────────────────────────────────────────

export interface BillingCycle { start: string; end: string }

/** A calendar month as a billing cycle, matching the invoice's own 7/1–7/31 shape. */
export function monthCycle(yyyymm: string): BillingCycle {
  const [y, m] = yyyymm.split("-").map(Number);
  return { start: `${yyyymm}-01`, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

export interface ItemMonth {
  itemId: string;
  product: PlaidBillableProduct;
  cycle: BillingCycle;
  environment: string;              // "unknown" when never captured
  /** Interpretation A — the Item existed at any point in the cycle. */
  presentDuringCycle: boolean;
  /** Interpretation B — the Item was still live on the last day of the cycle. */
  presentAtCycleEnd: boolean;
  /** True only where the product can be evidenced FOR THIS CYCLE (see below). */
  productEvidenced: boolean;
}

/**
 * Every (Item, product) that was billable in a cycle, under BOTH candidate
 * readings of the invoice.
 *
 * ⚠️ THE AMBIGUITY IS STRUCTURAL, NOT RESOLVED. The dashboard tile that
 * reconciled to the invoice is labelled "Lifetime Items on 7/31" while its
 * tooltip says "Items billed in the 7/1–7/31 cycle". July cannot separate them —
 * nothing was retired mid-cycle — so both are computed and named, and the caller
 * must say which one it priced. Presenting one as known truth would claim
 * billing knowledge this repository does not have.
 *
 * ⚠️ THE INVESTMENTS PRODUCT IS ONLY EVIDENCED FOR A CYCLE THAT INCLUDES TODAY.
 * `investmentsConsent` carries no timestamp, so whether consent was in force
 * during a past cycle is unknowable. `productEvidenced: false` marks that, rather
 * than projecting today's consent backward.
 */
export function itemMonths(
  items: readonly PlaidItemFact[],
  transitions: readonly PlaidItemTransition[],
  cycle: BillingCycle,
  today: string = todayUTCISO(),
): ItemMonth[] {
  const out: ItemMonth[] = [];
  const cycleIncludesToday = today >= cycle.start && today <= cycle.end;

  for (const item of items) {
    if (!isBillableItem(item)) continue;
    const born = iso(item.createdAt);
    const retired = retiredAtFrom(item.id, transitions);

    // Born after the cycle ended ⇒ contributed nothing to it.
    if (born > cycle.end) continue;
    // Retired before the cycle began ⇒ likewise.
    if (retired && retired < cycle.start) continue;

    const presentDuringCycle = true;                        // established by the two guards above
    const presentAtCycleEnd = born <= cycle.end && (!retired || retired > cycle.end);
    const environment = item.environment ?? "unknown";

    out.push({ itemId: item.id, product: "transactions", cycle,
      environment, presentDuringCycle, presentAtCycleEnd, productEvidenced: true });

    if (item.investmentsConsent) {
      out.push({ itemId: item.id, product: "investments", cycle, environment,
        presentDuringCycle, presentAtCycleEnd,
        productEvidenced: cycleIncludesToday });
    }
  }
  return out;
}

// ── Coverage ─────────────────────────────────────────────────────────────────

export interface CensusCoverage {
  /**
   * The earliest day retirement is detectable at all — the first row in the
   * transition ledger. Before it, a retired Item is indistinguishable from a live
   * one, so a census reads as an over-count of uncertain size.
   */
  retirementEvidenceFrom: string | null;
  /** The earliest surviving Item. A wipe leaves nothing to reconstruct from. */
  earliestItemCreatedAt: string | null;
  /** True when the cycle predates the evidence that would make it trustworthy. */
  incomplete: boolean;
  reasons: string[];
}

export function censusCoverage(
  items: readonly PlaidItemFact[],
  transitions: readonly PlaidItemTransition[],
  cycle: BillingCycle,
): CensusCoverage {
  const billable = items.filter(isBillableItem);
  const retirementEvidenceFrom = transitions.length
    ? transitions.map((t) => iso(t.at)).sort()[0] : null;
  const earliestItemCreatedAt = billable.length
    ? billable.map((i) => iso(i.createdAt)).sort()[0] : null;

  const reasons: string[] = [];
  if (!retirementEvidenceFrom || retirementEvidenceFrom > cycle.start) {
    reasons.push(
      `no retirement evidence covers this cycle (transition ledger ${retirementEvidenceFrom ? `starts ${retirementEvidenceFrom}` : "is empty"}) — an Item retired before then is counted as if it were live`);
  }
  if (earliestItemCreatedAt && earliestItemCreatedAt > cycle.start) {
    reasons.push(
      `no surviving Item predates ${earliestItemCreatedAt}; any Item that existed in this cycle and has since been deleted from the table cannot be reconstructed, so the census is a LOWER BOUND`);
  }
  return { retirementEvidenceFrom, earliestItemCreatedAt, incomplete: reasons.length > 0, reasons };
}

// ── Pricing ──────────────────────────────────────────────────────────────────

/** Which reading of the cycle a figure was computed under. Always stated. */
export type CycleInterpretation = "presentDuringCycle" | "presentAtCycleEnd";

export interface PlaidCycleCost {
  cycle: BillingCycle;
  interpretation: CycleInterpretation;
  /** Estimated USD, or null when no evidenced rate covers the cycle. */
  usd: number | null;
  /** Item-months counted, by product. */
  itemMonths: Record<PlaidBillableProduct, number>;
  /** Item-months a rate did not cover — reported, never folded in at zero. */
  unpricedItemMonths: number;
  /** Item-months whose product could not be evidenced for this cycle. */
  unevidencedProductItemMonths: number;
  byEnvironment: { environment: string; itemMonths: number; usd: number | null }[];
  coverage: CensusCoverage;
}

/**
 * Price one cycle under one named interpretation.
 *
 * ⚠️ THE INTERPRETATION IS AN ARGUMENT, NOT A DEFAULT BURIED IN THE CODE. A
 * caller must choose, and the choice travels with the figure.
 */
export function priceCycle(
  items: readonly PlaidItemFact[],
  transitions: readonly PlaidItemTransition[],
  cycle: BillingCycle,
  interpretation: CycleInterpretation,
  opts: { today?: string; rates?: readonly PlaidRate[] } = {},
): PlaidCycleCost {
  const rates = opts.rates ?? PLAID_RATES;
  const rows = itemMonths(items, transitions, cycle, opts.today)
    .filter((r) => (interpretation === "presentAtCycleEnd" ? r.presentAtCycleEnd : r.presentDuringCycle));

  const counts: Record<PlaidBillableProduct, number> = { transactions: 0, investments: 0 };
  const byEnv = new Map<string, { itemMonths: number; usd: number | null }>();
  let usd: number | null = null;
  let unpriced = 0, unevidenced = 0;

  for (const r of rows) {
    counts[r.product] += 1;
    if (!r.productEvidenced) unevidenced += 1;
    const rate = plaidRateAt(r.product, cycle.start, rates);
    const e = byEnv.get(r.environment) ?? { itemMonths: 0, usd: null };
    e.itemMonths += 1;
    if (rate) {
      usd = (usd ?? 0) + rate.usdPerItemMonth;
      e.usd = (e.usd ?? 0) + rate.usdPerItemMonth;
    } else {
      unpriced += 1;
    }
    byEnv.set(r.environment, e);
  }

  return {
    cycle, interpretation, usd, itemMonths: counts,
    unpricedItemMonths: unpriced,
    unevidencedProductItemMonths: unevidenced,
    byEnvironment: [...byEnv.entries()]
      .map(([environment, v]) => ({ environment, ...v }))
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
    coverage: censusCoverage(items, transitions, cycle),
  };
}

/**
 * Both readings, side by side.
 *
 * ⚠️ THE HONEST SHAPE FOR A SURFACE. Where the two agree, the ambiguity is moot
 * and a single figure is safe to show. Where they diverge, showing one number
 * would imply billing knowledge this repository does not have — so the divergence
 * is returned rather than resolved.
 */
export function priceCycleBothReadings(
  items: readonly PlaidItemFact[],
  transitions: readonly PlaidItemTransition[],
  cycle: BillingCycle,
  opts: { today?: string; rates?: readonly PlaidRate[] } = {},
) {
  const during = priceCycle(items, transitions, cycle, "presentDuringCycle", opts);
  const atEnd  = priceCycle(items, transitions, cycle, "presentAtCycleEnd", opts);
  return { during, atEnd, agree: during.usd === atEnd.usd
    && during.itemMonths.transactions === atEnd.itemMonths.transactions
    && during.itemMonths.investments === atEnd.itemMonths.investments };
}
