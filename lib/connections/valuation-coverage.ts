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
import { IS_TOKEN_INSTRUMENT, NOT_TOKEN_INSTRUMENT, TOKEN_ALIAS_PROVIDER, WALLET_TOKEN_POSITION_SOURCE } from '@/lib/crypto/token-asset';
import { reconstructedTokenValuation, tokenCloseGaps, tokenHeldWindow, type ReconstructedTokenValuation } from '@/lib/crypto/token-valuation.core';
import { loadTokenCloseFacts, loadTokenHeldSpans } from '@/lib/crypto/token-held-spans';
import { coverageFromRow, licensedInterval } from '@/lib/crypto/position-coverage';

type Client = Pick<PrismaClient, 'spaceAccountLink' | 'positionCoverage' | 'priceObservation' | 'positionObservation' | 'instrumentAlias'>;

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
  const tok = await pricedTokenDisclosure(client, accountIds);
  const { trackedFromISO: tokensTrackedFromISO, pricesFromISO: tokenPricesFromISO } = tok;
  const tokenValuation = { notValuedYet: tok.notValuedYet, withoutMarket: tok.withoutMarket, valuedUntilEarlier: tok.valuedUntilEarlier, valuedUntilRange: tok.valuedUntilRange, valuedWithGaps: tok.valuedWithGaps, gapsToISO: tok.gapsToISO, excluded: tok.excluded };
  if (!coverage.length) return deriveValuationCoverage([], new Map(), tokensTrackedFromISO, tokenPricesFromISO, tokenValuation);

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
    tokenPricesFromISO,
    tokenValuation,
  );
}

/**
 * TOKEN HOLDINGS (PR-A) — the first day a token that has EVER been priced was
 * observed in these accounts (from its licensed start when its history is
 * licensed — SPL / ERC-20 history): token value is included from there.
 *
 * LICENSED TOKEN HISTORY (PR #122 review B1) — every token with licensed
 * reconstructed history in these accounts, HELD NOW OR LONG SINCE EXITED (a
 * token sold before capture began has no observation at all, so it is read
 * from its licence, never from `firsts`), classified by the one rule
 * (token-valuation.core `reconstructedTokenValuation`):
 *   · VALUED_FROM_LATER — priced only from inside its held period; `pricesFromISO`
 *     is the latest such first close (F4: limiting, as native's later price floor);
 *   · NEVER_HELD — no positive balance ever: not counted at all (F2);
 *   · NOT_VALUED_YET — counted and disclosed (and the wallet is never complete);
 *   · NO_MARKET — a legitimate unpriced holding: counted and disclosed (never valued, never zero);
 *   · VALUED_WITH_GAPS — interior held days no close serves (delta F3): counted, and the latest
 *     such day carried so the chart discloses it only when its window reaches back over a gap;
 *   · EXCLUDED — explicitly classified (spam / non-economic): counted APART, never mixed with the above.
 * Dates and counts only.
 */
async function pricedTokenDisclosure(client: Client, accountIds: string[]): Promise<{
  trackedFromISO: string | null; pricesFromISO: string | null; notValuedYet: number; withoutMarket: number; valuedUntilEarlier: number; valuedUntilRange: { fromISO: string | null; toISO: string } | null; valuedWithGaps: number; gapsToISO: string | null; excluded: number;
}> {
  const [firsts, licensedRows] = await Promise.all([
    client.positionObservation.groupBy({
      by: ['instrumentId'],
      where: { financialAccountId: { in: accountIds }, source: WALLET_TOKEN_POSITION_SOURCE, supersededById: null, deletedAt: null, instrument: IS_TOKEN_INSTRUMENT },
      _min: { date: true },
    }),
    client.positionCoverage.findMany({
      where: { financialAccountId: { in: accountIds }, kind: { in: ['COMPLETE', 'PARTIAL'] }, coveredFromDate: { not: null }, instrument: IS_TOKEN_INSTRUMENT },
      select: { instrumentId: true, coveredFromDate: true, coveredToDate: true, kind: true, caveats: true, source: true, financialAccountId: true },
    }),
  ]);
  // A licence that licenses nothing (an open edge, a blocking caveat) speaks for no day.
  const live = licensedRows.filter((r) => licensedInterval(coverageFromRow(r)) !== null);
  const licensed = new Map<string, string>();
  for (const c of live) {
    const f = day(c.coveredFromDate)!;
    const prev = licensed.get(c.instrumentId);
    if (!prev || f < prev) licensed.set(c.instrumentId, f);
  }
  if (!firsts.length && !licensed.size) return { trackedFromISO: null, pricesFromISO: null, notValuedYet: 0, withoutMarket: 0, valuedUntilEarlier: 0, valuedUntilRange: null, valuedWithGaps: 0, gapsToISO: null, excluded: 0 };
  const firstIds = firsts.map((f) => f.instrumentId);
  const licensedIds = [...licensed.keys()];
  const [everPriced, closeFacts, aliases] = await Promise.all([
    firstIds.length ? client.priceObservation.groupBy({ by: ['instrumentId'], where: { instrumentId: { in: firstIds } }, _min: { date: true } }) : [],
    // B1 / S1 / delta F3 — first, last and every historical close: RAW_CLOSE only.
    loadTokenCloseFacts(client as never, licensedIds),
    licensedIds.length ? client.instrumentAlias.findMany({ where: { instrumentId: { in: licensedIds }, provider: TOKEN_ALIAS_PROVIDER }, select: { instrumentId: true, metadata: true } }) : [],
  ]);
  const priced = new Set(everPriced.map((p) => p.instrumentId));
  const trackedFromISO = firsts.filter((f) => priced.has(f.instrumentId))
    .map((f) => { const obs = day(f._min.date); const lic = licensed.get(f.instrumentId) ?? null; return lic && obs && lic < obs ? lic : obs; })
    .filter((d): d is string => d !== null).sort()[0] ?? null;
  const meta = new Map(aliases.map((a) => [a.instrumentId, a.metadata]));
  // F2/F4 — per (account, token): when it was actually held; never-held tokens count nowhere.
  const held = await loadTokenHeldSpans(client as never, accountIds, licensedIds);
  const RANK: Record<ReconstructedTokenValuation, number> = { NOT_VALUED_YET: 7, VALUED_FROM_LATER: 6, VALUED_UNTIL_EARLIER: 5, NO_MARKET: 4, VALUED_WITH_GAPS: 3, EXCLUDED: 2, VALUED: 1, NEVER_HELD: 0 };
  const worst = new Map<string, ReconstructedTokenValuation>();
  // Delta F3 — the latest unserved interior held day of any token, so the chart
  // says so only when its window reaches back over a gap.
  let gapsToISO: string | null = null;
  for (const r of live) {
    const licence = licensedInterval(coverageFromRow(r))!;
    const cf = closeFacts.get(r.instrumentId);
    const facts = { licence, held: held.get(`${r.financialAccountId}|${r.instrumentId}`) ?? null, closesFromISO: cf?.fromISO ?? null, closesToISO: cf?.toISO ?? null, closeDatesISO: cf?.datesISO ?? [] };
    const v = reconstructedTokenValuation(facts, meta.get(r.instrumentId));
    if (v === 'VALUED_WITH_GAPS') {
      const w = tokenHeldWindow(facts)!;
      const last = tokenCloseGaps(facts.closeDatesISO, w.fromISO, w.toISO).at(-1)?.toISO ?? null;
      if (last && (gapsToISO === null || last > gapsToISO)) gapsToISO = last;
    }
    const prev = worst.get(r.instrumentId);
    if (!prev || RANK[v] > RANK[prev]) worst.set(r.instrumentId, v);
  }
  let notValuedYet = 0, withoutMarket = 0, valuedUntilEarlier = 0, valuedWithGaps = 0, excluded = 0;
  let valuedUntilRange: { fromISO: string | null; toISO: string } | null = null;
  const pricedFrom: string[] = [];
  for (const [id, v] of worst) {
    if (v === 'NOT_VALUED_YET') notValuedYet++;
    else if (v === 'NO_MARKET') withoutMarket++;
    else if (v === 'VALUED_FROM_LATER') pricedFrom.push(closeFacts.get(id)!.fromISO);
    else if (v === 'VALUED_UNTIL_EARLIER') {
      valuedUntilEarlier++;
      const cf = closeFacts.get(id)!;
      if (!valuedUntilRange || cf.toISO < valuedUntilRange.toISO) valuedUntilRange = { fromISO: cf.fromISO, toISO: cf.toISO };
    }
    else if (v === 'VALUED_WITH_GAPS') valuedWithGaps++;
    else if (v === 'EXCLUDED') excluded++;
  }
  return { trackedFromISO, pricesFromISO: pricedFrom.sort().at(-1) ?? null, notValuedYet, withoutMarket, valuedUntilEarlier, valuedUntilRange, valuedWithGaps, gapsToISO: valuedWithGaps ? gapsToISO : null, excluded };
}
