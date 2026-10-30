/**
 * lib/platform/control-refusal.core.ts  (SEC-PLAT-2)
 *
 * PURE — the operator-action input for one refused CONTROL mutation. No I/O, so
 * the "never the submitted value" contract is unit-testable. See
 * lib/platform/control-refusal.ts for the why.
 */

import { AuditAction } from "@/lib/audit-actions";
import { isOperatorReasonCode, type OperatorActionInput } from "@/lib/audit";

export type ControlName = "refresh-cadence" | "job-cadence" | "ai-cost-controls" | "beta-reconciliation";
export type ControlVerb = "change" | "reset" | "apply";
export type ControlRefusalCode = "VALIDATION" | "CONFLICT" | "NOT_FOUND" | "NOT_EDITABLE";

export interface ControlRefusal {
  control: ControlName;
  verb: ControlVerb;
  code: ControlRefusalCode;
  /**
   * The target, ONLY when it is a member of the control's closed vocabulary
   * (BANK|WALLET, a registered job name, an AI control id) — the caller passes
   * `null` for anything it did not validate, and it is recorded as "unknown".
   */
  targetKey: string | null;
  /** The parsed reason CODE, when the body carried a valid one. The note is never recorded. */
  reasonCode?: unknown;
}

const TARGET_PREFIX: Record<ControlName, string> = {
  "refresh-cadence":  "refresh-cadence",
  "job-cadence":      "job-cadence",
  "ai-cost-controls": "ai-cost-control",
  // Beta reconciliation — the target key is the policy group it assigns.
  "beta-reconciliation": "beta-reconciliation",
};

/** Closed-vocabulary target keys are short identifiers; anything else is "unknown". */
const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

export function buildControlRefusalInput(
  actor: OperatorActionInput["actor"],
  refusal: ControlRefusal,
  req: { ipAddress?: string | null; userAgent?: string | null } = {},
): OperatorActionInput {
  const key = refusal.targetKey && SAFE_KEY.test(refusal.targetKey) ? refusal.targetKey : "unknown";
  return {
    actor,
    action: AuditAction.PLATFORM_CONTROL_REFUSED,
    target: { kind: "PLATFORM_SETTING", id: `${TARGET_PREFIX[refusal.control]}:${key}` },
    ...(isOperatorReasonCode(refusal.reasonCode) ? { reason: { code: refusal.reasonCode } } : {}),
    result: "REFUSED",
    detail: { control: refusal.control, verb: refusal.verb, refusal: refusal.code },
    ipAddress: req.ipAddress ?? null,
    userAgent: req.userAgent ?? null,
  };
}
