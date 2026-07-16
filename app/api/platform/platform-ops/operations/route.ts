/**
 * /api/platform/platform-ops/operations  (OPS-5 S4 — Manual Operations)
 *
 * The Manual Operations panel's data + action surface. Two verbs, two gates:
 *
 *   GET  — requirePlatformAccess("PLATFORM_OPS", "READ")
 *          The registry (kinds + commands, incl. reserved kinds so the panel
 *          shows the future-safe taxonomy) + recent manual-run history (the
 *          last manual JobRun rows) so the operator sees status + audit trail.
 *
 *   POST — requireFreshPlatformAccess("PLATFORM_OPS", "WRITE")  { commandId }
 *          Invoke a registered command. The whole action surface is WRITE (the
 *          investigation §5 gate — a "Run Now" is a WRITE action behind the
 *          fresh-grant check). Fresh = live-revocation re-checked, required for
 *          every platform mutation. Then: rate-limit → resolve command →
 *          runOperation (in-flight lock + runJob(trigger:"manual") for a
 *          mutating run; a plan for a dry-run) → AuditLog.
 *
 * NEVER BYPASS CANONICAL EXECUTION: this route does not run any job body
 * itself. runOperation resolves the SCHEDULED_JOBS body and runs it through
 * runJob — the one execution path, the one JobRun ledger. This route owns only
 * the auth, the audit row, and the rate limit.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withApiHandler } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { AuditAction } from "@/lib/audit-actions";
import {
  requirePlatformAccess,
  requireFreshPlatformAccess,
} from "@/lib/platform/authorize";
import {
  OPERATION_KINDS,
  listOperationCommands,
  getOperationCommand,
  type OperationKindMeta,
  type OperationCommand,
} from "@/lib/platform/operations/registry";
import {
  runOperation,
  realOperationDeps,
  type OperationOutcome,
  type DryRunPlan,
} from "@/lib/platform/operations/execute";

export const runtime = "nodejs";

const RECENT_LIMIT = 20;

// ── GET — registry + recent manual-run history ────────────────────────────────

export interface ManualRunRow {
  id: string;
  jobName: string;
  trigger: string;
  status: string;
  startedAt: string; // ISO
  completedAt: string | null;
  durationMs: number | null;
}

export interface OperationsResponse {
  kinds: OperationKindMeta[];
  commands: OperationCommand[];
  recent: ManualRunRow[];
}

export const GET = withApiHandler(async () => {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  // Recent manual runs — the audit history the panel renders. Manual runs are
  // trigger:"manual" JobRun rows (runJob tags them); cron runs are excluded.
  const recent = await db.jobRun.findMany({
    where: { trigger: "manual" },
    orderBy: { startedAt: "desc" },
    take: RECENT_LIMIT,
    select: {
      id: true,
      jobName: true,
      trigger: true,
      status: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
    },
  });

  return NextResponse.json({
    kinds: Object.values(OPERATION_KINDS),
    commands: listOperationCommands(),
    recent: recent.map((r) => ({
      id: r.id,
      jobName: r.jobName,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      durationMs: r.durationMs,
    })),
  } satisfies OperationsResponse);
}, "GET /api/platform/platform-ops/operations");

// ── POST — invoke a command ───────────────────────────────────────────────────

export interface OperationActionResponse {
  ok: boolean;
  commandId: string;
  kind: string;
  jobName: string;
  outcome: OperationOutcome;
  status?: string;
  summary?: unknown;
  error?: string;
  plan?: DryRunPlan;
}

export const POST = withApiHandler(async (req: NextRequest) => {
  // Whole action surface is WRITE + fresh (live-revocation) — investigation §5.
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "WRITE");
  if (err) return err;

  // Bound manual-operation invocations per operator (double-click / abuse).
  const limited = await limitByUser(auth.user.id, "platform-operation", {
    limit: 30,
    windowSec: 60,
  });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as { commandId?: unknown } | null;
  const commandId = typeof body?.commandId === "string" ? body.commandId : null;
  if (!commandId) {
    return NextResponse.json({ error: "commandId is required." }, { status: 400 });
  }

  const command = getOperationCommand(commandId);
  if (!command) {
    return NextResponse.json({ error: "Unknown operation command." }, { status: 404 });
  }

  const result = await runOperation(command, realOperationDeps(db));

  // Audit EVERY invocation (mutating run and dry-run alike) so the manual-ops
  // surface stays fully observable. metadata carries operation identity +
  // outcome only — job internals/values live in the JobRun row, never here.
  await db.auditLog.create({
    data: {
      userId: auth.user.id,
      performedByAdminId: auth.user.id,
      action: command.mutates
        ? AuditAction.PLATFORM_OPERATION_EXECUTED
        : AuditAction.PLATFORM_OPERATION_DRY_RUN,
      metadata: {
        commandId: command.id,
        kind: command.kind,
        targetJob: command.targetJob,
        outcome: result.outcome,
        ...(result.status ? { jobRunStatus: result.status } : {}),
      },
    },
  });

  // A refused (in-flight) run is a 409; a body failure is a 200 with
  // outcome:"failed" (the run happened and is ledgered — not an HTTP error).
  const httpStatus = result.outcome === "in-flight" ? 409 : 200;

  return NextResponse.json(
    {
      ok: result.outcome === "executed" || result.outcome === "planned",
      ...result,
    } satisfies OperationActionResponse,
    { status: httpStatus },
  );
}, "POST /api/platform/platform-ops/operations");
