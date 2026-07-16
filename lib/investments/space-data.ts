/**
 * lib/investments/space-data.ts  (PCS-1A · PCS-1B · PCS-1D)
 *
 * THE canonical read contract for the Investments workspace — the Investments
 * analogue of `lib/connections/space-data.ts`. ONE public composition loader over
 * slices split by TIME and never cross-derived (the PCS-1 invariant):
 *
 *   loadInvestmentsSpaceData(scope, options) → InvestmentsSpaceData             (PCS-1D)
 *     the single orchestrator. It composes the canonical slices — it computes none
 *     of them:
 *       • current    → getCurrentPositions() (A10-at-today seam)                 (PCS-1A)
 *       • historical → getInvestmentsTimeMachine() = A10, VERBATIM (opt-in)      (PCS-1B)
 *       • activity   → historical.flows re-surfaced (canonical PeriodFlows)      (PCS-1C)
 *       • trust      → buildInvestmentsTrustSummary(historical)                  (PCS-1C)
 *   loadInvestmentsHistory(args) → HistoricalPortfolio                          (PCS-1B)
 *     the A10 binding under its contract name, still exported for the /time-machine
 *     route (JSON byte-identical). As-of / compare / period flows / reconciliation
 *     live ONLY here; the composition loader reuses this SAME binding.
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
 * Pure assembly (current shape + allocation, and the four-slice composition) lives
 * in ./space-data-core; this binding only gathers the reads (positions + names +
 * the optional A10 result) and hands them to the pure assemblers.
 */

import { SpaceType, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import { DIGITAL_ASSET_ACCOUNT_TYPES } from "@/lib/account-classifier";
import {
  getCurrentPositions,
  type CurrentPositionsScope,
  type CurrentPositionsOptions,
} from "./current-positions";
import { getInvestmentsTimeMachine } from "./investments-time-machine";
import {
  assembleCurrentPortfolio,
  assembleInvestmentsSpaceData,
} from "./space-data-core";
import type { InvestmentsSpaceData } from "./space-data-core";
import { investmentsScopeDivergence, type ScopeDivergenceDisclosure } from "./scope-divergence";

export type {
  CurrentPortfolio,
  HistoricalPortfolio,
  InvestmentsSpaceData,
} from "./space-data-core";

// ── HISTORICAL (PCS-1B) ──────────────────────────────────────────────────────
// The canonical historical loader is the A10 Time Machine binding under its
// contract name — a NAMED delegation, not a second authority (it computes no
// value, price, FX, quantity, flow, or completeness math of its own). It returns
// the A10 result VERBATIM. Args = getInvestmentsTimeMachine's resolved
// { spaceId | financialAccountId, asOf, compareTo }, owned by the Perspective Shell.
// The composition loader below reuses this SAME binding for the historical slice,
// so the /investments/space-data route serves the A10 result unchanged.
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
 * HIST-1D — the shared-Space scope disclosure for an Investments read. Reads only
 * the Space type + a COUNT of ACTIVE investment/digital-asset links whose
 * visibility withholds per-item detail (the accounts counted in whole-Space wealth
 * but excluded from the member-facing detailEligible scope), then delegates the
 * copy to the pure `investmentsScopeDivergence`. Returns null when it cannot apply
 * (single-account read, personal Space, or no reduced-visibility investment link),
 * so the disclosure surfaces ONLY where the divergence is real. It reads no
 * balances/positions and changes no visibility rule — a pure transparency read.
 */
async function resolveScopeDivergence(
  client: Client,
  scope:  CurrentPositionsScope,
): Promise<ScopeDivergenceDisclosure | null> {
  if (!("spaceId" in scope)) return null; // a single-account read has no cross-account divergence to explain
  const spaceId = scope.spaceId;

  const space = await client.space.findUnique({ where: { id: spaceId }, select: { type: true } });
  if (!space || space.type !== SpaceType.SHARED) return null;

  const redactedInvestmentAccountCount = await client.spaceAccountLink.count({
    where: {
      spaceId,
      status: "ACTIVE",
      // Investment + digital-asset accounts only — non-investment links carry no
      // positions, so their visibility never causes an investments divergence.
      financialAccount: { deletedAt: null, type: { in: ["investment", ...DIGITAL_ASSET_ACCOUNT_TYPES] } },
      // Withholds per-item detail = NOT in the canonical detail-visibility set (the
      // exact predicate account-scope.ts uses to build the detailEligible scope).
      visibilityLevel: { notIn: TRANSACTION_DETAIL_VISIBILITY },
    },
  });

  return investmentsScopeDivergence({ isSharedSpace: true, redactedInvestmentAccountCount });
}

/**
 * When set, the workspace read ALSO loads the A10 historical view and derives its
 * `activity` + `trust` slices from it. `asOf`/`compareTo` are the Perspective
 * Shell's resolved dates; omit this to get a current-only read. Kept separate from
 * the current seam's own injected `asOf` clock (CurrentPositionsOptions.asOf) so
 * the two time axes never collide.
 */
export interface InvestmentsHistoryRequest {
  asOf:       string;
  compareTo?: string | null;
}

export interface LoadInvestmentsSpaceDataOptions extends CurrentPositionsOptions {
  history?: InvestmentsHistoryRequest;
}

/**
 * THE single public Investments workspace loader (PCS-1D). ORCHESTRATION ONLY — it
 * performs no financial computation, no reduction, no translation. It:
 *   1. calls the canonical CURRENT loader   (getCurrentPositions → assembleCurrentPortfolio),
 *   2. calls the canonical HISTORICAL loader (getInvestmentsTimeMachine = A10) when
 *      `options.history` is supplied,
 *   3. delegates to the pure `assembleInvestmentsSpaceData`, which re-surfaces
 *      ACTIVITY (historical.flows) and builds TRUST (buildInvestmentsTrustSummary)
 *      off that ONE A10 result.
 *
 * Every consumer that needs any mix of current holdings, A10, activity, allocation,
 * completeness, concentration, or trust reads it through this one contract instead
 * of assembling the graph itself. Accepts the same scope/options as
 * getCurrentPositions (injected `asOf` clock + `client`), plus the optional
 * `history` request for the A10 slice.
 */
export async function loadInvestmentsSpaceData(
  scope:    CurrentPositionsScope,
  options?: LoadInvestmentsSpaceDataOptions,
): Promise<InvestmentsSpaceData> {
  const client = options?.client ?? db;

  // The current positions read and the (independent) scope-divergence read run in
  // parallel, so the disclosure adds no latency to the workspace load.
  const [positions, scopeDivergence] = await Promise.all([
    getCurrentPositions(scope, options),
    resolveScopeDivergence(client, scope),
  ]);
  const accountIds = [...new Set(positions.rows.map((r) => r.accountId))];
  const accountNames = await resolveAccountNames(client, accountIds);
  const current = assembleCurrentPortfolio(positions, accountNames);

  // Historical slice through the SAME A10 binding the /time-machine route uses —
  // scoped identically to the current read, so both views cover the same accounts.
  const historical = options?.history
    ? await getInvestmentsTimeMachine({
        ...scope,
        asOf:      options.history.asOf,
        compareTo: options.history.compareTo ?? null,
        client,
      })
    : null;

  const data = assembleInvestmentsSpaceData({ current, historical });
  // Attach the disclosure (HIST-1D) only when it applies — it is a currency-agnostic
  // transparency note, not a slice the pure assembler computes.
  return scopeDivergence ? { ...data, scopeDivergence } : data;
}
