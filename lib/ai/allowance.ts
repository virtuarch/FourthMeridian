/**
 * lib/ai/allowance.ts  (BETA C7 — the per-customer daily AI allowance, enforced)
 *
 * THE PRODUCT-ROUTE SEAM for `aiDailyUsdAllowance`: one loader of today's spend,
 * one verdict, one refusal response. Consumed by app/api/ai/chat and
 * app/api/brief/generate AFTER their pacing windows and BEFORE any model work,
 * so a refusal costs no provider call.
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

/** The allowance in force for this customer, from the resolved entitlements (ceiling already applied). */
export function allowanceUsdOf(e: EffectiveEntitlements): number {
  const v = Number(e.dimensions.aiDailyUsdAllowance.value);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface AllowanceDeps {
  now?: Date;
  client?: AllowanceReadClient;
}

/** The verdict for one customer's next turn. Injectable for tests. */
export async function dailyAiAllowanceFor(userId: string, entitlements: EffectiveEntitlements, deps: AllowanceDeps = {}): Promise<AllowanceVerdict> {
  const spend = await loadTodaySpend(userId, deps.now, deps.client);
  return dailyAllowanceVerdict({ spentUsd: spend.spentUsd, allowanceUsd: allowanceUsdOf(entitlements), unpricedInvocations: spend.unpricedInvocations });
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * The refusal response, or null when the turn may proceed. The body is the one
 * shape both surfaces return: `{ error, code: "AI_ALLOWANCE", reason, spentUsd, allowanceUsd }`.
 */
export function allowanceRefusal(v: AllowanceVerdict, surfaceLabel: string): NextResponse | null {
  if (v.allowed) return null;
  return NextResponse.json(allowanceRefusalBody(v, surfaceLabel), { status: allowanceRefusalStatus(v), headers: NO_STORE });
}
