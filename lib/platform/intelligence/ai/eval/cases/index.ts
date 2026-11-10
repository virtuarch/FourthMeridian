/**
 * lib/platform/intelligence/ai/eval/cases/index.ts  (E0-CI — every case, by pack)
 *
 * P1b baseline: the existing tools (metrics, navigation, memory) + the boundary.
 * Each pack PR (P5+) adds cases/<pack>.ts here, with its fixtures and oracle.
 */

import { BOUNDARY_CASES } from "./boundary";
import { COST_CAP_ROUTE_CASES, COST_CAP_UNIT_CASES } from "./cost-cap";
import { MEMORY_CASES } from "./memory";
import { METRICS_CASES } from "./metrics";
import { NAVIGATION_CASES } from "./navigation";
import { P2_BOUNDARY_CASES } from "./p2-boundary";
import { ROUTER_CASES } from "./router";
import type { E0Case } from "./types";

export const E0_CASES: readonly E0Case[] = [...METRICS_CASES, ...NAVIGATION_CASES, ...BOUNDARY_CASES, ...MEMORY_CASES, ...P2_BOUNDARY_CASES, ...COST_CAP_ROUTE_CASES, ...COST_CAP_UNIT_CASES, ...ROUTER_CASES];
