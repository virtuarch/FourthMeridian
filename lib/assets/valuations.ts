/**
 * lib/assets/valuations.ts   (RWA-2A — ASSET VALUATION HISTORY, server side)
 *
 * The ONE writer and reader of the manual-asset valuation ledger
 * (AssetValuation, append-only) and acquisition facts (ManualAssetProfile).
 * Every function takes the CALLER'S tenant transaction client — the routes keep
 * their own transaction, authorization and audit; this module only owns the
 * ledger rows, so each route changes by one call.
 *
 * ── Append-only, by construction ─────────────────────────────────────────────
 * This module only ever CREATES valuation rows; the tenant role has no UPDATE or
 * DELETE grant on AssetValuation at all (migration 20261015120000). A backdated
 * correction is a NEW row with an older effective date; a same-day correction is
 * a NEW row with the same effective date and a later recordedAt. The policy that
 * turns rows into anchors is lib/assets/valuation-series.core.ts.
 *
 * ── Modeled values never enter the ledger ────────────────────────────────────
 * Interpolated / carried values are computed at read time and returned with
 * their basis; nothing here persists them.
 *
 * ── Privacy ──────────────────────────────────────────────────────────────────
 * RLS admits any viewer of an ACTIVE link, BALANCE_ONLY included. A dated value
 * history discloses more than that tier allows, so `loadValuationHistory` serves
 * only the OWNER or a viewer holding a FULL link (the accounts detail route's
 * rule); anyone else gets `forbidden`, indistinguishable from not-found.
 *
 * Audit: none here. The routes own their audit rows, and financial values
 * (prices, valuations, dates) never enter audit metadata.
 */

import type { TenantClient } from "@/lib/db/tenant-context";
import {
  buildValuationSeries, describeModeledHistory, isoDateOf, latestAnchor, resolveAnchors,
  type Anchor, type ProfileFacts, type ResolvedAnchors, type ValuationPoint, type ValuationRow,
} from "./valuation-series.core";

const DATE = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Optional acquisition facts submitted with a new asset. */
export interface AcquisitionInput {
  acquisitionDate?:              string | null;
  purchasePrice?:                number | null;
  purchasePriceIsStartingValue?: boolean;
}

function hasAcquisitionFacts(a: AcquisitionInput | undefined): a is AcquisitionInput {
  return !!a && (a.acquisitionDate != null || a.purchasePrice != null || a.purchasePriceIsStartingValue === true);
}

/**
 * New asset: write its acquisition facts (when any were given) and its FIRST
 * recorded valuation. Called inside POST /api/accounts/manual's transaction,
 * after the FinancialAccount exists and its Space link is ACTIVE (the RLS
 * insert predicate needs a visible-or-owned account).
 */
export async function recordInitialValuation(tx: TenantClient, args: {
  financialAccountId: string;
  userId:             string;
  value:              number;
  currency:           string;
  effectiveDate:      string;
  acquisition?:       AcquisitionInput;
}): Promise<void> {
  if (hasAcquisitionFacts(args.acquisition)) {
    await tx.manualAssetProfile.create({
      data: {
        financialAccountId:           args.financialAccountId,
        acquisitionDate:              args.acquisition.acquisitionDate ? DATE(args.acquisition.acquisitionDate) : null,
        purchasePrice:                args.acquisition.purchasePrice ?? null,
        // A purchase price is entered in the asset's currency (the form says so).
        purchaseCurrency:             args.acquisition.purchasePrice != null ? args.currency : null,
        purchasePriceIsStartingValue: args.acquisition.purchasePriceIsStartingValue === true,
      },
    });
  }
  await tx.assetValuation.create({
    data: {
      financialAccountId: args.financialAccountId,
      effectiveDate:      DATE(args.effectiveDate),
      value:              args.value,
      currency:           args.currency,
      recordedByUserId:   args.userId,
    },
  });
}

/** Read the acquisition facts as the pure policy's input. */
export async function loadProfileFacts(tx: TenantClient, financialAccountId: string): Promise<ProfileFacts | null> {
  const p = await tx.manualAssetProfile.findUnique({
    where:  { financialAccountId },
    select: { acquisitionDate: true, purchasePrice: true, purchaseCurrency: true, purchasePriceIsStartingValue: true },
  });
  return p ? {
    acquisitionDate:              p.acquisitionDate ? isoDateOf(p.acquisitionDate) : null,
    purchasePrice:                p.purchasePrice,
    purchaseCurrency:             p.purchaseCurrency,
    purchasePriceIsStartingValue: p.purchasePriceIsStartingValue,
  } : null;
}

async function loadRows(tx: TenantClient, financialAccountId: string): Promise<ValuationRow[]> {
  const rows = await tx.assetValuation.findMany({
    where:   { financialAccountId },
    orderBy: [{ effectiveDate: "asc" }, { recordedAt: "asc" }],
    select:  { id: true, effectiveDate: true, value: true, currency: true, recordedAt: true },
  });
  return rows.map((r) => ({
    id: r.id, effectiveDate: isoDateOf(r.effectiveDate), value: r.value,
    currency: r.currency, recordedAt: r.recordedAt.toISOString(),
  }));
}

/**
 * Existing asset: APPEND one dated valuation and return the anchor today's
 * balance must equal (the latest-dated one — a backdated correction never
 * displaces a more recent valuation).
 *
 * A pre-RWA-2 asset has no ledger rows; its current balance was itself entered
 * by the user at `lastUpdated`. Before the first append that value is written
 * into the ledger AS WHAT IT WAS — dated and timestamped at `lastUpdated` — so
 * the new row extends its history instead of erasing it.
 */
export async function appendValuation(tx: TenantClient, args: {
  financialAccountId: string;
  userId:             string;
  value:              number;
  currency:           string;
  effectiveDate:      string;
  legacy:             { balance: number; lastUpdated: Date };
}): Promise<{ latest: Anchor }> {
  const existing = await tx.assetValuation.count({ where: { financialAccountId: args.financialAccountId } });
  if (existing === 0) {
    await tx.assetValuation.create({
      data: {
        financialAccountId: args.financialAccountId,
        effectiveDate:      DATE(isoDateOf(args.legacy.lastUpdated)),
        value:              args.legacy.balance,
        currency:           args.currency,
        recordedAt:         args.legacy.lastUpdated,
        recordedByUserId:   null, // entered before the ledger existed; author not recorded then
      },
    });
  }
  await tx.assetValuation.create({
    data: {
      financialAccountId: args.financialAccountId,
      effectiveDate:      DATE(args.effectiveDate),
      value:              args.value,
      currency:           args.currency,
      recordedByUserId:   args.userId,
    },
  });
  const resolved = resolveAnchors({
    currency:   args.currency,
    valuations: await loadRows(tx, args.financialAccountId),
    profile:    await loadProfileFacts(tx, args.financialAccountId),
    legacy:     null,
  });
  return { latest: latestAnchor(resolved)! };
}

/** The resolved history of one asset — anchors, superseded rows, the chart series. */
export interface ValuationHistory {
  accountId:   string;
  currency:    string;
  profile:     ProfileFacts | null;
  resolved:    ResolvedAnchors;
  series:      ValuationPoint[];
  modeled:     ReturnType<typeof describeModeledHistory>;
}

/** Resolve one asset's history from rows already loaded (shared by the read + AI). */
export function resolveHistory(args: {
  accountId: string; currency: string; rows: ValuationRow[]; profile: ProfileFacts | null;
  legacy: { balance: number; lastUpdated: Date }; today: string;
}): ValuationHistory {
  const resolved = resolveAnchors({
    currency:   args.currency,
    valuations: args.rows,
    profile:    args.profile,
    legacy:     args.rows.length === 0
      ? { balance: args.legacy.balance, currency: args.currency, lastUpdated: args.legacy.lastUpdated.toISOString() }
      : null,
  });
  return {
    accountId: args.accountId,
    currency:  args.currency,
    profile:   args.profile,
    resolved,
    series:    buildValuationSeries(resolved, args.today),
    modeled:   describeModeledHistory(resolved, args.today),
  };
}

/**
 * The privacy-gated read: the owner, or a viewer holding an ACTIVE FULL link in
 * a Space they can see (RLS scopes SpaceAccountLink to visible Spaces).
 */
export async function loadValuationHistory(tx: TenantClient, args: {
  financialAccountId: string; viewerUserId: string; today: string;
}): Promise<{ kind: "ok"; history: ValuationHistory } | { kind: "forbidden" }> {
  const fa = await tx.financialAccount.findUnique({
    where:  { id: args.financialAccountId },
    select: { id: true, ownerUserId: true, syncStatus: true, deletedAt: true, currency: true, balance: true, lastUpdated: true },
  });
  if (!fa || fa.deletedAt || fa.syncStatus !== "manual") return { kind: "forbidden" };
  if (fa.ownerUserId !== args.viewerUserId) {
    const full = await tx.spaceAccountLink.findFirst({
      where:  { financialAccountId: fa.id, status: "ACTIVE", visibilityLevel: "FULL" },
      select: { id: true },
    });
    if (!full) return { kind: "forbidden" };
  }
  return {
    kind: "ok",
    history: resolveHistory({
      accountId: fa.id, currency: fa.currency,
      rows:      await loadRows(tx, fa.id),
      profile:   await loadProfileFacts(tx, fa.id),
      legacy:    { balance: fa.balance, lastUpdated: fa.lastUpdated },
      today:     args.today,
    }),
  };
}

/** Bulk read for the AI accounts assembler: rows + profiles for many manual assets. */
export async function loadHistoriesFor(tx: TenantClient, accounts: {
  id: string; currency: string; balance: number; lastUpdated: Date;
}[], today: string): Promise<Map<string, ValuationHistory>> {
  const out = new Map<string, ValuationHistory>();
  if (accounts.length === 0) return out;
  const ids = accounts.map((a) => a.id);
  const [rows, profiles] = await Promise.all([
    tx.assetValuation.findMany({
      where:   { financialAccountId: { in: ids } },
      orderBy: [{ effectiveDate: "asc" }, { recordedAt: "asc" }],
      select:  { id: true, financialAccountId: true, effectiveDate: true, value: true, currency: true, recordedAt: true },
    }),
    tx.manualAssetProfile.findMany({
      where:  { financialAccountId: { in: ids } },
      select: { financialAccountId: true, acquisitionDate: true, purchasePrice: true, purchaseCurrency: true, purchasePriceIsStartingValue: true },
    }),
  ]);
  const rowsBy = new Map<string, ValuationRow[]>();
  for (const r of rows) {
    const list = rowsBy.get(r.financialAccountId) ?? [];
    list.push({ id: r.id, effectiveDate: isoDateOf(r.effectiveDate), value: r.value, currency: r.currency, recordedAt: r.recordedAt.toISOString() });
    rowsBy.set(r.financialAccountId, list);
  }
  const profBy = new Map(profiles.map((p) => [p.financialAccountId, {
    acquisitionDate:              p.acquisitionDate ? isoDateOf(p.acquisitionDate) : null,
    purchasePrice:                p.purchasePrice,
    purchaseCurrency:             p.purchaseCurrency,
    purchasePriceIsStartingValue: p.purchasePriceIsStartingValue,
  } satisfies ProfileFacts]));
  for (const a of accounts) {
    out.set(a.id, resolveHistory({
      accountId: a.id, currency: a.currency, rows: rowsBy.get(a.id) ?? [], profile: profBy.get(a.id) ?? null,
      legacy: { balance: a.balance, lastUpdated: a.lastUpdated }, today,
    }));
  }
  return out;
}
