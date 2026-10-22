/**
 * GET /api/health  (OPS-1 S6 · OBS-001 / OPS-002 / OPS-014 / OBS-010)
 *
 * Minimal unauthenticated health endpoint for external uptime monitoring
 * (BetterStack / UptimeRobot / Checkly class) and the incident-response
 * runbook. docs/operations/external-monitoring.md says how to register a
 * monitor and what to assert.
 *
 * Signals — deliberately minimal and safe:
 *   - process is up (any response at all)
 *   - database reachable (SELECT 1) → `db: "ok"`, else HTTP 503 `degraded`
 *   - `scheduler` — the NON-SENSITIVE scheduler liveness block an external
 *     dead-man's switch alerts on: `lastDispatchAt`, `lastAlertEvaluationAt`,
 *     `lastBackstopCronAt`, `overdueJobs` (an integer), `alertEvaluatorOverdue`.
 *     Timestamps and one count — no job names, no mailbox, no error text.
 *     Null on a 503 (the ledger was not readable), never fabricated.
 *
 * Explicitly NOT exposed: env values, config, user counts, error details (a
 * failing DB returns a bare "degraded" — internals stay in the server log),
 * and — since OPS-014 / OBS-010 — the COMMIT SHA. Decision recorded: the sha
 * is dropped outright rather than gated behind a secret. The deployment
 * identity an operator needs lives on every JobRun / RefreshExecution row and
 * as Sentry's `release` (lib/monitoring/deployment.ts); a public route is the
 * wrong place to advertise which build is running.
 *
 * Rate-limited per IP so the unauthenticated DB ping cannot be used to hammer
 * the database. The limiter FAILS OPEN on a store error by design
 * (lib/rate-limit.ts) — and that is safe here because the very next statement
 * is the DB probe: if the store is down because the database is down, the probe
 * fails and the caller gets the 503 that IS the right signal. Fail-open can
 * never turn a dead database into a 200.
 *
 * `dynamic = "force-dynamic"` — a cached health check is a lie.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { limitByIp } from "@/lib/rate-limit";
import { readSchedulerSignals } from "./scheduler-signals";
import type { SchedulerSignals } from "./scheduler-signals-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "sin1"; // co-locate with the DB like other routes

export interface HealthResponse {
  status: "ok" | "degraded";
  db: "ok" | "error";
  /** Null when the ledger could not be read (always null on a 503). */
  scheduler: SchedulerSignals | null;
  time: string;
}

/** Injection seam for the route test (no live database there). Production callers pass nothing. */
export interface HealthDeps {
  ping?: () => Promise<unknown>;
  scheduler?: (now: Date) => Promise<SchedulerSignals>;
  now?: () => Date;
}

export async function handleHealth(req: NextRequest, deps: HealthDeps = {}): Promise<NextResponse> {
  const limited = await limitByIp(req, "health", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  const now = deps.now ? deps.now() : new Date();
  const ping = deps.ping ?? (() => db.$queryRaw`SELECT 1`);
  const scheduler = deps.scheduler ?? readSchedulerSignals;

  try {
    await ping();
  } catch (err) {
    console.error("[health] database check failed:", err);
    const body: HealthResponse = { status: "degraded", db: "error", scheduler: null, time: now.toISOString() };
    return NextResponse.json(body, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  // The ledger read is best-effort: a database that answers SELECT 1 but
  // cannot serve the ledger is still "db ok"; the block is null and says so by
  // its absence (a monitor asserting on it alerts, which is correct).
  let signals: SchedulerSignals | null = null;
  try {
    signals = await scheduler(now);
  } catch (err) {
    console.error("[health] scheduler signals unreadable (non-fatal):", err);
  }

  const body: HealthResponse = { status: "ok", db: "ok", scheduler: signals, time: now.toISOString() };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  return handleHealth(req);
}
