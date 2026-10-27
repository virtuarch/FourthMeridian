/**
 * lib/platform/control-refusal.ts  (SEC-PLAT-2)
 *
 * A refused CONTROL mutation is a fact worth keeping. Maintenance mode already
 * audits its refusals (lib/platform/policies/operational-controls.ts); the
 * refresh-cadence, job-cadence and AI cost-control routes answered 400/404/409
 * and wrote nothing, so a CONTROL holder probing or fumbling a platform-wide
 * control left no trace. Every refusal those routes return AFTER the grant
 * check now records one PLATFORM_CONTROL_REFUSED row through the operator-action
 * envelope.
 *
 * WHAT IS RECORDED — and what is not:
 *   - the control (refresh-cadence | job-cadence | ai-cost-controls), the verb
 *     (change | reset), a target drawn from a CLOSED vocabulary, the refusal
 *     CODE, and the reason CODE when one parsed;
 *   - NEVER the submitted value, the free-text note, the error message, the
 *     body, or any token. A malformed or hostile request cannot put text into
 *     the audit log through this path (pinned by control-refusal.test.ts).
 *
 * WHAT IS NOT A REFUSAL HERE: authorization denials (401/403) are recorded by
 * the shared guard (lib/platform/ops/access-denied.ts, OBS-009) before any route
 * code runs; a 429 is not recorded (an audit of rate-limited calls would be a
 * write amplifier for exactly the caller being limited).
 *
 * The write is awaited but BEST-EFFORT: a failed audit insert is logged and the
 * caller still returns its refusal — a refusal must never become a 500.
 */

import "server-only";

import { systemDb } from "@/lib/db";
import { buildOperatorActionData, type OperatorActionWriteClient } from "@/lib/audit";
import type { PlatformAuth } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { buildControlRefusalInput, type ControlRefusal } from "./control-refusal.core";

export type { ControlRefusal } from "./control-refusal.core";

export interface ControlRefusalRequest {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Record one refused CONTROL mutation. Never throws. */
export async function recordControlRefusal(
  auth: Pick<PlatformAuth, "user" | "grant">,
  refusal: ControlRefusal,
  req: ControlRefusalRequest = {},
  client: OperatorActionWriteClient = systemDb,
): Promise<void> {
  try {
    const input = buildControlRefusalInput(operatorActorFrom(auth, "PLATFORM_OPS"), refusal, req);
    await client.auditLog.create({ data: buildOperatorActionData(input) });
  } catch (error) {
    console.error("[control-refusal] audit write failed:", error instanceof Error ? error.message : "unknown error");
  }
}
