/**
 * GET /api/platform/platform-ops/new-connection-imports  (PB-7)
 *
 * "New-connection imports (7 d)": started / complete / recovered / in progress
 * / failed / removed — COUNTS ONLY. Platform Ops is identity-free by ruling;
 * the reader selects no owner and returns no item, institution or user
 * reference (lib/platform/ops/new-connection-imports.ts).
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getNewConnectionImports } from "@/lib/platform/ops/new-connection-imports";
import type { NewConnectionImports } from "@/lib/platform/ops/new-connection-imports-core";

export const runtime = "nodejs";

export type NewConnectionImportsResponse = NewConnectionImports;

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const body = await getNewConnectionImports();
  return NextResponse.json(body satisfies NewConnectionImportsResponse);
}
