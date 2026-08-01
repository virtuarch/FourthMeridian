/**
 * lib/investments/event-coverage.ts
 *
 * V26-QUANTITY-1E′ — the DB binding for the ingestion-coverage authority.
 * READ-ONLY: it never writes. Writes belong to the ingest path, which is the
 * only place that knows what was asked for and what came back.
 *
 * This is the authoritative source `EventStreamCompleteness` never had. Before
 * it, every caller of QUANTITY-1C.1 had to declare UNKNOWN, which meant no
 * multi-day interval was ever defensible and `ABSOLUTE_COMPLETE` was
 * unreachable on real data.
 */

import { db } from "@/lib/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  eventStreamCompletenessFor, type CoverageRecord,
} from "./event-coverage.core";
import type { EventStreamCompleteness } from "./quantity-replay.core";

type Client = PrismaClient | Prisma.TransactionClient;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Coverage for one account over one interval.
 *
 * Returns UNKNOWN when nothing is recorded — never a guess. That default is
 * what makes a missing write safe: absent evidence withholds claims rather than
 * licensing them.
 */
export async function eventStreamCompletenessForAccount(
  financialAccountId: string,
  requestedFromISO: string,
  requestedToISO: string,
  client: Client = db,
): Promise<EventStreamCompleteness> {
  const rows = await client.investmentEventCoverage.findMany({
    where: { financialAccountId },
    select: { requestedFromDate: true, requestedToDate: true, outcome: true, fetchedCount: true, earliestReturnedDate: true },
    orderBy: [{ requestedFromDate: "asc" }, { id: "asc" }],
  });
  return eventStreamCompletenessFor({
    records: rows.map(toRecord), requestedFromISO, requestedToISO,
  });
}

/**
 * Coverage for many accounts in one round trip.
 *
 * Every requested id appears in the result — an account with no rows maps to
 * UNKNOWN rather than being absent, so a caller iterating the map cannot
 * silently skip the accounts it knows least about.
 */
export async function eventStreamCompletenessForAccounts(
  financialAccountIds: readonly string[],
  requestedFromISO: string,
  requestedToISO: string,
  client: Client = db,
): Promise<Map<string, EventStreamCompleteness>> {
  const ids = [...new Set(financialAccountIds)];
  const out = new Map<string, EventStreamCompleteness>();
  if (ids.length === 0) return out;

  const rows = await client.investmentEventCoverage.findMany({
    where: { financialAccountId: { in: ids } },
    select: {
      financialAccountId: true, requestedFromDate: true, requestedToDate: true,
      outcome: true, fetchedCount: true, earliestReturnedDate: true,
    },
    orderBy: [{ requestedFromDate: "asc" }, { id: "asc" }],
  });

  const byAccount = new Map<string, CoverageRecord[]>();
  for (const r of rows) {
    const list = byAccount.get(r.financialAccountId) ?? byAccount.set(r.financialAccountId, []).get(r.financialAccountId)!;
    list.push(toRecord(r));
  }
  for (const id of ids.sort()) {
    out.set(id, eventStreamCompletenessFor({
      records: byAccount.get(id) ?? [], requestedFromISO, requestedToISO,
    }));
  }
  return out;
}

function toRecord(r: {
  requestedFromDate: Date; requestedToDate: Date; outcome: string; fetchedCount: number;
  earliestReturnedDate: Date | null;
}): CoverageRecord {
  return {
    requestedFromISO: iso(r.requestedFromDate),
    requestedToISO: iso(r.requestedToDate),
    outcome: r.outcome,
    fetchedCount: r.fetchedCount,
    earliestReturnedISO: r.earliestReturnedDate ? iso(r.earliestReturnedDate) : null,
  };
}
