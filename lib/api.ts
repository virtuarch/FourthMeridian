/**
 * lib/api.ts
 *
 * Shared utilities for API route handlers.
 *
 * ─── withApiHandler ──────────────────────────────────────────────────────────
 * A lightweight wrapper that catches unexpected errors and returns a consistent
 * JSON { error: "Internal server error" } with status 500.  Known errors
 * (auth, validation) are still returned by the route handler directly —
 * withApiHandler only catches things that fall through uncaught.
 *
 * Usage:
 *   export const GET = withApiHandler(async (req) => {
 *     const [user, err] = await requireUser();
 *     if (err) return err;
 *     ...
 *     return ok(data);
 *   }, "GET /api/workspaces");
 *
 * ─── getRequestMeta / getClientIp ────────────────────────────────────────────
 * getRequestMeta() returns a structured object with all request metadata:
 * IP, user-agent, Cloudflare headers (ray, country, colo), and protocol.
 * Use this as the standard source for audit log metadata and security events.
 *
 * getClientIp() is a thin wrapper around getRequestMeta() for the common
 * case where only the IP is needed.
 *
 * Header priority for IP:
 *   1. cf-connecting-ip  — Cloudflare sets this; cannot be spoofed by client
 *   2. x-forwarded-for   — first entry in the comma-separated chain
 *   3. x-real-ip         — set by some reverse proxies (nginx)
 *   4. "unknown"         — local dev or unproxied direct connection
 *
 * ─── Response helpers ────────────────────────────────────────────────────────
 * ok(), created(), badRequest(), notFound()
 * Thin wrappers around NextResponse.json() for the most common status codes.
 * They do not replace inline NextResponse.json() calls — use whichever is
 * clearer in context. Note: unauthorized() and forbidden() live in lib/session.ts
 * since they are auth-specific and already imported from there by all routes.
 */

import "server-only";

import { NextRequest, NextResponse } from "next/server";

// ── Request metadata ──────────────────────────────────────────────────────────

export interface RequestMeta {
  /** Real client IP (Cloudflare > x-forwarded-for > x-real-ip > "unknown"). */
  ip:           string;
  /** HTTP User-Agent string, or null if absent. */
  userAgent:    string | null;
  /** Cloudflare Ray ID (cf-ray), useful for correlating logs with CF dashboard. */
  cfRay:        string | null;
  /** Two-letter ISO country code from Cloudflare (cf-ipcountry). */
  country:      string | null;
  /** Cloudflare or Vercel edge PoP/colo where the request arrived. */
  colo:         string | null;
  /** Full x-forwarded-for chain, for logging only — do not use for IP identification. */
  forwardedFor: string | null;
  /** Request protocol: "https" in production, "http" in local dev. */
  protocol:     string;
}

/**
 * Extracts structured request metadata from a Next.js API request.
 * Prefer this over getClientIp() when writing audit logs or security events —
 * it captures everything in one pass.
 */
export function getRequestMeta(req: NextRequest | Request): RequestMeta {
  const h = req.headers;

  const cf          = h.get("cf-connecting-ip");
  const forwardedFor = h.get("x-forwarded-for");
  const realIp      = h.get("x-real-ip");

  const ip =
    cf?.trim() ??
    forwardedFor?.split(",")[0]?.trim() ??
    realIp?.trim() ??
    "unknown";

  return {
    ip,
    userAgent:    h.get("user-agent"),
    cfRay:        h.get("cf-ray"),
    country:      h.get("cf-ipcountry"),
    colo:         h.get("x-vercel-id")?.split(":")[0] ?? h.get("cf-ipcola") ?? null,
    forwardedFor,
    protocol:     h.get("x-forwarded-proto") ?? "https",
  };
}

/**
 * Returns the real client IP from a request.
 * Prefer getRequestMeta() when you need more than just the IP.
 */
export function getClientIp(req: NextRequest | Request): string {
  return getRequestMeta(req).ip;
}

// ── withApiHandler ────────────────────────────────────────────────────────────

type RouteHandler<T extends unknown[] = []> = (
  req: NextRequest,
  ...args: T
) => Promise<NextResponse> | NextResponse;

/**
 * Wraps a route handler with a top-level try/catch.
 *
 * - Expected errors (auth, 400/403/404) should be returned by the handler directly.
 * - Unexpected errors (DB failure, env var missing, etc.) are caught here,
 *   logged server-side with context, and returned as a generic 500.
 * - Stack traces and raw error messages are never sent to the client.
 *
 * @param handler  The route handler function
 * @param context  A short label for the server log (e.g. "GET /api/workspaces/goals")
 */
export function withApiHandler<T extends unknown[]>(
  handler: RouteHandler<T>,
  context: string,
): RouteHandler<T> {
  return async (req: NextRequest, ...args: T): Promise<NextResponse> => {
    try {
      return await handler(req, ...args);
    } catch (err) {
      console.error(`[api] ${context} unhandled error:`, err);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 },
      );
    }
  };
}

// ── Response helpers ──────────────────────────────────────────────────────────
// Thin wrappers for the most common success/client-error responses.
// Note: unauthorized() and forbidden() live in lib/session.ts.

/** 200 OK — generic success response. */
export const ok = (data: unknown): NextResponse =>
  NextResponse.json(data);

/** 201 Created — use after successfully creating a resource. */
export const created = (data: unknown): NextResponse =>
  NextResponse.json(data, { status: 201 });

/** 400 Bad Request — use for missing/invalid input. */
export const badRequest = (error: string): NextResponse =>
  NextResponse.json({ error }, { status: 400 });

/** 404 Not Found — use when the requested resource does not exist. */
export const notFound = (error = "Not found"): NextResponse =>
  NextResponse.json({ error }, { status: 404 });
