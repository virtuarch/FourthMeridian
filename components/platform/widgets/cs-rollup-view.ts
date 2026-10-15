/**
 * components/platform/widgets/cs-rollup-view.ts  (BETA · Workstream W4 — CS per-user roll-up)
 *
 * The Customer Success customer list grows a per-user usage/cost line from the
 * W3 roll-up (BETA-PRODUCT-ANALYTICS-DESIGN.md §8: AI turns · est. USD · Items ·
 * last engaged · funnel stage). W3 extends `CustomerListRow`
 * (lib/platform/customer/customers.ts) concurrently, so the fields are typed
 * here as OPTIONAL and every absent one renders "—" with the column word still
 * visible: the branch compiles and renders honestly before W3 merges, and the
 * coordinator can verify the names at integration.
 *
 * THE FIELD NAMES ARE THE W4→W3 ASK (additive on CustomerListRow):
 *   aiTurns30d          number | null   chat turns (correlationId#turnIndex) with this userId, 30 d
 *   aiEstimatedUsd30d   number | null   rate-card ESTIMATE over chat + brief, 30 d; null = unpriced
 *   plaidItemCount      number | null   non-REVOKED Plaid Items (the connection cap counts these)
 *   lastEngagedAt       string | null   ISO of the newest engagement fact (never cron/webhook/operator)
 *   funnelStage         string | null   the furthest onboarding stage reached (key or label)
 *
 * Pure: no React, no clock (`nowMs` is injected for the relative time).
 */

import { relTime } from "./job-health-format";

export interface CustomerRollupFields {
  aiTurns30d?: number | null;
  aiEstimatedUsd30d?: number | null;
  plaidItemCount?: number | null;
  lastEngagedAt?: string | null;
  funnelStage?: string | null;
}

export const ROLLUP_ABSENT = "—";

export interface RollupCell { key: keyof CustomerRollupFields; word: string; value: string; absent: boolean }

const fmtUsd = (v: number) => `$${v.toFixed(2)}`;

/** The five cells, in the design's order, every word present whether or not the field arrived. */
export function rollupCells(c: CustomerRollupFields, nowMs: number): RollupCell[] {
  const count = (v: number | null | undefined) => (typeof v === "number" ? v.toLocaleString("en-US") : ROLLUP_ABSENT);
  return [
    { key: "aiTurns30d", word: "AI turns 30 d", value: count(c.aiTurns30d), absent: typeof c.aiTurns30d !== "number" },
    { key: "aiEstimatedUsd30d", word: "est. USD", value: typeof c.aiEstimatedUsd30d === "number" ? fmtUsd(c.aiEstimatedUsd30d) : ROLLUP_ABSENT, absent: typeof c.aiEstimatedUsd30d !== "number" },
    { key: "plaidItemCount", word: "Items", value: count(c.plaidItemCount), absent: typeof c.plaidItemCount !== "number" },
    { key: "lastEngagedAt", word: "last engaged", value: typeof c.lastEngagedAt === "string" ? relTime(c.lastEngagedAt, nowMs) : ROLLUP_ABSENT, absent: typeof c.lastEngagedAt !== "string" },
    { key: "funnelStage", word: "stage", value: typeof c.funnelStage === "string" && c.funnelStage.length > 0 ? c.funnelStage.toLowerCase().replace(/_/g, " ") : ROLLUP_ABSENT, absent: typeof c.funnelStage !== "string" || c.funnelStage.length === 0 },
  ];
}

/** One line: "AI turns 30 d 12 · est. USD $0.41 · Items 2 · last engaged 3h ago · stage first connection". */
export function rollupLine(c: CustomerRollupFields, nowMs: number): string {
  return rollupCells(c, nowMs).map((x) => `${x.word} ${x.value}`).join(" · ");
}

/** True when NO roll-up field arrived — the reader has not been extended yet. */
export function rollupAbsent(c: CustomerRollupFields): boolean {
  return rollupCells(c, 0).every((x) => x.absent);
}

export const ROLLUP_NOTE = "Usage and cost figures are 30-day rate-card ESTIMATES (estimate, not a bill); a dash means the list reader has not supplied that field.";
