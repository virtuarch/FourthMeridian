/**
 * lib/investments/holding-ownership.ts
 *
 * V26-S2-OWNERSHIP — ownership resolved PER HOLDING, i.e. per (account,
 * instrument), against the ONE ownership engine.
 *
 * ── Why a second binding, and not a second model ─────────────────────────────
 * `lib/prices/ownership-window.ts` resolves ownership per INSTRUMENT, and for
 * its consumer that is exactly right: the price archive is deployment-global, so
 * "over what span might anyone have held NVDA" is the correct question to ask
 * before buying NVDA closes. One fetch serves every holder.
 *
 * VALUATION asks a different question. It values a HOLDING — this account's
 * position in this instrument — and instrument-scoped ownership answers it with
 * the UNION of every account's evidence. Measured on the live corpus: `CUR:USD`
 * has direct evidence back to 2025-08-27 that exists ONLY as Robinhood's derived
 * cash rows, and the instrument-scoped window used it to license the LLC
 * account's cash as KNOWN OWNED on dates where that account had no evidence of
 * its own. One user's second brokerage licensing the first is the same class of
 * defect as today's holdings licensing 2023 — evidence crossing a boundary it
 * does not belong to.
 *
 * So: same core (`resolveOwnershipWindow`), same doctrine, same segment
 * vocabulary — a narrower scope for the evidence that feeds it. There is still
 * exactly one ownership engine.
 *
 * ── What licenses ownership, per pair ────────────────────────────────────────
 *   DIRECT    the first PositionObservation or InvestmentEvent FOR THIS PAIR
 *   POSSIBLE  the earlier of the account's creation and its first transaction —
 *             proof the container existed and was active. Also the provider
 *             floor where `licenseProviderFloor` allows it (unchanged doctrine,
 *             already per-pair in its own evidence).
 *   CLOSED    the first OBSERVED zero on or after the last positive evidence
 *
 * STRICTLY READ-ONLY: every statement is a SELECT.
 */

import { db } from "@/lib/db";
import { Prisma, type PrismaClient } from "@prisma/client";
import { toISODateUTC } from "@/lib/prices/config";
import {
  resolveOwnershipWindow,
  type OwnershipEvidence,
  type OwnershipResolution,
} from "@/lib/prices/ownership-window.core";
import {
  licenseProviderFloor,
  earliestPossibleBound,
  CORPORATE_ACTION_TYPES,
  TRANSFER_TYPES,
} from "@/lib/prices/provider-floor.core";

export type { OwnershipResolution };

type Client = PrismaClient | Prisma.TransactionClient;

/** The canonical key for one holding. Used everywhere a pair is mapped. */
export function holdingKey(financialAccountId: string, instrumentId: string): string {
  return `${financialAccountId}|${instrumentId}`;
}

/** Ownership for one holding, plus the evidence dates that produced it. */
export interface HoldingOwnership {
  financialAccountId: string;
  instrumentId:       string;
  resolution:         OwnershipResolution;
  /** First direct evidence for THIS pair; null when none. */
  earliestDirectISO:  string | null;
  /** Last date this pair was positively evidenced; null when never positive. */
  lastPositiveISO:    string | null;
  /** First OBSERVED zero on/after the last positive; null when never closed. */
  closedFromISO:      string | null;
}

/**
 * Resolve ownership for every (account, instrument) pair in the given accounts.
 *
 * Batched: four grouped statements regardless of pair count. `valuationToISO` is
 * the caller's ceiling — this module reads no clock, so a dry run and the run it
 * authorises can be handed the same ceiling and produce identical windows.
 */
export async function loadHoldingOwnership(
  financialAccountIds: readonly string[],
  valuationToISO:      string,
  client:              Client = db,
): Promise<Map<string, HoldingOwnership>> {
  const out = new Map<string, HoldingOwnership>();
  const accountIds = [...new Set(financialAccountIds)].sort();
  if (accountIds.length === 0) return out;

  // ── DIRECT + CLOSURE, per pair, in one pass over the observation spine ─────
  //
  // `lastPositive` and `firstZeroAfterLastPositive` are computed together
  // because the closure rule is defined in terms of the positive evidence it
  // follows: a zero BEFORE the position was ever held is an empty row, not a
  // disposal, and treating it as one would close a window that never opened.
  //
  // Only an OBSERVED zero closes. A DERIVED zero is the backward replay's own
  // arithmetic and must not be able to end a window the same replay's evidence
  // opened; an IMPORTED/USER_ASSERTED zero is a statement about a statement
  // date, which the checkpoint path already handles.
  const obsRows = await client.$queryRaw<Array<{
    financialAccountId: string; instrumentId: string;
    earliestObs: Date | null; lastPositive: Date | null; firstZeroAfter: Date | null;
  }>>`
    WITH pairs AS (
      SELECT DISTINCT "financialAccountId", "instrumentId"
      FROM "PositionObservation"
      WHERE "deletedAt" IS NULL AND "supersededById" IS NULL
        AND "financialAccountId" IN (${Prisma.join(accountIds)})
    ),
    positives AS (
      SELECT p."financialAccountId", p."instrumentId",
             MIN(o.date)::date AS "earliestObs",
             MAX(o.date) FILTER (WHERE o.quantity > 0)::date AS "lastPositive"
      FROM pairs p
      JOIN "PositionObservation" o
        ON o."financialAccountId" = p."financialAccountId"
       AND o."instrumentId"       = p."instrumentId"
       AND o."deletedAt" IS NULL AND o."supersededById" IS NULL
      GROUP BY 1, 2
    )
    SELECT v."financialAccountId", v."instrumentId", v."earliestObs", v."lastPositive",
           (SELECT MIN(z.date)::date FROM "PositionObservation" z
             WHERE z."financialAccountId" = v."financialAccountId"
               AND z."instrumentId"       = v."instrumentId"
               AND z.origin = 'OBSERVED'
               AND z.quantity = 0
               AND z."deletedAt" IS NULL AND z."supersededById" IS NULL
               AND (v."lastPositive" IS NULL OR z.date >= v."lastPositive")
           ) AS "firstZeroAfter"
    FROM positives v
  `;

  // Events also evidence a pair directly, and can predate any observation.
  const evtRows = await client.investmentEvent.groupBy({
    by: ["financialAccountId", "instrumentId"],
    where: {
      financialAccountId: { in: accountIds },
      instrumentId:       { not: null },
      deletedAt:          null,
      supersededById:     null,
    },
    _min: { date: true },
  });

  // ── POSSIBLE: the account's own activity floor ────────────────────────────
  const accountFloors = await client.$queryRaw<Array<{ id: string; possible: Date | null }>>`
    SELECT fa.id,
           LEAST(fa."createdAt"::date, COALESCE(tx."firstTx", fa."createdAt"::date)) AS possible
    FROM "FinancialAccount" fa
    LEFT JOIN (
      SELECT "financialAccountId", MIN(date) AS "firstTx"
      FROM "Transaction" WHERE "financialAccountId" IS NOT NULL GROUP BY 1
    ) tx ON tx."financialAccountId" = fa.id
    WHERE fa.id IN (${Prisma.join(accountIds)})
  `;
  const accountPossible = new Map<string, string>();
  for (const r of accountFloors) if (r.possible) accountPossible.set(r.id, toISODateUTC(r.possible));

  // ── PROVIDER FLOOR — unchanged doctrine, already per-pair evidence ─────────
  const corp = Prisma.join(CORPORATE_ACTION_TYPES.map((t) => Prisma.sql`${t}::"InvestmentEventType"`));
  const xfer = Prisma.join(TRANSFER_TYPES.map((t) => Prisma.sql`${t}::"InvestmentEventType"`));
  const floorRows = await client.$queryRaw<Array<{
    financialAccountId: string; instrumentId: string; providerFloor: Date | null;
    hasPositiveObservation: boolean; hasTransfer: boolean;
    hasCorporateAction: boolean; reconciliation: string | null; conflicted: boolean | null;
    openingQuantity: number | null; unexplainedOpeningQuantity: number | null;
    openingAnchorDate: Date | null; hasOpeningAnchor: boolean; eventCount: number | null;
    isCashEquivalent: boolean;
  }>>`
    WITH current_item AS (
      SELECT DISTINCT ON ("financialAccountId") "financialAccountId", "plaidItemId"
      FROM "InvestmentEventCoverage" ORDER BY "financialAccountId", "attemptedAt" DESC
    ),
    floor AS (
      SELECT c."financialAccountId", MIN(c."earliestReturnedDate")::date AS "providerFloor"
      FROM "InvestmentEventCoverage" c
      JOIN current_item ci
        ON ci."financialAccountId" = c."financialAccountId"
       AND ci."plaidItemId"        = c."plaidItemId"
      WHERE c.outcome = 'COMPLETE'
        AND c."paginationReconciled" = true
        AND c."earliestReturnedDate" IS NOT NULL
      GROUP BY 1
    ),
    pairs AS (
      SELECT DISTINCT "financialAccountId", "instrumentId"
      FROM "PositionObservation"
      WHERE "deletedAt" IS NULL AND "supersededById" IS NULL
        AND "financialAccountId" IN (${Prisma.join(accountIds)})
    )
    SELECT p."financialAccountId", p."instrumentId",
           f."providerFloor",
           COALESCE((SELECT bool_or(o.quantity > 0) FROM "PositionObservation" o
                     WHERE o."financialAccountId" = p."financialAccountId"
                       AND o."instrumentId" = p."instrumentId"
                       AND o.origin = 'OBSERVED'
                       AND o."deletedAt" IS NULL AND o."supersededById" IS NULL), false)
             AS "hasPositiveObservation",
           EXISTS (SELECT 1 FROM "InvestmentEvent" e WHERE e."financialAccountId" = p."financialAccountId"
                     AND e."instrumentId" = p."instrumentId" AND e."deletedAt" IS NULL
                     AND e."supersededById" IS NULL AND e.type IN (${xfer})) AS "hasTransfer",
           EXISTS (SELECT 1 FROM "InvestmentEvent" e WHERE e."financialAccountId" = p."financialAccountId"
                     AND e."instrumentId" = p."instrumentId" AND e."deletedAt" IS NULL
                     AND e."supersededById" IS NULL AND e.type IN (${corp})) AS "hasCorporateAction",
           pr.reconciliation::text AS reconciliation, pr.conflicted,
           pr."openingQuantity", pr."unexplainedOpeningQuantity",
           (pr."earliestDefensibleDate"::date - 1) AS "openingAnchorDate",
           EXISTS (SELECT 1 FROM "PositionObservation" oa
                     WHERE oa."financialAccountId" = p."financialAccountId"
                       AND oa."instrumentId" = p."instrumentId"
                       AND oa.origin = 'DERIVED' AND oa.source = 'reconstruction'
                       AND oa."deletedAt" IS NULL AND oa."supersededById" IS NULL
                       AND oa.date = (pr."earliestDefensibleDate"::date - 1)) AS "hasOpeningAnchor",
           pr."eventCount", i."isCashEquivalent"
    FROM pairs p
    JOIN "Instrument" i ON i.id = p."instrumentId"
    LEFT JOIN floor f ON f."financialAccountId" = p."financialAccountId"
    LEFT JOIN "PositionReconstruction" pr
      ON pr."financialAccountId" = p."financialAccountId" AND pr."instrumentId" = p."instrumentId"
  `;

  // ── Assemble, per pair ────────────────────────────────────────────────────
  const direct = new Map<string, string>();
  const lastPositive = new Map<string, string>();
  const closedFrom = new Map<string, string>();
  const pairs = new Set<string>();

  for (const r of obsRows) {
    const k = holdingKey(r.financialAccountId, r.instrumentId);
    pairs.add(k);
    if (r.earliestObs) direct.set(k, toISODateUTC(r.earliestObs));
    if (r.lastPositive) lastPositive.set(k, toISODateUTC(r.lastPositive));
    if (r.firstZeroAfter) closedFrom.set(k, toISODateUTC(r.firstZeroAfter));
  }
  for (const r of evtRows) {
    if (!r.instrumentId || !r._min.date) continue;
    const k = holdingKey(r.financialAccountId, r.instrumentId);
    pairs.add(k);
    const iso = toISODateUTC(r._min.date);
    const prior = direct.get(k);
    if (prior === undefined || iso < prior) direct.set(k, iso);
  }

  const licensedFloor = new Map<string, string[]>();
  for (const r of floorRows) {
    const k = holdingKey(r.financialAccountId, r.instrumentId);
    const decision = licenseProviderFloor({
      financialAccountId: r.financialAccountId,
      instrumentId:       r.instrumentId,
      providerFloorISO:   r.providerFloor ? toISODateUTC(r.providerFloor) : null,
      // Per-pair direct evidence — the whole point of this binding.
      earliestDirectISO:  direct.get(k) ?? null,
      hasPositiveObservation: r.hasPositiveObservation === true,
      hasTransfer:            r.hasTransfer === true,
      hasCorporateAction:     r.hasCorporateAction === true,
      reconciliation:             (r.reconciliation as "COMPLETE" | "PARTIAL" | "FAILED" | null) ?? null,
      conflicted:                 r.conflicted === true,
      openingQuantity:            r.openingQuantity,
      unexplainedOpeningQuantity: r.unexplainedOpeningQuantity,
      openingAnchorDateISO:       r.openingAnchorDate ? toISODateUTC(r.openingAnchorDate) : null,
      hasOpeningAnchor:           r.hasOpeningAnchor === true,
      eventCount:                 r.eventCount,
      isCashEquivalent:           r.isCashEquivalent === true,
    });
    if (!decision.licensed) continue;
    const list = licensedFloor.get(k) ?? [];
    list.push(decision.possibleFromISO);
    licensedFloor.set(k, list);
  }

  for (const k of pairs) {
    const [financialAccountId, instrumentId] = k.split("|");
    const evidence: OwnershipEvidence = {
      instrumentId,
      earliestDirectISO: direct.get(k) ?? null,
      earliestPossibleISO: earliestPossibleBound(
        accountPossible.get(financialAccountId) ?? null,
        licensedFloor.get(k) ?? [],
      ),
      valuationToISO,
      closedFromISO: closedFrom.get(k) ?? null,
    };
    out.set(k, {
      financialAccountId,
      instrumentId,
      resolution:        resolveOwnershipWindow(evidence),
      earliestDirectISO: evidence.earliestDirectISO,
      lastPositiveISO:   lastPositive.get(k) ?? null,
      closedFromISO:     evidence.closedFromISO ?? null,
    });
  }
  return out;
}
