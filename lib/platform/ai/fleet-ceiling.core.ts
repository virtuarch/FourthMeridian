/**
 * lib/platform/ai/fleet-ceiling.core.ts  (SEC-AI-001 — the optional fleet AI spend ceiling, pure)
 *
 * THE DEFECT: the per-customer allowance is judged under a PER-CUSTOMER lock,
 * the fleet threshold (`ai-spend-fleet-high`) only ALERTS, and the only fleet
 * STOP was the manual kill switch. Nothing refused the fleet's next turn when
 * the fleet as a whole had spent enough.
 *
 * THE MECHANISM (off by default — no value is set, seeded or migrated):
 *   · ONE optional PlatformSetting, `ai_fleet_daily_ceiling_usd_24h`, whole USD,
 *     ABSENT_MEANS_OFF. Absent ⇒ no ceiling and the reservation is unchanged
 *     (no fleet lock, no fleet read).
 *   · When SET, the reservation (lib/platform/ai/allowance-reservation.ts)
 *     judges it INSIDE the same transaction as the per-customer allowance, after
 *     `pg_advisory_xact_lock(hashtext('ai-fleet'))`, so every admission is
 *     serialised fleet-wide and two concurrent edge turns cannot both pass.
 *   · The spend is THE fleet fold the alert judges: customer surfaces only,
 *     RETURNED rows, the trailing 24 h window, folded by `buildAiSpendHealth`
 *     and classified by `fleetSpendStatus` (ESTIMATED / PARTIAL / UNAVAILABLE).
 *   · Plus the fleet IN-FLIGHT count (the sum of every customer's reservation
 *     buckets) × RESERVE_USD — the ledger is written after the provider
 *     returns, so without it N simultaneous turns would all pass on the same
 *     stale sum. Rule: refuse when  fleetSpent + fleetInFlight × reserve ≥ ceiling
 *     — the per-customer rule, at fleet scope.
 *
 * ── UNAVAILABLE spend: FAIL OPEN (S2 to rule) ───────────────────────────────
 * When the fold has no priced figure (no customer call in the window, or none
 * could be priced) the fleet spend is UNKNOWN. This optional cap does NOT refuse
 * on an unknown: it admits and the caller LOGS it — never silently (S2 ruling a):
 * the fleet rule raises `ai-spend-fleet-high:ceiling-unenforceable:<day>` and the
 * Budget & controls line says "not enforced". With `ai_daily_allowance_enforced`
 * OFF the ceiling is not judged at all (ruling b), and the line says so. Unpriced calls are already
 * refused per customer (UNPRICED_MODEL, fail closed) and raise the existing
 * fleet alert's unpriced warning, so a cap that also refused would turn one
 * missing rate into a fleet-wide outage. PARTIAL is judged on its priced LOWER
 * BOUND: if even that reaches the ceiling, the ceiling is certainly reached.
 *
 * ── The guarantee, honestly ─────────────────────────────────────────────────
 * The same bound as the allowance: admitted fleet spend ≤ ceiling + Σ over the
 * concurrently admitted turns of (actual cost − RESERVE_USD). Bounded, not
 * absolute — a turn's cost is known only after the provider returns.
 *
 * PURE — no I/O, no clock, no database.
 */

import type { FleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";

/** The PlatformSetting key (registered in lib/platform-settings.ts). */
export const FLEET_CEILING_SETTING_KEY = "ai_fleet_daily_ceiling_usd_24h" as const;
/** The fleet advisory lock key — `hashtext('ai-fleet')`; taken ONLY when a ceiling is set. */
export const FLEET_CEILING_LOCK_KEY = "ai-fleet" as const;
/** The window the ceiling is judged over: the fleet alert's own trailing window. */
export const FLEET_CEILING_WINDOW_HOURS = 24;
/** Bounds — the fleet alert threshold's (lib/platform-settings.ts). */
export const FLEET_CEILING_MIN_USD = 1;
export const FLEET_CEILING_MAX_USD = 100_000;
/** What Budget & controls reads when no ceiling is set. */
export const FLEET_CEILING_NOT_SET = "Fleet daily ceiling: not set";

export type FleetCeiling =
  | { state: "OFF" }
  | { state: "SET"; usd: number }
  /** A stored row that fails the descriptor. Treated as OFF (and logged): the optional cap never refuses on a value it cannot read. */
  | { state: "INVALID"; raw: string };

/** PURE — the ceiling in force from its stored row (null/undefined = no row). */
export function resolveFleetCeiling(raw: string | null | undefined): FleetCeiling {
  if (raw === null || raw === undefined) return { state: "OFF" };
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { state: "INVALID", raw };
  const n = Number.parseInt(t, 10);
  if (n < FLEET_CEILING_MIN_USD || n > FLEET_CEILING_MAX_USD) return { state: "INVALID", raw };
  return { state: "SET", usd: n };
}

/** The ceiling's dollar figure, or null when no ceiling is in force. */
export function fleetCeilingUsdOf(c: FleetCeiling): number | null {
  return c.state === "SET" ? c.usd : null;
}

export type FleetCeilingDecision =
  | { outcome: "WITHIN"; committedUsd: number; ceilingUsd: number; status: FleetSpendStatus["status"] }
  | { outcome: "REACHED"; committedUsd: number; ceilingUsd: number; status: FleetSpendStatus["status"] }
  /** The spend is UNAVAILABLE — admitted without a judgement; the caller logs why. */
  | { outcome: "FAIL_OPEN"; ceilingUsd: number; status: "UNAVAILABLE"; reason: string };

/** PURE — the fleet decision for the next turn. */
export function fleetCeilingDecision(input: {
  spend: Pick<FleetSpendStatus, "status" | "pricedUsd" | "reason">;
  ceilingUsd: number;
  fleetInFlight: number;
  reserveUsd: number;
}): FleetCeilingDecision {
  const ceilingUsd = input.ceilingUsd;
  if (input.spend.status === "UNAVAILABLE" || input.spend.pricedUsd === null) {
    return { outcome: "FAIL_OPEN", ceilingUsd, status: "UNAVAILABLE", reason: input.spend.reason ?? "fleet spend unavailable" };
  }
  const inFlight = Number.isFinite(input.fleetInFlight) && input.fleetInFlight > 0 ? Math.floor(input.fleetInFlight) : 0;
  const reserve = Number.isFinite(input.reserveUsd) && input.reserveUsd > 0 ? input.reserveUsd : 0;
  const spent = Number.isFinite(input.spend.pricedUsd) && input.spend.pricedUsd > 0 ? input.spend.pricedUsd : 0;
  const committedUsd = spent + inFlight * reserve;
  const status = input.spend.status;
  return committedUsd >= ceilingUsd
    ? { outcome: "REACHED", committedUsd, ceilingUsd, status }
    : { outcome: "WITHIN", committedUsd, ceilingUsd, status };
}

/**
 * What the ceiling is doing right now, for the read-only line (S2 rulings a/b):
 *   NOT_SET          no ceiling;
 *   ENFORCED         set, and judged on a priced fleet spend;
 *   UNENFORCEABLE    set, but the fleet spend could not be priced — admitted, not enforced (fail open, alerted);
 *   ENFORCEMENT_OFF  set, but `ai_daily_allowance_enforced` is off — not judged.
 */
export type FleetCeilingState = "NOT_SET" | "ENFORCED" | "UNENFORCEABLE" | "ENFORCEMENT_OFF";

/** PURE — the state from the ceiling, the enforcement flag and the fleet fold's priced figure. */
export function fleetCeilingState(input: { ceilingUsd: number | null; allowanceEnforced: boolean; fleetPricedUsd: number | null; fleetInvocations: number }): FleetCeilingState {
  if (input.ceilingUsd === null) return "NOT_SET";
  if (!input.allowanceEnforced) return "ENFORCEMENT_OFF";
  if (input.fleetPricedUsd === null && input.fleetInvocations > 0) return "UNENFORCEABLE";
  return "ENFORCED";
}

/** Budget & controls — the read-only line. "rolling 24 h": unlike the per-customer allowance's UTC day (ruling d). */
export function fleetCeilingText(ceilingUsd: number | null, state?: FleetCeilingState): string {
  if (ceilingUsd === null) return FLEET_CEILING_NOT_SET;
  const base = `Fleet daily ceiling: $${ceilingUsd.toLocaleString("en-US")} per rolling ${FLEET_CEILING_WINDOW_HOURS} h`;
  if (state === "ENFORCEMENT_OFF") return `${base} — not enforced (allowance enforcement is off)`;
  if (state === "UNENFORCEABLE") return `${base} — not enforced (fleet spend could not be priced)`;
  return base;
}
