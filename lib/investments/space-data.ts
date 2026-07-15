/**
 * lib/investments/space-data.ts  (PCS-1A · PCS-1B)
 *
 * THE canonical read contract for the Investments workspace — the Investments
 * analogue of `lib/connections/space-data.ts`. Two loaders, split by TIME and
 * never cross-derived (the PCS-1 invariant):
 *
 *   CURRENT    → loadInvestmentsSpaceData(scope, options) → { current }   (PCS-1A)
 *                sourced EXCLUSIVELY from getCurrentPositions() (A10-at-today seam).
 *   HISTORICAL → loadInvestmentsHistory(args)             → HistoricalPortfolio (PCS-1B)
 *                = getInvestmentsTimeMachine() — the A10 Time Machine, VERBATIM.
 *                As-of / compare / period flows / reconciliation live ONLY here.
 *
 * Historical truth belongs EXCLUSIVELY to A10; the historical loader is that binding
 * under its contract name and reuses NONE of the current-position DTOs. No surface
 * may reach a historical portfolio through the current seam, and the current view is
 * never derived from the Time Machine (see space-data-core.ts). `space-data-historical.test.ts`
 * pins this in code.
 *
 * ── The CURRENT loader (PCS-1A) ──────────────────────────────────────────────
 * One loader, one ownership boundary: the only place the current portfolio view is
 * assembled, sourcing current truth EXCLUSIVELY from `getCurrentPositions()` (the
 * A10-at-today seam, visibility enforced inside it). It never touches the A10 Time
 * Machine and never reads the legacy `Holding` model — parity with AI (holdings
 * assembler) and data Export, which already read the same seam, is by shared
 * source, not convention.
 *
 * The only read this adds beyond the seam is a lightweight FinancialAccount NAME
 * lookup (for the by-account allocation axis), resolving the display name in the
 * canonical order (displayName ?? officialName ?? plaidName ?? name — the exact
 * order lib/data/accounts.ts and lib/connections/space-data.ts use). It reads no
 * balances, credit limits, visibility tiers, or valuations of its own — every
 * figure in the contract comes from the seam or a pure reduce of its rows.
 *
 * Pure assembly (shape + allocation) lives in ./space-data-core; this binding only
 * gathers the two inputs (positions + names) and hands them in.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import {
  getCurrentPositions,
  type CurrentPositionsScope,
  type CurrentPositionsOptions,
} from "./current-positions";
import { assembleCurrentPortfolio } from "./space-data-core";
import type { InvestmentsSpaceData } from "./space-data-core";

export type {
  CurrentPortfolio,
  HistoricalPortfolio,
  InvestmentsSpaceData,
} from "./space-data-core";

// ── HISTORICAL (PCS-1B) ──────────────────────────────────────────────────────
// The canonical historical loader is the A10 Time Machine binding under its
// contract name — a NAMED delegation, not a second authority (it computes no
// value, price, FX, quantity, flow, or completeness math of its own). Returning
// the A10 result VERBATIM keeps the /investments/time-machine route JSON — and so
// the client hook — byte-identical. Args = getInvestmentsTimeMachine's resolved
// { spaceId | financialAccountId, asOf, compareTo }, owned by the Perspective Shell.
export {
  getInvestmentsTimeMachine as loadInvestmentsHistory,
} from "./investments-time-machine";
export type {
  GetInvestmentsTimeMachineArgs as LoadInvestmentsHistoryArgs,
} from "./investments-time-machine";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * accountId → canonical display name, for the by-account allocation axis. Scoped
 * to the ids that actually appear in the current positions — no portfolio read,
 * just names. An id with no row simply resolves to its fallback in computeAllocation.
 */
async function resolveAccountNames(
  client:     Client,
  accountIds: string[],
): Promise<Record<string, string>> {
  if (accountIds.length === 0) return {};
  const rows = await client.financialAccount.findMany({
    where:  { id: { in: accountIds } },
    select: { id: true, name: true, displayName: true, officialName: true, plaidName: true },
  });
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.id] = r.displayName ?? r.officialName ?? r.plaidName ?? r.name;
  }
  return out;
}

/**
 * THE canonical Investments Space loader (current-state). Reads the canonical
 * current positions for the scope, resolves account names for the by-account
 * axis, and composes the `current` contract. Accepts the same scope/options as
 * getCurrentPositions (including the injected `asOf` clock and `client` for
 * determinism / tests).
 */
export async function loadInvestmentsSpaceData(
  scope:    CurrentPositionsScope,
  options?: CurrentPositionsOptions,
): Promise<InvestmentsSpaceData> {
  const client = options?.client ?? db;

  const positions = await getCurrentPositions(scope, options);
  const accountIds = [...new Set(positions.rows.map((r) => r.accountId))];
  const accountNames = await resolveAccountNames(client, accountIds);

  return { current: assembleCurrentPortfolio(positions, accountNames) };
}
