/**
 * lib/space-hero.ts
 *
 * Space Template Redesign — per-category hero definitions ("One Space,
 * One Lede"). Each chartable Space category maps to ONE primary metric
 * drawn from the Space's own SpaceSnapshot history (types/index.ts
 * Snapshot shape, served by GET /api/spaces/[id]/snapshots).
 *
 * This file is pure config + selectors — no React, no fetching — so the
 * hero vocabulary can be unit-tested and reused by future surfaces (the
 * Spaces landing rollup, Perspective Engine) without touching the widget.
 *
 * Categories with NO entry here intentionally have no trend hero:
 *   - PERSONAL renders via DashboardClient (KpiRow + NetWorthChart already
 *     form its hero).
 *   - GOAL / TRIP / VEHICLE / EQUIPMENT / CUSTOM / OTHER: no honest series
 *     exists for their lede (goal history isn't tracked; manual-asset
 *     categories are step functions better served by their value widgets).
 *     Per the approved investigation, intentional absence is part of the
 *     philosophy — no fake charts.
 */

import type { Snapshot } from "@/types";

export type HeroFraming = "up-good" | "down-good";

export interface SpaceHeroDef {
  /** Card title — an answer-shaped headline, not a topic label. */
  title: string;
  /** Selects this category's primary series from a snapshot row. */
  value: (s: Snapshot) => number;
  /** Which direction is good news — controls delta coloring only. */
  framing: HeroFraming;
  /** recharts line type — "stepAfter" for manually-updated (step) series. */
  chartType: "monotone" | "stepAfter";
  /** Scope/honesty label rendered under the headline (advisor rule:
   *  partial views must say what they are). */
  scopeLabel?: string;
}

export const SPACE_HERO_DEFS: Partial<Record<string, SpaceHeroDef>> = {
  HOUSEHOLD: {
    title:      "Net worth",
    value:      (s) => s.netWorth,
    framing:    "up-good",
    chartType:  "monotone",
    scopeLabel: "Across accounts shared with this Space",
  },
  FAMILY: {
    title:      "Net worth",
    value:      (s) => s.netWorth,
    framing:    "up-good",
    chartType:  "monotone",
    scopeLabel: "Across accounts shared with this Space",
  },
  BUSINESS: {
    // Cash position — NOT revenue or runway: neither has a defensible
    // deterministic series yet (approved investigation §1.3). Upgrade path:
    // in/out flow module first, runway only with a real burn definition.
    title:      "Cash position",
    value:      (s) => s.totalCash + s.totalSavings,
    framing:    "up-good",
    chartType:  "monotone",
    scopeLabel: "Cash and savings across linked business accounts",
  },
  INVESTMENT: {
    title:      "Portfolio value",
    value:      (s) => s.totalInvestments + s.totalCrypto,
    framing:    "up-good",
    chartType:  "monotone",
  },
  RETIREMENT: {
    title:      "Retirement portfolio",
    value:      (s) => s.totalInvestments + s.totalCrypto,
    framing:    "up-good",
    chartType:  "monotone",
  },
  DEBT_PAYOFF: {
    // The payoff arc — same `debt` series, down-is-good framing: the slope
    // is the user's own behavior (approved investigation §1.5).
    title:      "Remaining debt",
    value:      (s) => s.totalDebt,
    framing:    "down-good",
    chartType:  "monotone",
    scopeLabel: "Across debt accounts linked to this Space",
  },
  EMERGENCY_FUND: {
    title:      "Savings balance",
    value:      (s) => s.totalSavings,
    framing:    "up-good",
    chartType:  "monotone",
    scopeLabel: "Savings accounts linked to this Space",
  },
  PROPERTY: {
    // Equity = this Space's netWorth (value − mortgage) for a well-scoped
    // Property Space. Manual valuations are step functions — drawn as
    // steps, never interpolated slopes pretending to be market data.
    title:      "Equity",
    value:      (s) => s.netWorth,
    framing:    "up-good",
    chartType:  "stepAfter",
    scopeLabel: "Value minus debt across accounts linked to this Space",
  },
};

/** The hero definition for a category, or undefined when the category
 *  intentionally has no trend hero. */
export function getSpaceHeroDef(category: string): SpaceHeroDef | undefined {
  return SPACE_HERO_DEFS[category];
}
