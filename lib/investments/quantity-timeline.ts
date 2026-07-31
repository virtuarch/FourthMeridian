/**
 * lib/investments/quantity-timeline.ts
 *
 * V26-QUANTITY-1F — the quantity timeline read authority.
 *
 * ONE place that assembles the three inputs the arc built separately:
 *
 *   anchors       PositionObservation  (QUANTITY-1C)
 *   events        InvestmentEvent → normalized  (QUANTITY-1B)
 *   completeness  InvestmentEventCoverage  (QUANTITY-1E′)
 *
 * and produces a `QuantityTimeline` plus its `ReconciliationReport`.
 *
 * STRICTLY READ-ONLY. It writes nothing, mutates nothing, and calls no
 * provider. It is also, deliberately, not wired into valuation or snapshot
 * regeneration: an authority earns a consumer once it is trusted, and trust
 * here means a corpus in which coverage is actually recorded. Today the ledger
 * is empty until the next investment sync runs, so every pair still resolves to
 * UNKNOWN — correctly, and visibly.
 *
 * The window is a CALLER decision, as it is in 1C.1. This module never infers
 * one from the evidence it happens to hold, because a window derived from
 * evidence can never reveal that evidence is missing.
 */

import { db } from "@/lib/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  normalizeQuantityEvents, type NormalizedQuantityEvent,
} from "./quantity-event.core";
import {
  replayQuantityTimeline, UNKNOWN_EVENT_STREAM,
  type QuantityAnchor, type QuantityTimeline, type EventStreamCompleteness,
} from "./quantity-replay.core";
import {
  reconcileQuantityTimeline, type ReconciliationReport,
} from "./quantity-reconciliation.core";
import { eventStreamCompletenessForAccounts } from "./event-coverage";

type Client = PrismaClient | Prisma.TransactionClient;

const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface QuantityTimelineResult {
  financialAccountId: string;
  instrumentId:       string | null;
  /** For display only — never an identity. */
  tickerSymbol:       string | null;
  accountName:        string | null;
  timeline:           QuantityTimeline;
  reconciliation:     ReconciliationReport;
  eventStream:        EventStreamCompleteness;
}

export interface LoadQuantityTimelinesArgs {
  /** Restrict to these accounts. Omit for every account holding evidence. */
  financialAccountIds?: readonly string[];
  /** The REQUESTED interval — a caller decision, never inferred here. */
  windowFromISO:        string;
  windowToISO:          string;
  client?:              Client;
}

/**
 * Load every (account, instrument) timeline in the requested window.
 *
 * Deterministic: pairs are returned in sorted key order, and the underlying
 * replay is order-independent, so the same database state yields byte-identical
 * output.
 */
export async function loadQuantityTimelines(
  args: LoadQuantityTimelinesArgs,
): Promise<QuantityTimelineResult[]> {
  const client: Client = args.client ?? db;
  const { windowFromISO, windowToISO } = args;
  const accountFilter = args.financialAccountIds
    ? { in: [...new Set(args.financialAccountIds)] }
    : undefined;

  // ── Evidence ────────────────────────────────────────────────────────────
  // Soft-deleted and superseded rows are excluded here rather than downstream:
  // QUANTITY-1B counts what it is given, and handing it retracted rows would
  // put them in the audit as if they were live.
  const rawEvents = await client.investmentEvent.findMany({
    where: { ...(accountFilter ? { financialAccountId: accountFilter } : {}) },
    select: {
      id: true, financialAccountId: true, instrumentId: true, type: true, date: true,
      datetime: true, quantity: true, ratio: true, source: true, externalEventId: true,
      relatedInstrumentId: true, deletedAt: true, supersededById: true,
    },
  });
  const audit = normalizeQuantityEvents(rawEvents.map((r) => ({
    id: r.id, financialAccountId: r.financialAccountId, instrumentId: r.instrumentId,
    type: r.type, dateISO: iso(r.date),
    datetimeISO: r.datetime ? r.datetime.toISOString() : null,
    quantity: r.quantity, ratio: r.ratio, source: r.source,
    externalEventId: r.externalEventId, relatedInstrumentId: r.relatedInstrumentId,
    deletedAt: r.deletedAt, supersededById: r.supersededById,
  })));

  const positions = await client.positionObservation.findMany({
    where: {
      deletedAt: null, supersededById: null,
      ...(accountFilter ? { financialAccountId: accountFilter } : {}),
    },
    select: {
      id: true, financialAccountId: true, instrumentId: true, date: true, quantity: true,
      origin: true, completeness: true,
      instrument: { select: { tickerSymbol: true } },
      financialAccount: { select: { name: true } },
    },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });

  // ── Group by (account, instrument) ──────────────────────────────────────
  const eventsByPair = new Map<string, NormalizedQuantityEvent[]>();
  for (const e of audit.events) {
    const k = key(e.accountId, e.instrumentId);
    (eventsByPair.get(k) ?? eventsByPair.set(k, []).get(k)!).push(e);
  }
  const positionsByPair = new Map<string, typeof positions>();
  for (const p of positions) {
    const k = key(p.financialAccountId, p.instrumentId);
    (positionsByPair.get(k) ?? positionsByPair.set(k, []).get(k)!).push(p);
  }

  const pairKeys = [...new Set([...eventsByPair.keys(), ...positionsByPair.keys()])].sort();

  // ── Completeness, one round trip for every account involved ─────────────
  const accountIds = [...new Set(pairKeys.map((k) => k.split("|")[0]))];
  const completenessByAccount = await eventStreamCompletenessForAccounts(
    accountIds, windowFromISO, windowToISO, client,
  );

  // ── Assemble ────────────────────────────────────────────────────────────
  const out: QuantityTimelineResult[] = [];
  for (const k of pairKeys) {
    const [financialAccountId, rawInstrumentId] = k.split("|");
    const instrumentId = rawInstrumentId === "null" ? null : rawInstrumentId;
    const events = eventsByPair.get(k) ?? [];
    const pos = positionsByPair.get(k) ?? [];

    const anchors: QuantityAnchor[] = pos.map((p) => ({
      observationId: p.id,
      dateISO: iso(p.date),
      // PositionObservation.date is @db.Date — there is no instant evidence to
      // carry, and inventing one from createdAt would fabricate precedence.
      effectiveDateTimeISO: null,
      quantity: p.quantity,
      origin: p.origin,
      completeness: p.completeness ?? "unknown",
    }));

    const eventStream = completenessByAccount.get(financialAccountId) ?? UNKNOWN_EVENT_STREAM;

    const timeline = replayQuantityTimeline({
      instrumentId: instrumentId ?? "", accountId: financialAccountId,
      anchors, events, windowFromISO, windowToISO, eventStream,
    });
    const reconciliation = reconcileQuantityTimeline({ timeline, events });

    out.push({
      financialAccountId, instrumentId,
      tickerSymbol: pos[0]?.instrument?.tickerSymbol ?? null,
      accountName: pos[0]?.financialAccount?.name ?? null,
      timeline, reconciliation, eventStream,
    });
  }
  return out;
}

function key(accountId: string, instrumentId: string | null): string {
  return `${accountId}|${instrumentId ?? "null"}`;
}
