/**
 * lib/connections/valuation-coverage.ts
 *
 * The read behind valuation-coverage.core.ts. Same traversal as
 * space-data-health.ts (SpaceAccountLink ACTIVE → live FinancialAccount), limited
 * to links that disclose a balance — an account in no total cannot explain where
 * a total's history starts. Read-only; dates and symbols only.
 */

import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { grantsBalanceDisclosure } from '@/lib/account-privacy';
import { deriveValuationCoverage, type ValuationCoverage } from './valuation-coverage.core';

type Client = Pick<PrismaClient, 'spaceAccountLink' | 'positionCoverage' | 'priceObservation'>;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function loadValuationCoverage(client: Client, spaceId: string): Promise<ValuationCoverage | null> {
  const links = await client.spaceAccountLink.findMany({
    where: { spaceId, status: 'ACTIVE', financialAccount: { deletedAt: null } },
    select: { visibilityLevel: true, financialAccountId: true },
  });
  const accountIds = links.filter((l) => grantsBalanceDisclosure(l.visibilityLevel)).map((l) => l.financialAccountId);
  if (!accountIds.length) return null;

  const coverage = await client.positionCoverage.findMany({
    where: { financialAccountId: { in: accountIds }, kind: { in: ['COMPLETE', 'PARTIAL'] }, coveredFromDate: { not: null } },
    select: { instrumentId: true, coveredFromDate: true, instrument: { select: { tickerSymbol: true } } },
  });
  if (!coverage.length) return null;

  const instrumentIds = [...new Set(coverage.map((c) => c.instrumentId))];
  const floors = await client.priceObservation.groupBy({
    by: ['instrumentId'], where: { instrumentId: { in: instrumentIds }, basis: 'RAW_CLOSE' }, _min: { date: true },
  });
  const priceFloors = new Map<string, string | null>(instrumentIds.map((id) => [id, null]));
  for (const f of floors) priceFloors.set(f.instrumentId, day(f._min.date));

  return deriveValuationCoverage(
    coverage.map((c) => ({ symbol: c.instrument.tickerSymbol ?? 'Asset', instrumentId: c.instrumentId, balanceFromISO: day(c.coveredFromDate) })),
    priceFloors,
  );
}
