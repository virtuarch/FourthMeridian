/**
 * components/platform/widgets/growth-funnel-view.ts  (GROWTH-1 · growth_funnel)
 *
 * The PURE presentation model for the Growth funnel surface. It turns one
 * `GrowthFunnel` payload into the ordered stage descriptors the surface renders,
 * and resolves which stage a selection refers to. No React, no DOM, no fetch —
 * so the invariants below are testable as plain assertions (house pattern:
 * npx tsx components/platform/widgets/growth-funnel.test.ts).
 *
 * ── THIS MODULE AUTHORS NO METRIC ─────────────────────────────────────────────
 * Every count and every conversion rate is READ from a named field on the
 * payload and carried through unchanged. `lib/platform/growth/growth.ts` owns the
 * arithmetic (`ratio()` there returns null on a zero denominator); this file only
 * decides order, labels, and which field each figure came from. There is
 * deliberately no function here whose name ends in `Rate`, and the guard asserts
 * it — the moment this module computes a conversion figure, the authority has
 * been forked.
 *
 * ── THE THREE STATES OF A CONVERSION FIGURE ───────────────────────────────────
 * Collapsing these would lose real information, so `rate` is a three-state value:
 *
 *   undefined  the authority provides NO conversion figure for this stage.
 *              True of every first stage (nothing precedes it) and of the two
 *              tail stages (`redeemedActivated`, `returning7`) for which
 *              `GrowthFunnel` computes no ratio at all. Renders as nothing.
 *   null       the authority DID compute a ratio and it was unavailable — a zero
 *              denominator. Renders as an em-dash, never 0%.
 *   number     an authority-provided ratio. Renders as a percentage.
 *
 * The distinction matters operationally: "this projection does not measure that"
 * is a different fact from "there was nothing to divide by".
 */

import type { GrowthFunnel } from "@/lib/platform/growth/growth";

/** The em-dash used for a computed-but-unavailable figure. Local by design: the
 *  platform-wide honesty helpers live in an in-flight file this slice must not
 *  couple to (see the slice notes), and one constant is not an abstraction. */
export const RATE_UNAVAILABLE = "—";

export type FunnelId = "beta" | "activation";

/** `undefined` = not measured by this projection · `null` = no denominator. */
export type StageRate = number | null | undefined;

/** One canonical stage, ready to render. */
export interface FunnelStageView {
  /** Stable selection identity, e.g. "beta.approved". Local to this surface. */
  id: string;
  funnelId: FunnelId;
  funnelLabel: string;
  /** The shipped label for this stage — unchanged from the previous surface. */
  label: string;
  count: number;
  rate: StageRate;
  /** The `GrowthFunnel` field this count was read from. Shown when inspecting. */
  field: string;
  /** The `GrowthFunnel` field the rate was read from, when one exists. */
  rateField?: string;
  /**
   * Other canonical outcomes of the SAME step, present on the same payload.
   * Only the beta approval step has any (`denied`, `pending`) — they are not
   * stages in the funnel, but they are where the difference went, and they come
   * from the authority rather than from inference.
   */
  siblings?: Array<{ label: string; count: number; field: string }>;
}

export interface FunnelView {
  id: FunnelId;
  label: string;
  /** Ordered stages. The first stage's count is the proportionality denominator. */
  stages: FunnelStageView[];
}

const BETA_LABEL = "Beta access";
const ACTIVATION_LABEL = "Activation";

/**
 * Project one payload into the two canonical funnels, in authority order.
 *
 * Stage labels are carried over verbatim from the previous `OpsGrowthWidget`
 * (Requested / Approved / Redeemed / Redeemed & active · Users / Verified /
 * Activated / Returning (7d)) so this slice introduces no new naming for
 * anything an operator has already learned.
 */
export function buildFunnelViews(funnel: GrowthFunnel): FunnelView[] {
  const { beta, activation } = funnel;

  return [
    {
      id: "beta",
      label: BETA_LABEL,
      stages: [
        {
          id: "beta.requested",
          funnelId: "beta",
          funnelLabel: BETA_LABEL,
          label: "Requested",
          count: beta.requested,
          rate: undefined, // first stage — nothing precedes it
          field: "beta.requested",
        },
        {
          id: "beta.approved",
          funnelId: "beta",
          funnelLabel: BETA_LABEL,
          label: "Approved",
          count: beta.approved,
          rate: beta.approveRate,
          field: "beta.approved",
          rateField: "beta.approveRate",
          siblings: [
            { label: "Denied", count: beta.denied, field: "beta.denied" },
            { label: "Pending", count: beta.pending, field: "beta.pending" },
          ],
        },
        {
          id: "beta.redeemed",
          funnelId: "beta",
          funnelLabel: BETA_LABEL,
          label: "Redeemed",
          count: beta.redeemed,
          rate: beta.redeemRate,
          field: "beta.redeemed",
          rateField: "beta.redeemRate",
        },
        {
          id: "beta.redeemedActivated",
          funnelId: "beta",
          funnelLabel: BETA_LABEL,
          label: "Redeemed & active",
          count: beta.redeemedActivated,
          rate: undefined, // GrowthFunnel computes no ratio for this stage
          field: "beta.redeemedActivated",
        },
      ],
    },
    {
      id: "activation",
      label: ACTIVATION_LABEL,
      stages: [
        {
          id: "activation.totalUsers",
          funnelId: "activation",
          funnelLabel: ACTIVATION_LABEL,
          label: "Users",
          count: activation.totalUsers,
          rate: undefined, // first stage
          field: "activation.totalUsers",
        },
        {
          id: "activation.verified",
          funnelId: "activation",
          funnelLabel: ACTIVATION_LABEL,
          label: "Verified",
          count: activation.verified,
          rate: activation.verifyRate,
          field: "activation.verified",
          rateField: "activation.verifyRate",
        },
        {
          id: "activation.activated",
          funnelId: "activation",
          funnelLabel: ACTIVATION_LABEL,
          label: "Activated",
          count: activation.activated,
          rate: activation.activationRate,
          field: "activation.activated",
          rateField: "activation.activationRate",
        },
        {
          id: "activation.returning7",
          funnelId: "activation",
          funnelLabel: ACTIVATION_LABEL,
          label: "Returning (7d)",
          count: activation.returning7,
          rate: undefined, // GrowthFunnel computes no ratio for this stage
          field: "activation.returning7",
        },
      ],
    },
  ];
}

/**
 * Bar width as a fraction of the funnel's first stage — PRESENTATIONAL ONLY.
 *
 * This is the one division in the module and it carries no business meaning: it
 * is the same number the count already states, expressed as a width so the eye
 * can see where the drop is. It is never labelled, never shown as a figure, and
 * returns null (⇒ no bar) when the denominator cannot support it, so an empty
 * funnel renders no bars rather than a row of full ones.
 */
export function barFraction(count: number, denominator: number | null | undefined): number | null {
  if (denominator == null || denominator <= 0) return null;
  return Math.min(1, Math.max(0, count / denominator));
}

/**
 * Format an authority-provided rate. The three-state contract, rendered:
 * `undefined` → null (render nothing at all) · `null` → em-dash · number → %.
 *
 * Returning null rather than an empty string forces the caller to decide what an
 * unmeasured stage looks like, instead of silently emitting a blank that reads
 * like a missing value.
 */
export function formatRate(rate: StageRate): string | null {
  if (rate === undefined) return null;
  if (rate === null) return RATE_UNAVAILABLE;
  return `${Math.round(rate * 100)}%`;
}

/** The selected stage, or null when nothing (or something unknown) is selected. */
export function findStage(views: FunnelView[], stageId: string | null): FunnelStageView | null {
  if (!stageId) return null;
  for (const v of views) {
    const hit = v.stages.find((s) => s.id === stageId);
    if (hit) return hit;
  }
  return null;
}

/**
 * The stages immediately either side of a selection, within its own funnel.
 * Adjacency is canonical order — it is where the difference in counts went, and
 * it is the only context the current projection can honestly supply.
 */
export function adjacentStages(
  views: FunnelView[],
  stageId: string,
): { previous: FunnelStageView | null; next: FunnelStageView | null } {
  for (const v of views) {
    const i = v.stages.findIndex((s) => s.id === stageId);
    if (i === -1) continue;
    return { previous: v.stages[i - 1] ?? null, next: v.stages[i + 1] ?? null };
  }
  return { previous: null, next: null };
}
