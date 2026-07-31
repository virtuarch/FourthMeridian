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

  for (const instrumentId of ids) {
    const evidence: OwnershipEvidence = {
      instrumentId,
      earliestDirectISO:   direct.get(instrumentId) ?? null,
      earliestPossibleISO: possible.get(instrumentId) ?? null,
      valuationToISO,
    };
    out.set(instrumentId, resolveOwnershipWindow(evidence));
  }
  return out;
}
