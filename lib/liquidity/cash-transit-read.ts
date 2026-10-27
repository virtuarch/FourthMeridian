/**
 * lib/liquidity/cash-transit-read.ts   (v2.7-P2 — cash in transit, SERVER READ)
 *
 * READ-ONLY. Gathers the recent outgoing transfer legs on a Space's cash
 * accounts and projects the EXISTING transfer authority's verdict onto each
 * (lib/transactions/transfer-resolution.ts resolveTransferAssessments — called,
 * never restructured). The classification and the wording live in the pure
 * ./cash-transit.ts; this file only routes reads. No writes, no balances, no
 * new matching rule.
 *
 * Scope and privacy:
 *   · Only checking / savings accounts linked ACTIVE into the Space at a
 *     transaction-detail-granting tier (TRANSACTION_DETAIL_VISIBILITY) — a
 *     BALANCE_ONLY member's transfers are never read or disclosed.
 *   · Only rows the event projection admits (eventProjectionWhere) inside the
 *     banking population, so a pending/posted twin is one event.
 *   · Only legs filed TRANSFER: a DEBT_PAYMENT already names a liability
 *     destination and is not cash in transit.
 *   · The projection carries no names, descriptors or transaction ids. A
 *     destination account id is present only when the authority's KD-15 gate
 *     left it visible to this Space.
 *
 * The client it reads through is a REQUIRED, leading parameter (RLS idiom).
 */

import "server-only";
import { FlowType, ShareStatus } from "@prisma/client";
import type { ReadClient } from "@/lib/db/tenant-context";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import { BANKING_POPULATION } from "@/lib/data/banking-population";
import { eventProjectionWhere } from "@/lib/transactions/event-projection";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";
import { ECONOMIC_DATE_MAX_LAG_DAYS } from "@/lib/transactions/economic-date";
import { EXTERNAL_MATURITIES } from "@/lib/transactions/transfer-maturation";
import { resolveTransferAssessments } from "@/lib/transactions/transfer-resolution";
import type { TransferCandidateRelationship } from "@/lib/transactions/RelationshipResolver";
import { CASH_TRANSIT_WINDOW_DAYS, type CashTransitLeg, type LegLifecycle } from "./cash-transit";

const DAY_MS = 24 * 60 * 60 * 1000;

const lifecycleOf = (r: { settlementState: string | null; pending: boolean; deletedAt: Date | null }): LegLifecycle | null => {
  const s = resolveLifecycle({ settlementState: r.settlementState, pending: r.pending, deletedAt: r.deletedAt }).state;
  return s === "PENDING" || s === "POSTED" ? s : null;
};

/** Project the authority's assessment onto the four answers the disclosure uses. */
export function projectTransferMatch(a: TransferCandidateRelationship | undefined, persistedCounterparty: boolean): CashTransitLeg["match"] {
  // A provider-persisted link names the destination account; the resolver skips
  // such rows (persisted links outrank it), and the leg itself is not loaded —
  // a destination exists, so the money is not missing.
  if (persistedCounterparty) return "AMBIGUOUS";
  if (!a) return "OTHER";
  if (a.persistableCounterparty && a.counterpartyAccountId) return "MATCHED";
  // ⚠️ EXTERNAL_DEPOSITORY_TRANSFER is NOT positive evidence that the money left
  // the household when no owned leg exists yet: Plaid files every generic
  // ACCOUNT_TRANSFER / SAVINGS movement as venue DEPOSITORY, so an internal
  // transfer whose destination has not credited yet derives exactly this leaf.
  // The authority itself says the external leaves are DERIVED, never stamped,
  // and must stay free to become internal when the real leg appears. Inside the
  // match window it is therefore "not yet matched", worded neutrally.
  if (a.maturity === "EXTERNAL_DEPOSITORY_TRANSFER" && a.reason === "EXTERNAL_TERMINAL") return "UNMATCHED";
  if (EXTERNAL_MATURITIES.has(a.maturity) || a.maturity === "CASH_MOVEMENT") return "EXTERNAL";
  if (a.reason === "NO_CANDIDATE" && a.unresolvedReason === "NO_COUNTERPART_EVIDENCE") return "UNMATCHED";
  if (a.status === "AMBIGUOUS" || a.status === "RESOLVED") return "AMBIGUOUS";
  return "OTHER";
}

export async function loadCashTransitLegs(
  client: ReadClient,
  { spaceId, now }: { spaceId: string; now: Date },
): Promise<CashTransitLeg[]> {
  const accounts = await client.financialAccount.findMany({
    where: {
      deletedAt: null,
      type: { in: ["checking", "savings"] },
      spaceAccountLinks: {
        some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } },
      },
    },
    select: { id: true },
  });
  const cashIds = accounts.map((a) => a.id);
  if (cashIds.length === 0) return [];

  // Gather on the POSTING column, padded by the economic-date lag (the same
  // starvation guard transfer-resolution applies); the real window is applied
  // to the economic date below.
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const windowStart = new Date(today - (CASH_TRANSIT_WINDOW_DAYS + 1) * DAY_MS);
  const gatherStart = new Date(windowStart.getTime() - ECONOMIC_DATE_MAX_LAG_DAYS * DAY_MS);
  const rows = await client.transaction.findMany({
    where: {
      AND: [
        { financialAccountId: { in: cashIds }, deletedAt: null, amount: { lt: 0 }, flowType: FlowType.TRANSFER, date: { gte: gatherStart } },
        BANKING_POPULATION,
        eventProjectionWhere(),
      ],
    },
    select: {
      id: true, financialAccountId: true, date: true, amount: true, currency: true, flowType: true,
      deletedAt: true, pending: true, settlementState: true, pfcDetailed: true, pfcPrimary: true,
      merchant: true, category: true, counterpartyType: true, description: true, economicDate: true,
      counterpartyAccountId: true, plaidTransactionId: true, transactionEventId: true,
    },
  });
  const recent = rows.filter((r) => (r.economicDate ?? r.date).getTime() >= windowStart.getTime());
  if (recent.length === 0) return [];

  // A pending observation whose posted successor is live is carried by that
  // successor — the same guard loadPendingEvidence applies.
  const pendingRefs = recent.filter((r) => r.pending && r.plaidTransactionId).map((r) => r.plaidTransactionId as string);
  const superseded = pendingRefs.length
    ? new Set((await client.transaction.findMany({
        where: { deletedAt: null, pendingTransactionRef: { in: pendingRefs } },
        select: { pendingTransactionRef: true },
      })).map((r) => r.pendingTransactionRef).filter((v): v is string => v !== null))
    : new Set<string>();

  const assessments = await resolveTransferAssessments(
    client,
    recent.map((r) => ({
      ...r,
      category: r.category as string | null,
      counterpartyType: r.counterpartyType as string | null,
      flowType: r.flowType as string | null,
    })),
    { spaceId },
  );

  // Lifecycle of each ESTABLISHED destination leg (one query).
  const destLegIds = [...assessments.values()]
    .filter((a) => a.persistableCounterparty && a.counterpartyAccountId && a.transactionId)
    .map((a) => a.transactionId as string);
  const destLegs = destLegIds.length
    ? new Map((await client.transaction.findMany({
        where: { id: { in: destLegIds } },
        select: { id: true, settlementState: true, pending: true, deletedAt: true },
      })).map((d) => [d.id, lifecycleOf(d)] as const))
    : new Map<string, LegLifecycle | null>();

  const out: CashTransitLeg[] = [];
  for (const r of recent) {
    const lifecycle = lifecycleOf(r);
    if (lifecycle === null || !r.financialAccountId) continue;
    const a = assessments.get(r.id);
    const match = projectTransferMatch(a, r.counterpartyAccountId != null);
    out.push({
      sourceAccountId: r.financialAccountId,
      amount:    r.amount,
      currency:  r.currency ?? null,
      date:      (r.economicDate ?? r.date).toISOString().slice(0, 10),
      lifecycle,
      superseded: r.pending && r.plaidTransactionId != null && superseded.has(r.plaidTransactionId),
      match,
      destination: match === "MATCHED" && a?.counterpartyAccountId
        ? { accountId: a.counterpartyAccountId, lifecycle: a.transactionId ? destLegs.get(a.transactionId) ?? null : null }
        : null,
    });
  }
  return out;
}
