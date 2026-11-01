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
import { IS_TOKEN_INSTRUMENT, NOT_TOKEN_INSTRUMENT, WALLET_TOKEN_POSITION_SOURCE } from '@/lib/crypto/token-asset';

type Client = Pick<PrismaClient, 'spaceAccountLink' | 'positionCoverage' | 'priceObservation' | 'positionObservation'>;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function loadValuationCoverage(client: Client, spaceId: string): Promise<ValuationCoverage | null> {
  const links = await client.spaceAccountLink.findMany({
    where: { spaceId, status: 'ACTIVE', financialAccount: { deletedAt: null } },
    select: { visibilityLevel: true, financialAccountId: true },
  });
  const accountIds = links.filter((l) => grantsBalanceDisclosure(l.visibilityLevel)).map((l) => l.financialAccountId);
  if (!accountIds.length) return null;

  const coverage = await client.positionCoverage.findMany({
    // NATIVE licences only — a token's licence is not a ticker-named limit (tokens: below).
    where: { financialAccountId: { in: accountIds }, kind: { in: ['COMPLETE', 'PARTIAL'] }, coveredFromDate: { not: null }, instrument: NOT_TOKEN_INSTRUMENT },
    select: { instrumentId: true, coveredFromDate: true, instrument: { select: { tickerSymbol: true } } },
  });
  const tokensTrackedFromISO = await pricedTokensTrackedFrom(client, accountIds);
  if (!coverage.length) return deriveValuationCoverage([], new Map(), tokensTrackedFromISO);

  const instrumentIds = [...new Set(coverage.map((c) => c.instrumentId))];
  const floors = await client.priceObservation.groupBy({
    by: ['instrumentId'], where: { instrumentId: { in: instrumentIds }, basis: 'RAW_CLOSE' }, _min: { date: true },
  });
  const priceFloors = new Map<string, string | null>(instrumentIds.map((id) => [id, null]));
  for (const f of floors) priceFloors.set(f.instrumentId, day(f._min.date));

  return deriveValuationCoverage(
    coverage.map((c) => ({ symbol: c.instrument.tickerSymbol ?? 'Asset', instrumentId: c.instrumentId, balanceFromISO: day(c.coveredFromDate) })),
    priceFloors,
    tokensTrackedFromISO,
  );
}

/**
 * TOKEN HOLDINGS (PR-A) — the first day a token that has EVER been priced was
 * observed in these accounts. Unpriced tokens never contribute value, so they
 * never need a disclosure. Dates only.
 */
async function pricedTokensTrackedFrom(client: Client, accountIds: string[]): Promise<string | null> {
  const firsts = await client.positionObservation.groupBy({
    by: ['instrumentId'],
    where: { financialAccountId: { in: accountIds }, source: WALLET_TOKEN_POSITION_SOURCE, supersededById: null, deletedAt: null, instrument: IS_TOKEN_INSTRUMENT },
    _min: { date: true },
  });
  if (!firsts.length) return null;
  const priced = new Set((await client.priceObservation.groupBy({
    by: ['instrumentId'], where: { instrumentId: { in: firsts.map((f) => f.instrumentId) } }, _min: { date: true },
  })).map((p) => p.instrumentId));
  // SPL TOKEN HISTORY — a token whose history is LICENSED is included from its
  // licensed start, not from when capture began (the reconstructed days count).
  const licensed = new Map((await client.positionCoverage.findMany({
    where: { financialAccountId: { in: accountIds }, instrumentId: { in: firsts.map((f) => f.instrumentId) }, kind: { in: ['COMPLETE', 'PARTIAL'] }, coveredFromDate: { not: null } },
    select: { instrumentId: true, coveredFromDate: true },
  })).map((c) => [c.instrumentId, day(c.coveredFromDate)]));
  return firsts.filter((f) => priced.has(f.instrumentId))
    .map((f) => { const obs = day(f._min.date); const lic = licensed.get(f.instrumentId) ?? null; return lic && obs && lic < obs ? lic : obs; })
    .filter((d): d is string => d !== null).sort()[0] ?? null;
}
