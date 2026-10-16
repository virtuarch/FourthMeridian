/**
 * lib/ai/allowance.ts  (BETA C7 — the per-customer daily AI allowance, enforced)
 *
 * THE PRODUCT-ROUTE SEAM for `aiDailyUsdAllowance`: one loader of today's spend,
 * one verdict, one refusal response. Consumed by app/api/ai/chat and
 * app/api/brief/generate AFTER their pacing windows and AFTER the kill switch,
 * and BEFORE any model work, so a refusal costs no provider call.
 *
 * ── Authority ───────────────────────────────────────────────────────────────
 * The chat route runs its reads on the TENANT principal, and AiInvocation is
 * REVOKED from fm_app (…000100 §4): the ledger is written and read by fm_system
 * only. So the ONE ledger read lives in lib/platform/ai/customer-spend-today.ts
 * — under lib/platform/ with the other fm_system readers of that table, and
 * outside lib/ai/, whose delegate reads are classified as tenant-authority AI
 * evidence (lib/ai/evidence-authorities.ts) — and this module composes it:
 * the session's own userId in, a verdict out. This file imports no database
 * client. Nothing about another customer is selected; the userId is the
 * authenticated session's, handed in by the route.
 *
 * ── AI COST CONTROLS (2026-10-15) ───────────────────────────────────────────
 * The decision now runs through lib/platform/ai/allowance-reservation.ts: ONE
 * short fm_system transaction under a per-customer advisory lock that reads the
 * enforcement flag, today's spend and the IN-FLIGHT count, decides
 * `spent + inFlight × RESERVE_USD ≥ allowance`, and reserves this turn. The
 * route RELEASES the reservation in its `finally`. The guarantee is bounded,
 * not absolute — see that module's header and the verdict's `reservation`.
 * The allowance figure itself comes from the resolved entitlements, where the
 * ONE precedence function (lib/entitlements/ai-allowance.ts) already applied
 * USER_OVERRIDE > OVERLAY > PLATFORM_SETTING > POLICY and the ceiling.
 *
 * ── Why no audit row ────────────────────────────────────────────────────────
 * The ledger records provider calls; a refusal is not one. No existing
 * AuditLog action fits a customer-facing allowance refusal (W3 owns the
 * vocabulary), so the refusal is observable through the response code and the
 * route's log line only. See the hand-off.
 */

import "server-only";
import { NextResponse } from "next/server";
import { todayUTCISO } from "@/lib/time/clock";
import { readCustomerSpendGroupsToday, type CustomerSpendReadClient } from "@/lib/platform/ai/customer-spend-today";
import { reserveAiTurn, type ReservationOutcome } from "@/lib/platform/ai/allowance-reservation";
import type { EffectiveEntitlements } from "@/lib/entitlements/resolve";
import {
  allowanceRefusalBody, allowanceRefusalStatus, dailyAllowanceVerdict, sumTodaySpend,
  type AllowanceVerdict, type TodaySpend,
} from "@/lib/ai/allowance-core";

export type { AllowanceVerdict } from "@/lib/ai/allowance-core";
export { ALLOWANCE_CODE } from "@/lib/ai/allowance-core";
export { utcDayStart } from "@/lib/platform/ai/customer-spend-today";

/** The narrow read the loader composes — see lib/platform/ai/customer-spend-today.ts. */
export type AllowanceReadClient = CustomerSpendReadClient;

/** What this customer has caused so far today, priced at today's rate. */
export async function loadTodaySpend(
  userId: string,
  now: Date = new Date(),
  client?: AllowanceReadClient,
): Promise<TodaySpend> {
  const groups = await readCustomerSpendGroupsToday(userId, now, client);
  return sumTodaySpend(groups, todayUTCISO(now));
}

/** The allowance in force for this customer, from the resolved entitlements (the ONE precedence function, ceiling already applied). */
export function allowanceUsdOf(e: EffectiveEntitlements): number {
  const v = Number(e.dimensions.aiDailyUsdAllowance.value);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** The verdict plus the reservation's release handle — call `release()` in the route's `finally`. */
export type AllowanceAdmission = AllowanceVerdict & { release(): Promise<void> };

export interface AllowanceDeps {
  now?: Date;
  /**
   * The legacy injected ledger read (tests). When given WITHOUT `reserve`, the
   * decision is the plain check with `reservation: "NONE"` and `enforced`
   * (default true) — no lock, no counter.
   */
  client?: AllowanceReadClient;
  enforced?: boolean;
  /** The reservation seam (tests inject a fake transaction; the default is the real fm_system one). */
  reserve?: (userId: string, allowanceUsd: number, now: Date) => Promise<ReservationOutcome>;
}

const NO_RELEASE = async () => {};

/** The verdict for one customer's next turn, reserved. Injectable for tests. */
export async function dailyAiAllowanceFor(userId: string, entitlements: EffectiveEntitlements, deps: AllowanceDeps = {}): Promise<AllowanceAdmission> {
  const now = deps.now ?? new Date();
  const allowanceUsd = allowanceUsdOf(entitlements);
  if (deps.client && !deps.reserve) {
    const spend = await loadTodaySpend(userId, now, deps.client);
    const verdict = dailyAllowanceVerdict({ spentUsd: spend.spentUsd, allowanceUsd, unpricedInvocations: spend.unpricedInvocations, enforced: deps.enforced ?? true });
    return { ...verdict, release: NO_RELEASE };
  }
  const outcome = await (deps.reserve ?? ((u, a, n) => reserveAiTurn(u, a, n)))(userId, allowanceUsd, now);
  return { ...outcome.verdict, release: outcome.release };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * The refusal response, or null when the turn may proceed. The body is the one
 * shape both surfaces return: `{ error, code: "AI_ALLOWANCE", reason, spentUsd, allowanceUsd }`.
 */
export function allowanceRefusal(v: AllowanceVerdict, surfaceLabel: string): NextResponse | null {
  if (v.allowed) return null;
  const body = allowanceRefusalBody(v, surfaceLabel);
  return NextResponse.json(body, { status: allowanceRefusalStatus(v),
    headers: body.retryAfterSeconds ? { ...NO_STORE, "Retry-After": String(body.retryAfterSeconds) } : NO_STORE });
}
