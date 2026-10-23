/**
 * GET /api/platform/platform-ops/refresh/executions/[id]  (PLATFORM OPS OBSERVABILITY)
 *
 * One execution, inspected: its row and stages (the row seam), the same
 * source's last successful execution, and the refresh policy in force for its
 * kind (lib/platform/refresh/inspection.ts). 404 when unknown. Operator
 * audience is fixed by the grant, never by a parameter. Gated PLATFORM_OPS READ.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { inspectExecution } from "@/lib/platform/refresh/inspection";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const { id } = await params;
  const inspection = await inspectExecution(id);
  if (!inspection) return NextResponse.json({ error: "Execution not found" }, { status: 404 });
  return NextResponse.json(inspection);
}
