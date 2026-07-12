/**
 * lib/investments/investment-event-ingest.ts
 *
 * A3-3 — provider ingestion for canonical InvestmentEvents. Fetches up to the
 * Plaid-supported 24-month window via investmentsTransactionsGet, maps each
 * transaction through the pure stage-1 adapter, resolves accounts + instruments
 * through the ratified repository paths, and persists append-only canonical
 * rows — WITHOUT touching Holding, PositionObservation, Cash Flow, Liquidity,
 * Wealth, or the UI.
 *
 * Dark and best-effort: gated behind INVESTMENT_EVENTS_ENABLED; every call site
 * wraps it so an ingestion failure never fails a holdings refresh or connection
 * creation. Dedupe by [source, externalEventId]; a restated row (material fields
 * differ) appends a corrected row and supersedes the old one — raw facts are
 * never mutated in place. CANCEL rows persist as their own canonical rows;
 * cancel_transaction_id (deprecated) is ignored; no reconstruction here.
 */

import type { InvestmentTransaction, Security } from "plaid";
import { ProviderType, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { withPlaidRetry } from "@/lib/plaid/retry";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { getPlaidErrorCode, plaidErrorSummary } from "@/lib/plaid/errors";
import { resolveInstrumentForPlaidSecurity } from "@/lib/investments/instrument-resolver";
import {
  mapPlaidInvestmentTransactionToEvent,
  type MappedInvestmentEvent,
} from "@/lib/investments/plaid-investment-events";
import {
  investmentReconstructionEnabled,
  repairReconstructionForAccount,
} from "@/lib/investments/reconstruction-runner";
import { captureSecurityPrices, securityPriceCapturesEnabled } from "@/lib/prices/capture";

type Client = PrismaClient | Prisma.TransactionClient;

const PAGE_SIZE = 500;

/** Kill switch — independent of INVESTMENT_OBSERVATIONS_ENABLED. */
export function investmentEventsEnabled(): boolean {
  return process.env.INVESTMENT_EVENTS_ENABLED === "true";
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 24-month request window ending today (Plaid's supported historical depth). */
export function computeIngestWindow(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), now.getUTCDate()));
  return { start: ymd(start), end: ymd(now) };
}

/** Material (raw + canonical) fields whose change marks a provider restatement.
 *  instrumentId is excluded — improving identity resolution is not a restatement. */
export interface StoredEventForCompare {
  type: string;
  date: Date | string;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fees: number | null;
  currency: string | null;
  providerType: string | null;
  providerSubtype: string | null;
  providerSecurityId: string | null;
  description: string | null;
}

export function isMaterialInvestmentEventChange(existing: StoredEventForCompare, mapped: MappedInvestmentEvent): boolean {
  const de = (existing.date instanceof Date ? existing.date.toISOString() : String(existing.date)).slice(0, 10);
  const dm = mapped.date.toISOString().slice(0, 10);
  return (
    existing.type !== mapped.type ||
    de !== dm ||
    existing.quantity !== mapped.quantity ||
    existing.price !== mapped.price ||
    existing.amount !== mapped.amount ||
    existing.fees !== mapped.fees ||
    existing.currency !== mapped.currency ||
    existing.providerType !== mapped.providerType ||
    existing.providerSubtype !== mapped.providerSubtype ||
    existing.providerSecurityId !== mapped.providerSecurityId ||
    existing.description !== mapped.description
  );
}

/** Deterministic total order for A4's backward walk: (date, externalEventId). */
export function sortInvestmentTransactions(txns: InvestmentTransaction[]): InvestmentTransaction[] {
  return [...txns].sort(
    (a, b) => a.date.localeCompare(b.date) || a.investment_transaction_id.localeCompare(b.investment_transaction_id),
  );
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface IngestMetrics {
  status: "ok" | "disabled" | "consent_required" | "not_ready" | "error";
  requested: number;          // total_investment_transactions reported by Plaid
  fetched: number;            // rows processed
  inserted: number;
  unchanged: number;
  corrected: number;          // restated rows appended + old superseded
  unknown: number;            // canonical type UNKNOWN
  unresolvedInstrument: number;
  unmappedAccount: number;
  skipped: number;
  failed: number;
}

function emptyMetrics(status: IngestMetrics["status"]): IngestMetrics {
  return { status, requested: 0, fetched: 0, inserted: 0, unchanged: 0, corrected: 0, unknown: 0, unresolvedInstrument: 0, unmappedAccount: 0, skipped: 0, failed: 0 };
}

// ─── Ingestion ────────────────────────────────────────────────────────────────

export interface IngestParams {
  accessToken: string;
  /** Internal PlaidItem.id — for sync-issue context only (never the token). */
  plaidItemId?: string;
  now: Date;
  client?: Client;
}

/**
 * Ingest investment events for one Plaid Item. Never throws for expected Plaid
 * conditions (consent / PRODUCT_NOT_READY) — returns a status instead. Callers
 * still wrap in try/catch (best-effort contract).
 */
export async function ingestInvestmentEvents(params: IngestParams): Promise<IngestMetrics> {
  const client = params.client ?? db;
  const metrics = emptyMetrics("ok");
  const { start, end } = computeIngestWindow(params.now);

  // Dynamic import so this module (and its pure helpers/tests) loads without the
  // Plaid client's module-load env validation — the client is only needed here.
  const { plaidClient } = await import("@/lib/plaid/client");

  // ── Fetch (paginated) ────────────────────────────────────────────────────
  const all: InvestmentTransaction[] = [];
  const securitiesById: Record<string, Security> = {};
  try {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const res = await withPlaidRetry(
        () => plaidClient.investmentsTransactionsGet({
          access_token: params.accessToken,
          start_date: start,
          end_date: end,
          options: { count: PAGE_SIZE, offset },
        }),
        "investmentsTransactionsGet",
      );
      metrics.requested = res.data.total_investment_transactions;
      for (const s of res.data.securities) securitiesById[s.security_id] = s;
      all.push(...res.data.investment_transactions);
      if (all.length >= metrics.requested || res.data.investment_transactions.length === 0) break;
    }
  } catch (err) {
    const code = getPlaidErrorCode(err);
    if (code === "ADDITIONAL_CONSENT_REQUIRED") return emptyMetrics("consent_required");
    if (code === "PRODUCT_NOT_READY") return emptyMetrics("not_ready");
    console.warn(`[investment-events] fetch failed for item ${params.plaidItemId ?? "?"} (non-fatal): ${plaidErrorSummary(err)}`);
    await recordSyncIssue({ kind: "UPSERT_ERROR", plaidItemId: params.plaidItemId ?? null, detail: { stage: "investment-events-fetch", error: plaidErrorSummary(err) } });
    return { ...emptyMetrics("error"), failed: 1 };
  }

  // ── Persist (stable order) ───────────────────────────────────────────────
  const accountCache = new Map<string, string | null>();
  // A4 bounded-repair inputs: (account → instruments touched by new/corrected
  // events) + whether a cash-only event was touched. Only inserted/corrected
  // rows change a walk; unchanged rows never trigger a repair.
  const affected = new Map<string, { instrumentIds: Set<string>; cash: boolean }>();
  // A8-2 — resolved instrumentId → its Security, for same-day close-price capture
  // from the investment-transactions securities payload (the second capture flow).
  const priceSecurityByInstrument = new Map<string, Security>();
  for (const txn of sortInvestmentTransactions(all)) {
    metrics.fetched++;
    try {
      const faId = await resolveFinancialAccountId(client, txn.account_id, accountCache);
      if (!faId) {
        metrics.unmappedAccount++;
        metrics.skipped++;
        await recordSyncIssue({ kind: "MISSING_ACCOUNT", plaidItemId: params.plaidItemId ?? null, plaidAccountId: txn.account_id, detail: { stage: "investment-events", externalEventId: txn.investment_transaction_id } });
        continue;
      }

      const instrumentId = await resolveInstrument(client, txn, securitiesById, faId, metrics, params.plaidItemId);
      if (instrumentId && txn.security_id) {
        const sec = securitiesById[txn.security_id];
        if (sec) priceSecurityByInstrument.set(instrumentId, sec);
      }
      const mapped = mapPlaidInvestmentTransactionToEvent(txn);
      if (mapped.type === "UNKNOWN") metrics.unknown++;

      const outcome = await persistPlaidEvent(client, faId, instrumentId, mapped);
      if (outcome === "inserted") metrics.inserted++;
      else if (outcome === "unchanged") metrics.unchanged++;
      else metrics.corrected++;

      if (outcome === "inserted" || outcome === "corrected") {
        const a = affected.get(faId) ?? { instrumentIds: new Set<string>(), cash: false };
        if (instrumentId) a.instrumentIds.add(instrumentId);
        else a.cash = true;
        affected.set(faId, a);
      }
    } catch (rowErr) {
      metrics.failed++;
      console.warn(`[investment-events] row ${txn.investment_transaction_id} failed (non-fatal): ${rowErr instanceof Error ? rowErr.message : rowErr}`);
    }
  }

  // ── A4 bounded-repair hook ────────────────────────────────────────────────
  // Late/corrected events that land on an already-reconstructed position rerun
  // that position's walk (bounded to the affected instruments). Flag-gated and
  // best-effort — a repair failure never fails ingestion.
  await maybeRepairReconstructions(client, affected, params.now, params.plaidItemId);

  // ── A8-2 same-day price capture hook ──────────────────────────────────────
  // Persist any defensibly dated close prices carried on this window's securities
  // payload (basis RAW_CLOSE, source "plaid"). Flag-gated (SECURITY_PRICES_ENABLED)
  // and best-effort/non-fatal — a price-archive failure never fails ingestion.
  if (securityPriceCapturesEnabled() && priceSecurityByInstrument.size > 0) {
    try {
      await captureSecurityPrices({
        securities: [...priceSecurityByInstrument].map(([instrumentId, security]) => ({ instrumentId, security })),
        now: params.now,
      });
    } catch (priceErr) {
      console.warn(`[investment-events] security price capture failed (non-fatal): ${priceErr instanceof Error ? priceErr.message : priceErr}`);
    }
  }

  return metrics;
}

/**
 * Fire bounded reconstruction repair for every account touched by new/corrected
 * events. No-op unless INVESTMENT_RECONSTRUCTION_ENABLED; each account is wrapped
 * non-fatal so a repair failure is logged and swallowed, never surfaced to the
 * refresh/ingestion caller.
 */
async function maybeRepairReconstructions(
  client: Client,
  affected: Map<string, { instrumentIds: Set<string>; cash: boolean }>,
  now: Date,
  plaidItemId?: string,
): Promise<void> {
  if (!investmentReconstructionEnabled() || affected.size === 0) return;
  for (const [financialAccountId, a] of affected) {
    try {
      await repairReconstructionForAccount({
        financialAccountId,
        affectedInstrumentIds: [...a.instrumentIds],
        affectedCash: a.cash,
        now,
        client,
      });
    } catch (err) {
      console.warn(`[investment-events] reconstruction repair for account ${financialAccountId} failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      await recordSyncIssue({ kind: "UPSERT_ERROR", plaidItemId: plaidItemId ?? null, detail: { stage: "reconstruction-repair", financialAccountId } });
    }
  }
}

async function resolveFinancialAccountId(client: Client, plaidAccountId: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(plaidAccountId)) return cache.get(plaidAccountId)!;
  // Canonical provider-account identity first (D2), legacy plaidAccountId fallback.
  const identity = await client.providerAccountIdentity.findFirst({
    where: { provider: ProviderType.PLAID, externalAccountId: plaidAccountId },
    select: { financialAccountId: true },
  });
  let faId = identity?.financialAccountId ?? null;
  if (!faId) {
    const legacy = await client.financialAccount.findUnique({ where: { plaidAccountId }, select: { id: true } });
    faId = legacy?.id ?? null;
  }
  cache.set(plaidAccountId, faId);
  return faId;
}

async function resolveInstrument(
  client: Client,
  txn: InvestmentTransaction,
  securitiesById: Record<string, Security>,
  faId: string,
  metrics: IngestMetrics,
  plaidItemId?: string,
): Promise<string | null> {
  if (!txn.security_id) return null; // cash-only row — routes by currency, not an unresolved failure
  const sec = securitiesById[txn.security_id];
  if (!sec) { metrics.unresolvedInstrument++; return null; } // raw providerSecurityId still persisted
  try {
    const r = await resolveInstrumentForPlaidSecurity(sec, { client, financialAccountId: faId });
    if (r.conflict) { metrics.unresolvedInstrument++; return null; } // event kept, providerSecurityId retained
    return r.instrumentId;
  } catch (err) {
    metrics.unresolvedInstrument++;
    console.warn(`[investment-events] instrument resolve failed for security ${txn.security_id} (non-fatal): ${err instanceof Error ? err.message : err}`);
    await recordSyncIssue({ kind: "UPSERT_ERROR", plaidItemId: plaidItemId ?? null, detail: { stage: "investment-events-instrument", securityId: txn.security_id } });
    return null;
  }
}

function eventData(faId: string, instrumentId: string | null, m: MappedInvestmentEvent) {
  return {
    financialAccountId: faId,
    instrumentId,
    type: m.type,
    date: m.date,
    datetime: m.datetime,
    quantity: m.quantity,
    price: m.price,
    amount: m.amount,
    fees: m.fees,
    currency: m.currency,
    source: m.source,
    externalEventId: m.externalEventId,
    providerType: m.providerType,
    providerSubtype: m.providerSubtype,
    providerSecurityId: m.providerSecurityId,
    description: m.description,
    mapperVersion: m.mapperVersion,
  };
}

/**
 * Idempotent persist keyed on [source, externalEventId]. New → insert; identical
 * → unchanged; material change → append corrected row (which takes over the key)
 * and supersede the old row (its externalEventId released to null, recoverable
 * via the supersededById chain). Never mutates raw facts in place.
 */
async function persistPlaidEvent(
  client: Client,
  faId: string,
  instrumentId: string | null,
  mapped: MappedInvestmentEvent,
): Promise<"inserted" | "unchanged" | "corrected"> {
  const existing = await client.investmentEvent.findUnique({
    where: { source_externalEventId: { source: mapped.source, externalEventId: mapped.externalEventId } },
    select: { id: true, type: true, date: true, quantity: true, price: true, amount: true, fees: true, currency: true, providerType: true, providerSubtype: true, providerSecurityId: true, description: true, instrumentId: true },
  });

  if (!existing) {
    await client.investmentEvent.create({ data: eventData(faId, instrumentId, mapped) });
    return "inserted";
  }

  if (!isMaterialInvestmentEventChange(existing, mapped)) {
    // Attach a now-resolvable instrument if the row was written before resolution
    // succeeded (identity improvement is not a restatement).
    if (instrumentId && existing.instrumentId == null) {
      await client.investmentEvent.update({ where: { id: existing.id }, data: { instrumentId } });
    }
    return "unchanged";
  }

  // Correction: append + supersede, releasing the unique key in a transaction so
  // two rows never hold the same [source, externalEventId] simultaneously.
  const run = async (tx: Client) => {
    const created = await tx.investmentEvent.create({ data: { ...eventData(faId, instrumentId, mapped), externalEventId: null } });
    await tx.investmentEvent.update({ where: { id: existing.id }, data: { externalEventId: null, supersededById: created.id } });
    await tx.investmentEvent.update({ where: { id: created.id }, data: { externalEventId: mapped.externalEventId } });
  };
  if ("$transaction" in client) await (client as PrismaClient).$transaction((tx) => run(tx));
  else await run(client);
  return "corrected";
}
