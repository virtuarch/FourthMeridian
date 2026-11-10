/**
 * lib/platform/intelligence/ai/eval/cases/index.ts  (E0-CI — every case, by pack)
 *
 * P1b baseline: the existing tools (metrics, navigation, memory) + the boundary.
 * Each pack PR (P5+) adds cases/<pack>.ts here, with its fixtures and oracle. P5: customers.ts. P8: incidents.ts. P6: onboarding.ts. P7: connections.ts. P4b: conversations.ts (multi-area conversation turns).
 */

import { ANSWER_CASES } from "./answers";
import { BOUNDARY_CASES } from "./boundary";
import { CONNECTIONS_ROUTE_CASES, CONNECTIONS_UNIT_CASES } from "./connections";
import { CONVERSATION_CASES } from "./conversations";
import { COST_CAP_ROUTE_CASES, COST_CAP_UNIT_CASES } from "./cost-cap";
import { CUSTOMERS_CASES } from "./customers";
import { INCIDENTS_ROUTE_CASES, INCIDENTS_UNIT_CASES } from "./incidents";
import { MEMORY_CASES } from "./memory";
import { METRICS_CASES } from "./metrics";
import { NAVIGATION_CASES } from "./navigation";
import { ONBOARDING_ROUTE_CASES, ONBOARDING_UNIT_CASES } from "./onboarding";
import { P2_BOUNDARY_CASES } from "./p2-boundary";
import { ROUTER_CASES } from "./router";
import type { E0Case } from "./types";

export const E0_CASES: readonly E0Case[] = [...METRICS_CASES, ...NAVIGATION_CASES, ...BOUNDARY_CASES, ...MEMORY_CASES, ...P2_BOUNDARY_CASES, ...COST_CAP_ROUTE_CASES, ...COST_CAP_UNIT_CASES, ...ROUTER_CASES, ...ANSWER_CASES, ...CUSTOMERS_CASES, ...INCIDENTS_UNIT_CASES, ...INCIDENTS_ROUTE_CASES, ...ONBOARDING_UNIT_CASES, ...ONBOARDING_ROUTE_CASES, ...CONNECTIONS_UNIT_CASES, ...CONNECTIONS_ROUTE_CASES, ...CONVERSATION_CASES];
