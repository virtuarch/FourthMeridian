/**
 * GET /api/platform/platform-ops/env-status
 *
 * PO1.2 — environment configuration report for the `ops_env_status` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * Surfaces getEnvReport() (lib/env.ts) — the additive, non-throwing report-shape
 * companion to validateEnv(). NAMES + pass/warn/fail status only; environment
 * VALUES are never read into the response, matching the PII-avoidance doctrine.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getEnvReport, type EnvReport } from "@/lib/env";

export const runtime = "nodejs";

export type PlatformEnvStatusResponse = EnvReport;

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  return NextResponse.json(getEnvReport() satisfies PlatformEnvStatusResponse);
}
