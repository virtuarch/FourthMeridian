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
 * FEATURE FLAG  (OPS-1 S4 polarity — production default-ON)
 * ------------
 *   - Production (NODE_ENV === "production"): limiting is ACTIVE unless
 *     RATE_LIMIT_ENABLED === "false". A missing var can no longer mean
 *     "unprotected" — the explicit opt-out exists only as an emergency valve.
 *   - Dev/test: limiting is off unless RATE_LIMIT_ENABLED === "true"
 *     (unchanged, so local dev and the unit suite stay friction-free).
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

/**
 * OPS-1 S4 — default-on in production. Exported for deterministic tests of the
 * polarity; call sites should keep using limitByIp/limitByUser/limitByKey.
 */
export function isRateLimitingEnabled(): boolean {
  if (process.env.NODE_ENV === "production") {
    return process.env.RATE_LIMIT_ENABLED !== "false";
  }
  return process.env.RATE_LIMIT_ENABLED === "true";
}

const isEnabled = () => isRateLimitingEnabled();
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

// ── Strict (fail-CLOSED) variant for authentication paths (PS-4A) ──────────────
//
// enforce() above FAILS OPEN: on a store error it returns null (not limited) so
// an ordinary endpoint stays up during a rate-limit outage. That is the correct
// default for most endpoints, but it is the WRONG policy for login: failing open
// there silently removes brute-force protection during exactly the window an
// attacker would exploit.
//
// The authentication paths instead need to know the difference between
// "checked, not limited", "checked, limited", and "could not check". This
// variant surfaces that as a discriminated verdict WITHOUT swallowing the store
// error, so the caller can STOP the attempt and return temporary-unavailability
// (see app/api/auth/pre-login + lib/auth.ts authorize). It does not itself
// perform credential verification — it only reports.
//
// It still honours RATE_LIMIT_ENABLED (disabled ⇒ "ok", no DB call) and
// RATE_LIMIT_SHADOW (would-block is logged, reported as "ok"). A genuine store
// failure is reported as "unavailable" regardless of shadow, because the store
// being unreachable is an infrastructure fact, not a limit decision.

export type LimitVerdict =
  | { status: "ok" }
  | { status: "limited"; retryAfterSec: number }
  | { status: "unavailable" };

/**
 * `runCheck` is an injection seam (house pattern, cf. sync-lock) so tests can
 * execute the fail-closed branch deterministically without a live DB — the
 * store backend is production-gated, so the real `check` never throws in test.
 * Production callers use the default.
 */
export async function checkStrict(
  key: string,
  cfg: RateLimitConfig,
  runCheck: (k: string, c: RateLimitConfig) => Promise<RateLimitOutcome> = check,
): Promise<LimitVerdict> {
  if (!isEnabled()) return { status: "ok" };

  let outcome: RateLimitOutcome;
  try {
    outcome = await runCheck(key, cfg);
  } catch (err) {
    // FAIL CLOSED: do not proceed to credential verification without a working
    // limiter. The caller maps this to HTTP 503 + an operational capture.
    console.error("[rate-limit] store error — auth path failing CLOSED (unavailable):", err);
    return { status: "unavailable" };
  }

  if (!outcome.limited) return { status: "ok" };

  if (isShadow()) {
    console.warn(`[rate-limit] SHADOW would-block key=${key} limit=${cfg.limit}/${cfg.windowSec}s`);
    return { status: "ok" };
  }

  console.warn(`[rate-limit] BLOCK key=${key} limit=${cfg.limit}/${cfg.windowSec}s retryAfter=${outcome.retryAfterSec}s`);
  return { status: "limited", retryAfterSec: outcome.retryAfterSec };
}

/**
 * Strict per-IP check for authentication endpoints (fail-closed). Increments the
 * same fixed-window bucket as limitByIp for the given `(name, ip)`, so it is a
 * drop-in for the limiter call in a login route — the only difference is the
 * return shape and the failure policy.
 */
export function checkIpLimitStrict(req: Request, name: string, cfg: RateLimitConfig): Promise<LimitVerdict> {
  return checkStrict(`ip:${name}:${getClientIp(req)}`, cfg);
}

/**
 * Strict composite-key check for authentication contexts without a Request
 * object (the NextAuth authorize() callback keys on the submitted identifier).
 * Mirrors limitByKey's bucket; fail-closed return shape.
 */
export function checkKeyLimitStrict(key: string, name: string, cfg: RateLimitConfig): Promise<LimitVerdict> {
  return checkStrict(`key:${name}:${key}`, cfg);
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

/**
 * Generic composite-key limit for contexts that have neither a Request object
 * nor an authenticated user — e.g. the NextAuth authorize() callback, which
 * keys on the submitted login identifier (OPS-1 S4). The caller decides how to
 * react: route handlers return the NextResponse as-is; authorize() treats a
 * non-null result as a denial and returns null.
 */
export function limitByKey(
  key: string,
  name: string,
  cfg: RateLimitConfig,
): Promise<NextResponse | null> {
  return enforce(`key:${name}:${key}`, cfg);
}

/**
 * Read the current bucket count for a `limitByKey` key WITHOUT incrementing it
 * (Wave 2 ⑥ — CAPTCHA step-up on login). `(key, name)` must match the paired
 * `limitByKey(key, name, …)` call, and `windowSec` must equal that call's
 * config window so the same fixed-window bucket is read.
 *
 * Returns the count for the current window (0 if the bucket is empty — including
 * when rate limiting is disabled, since nothing is ever written then). Reads the
 * same backend the limiter writes (DB in production, in-memory otherwise) and
 * fails soft to 0 on any store error, so a peek can never take down a handler.
 *
 * This is a pure read: it does not enforce, block, or mutate. The caller decides
 * what to do with the number (e.g. require a CAPTCHA once it crosses a threshold).
 */
export async function peekKey(key: string, name: string, windowSec: number): Promise<number> {
  const fullKey       = `key:${name}:${key}`;
  const windowMs      = windowSec * 1000;
  const windowStartMs = Math.floor(Date.now() / windowMs) * windowMs;

  try {
    if (dbBackendActive()) {
      const row = await db.rateLimit.findUnique({
        where:  { key_windowStart: { key: fullKey, windowStart: new Date(windowStartMs) } },
        select: { count: true },
      });
      return row?.count ?? 0;
    }
    const existing = memStore.get(fullKey);
    return existing && existing.windowStart === windowStartMs ? existing.count : 0;
  } catch (err) {
    console.error("[rate-limit] peek error — treating as 0:", err);
    return 0;
  }
}
