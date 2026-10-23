/**
 * lib/prices/ownership-window.ts
 *
 * V26-PRICE-4 — the READ-ONLY I/O half of ownership resolution: gather the
 * evidence, hand it to the pure core (ownership-window.core.ts).
 *
 * Two bounds, from two different kinds of evidence:
 *
 *   DIRECT   first PositionObservation or InvestmentEvent for the instrument.
 *            Proof it was held — but dated when CAPTURE began, not when the
 *            asset was acquired.
 *   POSSIBLE the earliest date any account holding it could have held it:
 *            the account's creation date, or its first transaction, whichever is
 *            earlier. Not proof of holding THIS instrument — proof the container
 *            existed and was active, which is what makes earlier ownership
 *            possible rather than imagined.
 *
 * The gap between them is exactly the history a first-observation floor throws
 * away. Locally it is over three years for BTC: direct evidence starts 2026-07-19
 * while the wallet's transactions begin 2023-03-24. For the equities it is
 * nothing at all — their accounts were created AFTER their first observations, so
 * the possible bound adds no span and the window is entirely KNOWN. Both
 * outcomes fall out of the same rule.
 *
 * ── V26-PRICE-4B — the PROVIDER FLOOR, a third source for the POSSIBLE bound ──
 * That last sentence was the defect. `FinancialAccount.createdAt` is when WE
 * learned of the account, not when it existed, and investment accounts carry no
 * Transaction rows — so for a freshly connected brokerage the POSSIBLE bound
 * collapses onto the first observation and licenses nothing. A position
 * demonstrably held and later SOLD therefore read as UNKNOWN prehistory for
 * every day before connection.
 *
 * The provider's own corpus says more than our ingestion date. Where it covers a
 * span COMPLETELY (every page fetched, count reconciled) and the corrected
 * backward replay still lands on a POSITIVE unexplained opening — units that
 * existed before anything the corpus can explain — that opening must predate the
 * corpus, so ownership from the corpus floor is POSSIBLE. Never KNOWN: nothing
 * dates the holding to those days.
 *
 * V26-PRICE-4C — a later BUY does NOT disprove a positive opening; it changes the
 * quantity from its own date forward. So an acquiring event is no longer a
 * blanket refusal. What replaces it is stronger: the licensed interval must
 * actually RESOLVE to the opening quantity, which it does only once the
 * reconstruction has published its OPENING ANCHOR. See provider-floor.core.ts.
 *
 * The floor is `MIN(earliestReturnedDate)` over that account's COMPLETE,
 * pagination-reconciled coverage rows, restricted to ONE CONTINUOUS PROVIDER
 * IDENTITY (the plaidItem of the account's most recent attempt), so a replaced
 * or unrelated item can never widen it. Never `requestedFromDate` (a rolling
 * 24-month window computed from `now`, which would drift daily), never the
 * connection date, never a per-instrument first event.
 *
 * CASH IS EXCLUDED. `licenseProviderFloor` refuses `isCashEquivalent` outright:
 * cash arrives through deposits, withdrawals and trade settlement routed by
 * AMOUNT rather than quantity, so "no acquiring event" is not a meaningful
 * statement about it. See provider-floor.core.ts.
 *
 * Whether a floor may be used at all is decided by the pure predicate in
 * provider-floor.core.ts. This module only gathers its evidence. There is still
 * exactly one ownership engine: resolveOwnershipWindow.
 *
 * STRICTLY READ-ONLY: every statement is a SELECT.
 */

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { toISODateUTC } from "./config";
import {
  resolveOwnershipWindow,
  type OwnershipEvidence,
  type OwnershipResolution,
} from "./ownership-window.core";
import {
  licenseProviderFloor,
  earliestPossibleBound,
  CORPORATE_ACTION_TYPES,
  TRANSFER_TYPES,
} from "./provider-floor.core";

/**
 * Resolve ownership windows for a set of instruments, all against one valuation
 * ceiling. Batched: three grouped queries regardless of instrument count.
 *
 * `valuationToISO` is supplied by the caller — this module reads no clock, so a
 * dry run and the run it authorises can be given the identical ceiling and
 * produce identical windows.
 */
export async function loadOwnershipWindows(
  instrumentIds:  readonly string[],
  valuationToISO: string,
): Promise<Map<string, OwnershipResolution>> {
  const out = new Map<string, OwnershipResolution>();
  const ids = [...new Set(instrumentIds)].sort();
  if (ids.length === 0) return out;

  // ── DIRECT: first position observation / investment event ─────────────────
  const [obs, evt] = await Promise.all([
    db.positionObservation.groupBy({
      by: ["instrumentId"],
      where: { instrumentId: { in: ids }, deletedAt: null },
      _min: { date: true },
    }),
    db.investmentEvent.groupBy({
      by: ["instrumentId"],
      where: { instrumentId: { in: ids } },
      _min: { date: true },
    }),
  ]);
  const direct = new Map<string, string>();
  for (const row of [...obs, ...evt]) {
    const d = row._min.date;
    // InvestmentEvent.instrumentId is nullable — an unattributable event bounds nothing.
    if (!d || row.instrumentId === null) continue;
    const iso = toISODateUTC(d);
    const prior = direct.get(row.instrumentId);
    if (prior === undefined || iso < prior) direct.set(row.instrumentId, iso);
  }

  // ── POSSIBLE: earliest activity of any account that has held the instrument ─
  // One raw query: the accounts are found through PositionObservation, then the
  // earlier of account creation and the account's first transaction is taken.
  const possibleRows = await db.$queryRaw<Array<{ instrumentId: string; possible: Date | null }>>`
    SELECT po."instrumentId" AS "instrumentId",
           MIN(LEAST(fa."createdAt"::date, COALESCE(tx."firstTx", fa."createdAt"::date))) AS possible
    FROM "PositionObservation" po
    JOIN "FinancialAccount" fa ON fa.id = po."financialAccountId"
    LEFT JOIN (
      SELECT "financialAccountId", MIN(date) AS "firstTx"
      FROM "Transaction" WHERE "financialAccountId" IS NOT NULL GROUP BY 1
    ) tx ON tx."financialAccountId" = fa.id
    WHERE po."deletedAt" IS NULL
      AND po."instrumentId" IN (${Prisma.join(ids)})
    GROUP BY 1
  `;

  const possible = new Map<string, string>();
  for (const row of possibleRows) {
    if (row.possible) possible.set(row.instrumentId, toISODateUTC(row.possible));
  }

  // ── V26-PRICE-4B — PROVIDER FLOOR, per (account, instrument) ───────────────
  // One grouped query gathering exactly the evidence licenseProviderFloor reads.
  // `floor` restricts to ONE continuous provider identity: the plaidItem of the
  // account's most recent coverage attempt, so a replaced item cannot widen it.
  const corp = Prisma.join(CORPORATE_ACTION_TYPES.map((t) => Prisma.sql`${t}::"InvestmentEventType"`));
  const xfer = Prisma.join(TRANSFER_TYPES.map((t) => Prisma.sql`${t}::"InvestmentEventType"`));
  const floorRows = await db.$queryRaw<Array<{
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
        AND "instrumentId" IN (${Prisma.join(ids)})
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
           pr.reconciliation::text AS reconciliation,
           pr.conflicted,
           pr."openingQuantity",
           pr."unexplainedOpeningQuantity",
           -- V26-PRICE-4C — where an opening anchor would live, and whether the
           -- reconstruction has actually published one there.
           (pr."earliestDefensibleDate"::date - 1) AS "openingAnchorDate",
           EXISTS (SELECT 1 FROM "PositionObservation" oa
                     WHERE oa."financialAccountId" = p."financialAccountId"
                       AND oa."instrumentId" = p."instrumentId"
                       AND oa.origin = 'DERIVED' AND oa.source = 'reconstruction'
                       AND oa."deletedAt" IS NULL AND oa."supersededById" IS NULL
                       AND oa.date = (pr."earliestDefensibleDate"::date - 1)) AS "hasOpeningAnchor",
           pr."eventCount",
           i."isCashEquivalent"
    FROM pairs p
    JOIN "Instrument" i ON i.id = p."instrumentId"
    LEFT JOIN floor f ON f."financialAccountId" = p."financialAccountId"
    LEFT JOIN "PositionReconstruction" pr
      ON pr."financialAccountId" = p."financialAccountId" AND pr."instrumentId" = p."instrumentId"
  `;

  // A licensed floor contributes one more POSSIBLE candidate; it can only make
  // the bound earlier, and never earlier than the floor itself.
  const licensedByInstrument = new Map<string, string[]>();
  for (const r of floorRows) {
    const decision = licenseProviderFloor({
      financialAccountId: r.financialAccountId,
      instrumentId:       r.instrumentId,
      providerFloorISO:   r.providerFloor ? toISODateUTC(r.providerFloor) : null,
      earliestDirectISO:  direct.get(r.instrumentId) ?? null,
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
    const list = licensedByInstrument.get(r.instrumentId) ?? [];
    list.push(decision.possibleFromISO);
    licensedByInstrument.set(r.instrumentId, list);
  }

  for (const instrumentId of ids) {
    const evidence: OwnershipEvidence = {
      instrumentId,
      earliestDirectISO:   direct.get(instrumentId) ?? null,
      earliestPossibleISO: earliestPossibleBound(
        possible.get(instrumentId) ?? null,
        licensedByInstrument.get(instrumentId) ?? [],
      ),
      valuationToISO,
    };
    out.set(instrumentId, resolveOwnershipWindow(evidence));
  }
  return out;
}
