/**
 * lib/rate-limit.ts  (KD-3)
 *
 * Endpoint-local, fixed-window rate limiting.
 *
 * WHY THIS SHAPE
 * --------------
 * proxy.ts only matches /dashboard/* and /admin/* — it never runs on /api/*,
 * and the auth endpoints are unauthenticated (no user to key on). So limits are
 * applied per-route by calling limitByIp()/limitByUser() at the top of a
 * handler. No middleware matcher change, no generic wrapper.
 *
 * BACKENDS
 * --------
 *   - Production (NODE_ENV === "production"): DB-backed via the RateLimit table.
 *     One row per (key, windowStart) bucket, incremented atomically. Correct
 *     across Vercel's isolated serverless instances and cold starts.
 *   - Everything else (local dev / test): in-memory Map. Zero DB writes.
 *
 * FEATURE FLAG
 * ------------
 *   - RATE_LIMIT_ENABLED must be "true" to do anything. Unset/anything else →
 *     every call is a pure pass-through (returns null, no store access).
 *   - RATE_LIMIT_SHADOW === "true" → log-only: over-limit requests are counted
 *     and logged as "[rate-limit] SHADOW ..." but never blocked. Use this to
 *     measure real traffic before enforcing.
 *
 * USAGE
 * -----
 *   // Unauthenticated (per client IP):
 *   const limited = await limitByIp(req, "pre-login", { limit: 10, windowSec: 60 });
 *   if (limited) return limited;               // 429 NextResponse
 *
 *   // Authenticated (per user); exempt SYSTEM_ADMIN at the call site:
 *   if (user.role !== "SYSTEM_ADMIN") {
 *     const limited = await limitByUser(user.id, "ai-chat", { limit: 30, windowSec: 60 });
 *     if (limited) return limited;
 *   }
 *
 * The future Upstash/Redis migration swaps only the store functions below; call
 * sites and the RateLimit table stay untouched.
 */

import "server-only";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// ── Config ────────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

interface RateLimitOutcome {
  limited: boolean;
  /** Seconds until the current window resets. */
  retryAfterSec: number;
}

const isEnabled = () => process.env.RATE_LIMIT_ENABLED === "true";
const isShadow  = () => process.env.RATE_LIMIT_SHADOW  === "true";
const dbBackendActive = () => process.env.NODE_ENV === "production";

// ── In-memory backend (dev/test) ──────────────────────────────────────────────

const memStore = new Map<string, { windowStart: number; count: number }>();

function incrementMemory(key: string, windowStartMs: number): number {
  const existing = memStore.get(key);
  if (!existing || existing.windowStart !== windowStartMs) {
    memStore.set(key, { windowStart: windowStartMs, count: 1 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

// ── DB backend (production) ───────────────────────────────────────────────────

async function incrementDb(key: string, windowStart: Date): Promise<number> {
  // Single atomic upsert: create the bucket at 1, or increment the existing
  // count. The @@unique([key, windowStart]) constraint makes this race-safe
  // across concurrent serverless invocations.
  const row = await db.rateLimit.upsert({
    where:  { key_windowStart: { key, windowStart } },
    create: { key, windowStart, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  });
  return row.count;
}

// ── Core ──────────────────────────────────────────────────────────────────────

async function check(key: string, cfg: RateLimitConfig): Promise<RateLimitOutcome> {
  const windowMs        = cfg.windowSec * 1000;
  const now             = Date.now();
  const windowStartMs   = Math.floor(now / windowMs) * windowMs;
  const retryAfterSec   = Math.max(1, Math.ceil((windowStartMs + windowMs - now) / 1000));

  const count = dbBackendActive()
    ? await incrementDb(key, new Date(windowStartMs))
    : incrementMemory(key, windowStartMs);

  return { limited: count > cfg.limit, retryAfterSec };
}

/** Build the standard 429 response with a Retry-After header. */
function tooManyRequests(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

/**
 * Run a limit check for `key`. Returns a 429 NextResponse if the caller should
 * be blocked, otherwise null. Honours the RATE_LIMIT_ENABLED flag and
 * RATE_LIMIT_SHADOW log-only mode. Fails open on unexpected store errors so a
 * rate-limit outage never takes down an endpoint.
 */
async function enforce(key: string, cfg: RateLimitConfig): Promise<NextResponse | null> {
  if (!isEnabled()) return null;

  let outcome: RateLimitOutcome;
  try {
    outcome = await check(key, cfg);
  } catch (err) {
    console.error("[rate-limit] store error — failing open:", err);
    return null;
  }

  if (!outcome.limited) return null;

  if (isShadow()) {
    console.warn(`[rate-limit] SHADOW would-block key=${key} limit=${cfg.limit}/${cfg.windowSec}s`);
    return null;
  }

  console.warn(`[rate-limit] BLOCK key=${key} limit=${cfg.limit}/${cfg.windowSec}s retryAfter=${outcome.retryAfterSec}s`);
  return tooManyRequests(outcome.retryAfterSec);
}

// ── Key helpers ───────────────────────────────────────────────────────────────

/**
 * Extract the client IP from a request. Trusts the platform-set forwarding
 * headers (Vercel populates x-forwarded-for); falls back to "unknown" so a
 * missing header degrades to a single shared bucket rather than throwing.
 */
export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Per-IP limit for unauthenticated endpoints. `name` scopes the bucket per route. */
export function limitByIp(
  req: Request,
  name: string,
  cfg: RateLimitConfig,
): Promise<NextResponse | null> {
  return enforce(`ip:${name}:${getClientIp(req)}`, cfg);
}

/** Per-user limit for authenticated endpoints. `name` scopes the bucket per route. */
export function limitByUser(
  userId: string,
  name: string,
  cfg: RateLimitConfig,
): Promise<NextResponse | null> {
  return enforce(`user:${name}:${userId}`, cfg);
}
