/**
 * GET /api/platform/platform-ops/scheduler  (OPS-2C-7)
 *
 * The read surface for scheduler OBSERVATION — what scheduling behaviour was
 * recorded, what the registry declares should happen next, and which operational
 * gaps exist. Composed from the job-health authority, the dispatcher's own pure
 * slot selector, and the JobRun ledger; this route derives nothing itself.
 *
 * OBSERVATION ONLY. It reports no scheduler health (no such authority exists),
 * claims no dispatcher tick (they are not recorded), and exposes nothing to
 * change, pause, resume, or declare — that is OPS-2D.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getSchedulerObservation } from "@/lib/platform/scheduler/observation";
import type { SchedulerObservation } from "@/lib/platform/scheduler/observation-core";

export const runtime = "nodejs";

export type SchedulerObservationResponse = SchedulerObservation & { checkedAt: string };

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const observation = await getSchedulerObservation();
  return NextResponse.json(observation satisfies SchedulerObservationResponse);
}
