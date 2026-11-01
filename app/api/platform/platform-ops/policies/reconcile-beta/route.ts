/**
 * /api/platform/platform-ops/policies/reconcile-beta  (owner ruling, 2026-10-30)
 *
 *   GET   the DRY RUN — how many ACTIVE customer accounts have NO policy
 *         assignment and would receive the beta default, and how many accounts
 *         are excluded and why. Counts only, never an identity:
 *           { eligible, groupKey, excluded: { deactivated, nonCustomerRoles,
 *             alreadyAssigned, unknownAssignments }, checkedAt }
 *   POST  APPLY — { reason: { code, note? }, expectedEligible }  (expectedEligible REQUIRED)
 *         Creates a DEFAULT_POLICY_GROUP assignment for each eligible account,
 *         in ONE transaction with ONE CUSTOMER_POLICY_RECONCILED audit row.
 *
 * AUTHORIZATION
 *   GET   requirePlatformAccess("PLATFORM_OPS", "READ")        — observation
 *   POST  requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL") — a fleet-wide
 *         policy write, the same bar as every other platform-wide control
 *         (refresh / job cadence, AI cost controls, fleet-wide manual runs).
 *
 * REASON IS REQUIRED (lib/audit.ts REASON_REQUIRED_ACTIONS). `expectedEligible`
 * is the count the operator confirmed; a different current count ⇒ 409, nothing
 * written ("the population changed — re-check").
 *
 *   200  { outcome: "ASSIGNED" | "NOTHING_TO_ASSIGN", eligible, created, skipped, groupKey, dryRun }
 *   400  { error }                                     malformed body / missing or unsafe reason
 *   409  { error, code: "CONFLICT", dryRun }           the population changed; nothing written
 *   409  { error, code: "BLOCKED", dryRun }            Beta is archived / unusable; nothing written
 *
 * EVERY rule — the population, create-only (createMany + skipDuplicates; an
 * existing assignment, Founder or an unknown group, is never touched), the one
 * transaction and the one counts-only audit row — lives in
 * lib/platform/policies/reconcile-beta.ts. Nothing runs this automatically.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitByUser } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { recordControlRefusal } from "@/lib/platform/control-refusal";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import {
  applyBetaReconciliation, readBetaReconciliation, type BetaReconciliationDryRun,
} from "@/lib/platform/policies/reconcile-beta";

export const runtime = "nodejs";

export type BetaReconciliationDryRunResponse = BetaReconciliationDryRun;

export interface BetaReconciliationApplyResponse {
  outcome: "ASSIGNED" | "NOTHING_TO_ASSIGN";
  eligible: number;
  created: number;
  skipped: number;
  groupKey: string;
  /** The population after the run (eligible is 0 unless someone registered unassigned meanwhile). */
  dryRun: BetaReconciliationDryRun;
}

export interface BetaReconciliationRefusal {
  error: string;
  code?: "CONFLICT" | "BLOCKED";
  dryRun?: BetaReconciliationDryRun;
}

export const POPULATION_CHANGED = "The population changed — re-check.";
export const BETA_BLOCKED = {
  ARCHIVED: "The Beta policy group is archived — nothing was assigned (reconciliation never assigns another group).",
  INVALID: "The Beta policy group's stored definition is unusable — nothing was assigned (reconciliation never assigns another group).",
} as const;

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json((await readBetaReconciliation()) satisfies BetaReconciliationDryRunResponse);
}

/** SEC-PLAT-2 — the reason CODE a body carried, for the refusal record (never the note). */
function reasonCodeOf(body: Record<string, unknown> | null): unknown {
  const r = body?.reason;
  return r && typeof r === "object" ? (r as { code?: unknown }).code : undefined;
}

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "platform-beta-reconcile", { limit: 5, windowSec: 60 });
  if (limited) return limited;

  const meta = { ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent") };
  const raw = await req.json().catch(() => null);
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const refuse = async (res: NextResponse, code: "VALIDATION" | "CONFLICT" | "NOT_EDITABLE") => {
    await recordControlRefusal(auth, { control: "beta-reconciliation", verb: "apply", code, targetKey: null, reasonCode: reasonCodeOf(body) }, meta);
    return res;
  };

  if (!body) return refuse(NextResponse.json({ error: "A JSON body { reason, expectedEligible } is required." } satisfies BetaReconciliationRefusal, { status: 400 }), "VALIDATION");
  const expected = body.expectedEligible;
  // Required: a POST must name the count the operator confirmed (count before change is a contract, not a UI habit).
  if (!(typeof expected === "number" && Number.isInteger(expected) && expected >= 0)) {
    return refuse(NextResponse.json({ error: "expectedEligible is required: the non-negative count you confirmed." } satisfies BetaReconciliationRefusal, { status: 400 }), "VALIDATION");
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) {
    return refuse(NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." } satisfies BetaReconciliationRefusal, { status: 400 }), "VALIDATION");
  }

  const result = await applyBetaReconciliation({
    expectedEligible: expected,
    reason,
    actor: { ...operatorActorFrom(auth, "PLATFORM_OPS"), ...meta },
  });
  const dryRun = await readBetaReconciliation();
  if (!result.ok && result.code === "BLOCKED") {
    // Never falls through to another group: Beta archived / unusable ⇒ 409, nothing written.
    return refuse(NextResponse.json({ error: BETA_BLOCKED[result.blocked], code: "BLOCKED", dryRun } satisfies BetaReconciliationRefusal, { status: 409 }), "NOT_EDITABLE");
  }
  if (!result.ok) {
    return refuse(NextResponse.json({ error: POPULATION_CHANGED, code: "CONFLICT", dryRun } satisfies BetaReconciliationRefusal, { status: 409 }), "CONFLICT");
  }
  const { outcome, eligible, created, skipped, groupKey } = result;
  return NextResponse.json({ outcome, eligible, created, skipped, groupKey, dryRun } satisfies BetaReconciliationApplyResponse);
}
