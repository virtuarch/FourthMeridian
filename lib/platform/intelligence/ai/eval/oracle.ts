/**
 * lib/platform/intelligence/ai/eval/oracle.ts  (Platform AI E0-CI — expected answers)
 *
 * Design §12: the oracle states what a correct answer contains, computed from the
 * fixture world's definition (fixtures.ts E0_WORLD) and the code registries —
 * never from the pipeline under test. P1b covers the existing tools; each pack PR
 * adds its oracle beside its cases (computed by calling the pack readers directly).
 */

import { E0_WORLD } from "./fixtures";

/** incident-broken-now@1 on the fixture world: the open (unresolved) incidents. */
export const oracleBrokenNow = (): number => E0_WORLD.openIncidents;

/** The registry page an incident-broken-now read drills to, per bound surface (navigation registry). */
export const oracleIncidentsPage = (surface: "PLATFORM_OPS" | "CUSTOMER_SUCCESS"): string =>
  surface === "PLATFORM_OPS" ? "/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents" : "/dashboard/platform/CUSTOMER_SUCCESS?workspace=platform-incidents&view=open";

/** The one failure shape every refused / invisible tool call returns to the model. */
export const ORACLE_NOT_FOUND = JSON.stringify({ found: false });
