/**
 * GET /api/health  (OPS-1 S6)
 *
 * Minimal unauthenticated health endpoint for external uptime monitoring
 * (BetterStack/UptimeRobot class) and the incident-response runbook.
 *
 * Signals — deliberately minimal and safe:
 *   - process is up (any response at all)
 *   - database reachable (SELECT 1)
 *   - deploy identity (short commit sha, provided by Vercel; null locally)
 *
 * Explicitly NOT exposed: env values, config, queue/job state, user counts,
 * or error details (a failing DB returns a bare "degraded" — internals stay
 * in the server log).
 *
 * Rate-limited per IP so the unauthenticated DB ping cannot be used to hammer
 * the database. `dynamic = "force-dynamic"` — a cached health check is a lie.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { limitByIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "sin1"; // co-locate with the DB like other routes

export async function GET(req: NextRequest) {
  const limited = await limitByIp(req, "health", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;

  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      db:     "ok",
      commit,
      time:   new Date().toISOString(),
    });
  } catch (err) {
    console.error("[health] database check failed:", err);
    return NextResponse.json(
      { status: "degraded", db: "error", commit, time: new Date().toISOString() },
      { status: 503 },
    );
  }
}
